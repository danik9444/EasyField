import { IMAGE_MODEL_CONFIG } from './imageModelConfig.ts'
import { promptCharacterCount } from './promptLimits.ts'
import {
  STORYBOARD_MAX_SCENE_DURATION_SECONDS,
  STORYBOARD_MAX_SCENES,
  STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
  STORYBOARD_MIN_SCENE_DURATION_SECONDS,
  STORYBOARD_MIN_TOTAL_DURATION_SECONDS,
  effectiveStoryboardTiming,
  formatStoryboardDuration,
  formatStoryboardTimecode,
  isStoryboardSceneDuration,
  storyboardCompleteStory,
  storyboardSceneTimings,
  type StoryboardDraft,
} from './storyboard.ts'

export type StoryboardBoardCompileErrorCode =
  | 'unsupported-model'
  | 'missing-story'
  | 'missing-scenes'
  | 'too-many-scenes'
  | 'invalid-timing'
  | 'conflicting-references'
  | 'too-many-references'
  | 'prompt-too-long'

export interface StoryboardBoardReferenceManifestItem {
  /** Stable Library identity. It is never written into the provider prompt. */
  creationId: string
  /** One-based position in the exact `runImage.refs` order. */
  referenceIndex: number
  scope: 'previous-storyboard' | 'global' | 'scenes' | 'next-storyboard'
  /** One-based scene ordinals. Empty for a full-story/global reference. */
  sceneOrdinals: number[]
}

export type StoryboardBoardDraftInput = Pick<
  StoryboardDraft,
  | 'workflowMode'
  | 'timingMode'
  | 'previousStoryboardCreationId'
  | 'nextStoryboardCreationId'
  | 'referenceCreationIds'
  | 'title'
  | 'storyBrief'
  | 'storySummary'
  | 'model'
  | 'aspect'
  | 'resolution'
  | 'extras'
  | 'style'
  | 'totalDurationSeconds'
  | 'scenes'
>

export interface CompiledStoryboardBoard {
  ok: true
  prompt: string
  promptCharacters: number
  promptMax: number
  referenceCreationIds: string[]
  referenceManifest: StoryboardBoardReferenceManifestItem[]
  referenceCount: number
  maxReferenceImages: number
  inputFingerprint: string
}

export interface StoryboardBoardCompileError {
  ok: false
  code: StoryboardBoardCompileErrorCode
  error: string
  promptCharacters?: number
  promptMax?: number
  referenceCount?: number
  maxReferenceImages?: number
  sceneOrdinal?: number
}

export type StoryboardBoardCompileResult = CompiledStoryboardBoard | StoryboardBoardCompileError

export type StoryboardSceneReferenceDraftInput = Pick<
  StoryboardDraft,
  'model' | 'previousStoryboardCreationId' | 'nextStoryboardCreationId' | 'referenceCreationIds'
>

export interface CompiledStoryboardSceneReferenceManifest {
  ok: true
  /** Exact provider reference order. This list is never truncated. */
  referenceCreationIds: string[]
  referenceManifest: StoryboardBoardReferenceManifestItem[]
  referenceCount: number
  maxReferenceImages: number
  /** Derived from the validated manifest, not from the untrusted draft. */
  previousStoryboardAttached: boolean
  /** Derived from the validated manifest, not from the untrusted draft. */
  nextStoryboardAttached: boolean
}

export type StoryboardSceneReferenceCompileResult =
  | CompiledStoryboardSceneReferenceManifest
  | StoryboardBoardCompileError

export interface StoryboardContinuityReferenceConflict {
  creationId: string
  roles: Array<'previous storyboard' | 'current storyboard' | 'next storyboard'>
}

interface StoryboardReferenceCollectionInput {
  workflowMode: StoryboardDraft['workflowMode']
  previousStoryboardCreationId: string | null
  nextStoryboardCreationId: string | null
  referenceCreationIds: readonly string[]
  scenes: ReadonlyArray<{ referenceCreationIds: readonly string[] }>
}

function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function normalizedCreationId(value: string): string {
  return cleanText(value)
}

/**
 * Adjacent boards have directional meaning, so one Library image cannot also
 * occupy another continuity slot or act as current-board visual evidence.
 */
export function findStoryboardContinuityReferenceConflict(
  draft: Pick<StoryboardBoardDraftInput, 'workflowMode' | 'previousStoryboardCreationId' | 'nextStoryboardCreationId' | 'referenceCreationIds' | 'scenes'>,
): StoryboardContinuityReferenceConflict | null {
  const rolesById = new Map<string, StoryboardContinuityReferenceConflict['roles']>()
  const add = (rawId: string | null, role: StoryboardContinuityReferenceConflict['roles'][number]) => {
    const creationId = normalizedCreationId(rawId ?? '')
    if (!creationId) return
    const roles = rolesById.get(creationId) ?? []
    if (!roles.includes(role)) roles.push(role)
    rolesById.set(creationId, roles)
  }
  add(draft.previousStoryboardCreationId, 'previous storyboard')
  draft.referenceCreationIds.forEach((creationId) => add(creationId, 'current storyboard'))
  if (draft.workflowMode === 'scenes') {
    draft.scenes.forEach((scene) => {
      scene.referenceCreationIds.forEach((creationId) => add(creationId, 'current storyboard'))
    })
  }
  add(draft.nextStoryboardCreationId, 'next storyboard')

  for (const [creationId, roles] of rolesById) {
    if (roles.length > 1) return { creationId, roles }
  }
  return null
}

/**
 * Collects the exact reference order used by generation. An optional previous
 * board comes first, current-board material follows (one global list in Full,
 * ordered row references in By Scenes), and an optional next board comes last.
 * The first occurrence of each Library image wins while shared scene references
 * retain every scene ordinal.
 */
export function collectStoryboardBoardReferences(
  draft: StoryboardReferenceCollectionInput,
): StoryboardBoardReferenceManifestItem[] {
  const ordered: StoryboardBoardReferenceManifestItem[] = []
  const byId = new Map<string, StoryboardBoardReferenceManifestItem>()
  const append = (
    rawId: string | null,
    scope: StoryboardBoardReferenceManifestItem['scope'],
    sceneOrdinal?: number,
  ) => {
    const creationId = normalizedCreationId(rawId ?? '')
    if (!creationId) return
    const existing = byId.get(creationId)
    if (existing) {
      if (
        scope === 'scenes'
        && existing.scope === 'scenes'
        && sceneOrdinal !== undefined
        && !existing.sceneOrdinals.includes(sceneOrdinal)
      ) {
        existing.sceneOrdinals.push(sceneOrdinal)
      }
      return
    }
    const item: StoryboardBoardReferenceManifestItem = {
      creationId,
      referenceIndex: ordered.length + 1,
      scope,
      sceneOrdinals: scope === 'scenes' && sceneOrdinal !== undefined ? [sceneOrdinal] : [],
    }
    byId.set(creationId, item)
    ordered.push(item)
  }

  // Boundary context is deliberately placed around the current-board
  // material so provider reference order mirrors narrative chronology.
  append(draft.previousStoryboardCreationId, 'previous-storyboard')
  draft.referenceCreationIds.forEach((creationId) => append(creationId, 'global'))
  if (draft.workflowMode === 'scenes') {
    draft.scenes.forEach((scene, sceneIndex) => {
      scene.referenceCreationIds.forEach((creationId) => append(creationId, 'scenes', sceneIndex + 1))
    })
  }
  append(draft.nextStoryboardCreationId, 'next-storyboard')
  return ordered
}

/**
 * Preflights the exact reference list for one By Scenes image generation.
 *
 * Adjacent boards wrap the current scene references in narrative order. The
 * helper deliberately never slices an over-budget list: callers must surface
 * the structured error and let the editor decide which reference to remove.
 * The returned boundary flags are derived from the validated manifest so the
 * provider prompt can never claim that an omitted adjacent board was attached.
 */
export function compileStoryboardSceneReferenceManifest(
  draft: StoryboardSceneReferenceDraftInput,
  currentSceneReferenceCreationIds: readonly string[],
  sceneOrdinal = 1,
): StoryboardSceneReferenceCompileResult {
  const config = IMAGE_MODEL_CONFIG[draft.model]
  if (!config) {
    return {
      ok: false,
      code: 'unsupported-model',
      error: `${draft.model || 'This model'} is not a verified EasyField image model for scene generation.`,
    }
  }

  const normalizedSceneOrdinal = Number.isInteger(sceneOrdinal) && sceneOrdinal > 0
    ? sceneOrdinal
    : 1

  // Detect semantic reuse before collection deduplicates equal identities.
  const rolesById = new Map<string, StoryboardContinuityReferenceConflict['roles']>()
  const addRole = (
    rawId: string | null,
    role: StoryboardContinuityReferenceConflict['roles'][number],
  ) => {
    const creationId = normalizedCreationId(rawId ?? '')
    if (!creationId) return
    const roles = rolesById.get(creationId) ?? []
    if (!roles.includes(role)) roles.push(role)
    rolesById.set(creationId, roles)
  }
  addRole(draft.previousStoryboardCreationId, 'previous storyboard')
  draft.referenceCreationIds.forEach((creationId) => addRole(creationId, 'current storyboard'))
  currentSceneReferenceCreationIds.forEach((creationId) => addRole(creationId, 'current storyboard'))
  addRole(draft.nextStoryboardCreationId, 'next storyboard')
  const conflict = [...rolesById.entries()].find(([, roles]) => roles.length > 1)
  if (conflict) {
    return {
      ok: false,
      code: 'conflicting-references',
      error: `The same Library image cannot be used as ${conflict[1].join(' and ')} context. Choose a different storyboard for each role.`,
    }
  }

  const manifest = collectStoryboardBoardReferences({
    workflowMode: 'scenes',
    previousStoryboardCreationId: draft.previousStoryboardCreationId,
    nextStoryboardCreationId: draft.nextStoryboardCreationId,
    referenceCreationIds: [...draft.referenceCreationIds],
    scenes: [{ referenceCreationIds: [...currentSceneReferenceCreationIds] }],
  })
    .map((item) => item.scope === 'scenes'
      ? { ...item, sceneOrdinals: [normalizedSceneOrdinal] }
      : item)

  const referenceCreationIds = manifest.map((item) => item.creationId)
  if (referenceCreationIds.length > config.maxReferenceImages) {
    return {
      ok: false,
      code: 'too-many-references',
      referenceCount: referenceCreationIds.length,
      maxReferenceImages: config.maxReferenceImages,
      sceneOrdinal: normalizedSceneOrdinal,
      error: `${draft.model} accepts at most ${config.maxReferenceImages} reference image${config.maxReferenceImages === 1 ? '' : 's'} in one scene generation, but Scene ${normalizedSceneOrdinal} uses ${referenceCreationIds.length}. Remove a current-scene or continuity reference before generating.`,
    }
  }

  return {
    ok: true,
    referenceCreationIds,
    referenceManifest: manifest,
    referenceCount: referenceCreationIds.length,
    maxReferenceImages: config.maxReferenceImages,
    previousStoryboardAttached: manifest.some((item) => item.scope === 'previous-storyboard'),
    nextStoryboardAttached: manifest.some((item) => item.scope === 'next-storyboard'),
  }
}

function referenceLabel(index: number): string {
  return `REFERENCE IMAGE ${String(index).padStart(2, '0')}`
}

function sceneLabel(index: number, total: number): string {
  return `SCENE ${String(index).padStart(2, '0')} OF ${String(total).padStart(2, '0')}`
}

function referenceMappingLines(manifest: readonly StoryboardBoardReferenceManifestItem[]): string[] {
  if (!manifest.length) return ['None. Follow only the authored story material.']
  return manifest.map((item) => {
    if (item.scope === 'previous-storyboard') {
      return `${referenceLabel(item.referenceIndex)}: PREVIOUS STORYBOARD — incoming continuity context immediately before this board. Continue its established identities, world and visible end state into the opening; do not repeat its events or recreate it as output.`
    }
    if (item.scope === 'next-storyboard') {
      return `${referenceLabel(item.referenceIndex)}: NEXT STORYBOARD — outgoing continuity context immediately after this board. Guide the ending toward its established opening state; do not depict its future events early or recreate it as output.`
    }
    if (item.scope === 'global') {
      return `${referenceLabel(item.referenceIndex)}: global continuity reference for the whole board and every relevant panel.`
    }
    const scenes = item.sceneOrdinals.map((ordinal) => String(ordinal).padStart(2, '0'))
    return `${referenceLabel(item.referenceIndex)}: authoritative visual reference for ${scenes.length === 1 ? 'Scene' : 'Scenes'} ${scenes.join(', ')} only.`
  })
}

function referencesForScene(
  manifest: readonly StoryboardBoardReferenceManifestItem[],
  sceneOrdinal: number,
): string {
  const references = manifest
    .filter((item) => item.scope === 'scenes' && item.sceneOrdinals.includes(sceneOrdinal))
    .map((item) => String(item.referenceIndex).padStart(2, '0'))
  return references.length ? references.join(', ') : 'none'
}

/**
 * Builds one complete provider prompt without applying a length cap. The
 * compiler below validates the finished prompt as a whole, so the final scene
 * can never disappear through truncation.
 */
export function buildGeneratedStoryboardBoardPrompt(
  draft: StoryboardBoardDraftInput,
  manifest = collectStoryboardBoardReferences(draft),
): string {
  const sceneCount = draft.scenes.length
  const completeStory = cleanText(storyboardCompleteStory(draft))
  const style = cleanText(draft.style)
  const title = cleanText(draft.title)
  const effectiveTiming = effectiveStoryboardTiming(draft)
  const includeTiming = effectiveTiming.timingMode !== 'none'
  const hasAdjacentStoryboardContext = Boolean(
    draft.previousStoryboardCreationId || draft.nextStoryboardCreationId,
  )

  if (draft.workflowMode === 'full') {
    const timingLines = effectiveTiming.timingMode === 'manual'
      ? [
        `Total story duration: ${formatStoryboardDuration(effectiveTiming.totalDurationSeconds)}.`,
        'Use that duration only to guide the overall narrative pace; choose the panel count and relative emphasis yourself.',
      ]
      : effectiveTiming.timingMode === 'auto'
        ? ['Pacing: automatic. Choose a natural overall duration from 5 to 90 seconds from the Story Brief.']
        : []
    return [
      'Generate ONE complete storyboard-sheet image from the single Story Brief below.',
      `Treat the Story Brief as the only narrative plan. Choose an appropriate 1–${STORYBOARD_MAX_SCENES}-panel layout in story order.`,
      'Do not add characters, events or requests that are absent from the brief. Preserve every explicit detail and visual continuity.',
      ...(hasAdjacentStoryboardContext ? [
        'Previous and next storyboard references, when attached, are adjacent continuity context only. Generate only the current storyboard; never reproduce either adjacent board as part of the output.',
      ] : []),
      'Use clear panel borders and concise two-digit panel numbers; do not render the prose itself inside the panels.',
      `Title: ${title || 'Untitled storyboard'}`,
      `Visual style: ${style || '(unspecified)'}`,
      `Final image aspect: ${cleanText(draft.aspect) || 'model default'}`,
      ...timingLines,
      'REFERENCES',
      ...referenceMappingLines(manifest),
      'STORY BRIEF',
      completeStory,
      `CHECK: output one coherent storyboard sheet with 1–${STORYBOARD_MAX_SCENES} ordered panels and no invented story content.`,
    ].join('\n')
  }

  const timings = includeTiming ? storyboardSceneTimings(effectiveTiming.scenes) : []

  const sceneBlocks = draft.scenes.map((scene, index) => {
    const ordinal = index + 1
    const timing = timings[index]
    const lines = [
      sceneLabel(ordinal, sceneCount),
      `Title: ${cleanText(scene.title) || '(unspecified)'}`,
      `Visual direction: ${cleanText(scene.prompt) || '(unspecified; do not invent details)'}`,
      `Narrative purpose: ${cleanText(scene.explanation) || '(unspecified)'}`,
    ]
    if (includeTiming && timing) {
      lines.push(`Timing: ${formatStoryboardTimecode(timing.startSeconds)}–${formatStoryboardTimecode(timing.endSeconds)} · ${formatStoryboardDuration(timing.durationSeconds)}`)
    }
    if (draft.workflowMode === 'scenes') {
      lines.push(`Attached visual references: ${referencesForScene(manifest, ordinal)}`)
    }
    return lines.join('\n')
  })

  return [
    `Generate ONE storyboard-sheet image with exactly ${sceneCount} panel${sceneCount === 1 ? '' : 's'}, ordered left-to-right then top-to-bottom.`,
    'Render each listed scene once. Never omit, merge, duplicate, reorder or invent story content.',
    'Maintain visual continuity. Current-scene references constrain only their mapped scenes.',
    ...(hasAdjacentStoryboardContext ? [
      'Previous and next storyboard references, when attached, are adjacent continuity context only. Generate only the current storyboard; never reproduce either adjacent board as part of the output.',
    ] : []),
    'Scene prose directs visuals, not text to render. Use clear borders; only two-digit panel numbers may appear.',
    'BOARD',
    `Title: ${title || 'Untitled storyboard'}`,
    `Complete story: ${completeStory || '(unspecified; follow the scenes)'}`,
    `Visual style: ${style || '(unspecified)'}`,
    `Final image aspect: ${cleanText(draft.aspect) || 'model default'}`,
    ...(includeTiming ? [
      `Timing mode: ${effectiveTiming.timingMode === 'auto' ? 'automatic pacing' : 'manual exact timing'}`,
      `Total runtime: ${formatStoryboardDuration(effectiveTiming.totalDurationSeconds)}`,
    ] : []),
    'REFERENCES',
    ...referenceMappingLines(manifest),
    'EXACT ORDERED SCENES',
    ...sceneBlocks,
    `CHECK: output one image with exactly ${sceneCount} panel${sceneCount === 1 ? '' : 's'} in this order; no extra or missing scene.`,
  ].join('\n')
}

function fingerprint(value: string): string {
  // This is a compact change detector for draft/result association, not a
  // security primitive. FNV-1a is deterministic across renderer and tests.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * prime)
  }
  return `storyboard-board-v1-${hash.toString(16).padStart(16, '0')}`
}

function stableExtras(extras: Record<string, string>): Array<[string, string]> {
  return Object.entries(extras)
    .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
}

/**
 * Compiles and validates a true one-generation storyboard. A failed result is
 * suitable for a blocking UI message and contains no runnable provider input.
 */
export function compileGeneratedStoryboardBoard(
  draft: StoryboardBoardDraftInput,
): StoryboardBoardCompileResult {
  const config = IMAGE_MODEL_CONFIG[draft.model]
  if (!config) {
    return {
      ok: false,
      code: 'unsupported-model',
      error: `${draft.model || 'This model'} is not a verified EasyField image model for single-board generation.`,
    }
  }
  const fullStory = cleanText(draft.storyBrief)
  if (draft.workflowMode === 'full' && !fullStory) {
    return {
      ok: false,
      code: 'missing-story',
      error: 'Add a Story Brief before generating the complete storyboard.',
    }
  }
  if (draft.workflowMode === 'scenes' && !draft.scenes.length) {
    return {
      ok: false,
      code: 'missing-scenes',
      error: 'Add at least one scene before generating a complete storyboard image.',
    }
  }
  if (draft.workflowMode === 'scenes' && draft.scenes.length > STORYBOARD_MAX_SCENES) {
    return {
      ok: false,
      code: 'too-many-scenes',
      error: `A storyboard can contain at most ${STORYBOARD_MAX_SCENES} scenes.`,
    }
  }

  const effectiveTiming = effectiveStoryboardTiming(draft)

  if (draft.workflowMode === 'full' && effectiveTiming.timingMode !== 'none') {
    if (
      !Number.isInteger(draft.totalDurationSeconds)
      || draft.totalDurationSeconds < STORYBOARD_MIN_TOTAL_DURATION_SECONDS
      || draft.totalDurationSeconds > STORYBOARD_MAX_TOTAL_DURATION_SECONDS
    ) {
      return {
        ok: false,
        code: 'invalid-timing',
        error: `Full Storyboard duration must be a whole number from ${STORYBOARD_MIN_TOTAL_DURATION_SECONDS} to ${STORYBOARD_MAX_TOTAL_DURATION_SECONDS} seconds.`,
      }
    }
  } else if (effectiveTiming.timingMode !== 'none') {
    const invalidSceneIndex = effectiveTiming.scenes.findIndex((scene) => (
      !isStoryboardSceneDuration(scene.durationSeconds)
    ))
    if (invalidSceneIndex >= 0) {
      return {
        ok: false,
        code: 'invalid-timing',
        sceneOrdinal: invalidSceneIndex + 1,
        error: `Scene ${invalidSceneIndex + 1} needs a duration from ${STORYBOARD_MIN_SCENE_DURATION_SECONDS} to ${STORYBOARD_MAX_SCENE_DURATION_SECONDS} seconds in 0.5-second steps before generating the board.`,
      }
    }
    const sceneTotal = effectiveTiming.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)
    const minimumTotal = draft.scenes.length * STORYBOARD_MIN_SCENE_DURATION_SECONDS
    const maximumTotal = Math.min(
      STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
      draft.scenes.length * STORYBOARD_MAX_SCENE_DURATION_SECONDS,
    )
    if (
      !Number.isInteger(effectiveTiming.totalDurationSeconds * 2)
      || effectiveTiming.totalDurationSeconds < minimumTotal
      || effectiveTiming.totalDurationSeconds > maximumTotal
      || sceneTotal !== effectiveTiming.totalDurationSeconds
    ) {
      return {
        ok: false,
        code: 'invalid-timing',
        error: `Scene durations must equal the total storyboard duration, stay within ${STORYBOARD_MIN_SCENE_DURATION_SECONDS}–${STORYBOARD_MAX_SCENE_DURATION_SECONDS} seconds each, and remain under the ${STORYBOARD_MAX_TOTAL_DURATION_SECONDS}-second storyboard ceiling.`,
      }
    }
  }

  const continuityConflict = findStoryboardContinuityReferenceConflict(draft)
  if (continuityConflict) {
    return {
      ok: false,
      code: 'conflicting-references',
      error: `The same Library image cannot be used as ${continuityConflict.roles.join(' and ')} context. Choose a different storyboard for each role.`,
    }
  }

  const referenceManifest = collectStoryboardBoardReferences(draft)
  const referenceCreationIds = referenceManifest.map((item) => item.creationId)
  if (referenceCreationIds.length > config.maxReferenceImages) {
    return {
      ok: false,
      code: 'too-many-references',
      referenceCount: referenceCreationIds.length,
      maxReferenceImages: config.maxReferenceImages,
      error: `${draft.model} accepts at most ${config.maxReferenceImages} reference image${config.maxReferenceImages === 1 ? '' : 's'} in one generation, but this board uses ${referenceCreationIds.length}. Remove references or use the exact scene-by-scene board option.`,
    }
  }

  const prompt = buildGeneratedStoryboardBoardPrompt(draft, referenceManifest)
  const promptCharacters = promptCharacterCount(prompt)
  if (promptCharacters > config.promptMax) {
    return {
      ok: false,
      code: 'prompt-too-long',
      promptCharacters,
      promptMax: config.promptMax,
      referenceCount: referenceCreationIds.length,
      maxReferenceImages: config.maxReferenceImages,
      error: draft.workflowMode === 'full'
        ? `The complete Story Brief needs ${promptCharacters.toLocaleString()} prompt characters, but ${draft.model} accepts ${config.promptMax.toLocaleString()}. Nothing was truncated or generated. Shorten the Story Brief or choose a model with a larger prompt limit.`
        : `The complete ordered board needs ${promptCharacters.toLocaleString()} prompt characters, but ${draft.model} accepts ${config.promptMax.toLocaleString()}. Nothing was truncated or generated. Shorten the story or scenes, choose a model with a larger prompt limit, or use the exact scene-by-scene board option.`,
    }
  }

  const inputFingerprint = fingerprint(JSON.stringify({
    prompt,
    referenceCreationIds,
    model: draft.model,
    aspect: draft.aspect,
    resolution: draft.resolution,
    extras: stableExtras(draft.extras),
  }))

  return {
    ok: true,
    prompt,
    promptCharacters,
    promptMax: config.promptMax,
    referenceCreationIds,
    referenceManifest,
    referenceCount: referenceCreationIds.length,
    maxReferenceImages: config.maxReferenceImages,
    inputFingerprint,
  }
}
