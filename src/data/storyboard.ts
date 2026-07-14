import { IMAGE_MODEL_CONFIG, resolveImageOptions } from './imageModelConfig.ts'
import { IMAGE_MODEL_ALIASES, IMAGE_MODELS } from './models.ts'
import { truncatePrompt } from './promptLimits.ts'

export const STORYBOARD_SCHEMA_VERSION = 4 as const
export const STORYBOARD_MIN_SCENES = 1
export const STORYBOARD_MAX_SCENES = 20
export const STORYBOARD_DEFAULT_SCENE_COUNT = 1
export const STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS = 30
export const STORYBOARD_MIN_TOTAL_DURATION_SECONDS = 5
export const STORYBOARD_MAX_TOTAL_DURATION_SECONDS = 1_800
export const STORYBOARD_MIN_SCENE_DURATION_SECONDS = 1
export const STORYBOARD_DEFAULT_MODEL = 'Seedream 5 Pro'
export const STORYBOARD_DEFAULT_ASPECT = '16:9'
export const STORYBOARD_DEFAULT_RESOLUTION = '1K'
// Persistence envelope only. Each selected cloud image model applies its own
// (often smaller) prompt budget in the Storyboard workspace.
export const STORYBOARD_MAX_PROMPT_LENGTH = 20_000
export const STORYBOARD_MAX_TITLE_LENGTH = 160
export const STORYBOARD_MAX_EXPLANATION_LENGTH = 1_200
export const STORYBOARD_MAX_STORY_BRIEF_LENGTH = 12_000
export const STORYBOARD_MAX_STORY_SUMMARY_LENGTH = 4_000
export const STORYBOARD_MAX_STYLE_LENGTH = 800
export const STORYBOARD_MAX_CANDIDATES_PER_SCENE = 24
export const STORYBOARD_STYLE_OPTIONS = Object.freeze([
  'None',
  'Cinematic',
  'Realistic',
  'Documentary',
  'Commercial',
  'Anime',
  'Illustration',
])

const VALID_STORYBOARD_STYLES = new Set(STORYBOARD_STYLE_OPTIONS.filter((style) => style !== 'None'))

export interface StoryboardSceneCandidate {
  creationId: string
  promptSnapshot: string
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  createdAt: number
}

export interface StoryboardScene {
  id: string
  title: string
  prompt: string
  explanation: string
  durationSeconds: number
  candidates: StoryboardSceneCandidate[]
  approvedCreationId: string | null
  approvedPromptSnapshot: string | null
}

export type StoryboardWorkflowMode = 'full' | 'scenes'
export type StoryboardTimingMode = 'none' | 'auto' | 'manual'

export interface StoryboardDraft {
  schemaVersion: typeof STORYBOARD_SCHEMA_VERSION
  workflowMode: StoryboardWorkflowMode
  timingMode: StoryboardTimingMode
  referenceCreationIds: string[]
  title: string
  storyBrief: string
  storySummary: string
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  style: string
  totalDurationSeconds: number
  scenes: StoryboardScene[]
}

export interface StoryboardSceneTiming {
  sceneId: string
  durationSeconds: number
  startSeconds: number
  endSeconds: number
}

export interface StoryboardTimingMutation {
  totalDurationSeconds: number
  scenes: StoryboardScene[]
}

export function storyboardCompleteStory(
  draft: Pick<StoryboardDraft, 'workflowMode' | 'storyBrief' | 'storySummary'>,
): string {
  return draft.workflowMode === 'scenes'
    ? draft.storySummary.trim()
    : draft.storyBrief.trim()
}

/**
 * Read-only context supplied whenever AI improves Storyboard text. Keeping this
 * builder pure makes it impossible for the scene enhancer to silently omit a
 * sibling row or use the hidden by-scenes summary while Full Storyboard is
 * selected.
 */
export function buildStoryboardEnhancementContext(
  draft: Pick<StoryboardDraft, 'workflowMode' | 'timingMode' | 'title' | 'storyBrief' | 'storySummary' | 'model' | 'aspect' | 'resolution' | 'style' | 'totalDurationSeconds' | 'scenes'>,
  currentSceneId?: string,
): string {
  const completeStory = storyboardCompleteStory(draft)
  const modeLabel = draft.workflowMode === 'scenes' ? 'Storyboard by scenes' : 'Full storyboard'
  const hasTiming = draft.timingMode !== 'none'
  const timings = hasTiming
    ? storyboardSceneTimings(scaleStoryboardDurations(draft.scenes, draft.totalDurationSeconds))
    : []
  const sceneRows = draft.scenes.map((scene, index) => {
    const current = scene.id === currentSceneId ? ' · CURRENT SCENE' : ''
    const timing = timings[index]
    return [
      `SCENE ${String(index + 1).padStart(2, '0')}${current}`,
      timing ? `Timing: ${timing.startSeconds}s–${timing.endSeconds}s · ${timing.durationSeconds}s` : '',
      `Title: ${scene.title.trim() || '(not provided)'}`,
      `Prompt: ${scene.prompt.trim() || '(not provided)'}`,
      `Story note / explanation: ${scene.explanation.trim() || '(not provided)'}`,
    ].filter(Boolean).join('\n')
  })

  return [
    `Storyboard mode: ${modeLabel}`,
    `Storyboard title: ${draft.title.trim() || '(not provided)'}`,
    `Complete story context: ${completeStory || '(not provided — preserve only facts present in the scene rows)'}`,
    hasTiming ? `Timing mode: ${draft.timingMode === 'auto' ? 'Automatic pacing chosen from the story' : 'Manual exact timing'}` : '',
    hasTiming ? `Total story duration: ${draft.totalDurationSeconds} seconds` : '',
    `Output model: ${draft.model}`,
    `Visual direction: ${draft.style.trim() || 'None selected'}`,
    `Frame format: ${draft.aspect}${draft.resolution ? ` · ${draft.resolution}` : ''}`,
    '',
    'ORDERED SCENE ROWS',
    ...sceneRows,
  ].filter((line) => line !== '').join('\n\n')
}

export interface ResizeStoryboardScenesOptions {
  /** A destructive reduction is blocked by default whenever a trailing scene has content. */
  allowDiscard?: boolean
}

export interface ResizeStoryboardScenesResult {
  scenes: StoryboardScene[]
  targetCount: number
  changed: boolean
  blocked: boolean
  wouldDiscardContent: boolean
  affectedSceneIds: string[]
}

let fallbackIdSequence = 0

function safeText(value: unknown, maximum: number, trim = false): string {
  if (typeof value !== 'string') return ''
  const safe = truncatePrompt(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''), maximum)
  return trim ? safe.trim() : safe
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function makeSceneId(excluded: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const uuid = globalThis.crypto?.randomUUID?.()
    const candidate = uuid
      ? `scene-${uuid}`
      : `scene-${Date.now().toString(36)}-${(++fallbackIdSequence).toString(36)}`
    if (!excluded.has(candidate)) return candidate
  }
}

function normalizeModel(value: unknown): string {
  const raw = safeText(value, 100, true)
  const aliased = IMAGE_MODEL_ALIASES[raw] ?? raw
  return IMAGE_MODELS.includes(aliased) && IMAGE_MODEL_CONFIG[aliased]
    ? aliased
    : STORYBOARD_DEFAULT_MODEL
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

function normalizeSceneDuration(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return STORYBOARD_MIN_SCENE_DURATION_SECONDS
  return Math.max(STORYBOARD_MIN_SCENE_DURATION_SECONDS, Math.round(parsed))
}

function normalizeWorkflowMode(value: unknown): StoryboardWorkflowMode {
  return value === 'scenes' ? 'scenes' : 'full'
}

function normalizeTimingMode(value: unknown, schemaVersion: unknown): StoryboardTimingMode {
  if (value === 'none' || value === 'auto' || value === 'manual') return value
  return schemaVersion === 3 ? 'manual' : 'none'
}

function normalizeReferenceCreationIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of value) {
    const id = safeText(item, 240, true)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= maximum) break
  }
  return ids
}

function normalizeStyle(value: unknown): string {
  const style = safeText(value, STORYBOARD_MAX_STYLE_LENGTH, true)
  return VALID_STORYBOARD_STYLES.has(style) ? style : ''
}

function normalizeCandidate(value: unknown): StoryboardSceneCandidate | null {
  const source = safeRecord(value)
  const creationId = safeText(source.creationId, 240, true)
  if (!creationId) return null

  const model = normalizeModel(source.model)
  const options = resolveImageOptions(model, {
    aspect: safeText(source.aspect, 32, true),
    resolution: safeText(source.resolution, 32, true),
    extraOptionValues: safeRecord(source.extras) as Record<string, string>,
  })

  return {
    creationId,
    promptSnapshot: safeText(source.promptSnapshot, STORYBOARD_MAX_PROMPT_LENGTH),
    model,
    aspect: options.aspect,
    resolution: options.resolution,
    extras: options.extraOptionValues,
    createdAt: normalizeTimestamp(source.createdAt),
  }
}

function normalizeCandidates(value: unknown): StoryboardSceneCandidate[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: StoryboardSceneCandidate[] = []

  for (const entry of value) {
    const candidate = normalizeCandidate(entry)
    if (!candidate || seen.has(candidate.creationId)) continue
    seen.add(candidate.creationId)
    normalized.push(candidate)
  }

  return normalized.slice(-STORYBOARD_MAX_CANDIDATES_PER_SCENE)
}

function normalizeScene(value: unknown, usedIds: Set<string>): StoryboardScene {
  const source = safeRecord(value)
  const persistedId = safeText(source.id, 160, true)
  const id = persistedId && !usedIds.has(persistedId) ? persistedId : makeSceneId(usedIds)
  usedIds.add(id)

  const approvedCreationId = safeText(source.approvedCreationId, 240, true) || null
  const approvedPromptSnapshot = typeof source.approvedPromptSnapshot === 'string'
    ? safeText(source.approvedPromptSnapshot, STORYBOARD_MAX_PROMPT_LENGTH)
    : null

  return {
    id,
    title: safeText(source.title, STORYBOARD_MAX_TITLE_LENGTH),
    prompt: safeText(source.prompt, STORYBOARD_MAX_PROMPT_LENGTH),
    explanation: safeText(source.explanation, STORYBOARD_MAX_EXPLANATION_LENGTH),
    durationSeconds: normalizeSceneDuration(source.durationSeconds),
    candidates: normalizeCandidates(source.candidates),
    approvedCreationId,
    approvedPromptSnapshot: approvedCreationId ? approvedPromptSnapshot : null,
  }
}

export function clampStoryboardSceneCount(value: unknown, fallback = STORYBOARD_DEFAULT_SCENE_COUNT): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  const safeFallback = Math.min(STORYBOARD_MAX_SCENES, Math.max(STORYBOARD_MIN_SCENES, Math.round(fallback)))
  if (!Number.isFinite(parsed)) return safeFallback
  return Math.min(STORYBOARD_MAX_SCENES, Math.max(STORYBOARD_MIN_SCENES, Math.round(parsed)))
}

export function clampStoryboardTotalDuration(
  value: unknown,
  sceneCount = STORYBOARD_DEFAULT_SCENE_COUNT,
  fallback = STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS,
): number {
  const safeSceneCount = clampStoryboardSceneCount(sceneCount)
  const minimum = Math.max(STORYBOARD_MIN_TOTAL_DURATION_SECONDS, safeSceneCount * STORYBOARD_MIN_SCENE_DURATION_SECONDS)
  const safeFallback = Math.min(
    STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
    Math.max(minimum, Math.round(fallback)),
  )
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return safeFallback
  return Math.min(STORYBOARD_MAX_TOTAL_DURATION_SECONDS, Math.max(minimum, Math.round(parsed)))
}

function allocateStoryboardSeconds(totalDurationSeconds: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return []
  const total = Math.max(weights.length * STORYBOARD_MIN_SCENE_DURATION_SECONDS, Math.round(totalDurationSeconds))
  const safeWeights = weights.map((weight) => Number.isFinite(weight) && weight > 0 ? weight : 1)
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0)
  const exact = safeWeights.map((weight) => total * weight / weightTotal)
  const allocated = exact.map((value) => Math.max(STORYBOARD_MIN_SCENE_DURATION_SECONDS, Math.floor(value)))
  let remainder = total - allocated.reduce((sum, value) => sum + value, 0)
  while (remainder < 0) {
    const donor = allocated
      .map((value, index) => ({ index, available: value - STORYBOARD_MIN_SCENE_DURATION_SECONDS, excess: value - exact[index] }))
      .filter((item) => item.available > 0)
      .sort((left, right) => right.excess - left.excess || right.available - left.available || left.index - right.index)[0]
    if (!donor) break
    allocated[donor.index] -= 1
    remainder += 1
  }
  const remainderOrder = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
    allocated[remainderOrder[index % remainderOrder.length].index] += 1
  }
  return allocated
}

export function distributeStoryboardDurations(
  scenes: readonly StoryboardScene[],
  totalDurationSeconds: number,
): StoryboardScene[] {
  const total = clampStoryboardTotalDuration(totalDurationSeconds, scenes.length || STORYBOARD_DEFAULT_SCENE_COUNT)
  const durations = allocateStoryboardSeconds(total, scenes.map(() => 1))
  return scenes.map((scene, index) => ({ ...scene, durationSeconds: durations[index] }))
}

export function scaleStoryboardDurations(
  scenes: readonly StoryboardScene[],
  totalDurationSeconds: number,
): StoryboardScene[] {
  if (scenes.length === 0) return []
  const total = clampStoryboardTotalDuration(totalDurationSeconds, scenes.length)
  const durations = allocateStoryboardSeconds(total, scenes.map((scene) => normalizeSceneDuration(scene.durationSeconds)))
  return scenes.map((scene, index) => ({ ...scene, durationSeconds: durations[index] }))
}

export function adjustStoryboardSceneDuration(
  scenes: readonly StoryboardScene[],
  sceneId: string,
  requestedDurationSeconds: number,
  totalDurationSeconds: number,
): StoryboardScene[] {
  if (scenes.length === 0) return []
  const total = clampStoryboardTotalDuration(totalDurationSeconds, scenes.length)
  const normalized = scaleStoryboardDurations(scenes, total)
  const targetIndex = normalized.findIndex((scene) => scene.id === sceneId)
  if (targetIndex < 0) return normalized
  if (normalized.length === 1) return normalized.map((scene) => ({ ...scene, durationSeconds: total }))

  const maximum = total - (normalized.length - 1) * STORYBOARD_MIN_SCENE_DURATION_SECONDS
  const requested = Math.min(maximum, Math.max(STORYBOARD_MIN_SCENE_DURATION_SECONDS, Math.round(requestedDurationSeconds)))
  const durations = normalized.map((scene) => scene.durationSeconds)
  const delta = requested - durations[targetIndex]
  if (delta === 0) return normalized

  const compensationOrder = [
    ...Array.from({ length: normalized.length - targetIndex - 1 }, (_, offset) => targetIndex + offset + 1),
    ...Array.from({ length: targetIndex }, (_, offset) => targetIndex - offset - 1),
  ]

  if (delta > 0) {
    let needed = delta
    for (const index of compensationOrder) {
      const available = durations[index] - STORYBOARD_MIN_SCENE_DURATION_SECONDS
      const taken = Math.min(available, needed)
      durations[index] -= taken
      needed -= taken
      if (needed === 0) break
    }
    durations[targetIndex] += delta - needed
  } else {
    const recipientIndex = compensationOrder[0]
    durations[targetIndex] = requested
    durations[recipientIndex] += -delta
  }

  return normalized.map((scene, index) => ({ ...scene, durationSeconds: durations[index] }))
}

export function appendStoryboardSceneWithTiming(
  scenes: readonly StoryboardScene[],
  totalDurationSeconds: number,
  scene = createStoryboardScene(),
): StoryboardTimingMutation {
  const nextTotal = clampStoryboardTotalDuration(totalDurationSeconds, scenes.length + 1)
  const normalized = scaleStoryboardDurations(scenes, nextTotal)
  if (normalized.length === 0) {
    return { totalDurationSeconds: nextTotal, scenes: [{ ...scene, durationSeconds: nextTotal }] }
  }
  const longestIndex = normalized.reduce(
    (best, item, index) => item.durationSeconds > normalized[best].durationSeconds ? index : best,
    0,
  )
  if (normalized[longestIndex].durationSeconds <= STORYBOARD_MIN_SCENE_DURATION_SECONDS) {
    return { totalDurationSeconds: nextTotal, scenes: distributeStoryboardDurations([...normalized, scene], nextTotal) }
  }
  const addedDuration = Math.max(
    STORYBOARD_MIN_SCENE_DURATION_SECONDS,
    Math.floor(normalized[longestIndex].durationSeconds / 2),
  )
  const next = normalized.map((item, index) => index === longestIndex
    ? { ...item, durationSeconds: item.durationSeconds - addedDuration }
    : item)
  next.push({ ...scene, durationSeconds: addedDuration })
  return { totalDurationSeconds: nextTotal, scenes: next }
}

export function removeStoryboardSceneWithTiming(
  scenes: readonly StoryboardScene[],
  sceneId: string,
  totalDurationSeconds: number,
): StoryboardTimingMutation {
  const total = clampStoryboardTotalDuration(totalDurationSeconds, Math.max(1, scenes.length - 1))
  const normalized = scaleStoryboardDurations(scenes, totalDurationSeconds)
  const removedIndex = normalized.findIndex((scene) => scene.id === sceneId)
  if (removedIndex < 0 || normalized.length <= 1) return { totalDurationSeconds: total, scenes: normalized }
  const removedDuration = normalized[removedIndex].durationSeconds
  const next = normalized.filter((scene) => scene.id !== sceneId)
  const recipientIndex = Math.min(removedIndex, next.length - 1)
  next[recipientIndex] = { ...next[recipientIndex], durationSeconds: next[recipientIndex].durationSeconds + removedDuration }
  return { totalDurationSeconds: total, scenes: next }
}

export function storyboardSceneTimings(scenes: readonly StoryboardScene[]): StoryboardSceneTiming[] {
  let cursor = 0
  return scenes.map((scene) => {
    const durationSeconds = normalizeSceneDuration(scene.durationSeconds)
    const timing = {
      sceneId: scene.id,
      durationSeconds,
      startSeconds: cursor,
      endSeconds: cursor + durationSeconds,
    }
    cursor = timing.endSeconds
    return timing
  })
}

function storyboardWordCount(value: string): number {
  const words = value.trim().split(/\s+/u).filter(Boolean)
  return words.length
}

export function autoStoryboardTiming(
  scenes: readonly StoryboardScene[],
  completeStory = '',
): StoryboardTimingMutation {
  if (scenes.length === 0) {
    return { totalDurationSeconds: STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS, scenes: [] }
  }
  const weights = scenes.map((scene) => {
    const sceneWords = storyboardWordCount(`${scene.title} ${scene.prompt} ${scene.explanation}`)
    return Math.min(30, 4 + Math.ceil(sceneWords / 10))
  })
  const contextSeconds = Math.min(60, Math.ceil(storyboardWordCount(completeStory) / 8))
  const requestedTotal = weights.reduce((sum, weight) => sum + weight, 0) + contextSeconds
  const totalDurationSeconds = clampStoryboardTotalDuration(requestedTotal, scenes.length)
  return {
    totalDurationSeconds,
    scenes: scaleStoryboardDurations(
      scenes.map((scene, index) => ({ ...scene, durationSeconds: weights[index] })),
      totalDurationSeconds,
    ),
  }
}

export function formatStoryboardTimecode(value: number): string {
  const seconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function formatStoryboardDuration(value: number): string {
  const seconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  if (seconds < 60) return `${seconds}s`
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ''}${remainder ? ` ${remainder}s` : ''}`
  return `${minutes}m${remainder ? ` ${remainder}s` : ''}`
}

export function createStoryboardScene(id?: string): StoryboardScene {
  const safeId = safeText(id, 160, true)
  return {
    id: safeId || makeSceneId(),
    title: '',
    prompt: '',
    explanation: '',
    durationSeconds: STORYBOARD_MIN_SCENE_DURATION_SECONDS,
    candidates: [],
    approvedCreationId: null,
    approvedPromptSnapshot: null,
  }
}

export function createDefaultStoryboardDraft(sceneCount = STORYBOARD_DEFAULT_SCENE_COUNT): StoryboardDraft {
  const count = clampStoryboardSceneCount(sceneCount)
  const usedIds = new Set<string>()
  const scenes = Array.from({ length: count }, () => {
    const scene = createStoryboardScene(makeSceneId(usedIds))
    usedIds.add(scene.id)
    return scene
  })

  const totalDurationSeconds = clampStoryboardTotalDuration(STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS, count)
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    workflowMode: 'full',
    timingMode: 'none',
    referenceCreationIds: [],
    title: '',
    storyBrief: '',
    storySummary: '',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    style: '',
    totalDurationSeconds,
    scenes: distributeStoryboardDurations(scenes, totalDurationSeconds),
  }
}

export function normalizeStoryboardDraft(value: unknown): StoryboardDraft {
  const source = safeRecord(value)
  const model = normalizeModel(source.model)
  const options = resolveImageOptions(model, {
    aspect: safeText(source.aspect, 32, true),
    resolution: safeText(source.resolution, 32, true),
    extraOptionValues: safeRecord(source.extras) as Record<string, string>,
  })

  const sourceScenes = Array.isArray(source.scenes) && source.scenes.length > 0
    ? source.scenes.slice(0, STORYBOARD_MAX_SCENES)
    : Array.from({ length: STORYBOARD_DEFAULT_SCENE_COUNT }, () => ({}))
  const usedIds = new Set<string>()
  const scenes = sourceScenes.map((scene) => normalizeScene(scene, usedIds))
  const totalDurationSeconds = clampStoryboardTotalDuration(source.totalDurationSeconds, scenes.length)
  const timingMode = normalizeTimingMode(source.timingMode, source.schemaVersion)

  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    workflowMode: normalizeWorkflowMode(source.workflowMode),
    timingMode,
    referenceCreationIds: normalizeReferenceCreationIds(source.referenceCreationIds, IMAGE_MODEL_CONFIG[model].maxReferenceImages),
    title: safeText(source.title, STORYBOARD_MAX_TITLE_LENGTH),
    storyBrief: safeText(source.storyBrief, STORYBOARD_MAX_STORY_BRIEF_LENGTH),
    storySummary: safeText(source.storySummary, STORYBOARD_MAX_STORY_SUMMARY_LENGTH),
    model,
    aspect: options.aspect,
    resolution: options.resolution,
    extras: options.extraOptionValues,
    style: normalizeStyle(source.style),
    totalDurationSeconds,
    scenes: scaleStoryboardDurations(scenes, totalDurationSeconds),
  }
}

export function isStoryboardSceneApproved(scene: Pick<StoryboardScene, 'approvedCreationId'>): boolean {
  return Boolean(scene.approvedCreationId?.trim())
}

export function isStoryboardApprovalStale(
  scene: Pick<StoryboardScene, 'prompt' | 'approvedCreationId' | 'approvedPromptSnapshot'>,
): boolean {
  if (!isStoryboardSceneApproved(scene)) return false
  if (scene.approvedPromptSnapshot === null) return true
  return scene.prompt.trim() !== scene.approvedPromptSnapshot.trim()
}

export function storyboardSceneHasContent(
  scene: Pick<StoryboardScene, 'prompt' | 'candidates' | 'approvedCreationId' | 'approvedPromptSnapshot'>
    & Partial<Pick<StoryboardScene, 'title' | 'explanation'>>,
): boolean {
  return Boolean(
    scene.title?.trim()
    || scene.prompt.trim()
    || scene.explanation?.trim()
    || scene.candidates.length
    || scene.approvedCreationId
    || scene.approvedPromptSnapshot?.trim(),
  )
}

export function resizeStoryboardScenes(
  scenes: readonly StoryboardScene[],
  requestedCount: number,
  options: ResizeStoryboardScenesOptions = {},
): ResizeStoryboardScenesResult {
  const targetCount = clampStoryboardSceneCount(requestedCount, scenes.length || STORYBOARD_DEFAULT_SCENE_COUNT)

  if (targetCount === scenes.length) {
    return {
      scenes: [...scenes],
      targetCount,
      changed: false,
      blocked: false,
      wouldDiscardContent: false,
      affectedSceneIds: [],
    }
  }

  if (targetCount > scenes.length) {
    const next = [...scenes]
    const usedIds = new Set(next.map((scene) => scene.id))
    while (next.length < targetCount) {
      const scene = createStoryboardScene(makeSceneId(usedIds))
      usedIds.add(scene.id)
      next.push(scene)
    }
    return {
      scenes: next,
      targetCount,
      changed: true,
      blocked: false,
      wouldDiscardContent: false,
      affectedSceneIds: next.slice(scenes.length).map((scene) => scene.id),
    }
  }

  const trailing = scenes.slice(targetCount)
  const wouldDiscardContent = trailing.some(storyboardSceneHasContent)
  const affectedSceneIds = trailing.map((scene) => scene.id)
  if (wouldDiscardContent && !options.allowDiscard) {
    return {
      scenes: [...scenes],
      targetCount,
      changed: false,
      blocked: true,
      wouldDiscardContent,
      affectedSceneIds,
    }
  }

  return {
    scenes: scenes.slice(0, targetCount),
    targetCount,
    changed: true,
    blocked: false,
    wouldDiscardContent,
    affectedSceneIds,
  }
}

export function reorderStoryboardScenes(
  scenes: readonly StoryboardScene[],
  sceneId: string,
  requestedIndex: number,
): StoryboardScene[] {
  const sourceIndex = scenes.findIndex((scene) => scene.id === sceneId)
  if (sourceIndex < 0 || !Number.isFinite(requestedIndex) || scenes.length < 2) return [...scenes]

  const targetIndex = Math.min(scenes.length - 1, Math.max(0, Math.round(requestedIndex)))
  if (sourceIndex === targetIndex) return [...scenes]

  const next = [...scenes]
  const [scene] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, scene)
  return next
}

export function selectPendingStoryboardScenes(
  scenes: readonly StoryboardScene[],
  inFlightSceneIds: ReadonlySet<string> | readonly string[] = [],
): StoryboardScene[] {
  const inFlight = inFlightSceneIds instanceof Set
    ? inFlightSceneIds
    : new Set(inFlightSceneIds)
  return scenes.filter((scene) => (
    Boolean(scene.prompt.trim())
    && !isStoryboardSceneApproved(scene)
    && !inFlight.has(scene.id)
  ))
}

export function findStoryboardCandidate(
  scene: Pick<StoryboardScene, 'candidates'>,
  creationId: string | null | undefined,
): StoryboardSceneCandidate | undefined {
  return creationId ? scene.candidates.find((candidate) => candidate.creationId === creationId) : undefined
}
