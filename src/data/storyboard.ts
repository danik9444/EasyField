import { IMAGE_MODEL_CONFIG, resolveImageOptions } from './imageModelConfig.ts'
import { IMAGE_MODEL_ALIASES, IMAGE_MODELS } from './models.ts'
import { truncatePrompt } from './promptLimits.ts'

export const STORYBOARD_SCHEMA_VERSION = 9 as const
export const STORYBOARD_MIN_SCENES = 1
export const STORYBOARD_MAX_SCENES = 15
export const STORYBOARD_DEFAULT_SCENE_COUNT = 1
export const STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS = 5
export const STORYBOARD_MIN_TOTAL_DURATION_SECONDS = 5
export const STORYBOARD_MAX_TOTAL_DURATION_SECONDS = 90
export const STORYBOARD_MIN_SCENE_DURATION_SECONDS = 1
export const STORYBOARD_MAX_SCENE_DURATION_SECONDS = 5
export const STORYBOARD_SCENE_DURATION_STEP_SECONDS = 0.5
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
export const STORYBOARD_MAX_BOARD_CANDIDATES = 24
export const STORYBOARD_MIN_VERSIONS = 1
export const STORYBOARD_MAX_VERSIONS = 4
export const STORYBOARD_DEFAULT_VERSIONS = 1
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
  /**
   * Durable fingerprint of every input that shaped this frame (prompt,
   * references, continuity boards and generation settings). Older candidates
   * predate this field and remain readable until a caller supplies an expected
   * fingerprint for strict freshness checks.
   */
  inputFingerprint?: string
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  createdAt: number
}

export type StoryboardOutputStrategy = 'single-generation' | 'scene-composite'

/**
 * A durable complete-board result. Direct generations retain the one raw
 * generated contact-sheet Library ID used by their local metadata wrapper;
 * deterministic composites retain the exact ordered scene frame IDs.
 */
export interface StoryboardBoardCandidate {
  creationId: string
  /** Durable Job Center association for complete-board recovery. */
  jobId?: string
  strategy: StoryboardOutputStrategy
  promptSnapshot: string
  inputFingerprint: string
  sourceSceneCreationIds: string[]
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
  /** Library image IDs attached only to this row in Storyboard by scenes. */
  referenceCreationIds: string[]
  /** Number of alternatives requested when this scene is generated directly. */
  versionCount: number
  /** By-scenes timing can be inferred independently for every row. */
  durationMode: StoryboardSceneDurationMode
  durationSeconds: number
  candidates: StoryboardSceneCandidate[]
  approvedCreationId: string | null
  approvedPromptSnapshot: string | null
}

export type StoryboardWorkflowMode = 'full' | 'scenes'
export type StoryboardTimingMode = 'none' | 'auto' | 'manual'
export type StoryboardSceneDurationMode = 'auto' | 'manual'

export interface StoryboardDraft {
  schemaVersion: typeof STORYBOARD_SCHEMA_VERSION
  workflowMode: StoryboardWorkflowMode
  /**
   * The workflow-safe execution strategy. Complete-story drafts always run as
   * one generation; by-scenes drafts always compose their approved frames.
   * Candidate.strategy remains the durable provenance of existing results.
   */
  outputStrategy: StoryboardOutputStrategy
  /** Also generate standalone scene frames before creating a full storyboard. */
  includeSeparateSceneFrames: boolean
  timingMode: StoryboardTimingMode
  /** Optional adjacent board used only to continue into this board's opening. */
  previousStoryboardCreationId: string | null
  /** Optional adjacent board used only to lead out of this board's ending. */
  nextStoryboardCreationId: string | null
  referenceCreationIds: string[]
  title: string
  storyBrief: string
  storySummary: string
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  style: string
  /** Number of alternatives generated for every missing scene in a board run. */
  versionCount: number
  /** Complete-board results survive strategy switches and application restarts. */
  boardCandidates: StoryboardBoardCandidate[]
  approvedBoardCreationId: string | null
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

/** A provider-resolved duration for one authored scene. */
export interface StoryboardSceneDurationResolution {
  sceneId: string
  durationSeconds: number
}

export interface EffectiveStoryboardTiming extends StoryboardTimingMutation {
  timingMode: StoryboardTimingMode
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
  draft: Pick<StoryboardDraft, 'workflowMode' | 'timingMode' | 'previousStoryboardCreationId' | 'nextStoryboardCreationId' | 'referenceCreationIds' | 'title' | 'storyBrief' | 'storySummary' | 'model' | 'aspect' | 'resolution' | 'style' | 'totalDurationSeconds' | 'scenes'>,
  currentSceneId?: string,
): string {
  const completeStory = storyboardCompleteStory(draft)
  const modeLabel = draft.workflowMode === 'scenes' ? 'Storyboard by scenes' : 'Full storyboard'
  const effectiveTiming = effectiveStoryboardTiming(draft)
  const hasTiming = effectiveTiming.timingMode !== 'none'
  const totalDurationSeconds = effectiveTiming.totalDurationSeconds
  const commonContext = [
    `Storyboard mode: ${modeLabel}`,
    `Storyboard title: ${draft.title.trim() || '(not provided)'}`,
    `Complete story context: ${completeStory || (draft.workflowMode === 'full' ? '(not provided)' : '(not provided — preserve only facts present in the scene rows)')}`,
    hasTiming ? `Timing mode: ${effectiveTiming.timingMode === 'auto' ? 'Automatic pacing will be chosen only when the final storyboard is created' : 'Manual exact timing'}` : '',
    hasTiming && effectiveTiming.timingMode === 'manual' ? `Total story duration: ${totalDurationSeconds} seconds` : '',
    `Output model: ${draft.model}`,
    `Visual direction: ${draft.style.trim() || 'None selected'}`,
    `Frame format: ${draft.aspect}${draft.resolution ? ` · ${draft.resolution}` : ''}`,
    `Global visual references: ${draft.referenceCreationIds.length || 'none'}${draft.referenceCreationIds.length ? ` attached to ${draft.workflowMode === 'scenes' ? 'every scene and the complete board' : 'the complete board'}` : ''}`,
    draft.previousStoryboardCreationId
      ? 'Previous storyboard: attached as incoming continuity context only. Continue its established identity, world and visible end state into this storyboard; do not repeat its events or treat it as output to recreate.'
      : '',
    draft.nextStoryboardCreationId
      ? 'Next storyboard: attached as outgoing continuity context only. Guide this storyboard toward its established opening state without depicting its future events early or treating it as output to recreate.'
      : '',
  ].filter((line) => line !== '')

  // In Full Storyboard the Story Brief is the single authoritative plan.
  // Persisted rows may belong to an earlier By-Scenes session and must never
  // leak into prompt improvement while Full is selected.
  if (draft.workflowMode === 'full') return commonContext.join('\n\n')

  const timings = hasTiming ? storyboardSceneTimings(effectiveTiming.scenes) : []
  const sceneRows = draft.scenes.map((scene, index) => {
    const current = scene.id === currentSceneId ? ' · CURRENT SCENE' : ''
    const timing = timings[index]
    return [
      `SCENE ${String(index + 1).padStart(2, '0')}${current}`,
      scene.durationMode === 'auto'
        ? 'Timing: Auto — decide from the complete story only when creating the final storyboard'
        : timing ? `Timing: ${timing.startSeconds}s–${timing.endSeconds}s · ${timing.durationSeconds}s` : '',
      `Title: ${scene.title.trim() || '(not provided)'}`,
      `Prompt: ${scene.prompt.trim() || '(not provided)'}`,
      `Story note / explanation: ${scene.explanation.trim() || '(not provided)'}`,
      `Visual references: ${scene.referenceCreationIds.length || 'none'}${scene.referenceCreationIds.length ? ' attached to this scene' : ''}`,
    ].filter(Boolean).join('\n')
  })

  return [
    ...commonContext,
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

export function clampStoryboardSceneDuration(
  value: unknown,
  fallback = STORYBOARD_MIN_SCENE_DURATION_SECONDS,
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  const parsedFallback = typeof fallback === 'number' ? fallback : Number(fallback)
  const safeFallback = Number.isFinite(parsedFallback)
    ? Math.round(parsedFallback / STORYBOARD_SCENE_DURATION_STEP_SECONDS) * STORYBOARD_SCENE_DURATION_STEP_SECONDS
    : STORYBOARD_MIN_SCENE_DURATION_SECONDS
  if (!Number.isFinite(parsed)) {
    return Math.min(
      STORYBOARD_MAX_SCENE_DURATION_SECONDS,
      Math.max(STORYBOARD_MIN_SCENE_DURATION_SECONDS, safeFallback),
    )
  }
  const quantized = Math.round(parsed / STORYBOARD_SCENE_DURATION_STEP_SECONDS)
    * STORYBOARD_SCENE_DURATION_STEP_SECONDS
  return Math.min(
    STORYBOARD_MAX_SCENE_DURATION_SECONDS,
    Math.max(STORYBOARD_MIN_SCENE_DURATION_SECONDS, quantized),
  )
}

export function isStoryboardSceneDuration(value: unknown): boolean {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= STORYBOARD_MIN_SCENE_DURATION_SECONDS
    && value <= STORYBOARD_MAX_SCENE_DURATION_SECONDS
    && Number.isInteger(value / STORYBOARD_SCENE_DURATION_STEP_SECONDS)
}

function normalizeSceneDurationMode(
  value: unknown,
  fallback: StoryboardSceneDurationMode,
): StoryboardSceneDurationMode {
  return value === 'auto' || value === 'manual' ? value : fallback
}

function normalizeWorkflowMode(value: unknown): StoryboardWorkflowMode {
  return value === 'scenes' ? 'scenes' : 'full'
}

function storyboardExecutionStrategy(workflowMode: StoryboardWorkflowMode): StoryboardOutputStrategy {
  return workflowMode === 'full' ? 'single-generation' : 'scene-composite'
}

function normalizeIncludeSeparateSceneFrames(
  source: Record<string, unknown>,
  persistedSchemaVersion: number,
  workflowMode: StoryboardWorkflowMode,
): boolean {
  if (workflowMode !== 'full' || !Number.isFinite(persistedSchemaVersion)) return false
  if (persistedSchemaVersion === 7) return source.outputStrategy === 'scene-composite'
  if (persistedSchemaVersion >= 8 && persistedSchemaVersion <= STORYBOARD_SCHEMA_VERSION) {
    return source.includeSeparateSceneFrames === true
  }
  return false
}

export function normalizeStoryboardOutputStrategy(value: unknown): StoryboardOutputStrategy {
  return value === 'single-generation' ? 'single-generation' : 'scene-composite'
}

function isStoryboardOutputStrategy(value: unknown): value is StoryboardOutputStrategy {
  return value === 'single-generation' || value === 'scene-composite'
}

function normalizeTimingMode(value: unknown, schemaVersion: unknown): StoryboardTimingMode {
  if (value === 'none' || value === 'auto' || value === 'manual') return value
  return schemaVersion === 3 ? 'manual' : 'none'
}

function normalizeReferenceCreationIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || maximum <= 0) return []
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

export function clampStoryboardVersionCount(value: unknown, fallback = STORYBOARD_DEFAULT_VERSIONS): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  const normalizedFallback = Number.isFinite(fallback) ? Math.round(fallback) : STORYBOARD_DEFAULT_VERSIONS
  const safeFallback = Math.min(STORYBOARD_MAX_VERSIONS, Math.max(STORYBOARD_MIN_VERSIONS, normalizedFallback))
  if (!Number.isFinite(parsed)) return safeFallback
  return Math.min(STORYBOARD_MAX_VERSIONS, Math.max(STORYBOARD_MIN_VERSIONS, Math.round(parsed)))
}

function normalizeCandidate(value: unknown): StoryboardSceneCandidate | null {
  const source = safeRecord(value)
  const creationId = safeText(source.creationId, 240, true)
  if (!creationId) return null
  const inputFingerprint = safeText(source.inputFingerprint, 512, true)

  const model = normalizeModel(source.model)
  const options = resolveImageOptions(model, {
    aspect: safeText(source.aspect, 32, true),
    resolution: safeText(source.resolution, 32, true),
    extraOptionValues: safeRecord(source.extras) as Record<string, string>,
  })

  return {
    creationId,
    promptSnapshot: safeText(source.promptSnapshot, STORYBOARD_MAX_PROMPT_LENGTH),
    ...(inputFingerprint ? { inputFingerprint } : {}),
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

  return normalized
}

function normalizeBoardCandidate(value: unknown): StoryboardBoardCandidate | null {
  const source = safeRecord(value)
  const creationId = safeText(source.creationId, 240, true)
  const jobId = safeText(source.jobId, 240, true)
  const inputFingerprint = safeText(source.inputFingerprint, 512, true)
  if (!creationId || !inputFingerprint || !isStoryboardOutputStrategy(source.strategy)) return null

  const model = normalizeModel(source.model)
  const options = resolveImageOptions(model, {
    aspect: safeText(source.aspect, 32, true),
    resolution: safeText(source.resolution, 32, true),
    extraOptionValues: safeRecord(source.extras) as Record<string, string>,
  })

  return {
    creationId,
    ...(jobId ? { jobId } : {}),
    strategy: source.strategy,
    promptSnapshot: safeText(source.promptSnapshot, STORYBOARD_MAX_PROMPT_LENGTH),
    inputFingerprint,
    sourceSceneCreationIds: normalizeReferenceCreationIds(
      source.sourceSceneCreationIds,
      source.strategy === 'scene-composite' ? STORYBOARD_MAX_SCENES : 1,
    ),
    model,
    aspect: options.aspect,
    resolution: options.resolution,
    extras: options.extraOptionValues,
    createdAt: normalizeTimestamp(source.createdAt),
  }
}

function normalizeBoardCandidates(
  value: unknown,
  approvedBoardCreationId: string | null,
): StoryboardBoardCandidate[] {
  if (!Array.isArray(value)) return []
  const candidates = value.flatMap((entry) => {
    const candidate = normalizeBoardCandidate(entry)
    return candidate ? [candidate] : []
  })
  return appendStoryboardBoardCandidates({ boardCandidates: [], approvedBoardCreationId }, candidates)
}

function normalizeScene(
  value: unknown,
  usedIds: Set<string>,
  referenceLimit: number,
  legacyReferenceCreationIds: readonly string[] = [],
  durationModeFallback: StoryboardSceneDurationMode = 'auto',
): StoryboardScene {
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
    referenceCreationIds: normalizeReferenceCreationIds(
      Array.isArray(source.referenceCreationIds) ? source.referenceCreationIds : legacyReferenceCreationIds,
      referenceLimit,
    ),
    versionCount: clampStoryboardVersionCount(source.versionCount),
    durationMode: normalizeSceneDurationMode(source.durationMode, durationModeFallback),
    durationSeconds: clampStoryboardSceneDuration(source.durationSeconds),
    candidates: appendStoryboardCandidates({
      candidates: normalizeCandidates(source.candidates),
      approvedCreationId,
    }, []),
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

/**
 * Full Storyboard is one story-level generation, so its runtime is not
 * constrained by the number of hidden/persisted scene rows. By-scenes timing
 * continues to use `clampStoryboardTotalDuration` below.
 */
export function clampFullStoryboardDuration(
  value: unknown,
  fallback = STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS,
): number {
  const normalizedFallback = Number.isFinite(fallback)
    ? Math.round(fallback)
    : STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS
  const safeFallback = Math.min(
    STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
    Math.max(STORYBOARD_MIN_TOTAL_DURATION_SECONDS, normalizedFallback),
  )
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return safeFallback
  return Math.min(
    STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
    Math.max(STORYBOARD_MIN_TOTAL_DURATION_SECONDS, Math.round(parsed)),
  )
}

export function clampStoryboardTotalDuration(
  value: unknown,
  sceneCount = STORYBOARD_DEFAULT_SCENE_COUNT,
  fallback = STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS,
): number {
  const safeSceneCount = clampStoryboardSceneCount(sceneCount)
  const maximum = Math.min(
    STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
    safeSceneCount * STORYBOARD_MAX_SCENE_DURATION_SECONDS,
  )
  const minimum = Math.min(
    maximum,
    Math.max(STORYBOARD_MIN_TOTAL_DURATION_SECONDS, safeSceneCount * STORYBOARD_MIN_SCENE_DURATION_SECONDS),
  )
  const safeFallback = Math.min(maximum, Math.max(minimum, Math.round(fallback)))
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return safeFallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

function allocateStoryboardSeconds(totalDurationSeconds: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return []
  const minimum = weights.length * STORYBOARD_MIN_SCENE_DURATION_SECONDS
  const maximum = weights.length * STORYBOARD_MAX_SCENE_DURATION_SECONDS
  const total = Math.min(maximum, Math.max(minimum, Math.round(totalDurationSeconds)))
  const safeWeights = weights.map((weight) => Number.isFinite(weight) && weight > 0 ? weight : 1)
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0)
  const exact = safeWeights.map((weight) => total * weight / weightTotal)
  const allocated = weights.map(() => STORYBOARD_MIN_SCENE_DURATION_SECONDS)
  let remainder = total - minimum
  while (remainder > 0) {
    const recipient = allocated
      .map((value, index) => ({ index, value, need: exact[index] - value }))
      .filter((item) => item.value < STORYBOARD_MAX_SCENE_DURATION_SECONDS)
      .sort((left, right) => right.need - left.need || left.index - right.index)[0]
    if (!recipient) break
    allocated[recipient.index] += 1
    remainder -= 1
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
  const durations = allocateStoryboardSeconds(total, scenes.map((scene) => clampStoryboardSceneDuration(scene.durationSeconds)))
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

  const minimum = Math.max(
    STORYBOARD_MIN_SCENE_DURATION_SECONDS,
    total - (normalized.length - 1) * STORYBOARD_MAX_SCENE_DURATION_SECONDS,
  )
  const maximum = Math.min(
    STORYBOARD_MAX_SCENE_DURATION_SECONDS,
    total - (normalized.length - 1) * STORYBOARD_MIN_SCENE_DURATION_SECONDS,
  )
  const requested = Math.min(maximum, Math.max(minimum, Math.round(requestedDurationSeconds)))
  const otherScenes = normalized.filter((_, index) => index !== targetIndex)
  const otherDurations = allocateStoryboardSeconds(
    total - requested,
    otherScenes.map((scene) => scene.durationSeconds),
  )
  let otherIndex = 0
  return normalized.map((scene, index) => index === targetIndex
    ? { ...scene, durationSeconds: requested }
    : { ...scene, durationSeconds: otherDurations[otherIndex++] })
}

export function appendStoryboardSceneWithTiming(
  scenes: readonly StoryboardScene[],
  totalDurationSeconds: number,
  scene = createStoryboardScene(),
): StoryboardTimingMutation {
  const next = [...scenes, scene]
  const nextTotal = clampStoryboardTotalDuration(totalDurationSeconds, next.length)
  return { totalDurationSeconds: nextTotal, scenes: scaleStoryboardDurations(next, nextTotal) }
}

export function removeStoryboardSceneWithTiming(
  scenes: readonly StoryboardScene[],
  sceneId: string,
  totalDurationSeconds: number,
): StoryboardTimingMutation {
  const normalized = scaleStoryboardDurations(scenes, totalDurationSeconds)
  const removedIndex = normalized.findIndex((scene) => scene.id === sceneId)
  if (removedIndex < 0 || normalized.length <= 1) {
    return {
      totalDurationSeconds: clampStoryboardTotalDuration(totalDurationSeconds, normalized.length || 1),
      scenes: normalized,
    }
  }
  const next = normalized.filter((scene) => scene.id !== sceneId)
  const total = clampStoryboardTotalDuration(totalDurationSeconds, next.length)
  return { totalDurationSeconds: total, scenes: scaleStoryboardDurations(next, total) }
}

export function storyboardSceneTimings(scenes: readonly StoryboardScene[]): StoryboardSceneTiming[] {
  let cursor = 0
  return scenes.map((scene) => {
    const durationSeconds = clampStoryboardSceneDuration(scene.durationSeconds)
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
    return Math.min(
      STORYBOARD_MAX_SCENE_DURATION_SECONDS,
      STORYBOARD_MIN_SCENE_DURATION_SECONDS + Math.ceil(sceneWords / 12),
    )
  })
  const contextSeconds = Math.min(scenes.length, Math.ceil(storyboardWordCount(completeStory) / 30))
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

/**
 * Resolves only the rows left on Auto in Storyboard by scenes. Explicit scene
 * durations remain authoritative while automatic rows are paced from the
 * complete story plus the content of every ordered scene.
 */
export function resolveStoryboardSceneDurations(
  scenes: readonly StoryboardScene[],
  completeStory = '',
): StoryboardTimingMutation {
  if (scenes.length === 0) {
    return { totalDurationSeconds: STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS, scenes: [] }
  }
  const automatic = autoStoryboardTiming(scenes, completeStory).scenes
  const resolved = scenes.map((scene, index) => ({
    ...scene,
    durationSeconds: scene.durationMode === 'auto'
      ? clampStoryboardSceneDuration(automatic[index]?.durationSeconds)
      : clampStoryboardSceneDuration(scene.durationSeconds),
  }))
  const totalDurationSeconds = resolved.reduce((sum, scene) => sum + scene.durationSeconds, 0)
  return {
    // By-scenes timing is the exact sum of its independent 1–5 second rows.
    // Unlike Full Storyboard it intentionally has no five-second global floor.
    totalDurationSeconds,
    scenes: resolved,
  }
}

/**
 * Applies a generation-time timing response without ever changing an explicit
 * Manual row. The resolver is intentionally strict: an Auto row without a
 * valid provider result is an error instead of silently falling back to a
 * locally invented duration.
 */
export function applyStoryboardSceneDurationResolution(
  scenes: readonly StoryboardScene[],
  resolutions: readonly StoryboardSceneDurationResolution[],
): StoryboardTimingMutation {
  const resolvedById = new Map<string, number>()
  resolutions.forEach((resolution) => {
    if (resolvedById.has(resolution.sceneId)) {
      throw new Error(`Duplicate storyboard timing for scene ${resolution.sceneId}`)
    }
    if (
      !isStoryboardSceneDuration(resolution.durationSeconds)
    ) {
      throw new Error(`Invalid storyboard timing for scene ${resolution.sceneId}`)
    }
    resolvedById.set(resolution.sceneId, resolution.durationSeconds)
  })

  const resolvedScenes = scenes.map((scene) => {
    if (scene.durationMode === 'manual') return { ...scene }
    const durationSeconds = resolvedById.get(scene.id)
    if (durationSeconds === undefined) {
      throw new Error(`Missing storyboard timing for scene ${scene.id}`)
    }
    return { ...scene, durationSeconds }
  })

  return {
    totalDurationSeconds: resolvedScenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    scenes: resolvedScenes,
  }
}

/**
 * Returns the timing snapshot consumers must use without mutating the hidden
 * Full Storyboard timing preference while the user works in By Scenes.
 */
export function effectiveStoryboardTiming(
  draft: Pick<StoryboardDraft, 'workflowMode' | 'timingMode' | 'totalDurationSeconds' | 'storyBrief' | 'storySummary' | 'scenes'>,
): EffectiveStoryboardTiming {
  if (draft.workflowMode === 'scenes') {
    const scenes = draft.scenes.map((scene) => ({
      ...scene,
      durationSeconds: clampStoryboardSceneDuration(scene.durationSeconds),
    }))
    return {
      timingMode: scenes.some((scene) => scene.durationMode === 'auto') ? 'auto' : 'manual',
      totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
      scenes,
    }
  }
  // Full Storyboard owns one story-level duration. Its hidden legacy scene
  // rows are deliberately neither rescaled nor consulted for automatic pace.
  const totalDurationSeconds = clampFullStoryboardDuration(draft.totalDurationSeconds)
  return {
    timingMode: draft.timingMode,
    totalDurationSeconds,
    scenes: draft.scenes,
  }
}

export function formatStoryboardTimecode(value: number): string {
  const seconds = Math.max(
    0,
    Math.round((Number.isFinite(value) ? value : 0) / STORYBOARD_SCENE_DURATION_STEP_SECONDS)
      * STORYBOARD_SCENE_DURATION_STEP_SECONDS,
  )
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const wholeRemainder = Math.floor(seconds % 60)
  const remainder = `${String(wholeRemainder).padStart(2, '0')}${seconds % 1 ? '.5' : ''}`
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${String(minutes).padStart(2, '0')}:${remainder}`
}

export function formatStoryboardDuration(value: number): string {
  const seconds = Math.max(
    0,
    Math.round((Number.isFinite(value) ? value : 0) / STORYBOARD_SCENE_DURATION_STEP_SECONDS)
      * STORYBOARD_SCENE_DURATION_STEP_SECONDS,
  )
  const formatSeconds = (amount: number) => Number.isInteger(amount) ? String(amount) : amount.toFixed(1)
  if (seconds < 60) return `${formatSeconds(seconds)}s`
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ''}${remainder ? ` ${formatSeconds(remainder)}s` : ''}`
  return `${minutes}m${remainder ? ` ${formatSeconds(remainder)}s` : ''}`
}

export function createStoryboardScene(id?: string): StoryboardScene {
  const safeId = safeText(id, 160, true)
  return {
    id: safeId || makeSceneId(),
    title: '',
    prompt: '',
    explanation: '',
    referenceCreationIds: [],
    versionCount: STORYBOARD_DEFAULT_VERSIONS,
    durationMode: 'auto',
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
    outputStrategy: 'single-generation',
    includeSeparateSceneFrames: false,
    timingMode: 'none',
    previousStoryboardCreationId: null,
    nextStoryboardCreationId: null,
    referenceCreationIds: [],
    title: '',
    storyBrief: '',
    storySummary: '',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    style: '',
    versionCount: STORYBOARD_DEFAULT_VERSIONS,
    boardCandidates: [],
    approvedBoardCreationId: null,
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

  const workflowMode = normalizeWorkflowMode(source.workflowMode)
  const timingMode = normalizeTimingMode(source.timingMode, source.schemaVersion)
  const referenceLimit = IMAGE_MODEL_CONFIG[model].maxReferenceImages
  const normalizedGlobalReferences = normalizeReferenceCreationIds(source.referenceCreationIds, referenceLimit)
  const persistedSchemaVersion = Number(source.schemaVersion)
  const sourceScenes = Array.isArray(source.scenes) && source.scenes.length > 0
    ? source.scenes.slice(0, STORYBOARD_MAX_SCENES)
    : Array.from({ length: STORYBOARD_DEFAULT_SCENE_COUNT }, () => ({}))
  const usedIds = new Set<string>()
  const scenes = sourceScenes.map((scene) => normalizeScene(
    scene,
    usedIds,
    referenceLimit,
    [],
    workflowMode === 'scenes' && timingMode === 'manual' ? 'manual' : 'auto',
  ))
  const globalReferenceIds = new Set(normalizedGlobalReferences)
  const referenceSafeScenes = workflowMode === 'scenes' && globalReferenceIds.size
    ? scenes.map((scene) => ({
      ...scene,
      referenceCreationIds: scene.referenceCreationIds.filter((creationId) => !globalReferenceIds.has(creationId)),
    }))
    : scenes
  const requestedTotalDurationSeconds = workflowMode === 'full'
    ? clampFullStoryboardDuration(source.totalDurationSeconds)
    : clampStoryboardTotalDuration(source.totalDurationSeconds, scenes.length)
  const storyBrief = safeText(source.storyBrief, STORYBOARD_MAX_STORY_BRIEF_LENGTH)
  const storySummary = safeText(source.storySummary, STORYBOARD_MAX_STORY_SUMMARY_LENGTH)
  const normalizedScenes = workflowMode === 'scenes'
    ? {
      totalDurationSeconds: scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
      // Auto rows deliberately keep their last persisted value. The value is
      // not displayed as a prediction and is replaced only by the strict
      // generation-time pacing response.
      scenes: referenceSafeScenes,
    }
    : {
      totalDurationSeconds: requestedTotalDurationSeconds,
      // Full Storyboard is generated from the Story Brief as one plan. Keep
      // legacy rows intact for safe workflow switching, but never make the
      // Full duration depend on or redistribute through them.
      scenes: referenceSafeScenes,
    }
  const requestedApprovedBoardCreationId = safeText(source.approvedBoardCreationId, 240, true) || null
  const boardCandidates = normalizeBoardCandidates(source.boardCandidates, requestedApprovedBoardCreationId)
  const approvedBoardCreationId = requestedApprovedBoardCreationId
    && boardCandidates.some((candidate) => candidate.creationId === requestedApprovedBoardCreationId)
    ? requestedApprovedBoardCreationId
    : null

  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    workflowMode,
    outputStrategy: storyboardExecutionStrategy(workflowMode),
    includeSeparateSceneFrames: normalizeIncludeSeparateSceneFrames(
      source,
      persistedSchemaVersion,
      workflowMode,
    ),
    timingMode,
    previousStoryboardCreationId: safeText(source.previousStoryboardCreationId, 240, true) || null,
    nextStoryboardCreationId: safeText(source.nextStoryboardCreationId, 240, true) || null,
    referenceCreationIds: normalizedGlobalReferences,
    title: safeText(source.title, STORYBOARD_MAX_TITLE_LENGTH),
    storyBrief,
    storySummary,
    model,
    aspect: options.aspect,
    resolution: options.resolution,
    extras: options.extraOptionValues,
    style: normalizeStyle(source.style),
    versionCount: clampStoryboardVersionCount(source.versionCount),
    boardCandidates,
    approvedBoardCreationId,
    totalDurationSeconds: requestedTotalDurationSeconds,
    scenes: normalizedScenes.scenes,
  }
}

export function isStoryboardSceneApproved(scene: Pick<StoryboardScene, 'approvedCreationId'>): boolean {
  return Boolean(scene.approvedCreationId?.trim())
}

/**
 * Counts durable scene alternatives that are still backed by an available
 * Library image. The approved image is included even for older drafts where
 * it was not copied into the candidates array.
 */
export function countAvailableStoryboardSceneVersions(
  scene: Pick<StoryboardScene, 'candidates' | 'approvedCreationId'>,
  availableCreationIds: Iterable<string>,
): number {
  const available = new Set(availableCreationIds)
  const versionIds = new Set<string>()
  for (const candidate of scene.candidates) {
    const creationId = candidate.creationId.trim()
    if (creationId && available.has(creationId)) versionIds.add(creationId)
  }
  const approvedCreationId = scene.approvedCreationId?.trim()
  if (approvedCreationId && available.has(approvedCreationId)) {
    versionIds.add(approvedCreationId)
  }
  return versionIds.size
}

/** Returns how many more standalone images are needed to reach the request. */
export function storyboardSceneVersionDeficit(
  scene: Pick<StoryboardScene, 'candidates' | 'approvedCreationId'>,
  requestedVersions: unknown,
  availableCreationIds: Iterable<string>,
): number {
  return Math.max(
    0,
    clampStoryboardVersionCount(requestedVersions)
      - countAvailableStoryboardSceneVersions(scene, availableCreationIds),
  )
}

export function isStoryboardApprovalStale(
  scene: Pick<StoryboardScene, 'prompt' | 'approvedCreationId' | 'approvedPromptSnapshot'>
    & Partial<Pick<StoryboardScene, 'candidates'>>,
  expectedInputFingerprint?: string,
): boolean {
  if (!isStoryboardSceneApproved(scene)) return false
  if (scene.approvedPromptSnapshot === null) return true
  if (scene.prompt.trim() !== scene.approvedPromptSnapshot.trim()) return true
  if (expectedInputFingerprint === undefined) return false

  const approvedCreationId = scene.approvedCreationId?.trim()
  const approvedCandidate = scene.candidates?.find((candidate) => (
    candidate.creationId.trim() === approvedCreationId
  ))
  return approvedCandidate?.inputFingerprint !== expectedInputFingerprint
}

export function storyboardSceneHasContent(
  scene: Pick<StoryboardScene, 'prompt' | 'referenceCreationIds' | 'candidates' | 'approvedCreationId' | 'approvedPromptSnapshot'>
    & Partial<Pick<StoryboardScene, 'title' | 'explanation'>>,
): boolean {
  return Boolean(
    scene.title?.trim()
    || scene.prompt.trim()
    || scene.explanation?.trim()
    || scene.referenceCreationIds.length
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

export type StoryboardSceneCompletionAction =
  | 'preserve'
  | 'use-reference'
  | 'generate'
  | 'missing'
  | 'ambiguous-references'

/**
 * Resolves a scene without mutating it. Approved output always wins; a single
 * reference with no prompt is reused exactly; only prompted scenes are sent
 * to image generation. Supplying an expected input fingerprint opts into a
 * strict freshness check, so an approval made from older scene/reference/
 * continuity inputs is no longer preserved.
 */
export function storyboardSceneCompletionAction(
  scene: Pick<StoryboardScene, 'prompt' | 'referenceCreationIds' | 'approvedCreationId'>
    & Partial<Pick<StoryboardScene, 'candidates' | 'approvedPromptSnapshot'>>,
  allowExactReferenceReuse = true,
  expectedInputFingerprint?: string,
): StoryboardSceneCompletionAction {
  if (
    isStoryboardSceneApproved(scene)
    && (
      expectedInputFingerprint === undefined
      || !isStoryboardApprovalStale({
        ...scene,
        approvedPromptSnapshot: scene.approvedPromptSnapshot ?? null,
      }, expectedInputFingerprint)
    )
  ) return 'preserve'
  if (scene.prompt.trim()) return 'generate'
  if (allowExactReferenceReuse && scene.referenceCreationIds.length === 1) return 'use-reference'
  if (allowExactReferenceReuse && scene.referenceCreationIds.length > 1) return 'ambiguous-references'
  return 'missing'
}

/** Returns every requested Library reference that is not currently available. */
export function findMissingStoryboardReferenceIds(
  referenceCreationIds: readonly string[],
  availableCreationIds: Iterable<string>,
): string[] {
  const available = new Set(availableCreationIds)
  return referenceCreationIds.filter((creationId) => !available.has(creationId))
}

export function findStoryboardCandidate(
  scene: Pick<StoryboardScene, 'candidates'>,
  creationId: string | null | undefined,
): StoryboardSceneCandidate | undefined {
  return creationId ? scene.candidates.find((candidate) => candidate.creationId === creationId) : undefined
}

/**
 * Appends a generated batch without ever evicting the frame currently used by
 * the storyboard. Newer alternatives win duplicate IDs and the remaining
 * history is capped to the durable per-scene limit.
 */
export function appendStoryboardCandidates(
  scene: Pick<StoryboardScene, 'candidates' | 'approvedCreationId'>,
  incoming: readonly StoryboardSceneCandidate[],
): StoryboardSceneCandidate[] {
  const orderedIds: string[] = []
  const byId = new Map<string, StoryboardSceneCandidate>()

  for (const candidate of [...scene.candidates, ...incoming]) {
    const id = candidate.creationId.trim()
    if (!id) continue
    if (!byId.has(id)) orderedIds.push(id)
    byId.set(id, candidate)
  }

  if (orderedIds.length <= STORYBOARD_MAX_CANDIDATES_PER_SCENE) {
    return orderedIds.flatMap((id) => byId.get(id) ?? [])
  }

  const approvedId = scene.approvedCreationId && byId.has(scene.approvedCreationId)
    ? scene.approvedCreationId
    : null
  const remainingCapacity = STORYBOARD_MAX_CANDIDATES_PER_SCENE - (approvedId ? 1 : 0)
  const newestIds = orderedIds
    .filter((id) => id !== approvedId)
    .slice(-remainingCapacity)
  const keep = new Set(approvedId ? [approvedId, ...newestIds] : newestIds)
  return orderedIds.flatMap((id) => keep.has(id) ? byId.get(id) ?? [] : [])
}

/**
 * Merges complete-board alternatives by stable Library ID. Later metadata wins
 * for duplicates, history remains bounded, and an approved result is never
 * evicted by newer versions.
 */
export function appendStoryboardBoardCandidates(
  board: Pick<StoryboardDraft, 'boardCandidates' | 'approvedBoardCreationId'>,
  incoming: readonly StoryboardBoardCandidate[],
): StoryboardBoardCandidate[] {
  const orderedIds: string[] = []
  const byId = new Map<string, StoryboardBoardCandidate>()

  for (const candidate of [...board.boardCandidates, ...incoming]) {
    const id = candidate.creationId.trim()
    if (!id) continue
    if (!byId.has(id)) orderedIds.push(id)
    byId.set(id, candidate)
  }

  if (orderedIds.length <= STORYBOARD_MAX_BOARD_CANDIDATES) {
    return orderedIds.flatMap((id) => byId.get(id) ?? [])
  }

  const approvedId = board.approvedBoardCreationId && byId.has(board.approvedBoardCreationId)
    ? board.approvedBoardCreationId
    : null
  const remainingCapacity = STORYBOARD_MAX_BOARD_CANDIDATES - (approvedId ? 1 : 0)
  const newestIds = orderedIds
    .filter((id) => id !== approvedId)
    .slice(-remainingCapacity)
  const keep = new Set(approvedId ? [approvedId, ...newestIds] : newestIds)
  return orderedIds.flatMap((id) => keep.has(id) ? byId.get(id) ?? [] : [])
}
