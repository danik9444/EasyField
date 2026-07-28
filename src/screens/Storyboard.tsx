import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { Lightbox } from '../components/Lightbox'
import {
  StoryboardFinalStrip,
  type StoryboardFinalSceneView,
} from '../components/StoryboardFinalStrip'
import {
  StoryboardSceneCard,
  StoryboardVersionPicker,
  type StoryboardCandidateView,
  type StoryboardSceneRunState,
} from '../components/StoryboardSceneCard'
import { StoryboardReferencePicker } from '../components/StoryboardSceneReferencePicker'
import {
  StoryboardContinuityAdvanced,
  type StoryboardContinuityAsset,
  type StoryboardContinuityRole,
} from '../components/StoryboardContinuityAdvanced'
import { StoryboardTimingEditor } from '../components/StoryboardTimingEditor'
import { StoryboardBoardResults, type StoryboardBoardCandidateView } from '../components/StoryboardBoardResults'
import { Icon } from '../icons'
import { host } from '../services/host'
import {
  ChatError,
  canEnhancePrompt,
  enhancePrompt,
  resolveStoryboardAutoTiming,
  type EnhanceReference,
} from '../services/chat'
import { resolve } from '../services/resolve'
import { renderStoryboardPng } from '../services/storyboardExport'
import { isConnected, isGenerationExit, runImage, saveUrl } from '../services/run'
import { canBackgroundJob, canCancelJob, cancelJob, continueJobInBackground, getJobs, prepareJobLedger, startJob, useJobs } from '../services/jobCenter'
import { addCreations, addCreationsDurably, getCreations, useCreations, usePersistenceState, type Creation } from '../data/creations'
import { IMAGE_MODEL_CONFIG, resolveImageOptions } from '../data/imageModelConfig'
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, IMAGE_MODELS } from '../data/models'
import { AGENT_MODEL_META, IMAGE_MODEL_META } from '../data/modelPresentation'
import { formatEstimate, imageRunEstimate, resolveCharged, type Estimate } from '../data/pricing'
import { loadValue, saveValue } from '../data/prefs'
import { isDecodableReferenceImageFile, type ReferenceImage } from '../data/referenceImage'
import { promptCharacterCount } from '../data/promptLimits'
import {
  STORYBOARD_MAX_PROMPT_LENGTH,
  STORYBOARD_MAX_SCENE_DURATION_SECONDS,
  STORYBOARD_MAX_SCENES,
  STORYBOARD_MAX_STORY_BRIEF_LENGTH,
  STORYBOARD_MAX_STORY_SUMMARY_LENGTH,
  STORYBOARD_MAX_TITLE_LENGTH,
  STORYBOARD_MIN_SCENE_DURATION_SECONDS,
  STORYBOARD_MIN_SCENES,
  STORYBOARD_SCENE_DURATION_STEP_SECONDS,
  STORYBOARD_STYLE_OPTIONS,
  applyStoryboardSceneDurationResolution,
  appendStoryboardBoardCandidates,
  appendStoryboardCandidates,
  appendStoryboardSceneWithTiming,
  buildStoryboardEnhancementContext,
  clampFullStoryboardDuration,
  clampStoryboardSceneDuration,
  clampStoryboardTotalDuration,
  clampStoryboardVersionCount,
  createDefaultStoryboardDraft,
  createStoryboardScene,
  effectiveStoryboardTiming,
  findMissingStoryboardReferenceIds,
  findStoryboardCandidate,
  isStoryboardApprovalStale,
  isStoryboardSceneApproved,
  normalizeStoryboardDraft,
  removeStoryboardSceneWithTiming,
  reorderStoryboardScenes,
  scaleStoryboardDurations,
  storyboardCompleteStory,
  storyboardSceneCompletionAction,
  storyboardSceneVersionDeficit,
  storyboardSceneTimings,
  storyboardSceneHasContent,
  type StoryboardDraft,
  type StoryboardBoardCandidate,
  type StoryboardOutputStrategy,
  type StoryboardScene,
  type StoryboardSceneCandidate,
  type StoryboardSceneDurationMode,
  type StoryboardTimingMode,
} from '../data/storyboard'
import {
  collectStoryboardBoardReferences,
  compileGeneratedStoryboardBoard,
  compileStoryboardSceneReferenceManifest,
  findStoryboardContinuityReferenceConflict,
} from '../data/storyboardBoard'
import {
  createStoryboardBoardJobMetadata,
  parseStoryboardBoardJobMetadata,
} from '../data/storyboardJobRecovery'

const STORYBOARD_DRAFT_KEY = 'default:storyboard-v1'
const ENHANCER_PREF_KEY = 'enhancer-storyboard'
const ENHANCE_MAX_LENGTH = 6_000
const SCENE_PROMPT_MIN_LENGTH = 3
const STORYBOARD_CONTEXT_INSTRUCTION = 'Use the complete story and every ordered scene row only to prevent contradictions and preserve explicitly established continuity. Treat attached references as authoritative visual evidence. When the current field is blank, reference-led Auto may draft only that field for its selected Storyboard purpose. A previous storyboard is incoming context and a next storyboard is outgoing context only: never copy either board into the current output, repeat its events or reveal future events early. Never copy an action or fill a missing detail from another scene unless the current primary text explicitly refers to it.'

type SaveState = 'loading' | 'saved' | 'saving' | 'error'
type BriefRunState = 'idle' | 'enhancing' | 'planning' | 'error'

interface SceneRuntime {
  state: StoryboardSceneRunState
  error?: string
  note?: string
  jobId?: string
  requestedVersions?: number
  generation?: {
    promptSnapshot: string
    inputFingerprint: string
    model: string
    aspect: string
    resolution: string
    extras: Record<string, string>
    attachedCreationIds: string[]
  }
}

interface BriefRuntime {
  state: BriefRunState
  error?: string
  note?: string
}

type BoardRunState = 'idle' | 'generating' | 'pending' | 'error'

interface BoardRuntime {
  state: BoardRunState
  error?: string
  note?: string
  jobId?: string
  requestedVersions?: number
  generation?: {
    promptSnapshot: string
    inputFingerprint: string
    model: string
    aspect: string
    resolution: string
    extras: Record<string, string>
    attachedCreationIds: string[]
  }
}

type StoryboardReferenceImage = ReferenceImage & { creationId?: string }

interface GenerationSnapshot {
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  style: string
  references: ReferenceImage[]
  referenceCreationIds: string[]
  /** Current scene inputs only; adjacent boards must never become exact output. */
  exactReferenceCreationIds: string[]
  /** Shared story references that guide every scene but can never become exact output. */
  globalReferenceCount: number
  /** References attached only to this scene. */
  sceneReferenceCount: number
  previousStoryboardAttached: boolean
  nextStoryboardAttached: boolean
  sceneCount: number
  allowExactReferenceReuse: boolean
  versionCount: number
}

interface StoryboardSceneVersionPlan {
  scene: StoryboardScene
  versionCount: number
}

interface GenerateAllOptions {
  /** Fill every scene up to the shared Full Storyboard version target. */
  ensureRequestedVersions?: boolean
}

interface StoryboardProps {
  onBack: () => void
  onOpenLibrary: () => void
  toast: (message: string) => void
  onSpend: (credits: number) => void
}

function sceneLabel(index: number): string {
  return `Scene ${String(index + 1).padStart(2, '0')}`
}

function availableStoryboardImageIds(creations: readonly Creation[]): string[] {
  return creations
    .filter((creation) => creation.kind === 'image' && Boolean(creation.url))
    .map((creation) => creation.id)
}

function separateSceneVersionPlan(
  draft: Pick<StoryboardDraft, 'scenes' | 'versionCount'>,
  availableCreationIds: Iterable<string>,
): StoryboardSceneVersionPlan[] {
  const available = [...availableCreationIds]
  return draft.scenes.flatMap((scene) => {
    const versionCount = storyboardSceneVersionDeficit(scene, draft.versionCount, available)
    return versionCount > 0 ? [{ scene, versionCount }] : []
  })
}

function candidateExtension(candidate: Pick<StoryboardSceneCandidate, 'extras'>): string {
  const format = candidate.extras.format?.toLocaleLowerCase()
  return format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png'
}

function sceneInputFingerprintValue(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * prime)
  }
  return `storyboard-scene-v1-${hash.toString(16).padStart(16, '0')}`
}

function sceneInputFingerprintFromSnapshot(
  prompt: string,
  settings: Pick<GenerationSnapshot,
    | 'model'
    | 'aspect'
    | 'resolution'
    | 'extras'
    | 'style'
    | 'referenceCreationIds'
    | 'exactReferenceCreationIds'
    | 'previousStoryboardAttached'
    | 'nextStoryboardAttached'
    | 'sceneCount'
  >,
  sceneOrdinal: number,
): string {
  return sceneInputFingerprintValue(JSON.stringify({
    prompt: prompt.trim(),
    model: settings.model,
    aspect: settings.aspect,
    resolution: settings.resolution,
    extras: Object.entries(settings.extras).sort(([left], [right]) => left.localeCompare(right)),
    style: settings.style.trim(),
    referenceCreationIds: settings.referenceCreationIds,
    exactReferenceCreationIds: settings.exactReferenceCreationIds,
    previousStoryboardAttached: settings.previousStoryboardAttached,
    nextStoryboardAttached: settings.nextStoryboardAttached,
    sceneOrdinal,
    sceneCount: settings.sceneCount,
  }))
}

function sceneInputFingerprintForDraft(
  draft: StoryboardDraft,
  scene: StoryboardScene,
  sceneOrdinal: number,
): string {
  const exactReferenceCreationIds = draft.workflowMode === 'scenes'
    ? scene.referenceCreationIds.filter((creationId) => !draft.referenceCreationIds.includes(creationId))
    : draft.referenceCreationIds
  return sceneInputFingerprintFromSnapshot(scene.prompt, {
    model: draft.model,
    aspect: draft.aspect,
    resolution: draft.resolution,
    extras: draft.extras,
    style: draft.style,
    referenceCreationIds: orderedSceneGenerationReferenceIds(draft, exactReferenceCreationIds),
    exactReferenceCreationIds,
    previousStoryboardAttached: Boolean(draft.previousStoryboardCreationId),
    nextStoryboardAttached: Boolean(draft.nextStoryboardCreationId),
    sceneCount: draft.scenes.length,
  }, sceneOrdinal)
}

function expectedSceneInputFingerprintForDraft(
  draft: StoryboardDraft,
  scene: StoryboardScene,
  sceneOrdinal: number,
): string | undefined {
  const approvedCandidate = findStoryboardCandidate(scene, scene.approvedCreationId)
  const hasReferenceContext = Boolean(
    draft.previousStoryboardCreationId
    || draft.nextStoryboardCreationId
    || draft.referenceCreationIds.length,
  )
  // Legacy candidates predate durable input fingerprints. Preserve their old
  // prompt-only behavior until shared or adjacent visual context is added;
  // every new candidate opts into strict freshness automatically.
  if (!approvedCandidate?.inputFingerprint && !hasReferenceContext) return undefined
  return sceneInputFingerprintForDraft(draft, scene, sceneOrdinal)
}

function sceneContinuityScaffold({
  previous,
  next,
  globalReferenceCount,
  currentReferenceCount,
  sceneOrdinal,
  sceneCount,
}: {
  previous: boolean
  next: boolean
  globalReferenceCount: number
  currentReferenceCount: number
  sceneOrdinal: number
  sceneCount: number
}): string {
  if (!previous && !next && globalReferenceCount === 0 && currentReferenceCount === 0) return ''
  let referenceIndex = 1
  const lines = ['STORYBOARD REFERENCE CONTEXT (provider reference order):']
  if (previous) {
    lines.push(sceneOrdinal === 0
      ? `REFERENCE IMAGE ${String(referenceIndex).padStart(2, '0')}: PREVIOUS STORYBOARD. Continue its visible final state directly into this opening scene without repeating its events.`
      : `REFERENCE IMAGE ${String(referenceIndex).padStart(2, '0')}: PREVIOUS STORYBOARD. Use only for established identity, world and visual continuity; do not repeat its events or force its boundary state into this middle scene.`)
    referenceIndex += 1
  }
  if (globalReferenceCount > 0) {
    const first = referenceIndex
    const last = referenceIndex + globalReferenceCount - 1
    lines.push(first === last
      ? `REFERENCE IMAGE ${String(first).padStart(2, '0')}: GLOBAL STORY REFERENCE. Apply its identity, location or visual language wherever relevant in this scene.`
      : `REFERENCE IMAGES ${String(first).padStart(2, '0')}–${String(last).padStart(2, '0')}: GLOBAL STORY REFERENCES. Apply their identities, locations and visual language wherever relevant in this scene.`)
    referenceIndex = last + 1
  }
  if (currentReferenceCount > 0) {
    const first = referenceIndex
    const last = referenceIndex + currentReferenceCount - 1
    lines.push(first === last
      ? `REFERENCE IMAGE ${String(first).padStart(2, '0')}: authoritative visual reference for the CURRENT scene.`
      : `REFERENCE IMAGES ${String(first).padStart(2, '0')}–${String(last).padStart(2, '0')}: authoritative visual references for the CURRENT scene.`)
    referenceIndex = last + 1
  }
  if (next) {
    lines.push(sceneOrdinal === sceneCount - 1
      ? `REFERENCE IMAGE ${String(referenceIndex).padStart(2, '0')}: NEXT STORYBOARD. Guide this final scene directly toward its visible opening state without depicting its future events early.`
      : `REFERENCE IMAGE ${String(referenceIndex).padStart(2, '0')}: NEXT STORYBOARD. Use only for established identity, world and visual continuity; do not anticipate its opening state or depict its future events in this earlier scene.`)
  }
  lines.push('Generate only the current scene. Never reproduce either adjacent storyboard as the output.')
  return lines.join('\n')
}

function effectiveScenePrompt(
  prompt: string,
  style: string,
  continuity: { previous: boolean; next: boolean; globalReferenceCount: number; currentReferenceCount: number; sceneOrdinal: number; sceneCount: number } = {
    previous: false,
    next: false,
    globalReferenceCount: 0,
    currentReferenceCount: 0,
    sceneOrdinal: 0,
    sceneCount: 1,
  },
): string {
  const clean = prompt.trim()
  const parts = [clean]
  const continuityScaffold = sceneContinuityScaffold(continuity)
  if (continuityScaffold) parts.push(continuityScaffold)
  if (style && style !== 'None') {
    parts.push(`Overall visual direction: ${style}. Preserve every specific subject, action, environment and camera detail above.`)
  }
  return parts.filter(Boolean).join('\n\n')
}

function storyboardScenePromptMax(
  model: string,
  style: string,
  continuity: { previous: boolean; next: boolean; globalReferenceCount: number; currentReferenceCount: number; sceneOrdinal: number; sceneCount: number } = {
    previous: false,
    next: false,
    globalReferenceCount: 0,
    currentReferenceCount: 0,
    sceneOrdinal: 0,
    sceneCount: 1,
  },
): number {
  const providerMax = IMAGE_MODEL_CONFIG[model]?.promptMax ?? STORYBOARD_MAX_PROMPT_LENGTH
  const styleScaffoldLength = promptCharacterCount(effectiveScenePrompt('', style, continuity))
  return Math.max(1, providerMax - styleScaffoldLength)
}

function applyAutomaticStoryboardTiming(draft: StoryboardDraft): StoryboardDraft {
  // Auto scene timing is intentionally unresolved while editing. It is chosen
  // from the complete story and every ordered scene only when the editor asks
  // to create the final storyboard; ordinary keystrokes must never invent or
  // overwrite timing behind the user's back.
  return draft
}

function releaseReferenceImages(references: StoryboardReferenceImage[]): void {
  references.forEach((reference) => {
    if (reference.kind === 'upload' && !reference.creationId) URL.revokeObjectURL(reference.url)
  })
}

function referencesForPrompting(references: ReferenceImage[]): EnhanceReference[] {
  return references.map((reference) => reference.kind === 'upload'
    ? { role: 'story reference image', label: reference.name, imageUrl: reference.url }
    : { role: 'story reference image', note: `timeline frame at ${reference.timecode}` })
}

function referencesFromCreationIds(
  creationIds: readonly string[],
  creationsById: ReadonlyMap<string, Creation>,
  label: string,
): StoryboardReferenceImage[] {
  return creationIds.flatMap((creationId, index): StoryboardReferenceImage[] => {
    const creation = creationsById.get(creationId)
    if (!creation || creation.kind !== 'image' || !creation.url) return []
    return [{
      id: `story-ref-${creationId}`,
      kind: 'upload',
      name: creation.prompt?.trim() || `${label} reference ${index + 1}`,
      url: creation.url,
      creationId,
    }]
  })
}

function adjacentStoryboardReferenceIds(
  draft: Pick<StoryboardDraft, 'previousStoryboardCreationId' | 'nextStoryboardCreationId'>,
): string[] {
  return [draft.previousStoryboardCreationId, draft.nextStoryboardCreationId]
    .filter((creationId): creationId is string => Boolean(creationId))
}

function orderedSceneGenerationReferenceIds(
  draft: Pick<StoryboardDraft, 'previousStoryboardCreationId' | 'nextStoryboardCreationId' | 'referenceCreationIds'>,
  currentSceneReferenceIds: readonly string[],
): string[] {
  return [...new Set([
    ...(draft.previousStoryboardCreationId ? [draft.previousStoryboardCreationId] : []),
    ...draft.referenceCreationIds,
    ...currentSceneReferenceIds,
    ...(draft.nextStoryboardCreationId ? [draft.nextStoryboardCreationId] : []),
  ])]
}

function storyboardPromptingReferences(
  draft: Pick<StoryboardDraft, 'previousStoryboardCreationId' | 'nextStoryboardCreationId'>,
  currentReferences: readonly ReferenceImage[],
  creationsById: ReadonlyMap<string, Creation>,
): EnhanceReference[] {
  const references: EnhanceReference[] = []
  const previous = draft.previousStoryboardCreationId
    ? creationsById.get(draft.previousStoryboardCreationId)
    : undefined
  if (previous?.kind === 'image' && previous.url) {
    references.push({
      role: 'previous storyboard · incoming continuity context only',
      label: previous.prompt?.trim() || 'Previous storyboard',
      imageUrl: previous.url,
    })
  }
  references.push(...referencesForPrompting([...currentReferences]))
  const next = draft.nextStoryboardCreationId
    ? creationsById.get(draft.nextStoryboardCreationId)
    : undefined
  if (next?.kind === 'image' && next.url) {
    references.push({
      role: 'next storyboard · outgoing continuity context only',
      label: next.prompt?.trim() || 'Next storyboard',
      imageUrl: next.url,
    })
  }
  return references
}

function completeStoryboardPromptingReferences(
  draft: StoryboardDraft,
  creationsById: ReadonlyMap<string, Creation>,
): EnhanceReference[] {
  return collectStoryboardBoardReferences(draft).flatMap((item): EnhanceReference[] => {
    const creation = creationsById.get(item.creationId)
    if (!creation || creation.kind !== 'image' || !creation.url) return []
    const role = item.scope === 'previous-storyboard'
      ? 'previous storyboard · incoming continuity context only'
      : item.scope === 'next-storyboard'
        ? 'next storyboard · outgoing continuity context only'
        : item.scope === 'scenes'
          ? `current storyboard · scene ${item.sceneOrdinals.join(', ')}`
          : 'current storyboard · global visual reference'
    return [{
      role,
      label: creation.prompt?.trim() || creation.model?.trim() || 'Storyboard reference',
      imageUrl: creation.url,
    }]
  })
}

function combineStoryboardEstimates(estimates: readonly Estimate[]): Estimate {
  if (!estimates.length) return { credits: 0, perSecond: false, count: 0, unit: 'img', source: 'local' }
  const unavailable = estimates.some((estimate) => estimate.credits == null)
  const source = unavailable
    ? 'unavailable'
    : estimates.some((estimate) => estimate.source === 'fallback')
      ? 'fallback'
      : estimates.every((estimate) => estimate.source === 'live') ? 'live' : estimates[0].source
  return {
    credits: unavailable ? null : estimates.reduce((sum, estimate) => sum + (estimate.credits ?? 0), 0),
    perSecond: false,
    count: estimates.reduce((sum, estimate) => sum + Math.max(0, estimate.count ?? 1), 0),
    unit: 'img',
    source,
  }
}

function actionNote(label: string, credits: number | null | undefined): string {
  if (typeof credits !== 'number' || !Number.isFinite(credits)) return label
  const digits = credits > 0 && credits < 0.01 ? 3 : 2
  return `${label} · ${credits.toFixed(digits).replace(/\.00$/, '')} cr`
}

function safeExportName(title: string): string {
  const base = title.trim() || 'easyfield-storyboard'
  const safe = base
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  return safe || 'easyfield-storyboard'
}

function exactStoryboardFingerprint(draft: StoryboardDraft, sourceSceneCreationIds: readonly string[]): string {
  const timing = effectiveStoryboardTiming(draft)
  const value = JSON.stringify({
    version: 1,
    title: draft.title,
    story: storyboardCompleteStory(draft),
    aspect: draft.aspect,
    previousStoryboardCreationId: draft.previousStoryboardCreationId,
    nextStoryboardCreationId: draft.nextStoryboardCreationId,
    timingMode: timing.timingMode,
    totalDurationSeconds: timing.totalDurationSeconds,
    scenes: timing.scenes.map((scene) => ({
      title: scene.title,
      prompt: scene.prompt,
      explanation: scene.explanation,
      durationMode: scene.durationMode,
      durationSeconds: scene.durationSeconds,
    })),
    sourceSceneCreationIds,
  })
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `scene-composite-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function Storyboard({ onBack, onOpenLibrary, toast, onSpend }: StoryboardProps) {
  const [draft, setDraft] = useState<StoryboardDraft>(() => createDefaultStoryboardDraft())
  const [hydrated, setHydrated] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('loading')
  const [enhancerModel, setEnhancerModel] = useState(() => {
    const saved = loadValue(ENHANCER_PREF_KEY)
    return saved && AGENT_MODELS.includes(saved) ? saved : DEFAULT_AGENT_MODEL
  })
  const [runtime, setRuntime] = useState<Record<string, SceneRuntime>>({})
  const [briefRuntime, setBriefRuntime] = useState<BriefRuntime>({ state: 'idle' })
  const [boardRuntime, setBoardRuntime] = useState<BoardRuntime>({ state: 'idle' })
  const [activeCandidateIds, setActiveCandidateIds] = useState<Record<string, string>>({})
  const [activeBoardCandidateId, setActiveBoardCandidateId] = useState<string | null>(null)
  const [visualSettingsOpen, setVisualSettingsOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchCancelling, setBatchCancelling] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ complete: 0, total: 0 })
  const [timingResolving, setTimingResolving] = useState(false)
  const [exportingBoard, setExportingBoard] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [referenceImages, setReferenceImages] = useState<StoryboardReferenceImage[]>([])
  const [storyReferenceDialogOpen, setStoryReferenceDialogOpen] = useState(false)
  const [referenceDialogSceneId, setReferenceDialogSceneId] = useState<string | null>(null)
  const [continuityDialogRole, setContinuityDialogRole] = useState<StoryboardContinuityRole | null>(null)
  const [referenceImporting, setReferenceImporting] = useState(false)
  const creations = useCreations()
  const jobs = useJobs()
  const libraryPersistenceState = usePersistenceState()
  const draftRef = useRef(draft)
  const hydratedRef = useRef(hydrated)
  const mountedRef = useRef(true)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const inFlightSceneIdsRef = useRef(new Set<string>())
  const controllersRef = useRef(new Map<string, AbortController>())
  const sceneJobIdsRef = useRef(new Map<string, string>())
  const boardJobIdRef = useRef<string | null>(null)
  const ignoredBoardJobIdsRef = useRef(new Set<string>())
  const composingBoardSourceIdsRef = useRef(new Set<string>())
  const batchCancelRef = useRef(false)
  const finalRef = useRef<HTMLDivElement>(null)
  const referenceImagesRef = useRef(referenceImages)
  const referenceIdCounterRef = useRef(1)
  const referenceImportingRef = useRef(false)

  draftRef.current = draft
  hydratedRef.current = hydrated
  referenceImagesRef.current = referenceImages

  const creationsById = useMemo(
    () => new Map(creations.map((creation) => [creation.id, creation])),
    [creations],
  )
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs])

  const continuityAsset = useCallback((creationId: string | null): StoryboardContinuityAsset | null => {
    if (!creationId) return null
    const creation = creationsById.get(creationId)
    if (!creation || creation.kind !== 'image' || !creation.url) return null
    return {
      creationId,
      name: creation.prompt?.trim() || creation.model?.trim() || 'Storyboard',
      url: creation.url,
    }
  }, [creationsById])
  const previousStoryboardAsset = continuityAsset(draft.previousStoryboardCreationId)
  const nextStoryboardAsset = continuityAsset(draft.nextStoryboardCreationId)
  const continuityReferenceIds = [draft.previousStoryboardCreationId, draft.nextStoryboardCreationId]
    .filter((id): id is string => Boolean(id))
  const unresolvedContinuityReferenceIds = continuityReferenceIds.filter((id) => {
    const creation = creationsById.get(id)
    return !creation || creation.kind !== 'image' || !creation.url
  })

  const sceneReferenceCreationIds = draft.scenes.flatMap((scene) => scene.referenceCreationIds)
  const unresolvedSceneReferenceIds = sceneReferenceCreationIds.filter((id) => {
    const creation = creationsById.get(id)
    return !creation || creation.kind !== 'image' || !creation.url
  })

  const expectedReferenceCount = draft.referenceCreationIds.length
  const activeReferenceCreationIds = referenceImages.flatMap((reference) => reference.creationId ? [reference.creationId] : [])
  const savedReferencesResolved = activeReferenceCreationIds.length === expectedReferenceCount
    && activeReferenceCreationIds.every((id, index) => id === draft.referenceCreationIds[index])
  const referencesRestoring = hydrated
    && expectedReferenceCount > 0
    && !savedReferencesResolved
    && (libraryPersistenceState === 'loading'
      || libraryPersistenceState === 'ready')
  const referencesUnavailable = hydrated
    && expectedReferenceCount > 0
    && !savedReferencesResolved
    && (libraryPersistenceState === 'unavailable' || libraryPersistenceState === 'error')
  const sceneReferencesRestoring = hydrated
    && draft.workflowMode === 'scenes'
    && unresolvedSceneReferenceIds.length > 0
    && (libraryPersistenceState === 'loading' || libraryPersistenceState === 'ready')
  const sceneReferencesUnavailable = hydrated
    && draft.workflowMode === 'scenes'
    && unresolvedSceneReferenceIds.length > 0
    && (libraryPersistenceState === 'unavailable' || libraryPersistenceState === 'error')
  const continuityReferencesRestoring = hydrated
    && unresolvedContinuityReferenceIds.length > 0
    && (libraryPersistenceState === 'loading' || libraryPersistenceState === 'ready')
  const continuityReferencesUnavailable = hydrated
    && unresolvedContinuityReferenceIds.length > 0
    && (libraryPersistenceState === 'unavailable' || libraryPersistenceState === 'error')
  const activeReferencesRestoring = referencesRestoring
    || (draft.workflowMode === 'scenes' && sceneReferencesRestoring)
  const activeReferencesUnavailable = referencesUnavailable
    || (draft.workflowMode === 'scenes' && sceneReferencesUnavailable)
  const referencesBlocked = activeReferencesRestoring
    || activeReferencesUnavailable
    || continuityReferencesRestoring
    || continuityReferencesUnavailable

  useEffect(() => {
    if (!hydrated || libraryPersistenceState !== 'ready') return
    const current = referenceImagesRef.current
    const currentByCreationId = new Map(
      current.flatMap((reference) => reference.creationId ? [[reference.creationId, reference] as const] : []),
    )
    const next = draft.referenceCreationIds.flatMap((creationId, index): StoryboardReferenceImage[] => {
      const creation = creationsById.get(creationId)
      if (!creation || creation.kind !== 'image' || !creation.url) return []
      const existing = currentByCreationId.get(creationId)
      return [{
        id: existing?.id ?? `story-ref-${creationId}`,
        kind: 'upload',
        name: creation.prompt?.trim() || `Storyboard reference ${index + 1}`,
        url: creation.url,
        creationId,
      }]
    })
    const unchanged = next.length === current.length
      && next.every((reference, index) => {
        const existing = current[index]
        if (reference.kind !== 'upload') return false
        return reference.creationId === existing?.creationId
          && reference.url === (existing?.kind === 'upload' ? existing.url : undefined)
      })
    if (!unchanged) {
      referenceImagesRef.current = next
      setReferenceImages(next)
    }

    const restoredIds = next.flatMap((reference) => reference.creationId ? [reference.creationId] : [])
    if (
      restoredIds.length !== draft.referenceCreationIds.length
      || restoredIds.some((id, index) => id !== draft.referenceCreationIds[index])
    ) {
      setDraft((currentDraft) => {
        const nextDraft = { ...currentDraft, referenceCreationIds: restoredIds }
        draftRef.current = nextDraft
        return nextDraft
      })
    }
  }, [creationsById, draft.referenceCreationIds, hydrated, libraryPersistenceState])

  useEffect(() => {
    if (!hydrated || libraryPersistenceState !== 'ready' || draft.workflowMode !== 'scenes') return
    const hasUnavailable = draft.scenes.some((scene) => scene.referenceCreationIds.some((id) => {
      const creation = creationsById.get(id)
      return !creation || creation.kind !== 'image' || !creation.url
    }))
    if (!hasUnavailable) return
    setDraft((current) => {
      const nextScenes = current.scenes.map((scene) => ({
        ...scene,
        referenceCreationIds: scene.referenceCreationIds.filter((id) => {
          const creation = creationsById.get(id)
          return creation?.kind === 'image' && Boolean(creation.url)
        }),
      }))
      const changed = nextScenes.some((scene, index) => scene.referenceCreationIds.length !== current.scenes[index].referenceCreationIds.length)
      if (!changed) return current
      const next = { ...current, scenes: nextScenes }
      draftRef.current = next
      return next
    })
  }, [creationsById, draft.scenes, draft.workflowMode, hydrated, libraryPersistenceState])

  useEffect(() => {
    if (!hydrated || libraryPersistenceState !== 'ready') return
    const isAvailable = (creationId: string | null) => {
      if (!creationId) return true
      const creation = creationsById.get(creationId)
      return creation?.kind === 'image' && Boolean(creation.url)
    }
    if (isAvailable(draft.previousStoryboardCreationId) && isAvailable(draft.nextStoryboardCreationId)) return
    setDraft((current) => {
      const previousStoryboardCreationId = isAvailable(current.previousStoryboardCreationId)
        ? current.previousStoryboardCreationId
        : null
      const nextStoryboardCreationId = isAvailable(current.nextStoryboardCreationId)
        ? current.nextStoryboardCreationId
        : null
      if (
        previousStoryboardCreationId === current.previousStoryboardCreationId
        && nextStoryboardCreationId === current.nextStoryboardCreationId
      ) return current
      const next = { ...current, previousStoryboardCreationId, nextStoryboardCreationId }
      draftRef.current = next
      return next
    })
  }, [creationsById, draft.nextStoryboardCreationId, draft.previousStoryboardCreationId, hydrated, libraryPersistenceState])

  useEffect(() => {
    mountedRef.current = true
    let active = true
    void host.getState<StoryboardDraft>('drafts', STORYBOARD_DRAFT_KEY).then((stored) => {
      if (!active) return
      const restored = normalizeStoryboardDraft(stored)
      setDraft(restored)
      draftRef.current = restored
      setHydrated(true)
      setSaveState('saved')
    }).catch(() => {
      if (!active) return
      setHydrated(true)
      setSaveState('error')
    })
    return () => {
      active = false
      mountedRef.current = false
    }
  }, [])

  const persistDraft = useCallback((value: StoryboardDraft): Promise<void> => {
    const snapshot = normalizeStoryboardDraft(value)
    if (mountedRef.current) setSaveState('saving')
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => host.setState('drafts', STORYBOARD_DRAFT_KEY, snapshot))
    const queued = saveQueueRef.current
    void queued.then(() => {
      if (mountedRef.current && draftRef.current === value) setSaveState('saved')
    }).catch(() => {
      if (mountedRef.current) setSaveState('error')
    })
    return queued
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistDraft(draft)
    }, 180)
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [draft, hydrated, persistDraft])

  useEffect(() => () => {
    batchCancelRef.current = true
    controllersRef.current.forEach((controller) => controller.abort())
    controllersRef.current.clear()
    sceneJobIdsRef.current.clear()
    boardJobIdRef.current = null
    releaseReferenceImages(referenceImagesRef.current)
    if (hydratedRef.current) void persistDraft(draftRef.current)
  }, [persistDraft])

  const updateDraft = useCallback((mutate: (current: StoryboardDraft) => StoryboardDraft) => {
    setDraft((current) => {
      const proposed = mutate(current)
      const next = applyAutomaticStoryboardTiming(proposed)
      draftRef.current = next
      return next
    })
  }, [])

  const updateScene = useCallback((sceneId: string, mutate: (scene: StoryboardScene) => StoryboardScene) => {
    updateDraft((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => scene.id === sceneId ? mutate(scene) : scene),
    }))
  }, [updateDraft])

  const setSceneRuntime = useCallback((sceneId: string, next: SceneRuntime) => {
    setRuntime((current) => ({ ...current, [sceneId]: next }))
  }, [])

  useEffect(() => {
    if (
      !hydrated
      || boardRuntime.state !== 'idle'
      || controllersRef.current.has('board:generate')
    ) return

    const recoverable = jobs.flatMap((job) => {
      if (ignoredBoardJobIdsRef.current.has(job.id)) return []
      const snapshot = parseStoryboardBoardJobMetadata(job.recoveryMetadata, STORYBOARD_DRAFT_KEY)
      if (!snapshot || job.kind !== 'image' || job.status === 'failed' || job.status === 'cancelled') return []
      const resultUrls = [...new Set(job.resultUrls ?? [])]
      if (job.status === 'succeeded' && !resultUrls.length) return []
      const associatedCandidates = draft.boardCandidates.filter((candidate) => (
        candidate.strategy === 'single-generation'
        && candidate.jobId === job.id
      ))
      const attachedCreationIds = associatedCandidates.flatMap((candidate) => {
        const sourceIds = candidate.sourceSceneCreationIds.filter((creationId) => {
          const source = creationsById.get(creationId)
          return source && resultUrls.includes(source.url)
        })
        if (sourceIds.length) return sourceIds
        const creation = creationsById.get(candidate.creationId)
        return creation && resultUrls.includes(creation.url) ? [candidate.creationId] : []
      })
      if (job.status === 'succeeded' && associatedCandidates.length >= resultUrls.length) return []
      return [{ job, snapshot, attachedCreationIds }]
    }).sort((left, right) => right.job.startedAt - left.job.startedAt)

    const match = recoverable[0]
    if (!match) return
    boardJobIdRef.current = match.job.id
    setBoardRuntime({
      state: 'pending',
      note: match.job.status === 'succeeded'
        ? 'Restoring complete board from Library'
        : 'Complete board continues in Activity',
      jobId: match.job.id,
      requestedVersions: match.snapshot.requestedVersions,
      generation: {
        promptSnapshot: match.snapshot.promptSnapshot,
        inputFingerprint: match.snapshot.inputFingerprint,
        model: match.snapshot.model,
        aspect: match.snapshot.aspect,
        resolution: match.snapshot.resolution,
        extras: { ...match.snapshot.extras },
        attachedCreationIds: match.attachedCreationIds,
      },
    })
  }, [boardRuntime.state, creationsById, draft.boardCandidates, hydrated, jobs])

  useEffect(() => {
    const pendingRuns = Object.entries(runtime).filter((entry): entry is [string, SceneRuntime & {
      jobId: string
      generation: NonNullable<SceneRuntime['generation']>
    }] => entry[1].state === 'pending' && Boolean(entry[1].jobId && entry[1].generation))
    if (!pendingRuns.length) return

    const candidateBatches = new Map<string, StoryboardSceneCandidate[]>()
    const activations = new Map<string, string>()
    const runtimeUpdates = new Map<string, SceneRuntime>()

    pendingRuns.forEach(([sceneId, sceneRuntime]) => {
      const job = jobsById.get(sceneRuntime.jobId)
      if (!job) return
      const generation = sceneRuntime.generation
      const attachedIds = new Set(generation.attachedCreationIds)
      const resultUrls = new Set(job.resultUrls ?? [])
      const newlyRecovered = creations.filter((creation) => (
        creation.kind === 'image'
        && resultUrls.has(creation.url)
        && !attachedIds.has(creation.id)
      ))
      newlyRecovered.forEach((creation) => attachedIds.add(creation.id))

      if (newlyRecovered.length) {
        candidateBatches.set(sceneId, newlyRecovered.map((creation) => ({
          creationId: creation.id,
          promptSnapshot: generation.promptSnapshot,
          inputFingerprint: generation.inputFingerprint,
          model: generation.model,
          aspect: generation.aspect,
          resolution: generation.resolution,
          extras: { ...generation.extras },
          createdAt: creation.createdAt,
        })))
        activations.set(sceneId, newlyRecovered.at(-1)!.id)
      }

      const requestedVersions = sceneRuntime.requestedVersions ?? 1
      const readyCount = attachedIds.size
      const terminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
      const waitingForLibrary = (job.resultUrls?.length ?? 0) > readyCount
      if (terminal && !waitingForLibrary) {
        runtimeUpdates.set(sceneId, readyCount > 0 ? {
          state: 'idle',
          requestedVersions,
          note: requestedVersions > 1
            ? readyCount >= requestedVersions
              ? `${readyCount} versions ready`
              : `${readyCount} of ${requestedVersions} versions ready · remaining versions did not complete`
            : 'Frame ready',
        } : {
          state: 'error',
          requestedVersions,
          error: job.error || job.detail || 'The generation could not be completed.',
        })
      } else if (newlyRecovered.length) {
        runtimeUpdates.set(sceneId, {
          ...sceneRuntime,
          note: `${readyCount} of ${requestedVersions} versions ready · finishing in Activity`,
          generation: { ...generation, attachedCreationIds: [...attachedIds] },
        })
      }
    })

    if (candidateBatches.size) {
      updateDraft((current) => ({
        ...current,
        scenes: current.scenes.map((scene) => {
          const candidates = candidateBatches.get(scene.id)
          if (!candidates?.length) return scene
          const existingApproval = findStoryboardCandidate(scene, scene.approvedCreationId)
          const keepExistingApproval = existingApproval?.inputFingerprint === candidates[0].inputFingerprint
          return {
            ...scene,
            candidates: appendStoryboardCandidates(scene, candidates),
            approvedCreationId: keepExistingApproval ? scene.approvedCreationId : candidates[0].creationId,
            approvedPromptSnapshot: keepExistingApproval ? scene.approvedPromptSnapshot : candidates[0].promptSnapshot,
          }
        }),
      }))
      setActiveCandidateIds((current) => {
        const next = { ...current }
        activations.forEach((candidateId, sceneId) => { next[sceneId] = candidateId })
        return next
      })
    }

    if (runtimeUpdates.size) {
      setRuntime((current) => {
        const next = { ...current }
        runtimeUpdates.forEach((nextRuntime, sceneId) => {
          if (current[sceneId]?.jobId === runtime[sceneId]?.jobId) next[sceneId] = nextRuntime
        })
        return next
      })
    }
  }, [creations, jobsById, runtime, updateDraft])

  useEffect(() => {
    if (boardRuntime.state !== 'pending' || !boardRuntime.jobId || !boardRuntime.generation) return
    const job = jobsById.get(boardRuntime.jobId)
    if (!job) return
    const generation = boardRuntime.generation
    const jobCandidates = draftRef.current.boardCandidates.filter((candidate) => (
      candidate.strategy === 'single-generation'
      && candidate.jobId === boardRuntime.jobId
    ))
    const attachedIds = new Set([
      ...generation.attachedCreationIds,
      ...jobCandidates.flatMap((candidate) => candidate.sourceSceneCreationIds),
    ])
    const resultUrls = new Set(job.resultUrls ?? [])
    const newlyRecovered = creations.filter((creation) => (
      creation.kind === 'image'
      && resultUrls.has(creation.url)
      && !attachedIds.has(creation.id)
      && !composingBoardSourceIdsRef.current.has(creation.id)
    ))

    if (newlyRecovered.length) {
      newlyRecovered.forEach((creation) => composingBoardSourceIdsRef.current.add(creation.id))
      const recoveryDraft = draftRef.current
      const recoveryCompile = compileGeneratedStoryboardBoard(recoveryDraft)
      const matchesCurrentInput = recoveryCompile.ok
        && recoveryCompile.inputFingerprint === generation.inputFingerprint
      const jobId = boardRuntime.jobId
      void (async () => {
        const recoveredCandidates: StoryboardBoardCandidate[] = []
        for (const raw of newlyRecovered) {
          recoveredCandidates.push({
            creationId: raw.id,
            jobId,
            strategy: 'single-generation',
            promptSnapshot: generation.promptSnapshot,
            inputFingerprint: generation.inputFingerprint,
            sourceSceneCreationIds: [],
            model: generation.model,
            aspect: generation.aspect,
            resolution: generation.resolution,
            extras: { ...generation.extras },
            createdAt: raw.createdAt,
          })
          composingBoardSourceIdsRef.current.delete(raw.id)
        }
        if (!recoveredCandidates.length || !mountedRef.current) return
        updateDraft((current) => {
          const keepExistingApproval = current.boardCandidates.some((candidate) => (
            candidate.creationId === current.approvedBoardCreationId
            && candidate.strategy === 'single-generation'
            && candidate.inputFingerprint === generation.inputFingerprint
          ))
          return {
            ...current,
            boardCandidates: appendStoryboardBoardCandidates(current, recoveredCandidates),
            approvedBoardCreationId: keepExistingApproval ? current.approvedBoardCreationId : recoveredCandidates[0].creationId,
          }
        })
        setActiveBoardCandidateId(recoveredCandidates.at(-1)!.creationId)
        setBoardRuntime((current) => current.jobId === jobId && current.generation ? {
          ...current,
          note: matchesCurrentInput ? current.note : 'Restored from the original storyboard run',
          generation: {
            ...current.generation,
            attachedCreationIds: [
              ...new Set([...current.generation.attachedCreationIds, ...newlyRecovered.map((creation) => creation.id)]),
            ],
          },
        } : current)
      })()
    }

    const requestedVersions = boardRuntime.requestedVersions ?? 1
    const readyCount = jobCandidates.length
    const terminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
    const waitingForLibrary = (job.resultUrls?.length ?? 0) > attachedIds.size
      || newlyRecovered.length > 0
      || composingBoardSourceIdsRef.current.size > 0
    if (terminal && !waitingForLibrary) {
      setBoardRuntime(readyCount > 0 ? {
        state: 'idle',
        requestedVersions,
        note: requestedVersions > 1
          ? readyCount >= requestedVersions
            ? `${readyCount} complete-board versions ready`
            : `${readyCount} of ${requestedVersions} complete-board versions ready`
          : 'Complete board ready',
      } : {
        state: 'error',
        requestedVersions,
        error: job.error || job.detail || 'The complete storyboard could not be generated.',
      })
    } else if (newlyRecovered.length) {
      setBoardRuntime({
        ...boardRuntime,
        note: `${readyCount} of ${requestedVersions} complete-board versions ready · restoring from Library`,
      })
    }
  }, [boardRuntime, creations, jobsById, updateDraft])

  const handleBack = () => {
    if (referenceImportingRef.current) {
      toast('Wait for the reference image to finish saving before leaving Storyboard')
      return
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    void persistDraft(draftRef.current).finally(onBack)
  }

  const addScene = () => {
    if (draftRef.current.scenes.length >= STORYBOARD_MAX_SCENES) return
    updateDraft((current) => {
      if (current.workflowMode === 'scenes') {
        return { ...current, scenes: [...current.scenes, createStoryboardScene()] }
      }
      const timing = appendStoryboardSceneWithTiming(current.scenes, current.totalDurationSeconds)
      return { ...current, ...timing }
    })
  }

  const removeScene = (sceneId: string) => {
    const current = draftRef.current
    if (current.scenes.length <= STORYBOARD_MIN_SCENES) return
    const target = current.scenes.find((scene) => scene.id === sceneId)
    if (!target) return
    if (storyboardSceneHasContent(target)) {
      const confirmed = window.confirm('Remove this scene from the storyboard? Generated frames will remain safe in Library.')
      if (!confirmed) return
    }
    updateDraft((latest) => {
      if (latest.workflowMode === 'scenes') {
        return { ...latest, scenes: latest.scenes.filter((scene) => scene.id !== sceneId) }
      }
      const timing = removeStoryboardSceneWithTiming(latest.scenes, sceneId, latest.totalDurationSeconds)
      return { ...latest, ...timing }
    })
    setRuntime((latest) => {
      const next = { ...latest }
      delete next[sceneId]
      return next
    })
    setActiveCandidateIds((latest) => {
      const next = { ...latest }
      delete next[sceneId]
      return next
    })
    if (referenceDialogSceneId === sceneId) setReferenceDialogSceneId(null)
  }

  const moveScene = (sceneId: string, direction: -1 | 1) => {
    const current = draftRef.current
    const sourceIndex = current.scenes.findIndex((scene) => scene.id === sceneId)
    if (sourceIndex < 0) return
    updateDraft((latest) => ({
      ...latest,
      scenes: reorderStoryboardScenes(latest.scenes, sceneId, sourceIndex + direction),
    }))
  }

  const changeTotalDuration = (requestedDurationSeconds: number) => {
    updateDraft((current) => {
      const totalDurationSeconds = current.workflowMode === 'full'
        ? clampFullStoryboardDuration(requestedDurationSeconds)
        : clampStoryboardTotalDuration(requestedDurationSeconds, current.scenes.length)
      return {
        ...current,
        totalDurationSeconds,
        scenes: current.workflowMode === 'full'
          ? current.scenes
          : scaleStoryboardDurations(current.scenes, totalDurationSeconds),
      }
    })
  }

  const changeTimingMode = (timingMode: StoryboardTimingMode) => {
    updateDraft((current) => {
      if (current.timingMode === timingMode) return current
      return { ...current, timingMode }
    })
  }

  const changeSceneDuration = (sceneId: string, durationSeconds: number) => {
    updateDraft((current) => {
      const scenes: StoryboardScene[] = current.scenes.map((scene) => scene.id === sceneId
        ? {
          ...scene,
          durationMode: 'manual',
          durationSeconds: clampStoryboardSceneDuration(durationSeconds),
        }
        : scene)
      return {
        ...current,
        scenes,
      }
    })
  }

  const changeSceneTiming = (
    sceneId: string,
    durationMode: StoryboardSceneDurationMode,
    durationSeconds?: number,
  ) => {
    updateDraft((current) => {
      const scenes = current.scenes.map((scene) => scene.id === sceneId
        ? {
          ...scene,
          durationMode,
          durationSeconds: durationMode === 'manual' && typeof durationSeconds === 'number'
            ? clampStoryboardSceneDuration(durationSeconds)
            : scene.durationSeconds,
        }
        : scene)
      return {
        ...current,
        scenes,
      }
    })
  }

  const ordinaryReferenceLimit = (source = draftRef.current): number => (
    Math.max(0, IMAGE_MODEL_CONFIG[source.model].maxReferenceImages - adjacentStoryboardReferenceIds(source).length)
  )

  const globalReferenceLimit = (source = draftRef.current): number => {
    const globalIds = new Set(source.referenceCreationIds)
    const largestSceneSpecificCount = source.workflowMode === 'scenes'
      ? Math.max(0, ...source.scenes.map((scene) => (
        new Set(scene.referenceCreationIds.filter((creationId) => !globalIds.has(creationId))).size
      )))
      : 0
    return Math.max(0, ordinaryReferenceLimit(source) - largestSceneSpecificCount)
  }

  const sceneReferenceLimit = (source = draftRef.current): number => (
    Math.max(0, ordinaryReferenceLimit(source) - new Set(source.referenceCreationIds).size)
  )

  const largestOrdinaryReferenceCount = (source = draftRef.current): number => (
    source.workflowMode === 'full'
      ? new Set(source.referenceCreationIds).size
      : Math.max(
        new Set(source.referenceCreationIds).size,
        ...source.scenes.map((scene) => new Set([
          ...source.referenceCreationIds,
          ...scene.referenceCreationIds,
        ]).size),
      )
  )

  const continuityReferenceImage = (role: StoryboardContinuityRole): StoryboardReferenceImage[] => {
    const source = draftRef.current
    const creationId = role === 'previous'
      ? source.previousStoryboardCreationId
      : source.nextStoryboardCreationId
    return referencesFromCreationIds(
      creationId ? [creationId] : [],
      new Map(getCreations().map((creation) => [creation.id, creation])),
      role === 'previous' ? 'Previous storyboard' : 'Next storyboard',
    )
  }

  const attachContinuityCreation = (role: StoryboardContinuityRole, creation: Creation): boolean => {
    if (creation.kind !== 'image' || !creation.url) {
      toast('Choose a storyboard image from Library')
      return false
    }
    const current = draftRef.current
    const currentRoleId = role === 'previous'
      ? current.previousStoryboardCreationId
      : current.nextStoryboardCreationId
    if (currentRoleId === creation.id) return true
    const otherRoleId = role === 'previous'
      ? current.nextStoryboardCreationId
      : current.previousStoryboardCreationId
    const ordinaryIds = new Set([
      ...current.referenceCreationIds,
      ...current.scenes.flatMap((scene) => scene.referenceCreationIds),
    ])
    if (creation.id === otherRoleId || ordinaryIds.has(creation.id)) {
      toast('That image already has another reference role · choose a different storyboard')
      return false
    }
    const currentContinuityCount = adjacentStoryboardReferenceIds(current).length
    const replacing = Boolean(currentRoleId)
    const nextContinuityCount = currentContinuityCount + (replacing ? 0 : 1)
    const modelLimit = IMAGE_MODEL_CONFIG[current.model].maxReferenceImages
    if (largestOrdinaryReferenceCount(current) + nextContinuityCount > modelLimit) {
      toast(`${current.model} has no free reference slot · remove a current reference first`)
      return false
    }
    updateDraft((latest) => ({
      ...latest,
      ...(role === 'previous'
        ? { previousStoryboardCreationId: creation.id }
        : { nextStoryboardCreationId: creation.id }),
    }))
    setAdvancedOpen(true)
    return true
  }

  const addContinuityFiles = async (role: StoryboardContinuityRole, files: File[]) => {
    if (referenceImportingRef.current || referencesBlocked || !files.length) return
    referenceImportingRef.current = true
    setReferenceImporting(true)
    try {
      const validity = await Promise.all(files.map(isDecodableReferenceImageFile))
      const file = files.find((_, index) => validity[index])
      if (!file) {
        toast('Use a JPEG, PNG or WebP storyboard image up to 10 MB')
        return
      }
      const objectUrl = URL.createObjectURL(file)
      const [creation] = addCreations([{
        kind: 'image',
        url: objectUrl,
        model: role === 'previous' ? 'Previous storyboard context' : 'Next storyboard context',
        prompt: file.name,
        meta: `${role === 'previous' ? 'Previous' : 'Next'} storyboard continuity · ${file.type || 'image'}`,
      }])
      if (!creation) {
        URL.revokeObjectURL(objectUrl)
        toast('The storyboard image could not be saved to Library')
        return
      }
      attachContinuityCreation(role, creation)
      if (files.length > 1) toast('One adjacent storyboard can be attached in each slot')
    } finally {
      referenceImportingRef.current = false
      if (mountedRef.current) setReferenceImporting(false)
    }
  }

  const addContinuityCreations = async (role: StoryboardContinuityRole, selected: Creation[]) => {
    if (referenceImportingRef.current || referencesBlocked || !selected.length) return
    attachContinuityCreation(role, selected[0])
  }

  const grabContinuityFrame = async (role: StoryboardContinuityRole) => {
    if (referenceImportingRef.current || referencesBlocked) return
    referenceImportingRef.current = true
    setReferenceImporting(true)
    try {
      const grabbed = await resolve.grabFrame()
      if (!grabbed.ok || !grabbed.blobUrl) {
        toast(`Frame capture failed · ${grabbed.error || 'check Resolve and the playhead'}`)
        return
      }
      const [creation] = addCreations([{
        kind: 'image',
        url: grabbed.blobUrl,
        model: role === 'previous' ? 'Previous storyboard context' : 'Next storyboard context',
        prompt: grabbed.name,
        meta: `${role === 'previous' ? 'Previous' : 'Next'} storyboard continuity · Resolve frame`,
        fromTimeline: true,
      }])
      if (!creation) {
        URL.revokeObjectURL(grabbed.blobUrl)
        toast('The grabbed frame could not be saved as storyboard context')
        return
      }
      attachContinuityCreation(role, creation)
    } finally {
      referenceImportingRef.current = false
      if (mountedRef.current) setReferenceImporting(false)
    }
  }

  const removeContinuityReference = (role: StoryboardContinuityRole) => {
    if (referenceImportingRef.current || referencesBlocked) return
    updateDraft((current) => ({
      ...current,
      ...(role === 'previous'
        ? { previousStoryboardCreationId: null }
        : { nextStoryboardCreationId: null }),
    }))
  }

  const changeModel = (model: string) => {
    if (referencesBlocked) {
      toast(referencesUnavailable ? 'Library references are unavailable right now' : 'Restoring Storyboard references…')
      return
    }
    const workInFlight = referenceImporting
      || batchRunning
      || exportingBoard
      || boardRuntime.state === 'generating'
      || boardRuntime.state === 'pending'
      || briefRuntime.state === 'enhancing'
      || briefRuntime.state === 'planning'
      || Object.values(runtime).some((scene) => scene.state === 'enhancing' || scene.state === 'generating' || scene.state === 'pending')
    if (workInFlight) {
      toast('Wait for the current storyboard task before changing models')
      return
    }
    const options = resolveImageOptions(model)
    const nextReferenceLimit = IMAGE_MODEL_CONFIG[model].maxReferenceImages
    const currentReferences = referenceImagesRef.current
    const currentDraft = draftRef.current
    const keptPreviousStoryboardId = nextReferenceLimit > 0 ? currentDraft.previousStoryboardCreationId : null
    const keptNextStoryboardId = nextReferenceLimit > Number(Boolean(keptPreviousStoryboardId))
      ? currentDraft.nextStoryboardCreationId
      : null
    const keptContinuityCount = Number(Boolean(keptPreviousStoryboardId)) + Number(Boolean(keptNextStoryboardId))
    const nextOrdinaryReferenceLimit = Math.max(0, nextReferenceLimit - keptContinuityCount)
    const keptReferences = currentReferences.slice(0, nextOrdinaryReferenceLimit)
    const keptGlobalIds = new Set(keptReferences.flatMap((reference) => reference.creationId ? [reference.creationId] : []))
    const nextSceneReferenceLimit = Math.max(0, nextOrdinaryReferenceLimit - keptGlobalIds.size)
    const nextScenes = currentDraft.scenes.map((scene) => ({
      ...scene,
      referenceCreationIds: [...new Set(scene.referenceCreationIds)]
        .filter((creationId) => !keptGlobalIds.has(creationId))
        .slice(0, nextSceneReferenceLimit),
    }))
    const sceneReferencesToRemove = currentDraft.scenes.reduce((sum, scene, index) => (
      sum + Math.max(0, scene.referenceCreationIds.length - nextScenes[index].referenceCreationIds.length)
    ), 0)
    const globalReferencesToRemove = currentReferences.length - keptReferences.length
    const continuityReferencesToRemove = Number(Boolean(currentDraft.previousStoryboardCreationId && !keptPreviousStoryboardId))
      + Number(Boolean(currentDraft.nextStoryboardCreationId && !keptNextStoryboardId))
    const removeCount = globalReferencesToRemove + sceneReferencesToRemove + continuityReferencesToRemove
    if (removeCount > 0) {
      const confirmed = window.confirm(
        `${model} accepts ${nextReferenceLimit} total reference image${nextReferenceLimit === 1 ? '' : 's'} per generation, including adjacent storyboards. Switch models and detach ${removeCount} extra reference${removeCount === 1 ? '' : 's'}? Library originals stay safe.`,
      )
      if (!confirmed) return
      releaseReferenceImages(currentReferences.slice(nextOrdinaryReferenceLimit))
      referenceImagesRef.current = keptReferences
      setReferenceImages(keptReferences)
      toast(`${model} kept references in chronological priority · Library originals were not changed`)
    }
    updateDraft((current) => ({
      ...current,
      model,
      previousStoryboardCreationId: keptPreviousStoryboardId,
      nextStoryboardCreationId: keptNextStoryboardId,
      referenceCreationIds: referenceImagesRef.current.flatMap((reference) => reference.creationId ? [reference.creationId] : []),
      scenes: nextScenes,
      aspect: options.aspect,
      resolution: options.resolution,
      extras: options.extraOptionValues,
    }))
  }

  const addReferenceFiles = async (files: File[]) => {
    if (referenceImportingRef.current || referencesBlocked || !files.length) return
    referenceImportingRef.current = true
    setReferenceImporting(true)
    try {
      const validity = await Promise.all(files.map(isDecodableReferenceImageFile))
      const validFiles = files.filter((_, index) => validity[index])
      const model = draftRef.current.model
      const limit = globalReferenceLimit(draftRef.current)
      const remaining = Math.max(0, limit - referenceImagesRef.current.length)
      const toAdd = validFiles.slice(0, remaining)
      const objectUrls = toAdd.map((file) => URL.createObjectURL(file))
      const imported = addCreations(toAdd.map((file, index) => ({
        kind: 'image',
        url: objectUrls[index],
        model: 'Storyboard reference',
        prompt: file.name,
        meta: `Storyboard reference · ${file.type || 'image'}`,
      })))
      const additions: StoryboardReferenceImage[] = imported.map((creation, index) => ({
        id: `story-ref-${Date.now().toString(36)}-${referenceIdCounterRef.current++}`,
        kind: 'upload',
        name: toAdd[index]?.name || `Storyboard reference ${index + 1}`,
        url: creation.url,
        creationId: creation.id,
      }))
      objectUrls.slice(imported.length).forEach((url) => URL.revokeObjectURL(url))
      if (additions.length) {
        const next = [...referenceImagesRef.current, ...additions].slice(0, limit)
        referenceImagesRef.current = next
        setReferenceImages(next)
        updateDraft((current) => ({
          ...current,
          referenceCreationIds: next.flatMap((reference) => reference.creationId ? [reference.creationId] : []),
        }))
      }
      const invalidCount = files.length - validFiles.length
      if (invalidCount) {
        toast(`${invalidCount} reference${invalidCount === 1 ? '' : 's'} skipped · use JPEG, PNG or WebP up to 10 MB`)
      }
      if (validFiles.length > toAdd.length) {
        toast(`${model} accepts up to ${limit} reference image${limit === 1 ? '' : 's'}`)
      }
    } finally {
      referenceImportingRef.current = false
      if (mountedRef.current) setReferenceImporting(false)
    }
  }

  const addReferenceCreations = async (selected: Creation[]) => {
    if (referenceImportingRef.current || referencesBlocked || !selected.length) return
    const model = draftRef.current.model
    const limit = globalReferenceLimit(draftRef.current)
    const current = referenceImagesRef.current
    const existingIds = new Set([
      ...current.flatMap((reference) => reference.creationId ? [reference.creationId] : []),
      ...draftRef.current.scenes.flatMap((scene) => scene.referenceCreationIds),
      ...adjacentStoryboardReferenceIds(draftRef.current),
    ])
    const additions = selected
      .filter((creation) => creation.kind === 'image' && !!creation.url && !existingIds.has(creation.id))
      .slice(0, Math.max(0, limit - current.length))
      .map((creation, index): StoryboardReferenceImage => ({
        id: `story-ref-${creation.id}-${referenceIdCounterRef.current++}`,
        kind: 'upload',
        name: creation.prompt?.trim() || creation.model?.trim() || `Storyboard reference ${current.length + index + 1}`,
        url: creation.url,
        creationId: creation.id,
      }))
    if (!additions.length) {
      toast(current.length >= limit ? `${model} already has its maximum ${limit} reference image${limit === 1 ? '' : 's'}` : 'Those Library images are already attached')
      return
    }
    const next = [...current, ...additions]
    referenceImagesRef.current = next
    setReferenceImages(next)
    updateDraft((draft) => ({
      ...draft,
      referenceCreationIds: next.flatMap((reference) => reference.creationId ? [reference.creationId] : []),
    }))
  }

  const grabReferenceFrame = async () => {
    if (referenceImportingRef.current || referencesBlocked) return
    const model = draftRef.current.model
    const limit = globalReferenceLimit(draftRef.current)
    if (referenceImagesRef.current.length >= limit) {
      toast(`${model} already has its maximum ${limit} reference image${limit === 1 ? '' : 's'}`)
      return
    }
    referenceImportingRef.current = true
    setReferenceImporting(true)
    try {
      const grabbed = await resolve.grabFrame()
      if (!grabbed.ok || !grabbed.blobUrl) {
        toast(`Frame capture failed · ${grabbed.error || 'check Resolve and the playhead'}`)
        return
      }
      const [creation] = addCreations([{
        kind: 'image',
        url: grabbed.blobUrl,
        model: 'Storyboard reference',
        prompt: grabbed.name,
        meta: 'Storyboard reference · Resolve frame',
        fromTimeline: true,
      }])
      if (!creation) {
        URL.revokeObjectURL(grabbed.blobUrl)
        toast('The grabbed frame could not be saved as a reference')
        return
      }
      const reference: StoryboardReferenceImage = {
        id: `story-ref-${Date.now().toString(36)}-${referenceIdCounterRef.current++}`,
        kind: 'upload',
        name: grabbed.name,
        url: creation.url,
        creationId: creation.id,
      }
      const current = referenceImagesRef.current
      const latestLimit = globalReferenceLimit(draftRef.current)
      if (current.length >= latestLimit) return
      const next = [...current, reference]
      referenceImagesRef.current = next
      setReferenceImages(next)
      updateDraft((draft) => ({
        ...draft,
        referenceCreationIds: next.flatMap((item) => item.creationId ? [item.creationId] : []),
      }))
    } finally {
      referenceImportingRef.current = false
      if (mountedRef.current) setReferenceImporting(false)
    }
  }

  const removeReferenceImage = (referenceId: string) => {
    if (referencesBlocked || referenceImportingRef.current) return
    const current = referenceImagesRef.current
    const target = current.find((reference) => reference.id === referenceId)
    if (target) releaseReferenceImages([target])
    const next = current.filter((reference) => reference.id !== referenceId)
    referenceImagesRef.current = next
    setReferenceImages(next)
    updateDraft((draft) => ({
      ...draft,
      referenceCreationIds: next.flatMap((reference) => reference.creationId ? [reference.creationId] : []),
    }))
  }

  const sceneReferencesFor = useCallback((scene: StoryboardScene): StoryboardReferenceImage[] => {
    const globalIds = new Set(draftRef.current.referenceCreationIds)
    return referencesFromCreationIds(
      scene.referenceCreationIds.filter((creationId) => !globalIds.has(creationId)),
      creationsById,
      scene.title.trim() || 'Scene',
    )
  }, [creationsById])

  const addSceneReferenceFiles = async (sceneId: string, files: File[]) => {
    if (referenceImportingRef.current || referencesBlocked || !files.length) return
    referenceImportingRef.current = true
    setReferenceImporting(true)
    try {
      const validity = await Promise.all(files.map(isDecodableReferenceImageFile))
      const validFiles = files.filter((_, index) => validity[index])
      const currentScene = draftRef.current.scenes.find((scene) => scene.id === sceneId)
      if (!currentScene) return
      const model = draftRef.current.model
      const limit = sceneReferenceLimit(draftRef.current)
      const remaining = Math.max(0, limit - currentScene.referenceCreationIds.length)
      const toAdd = validFiles.slice(0, remaining)
      const objectUrls = toAdd.map((file) => URL.createObjectURL(file))
      const imported = addCreations(toAdd.map((file, index) => ({
        kind: 'image',
        url: objectUrls[index],
        model: 'Storyboard scene reference',
        prompt: file.name,
        meta: `Storyboard scene reference · ${file.type || 'image'}`,
      })))
      objectUrls.slice(imported.length).forEach((url) => URL.revokeObjectURL(url))
      if (imported.length) {
        updateScene(sceneId, (scene) => ({
          ...scene,
          referenceCreationIds: [...scene.referenceCreationIds, ...imported.map((creation) => creation.id)]
            .slice(0, sceneReferenceLimit(draftRef.current)),
        }))
      }
      const invalidCount = files.length - validFiles.length
      if (invalidCount) toast(`${invalidCount} reference${invalidCount === 1 ? '' : 's'} skipped · use JPEG, PNG or WebP up to 10 MB`)
      if (validFiles.length > toAdd.length) toast(`${model} accepts up to ${limit} references for each scene`)
    } finally {
      referenceImportingRef.current = false
      if (mountedRef.current) setReferenceImporting(false)
    }
  }

  const addSceneReferenceCreations = async (sceneId: string, selected: Creation[]) => {
    if (referenceImportingRef.current || referencesBlocked || !selected.length) return
    const scene = draftRef.current.scenes.find((item) => item.id === sceneId)
    if (!scene) return
    const limit = sceneReferenceLimit(draftRef.current)
    const existing = new Set([
      ...scene.referenceCreationIds,
      ...draftRef.current.referenceCreationIds,
      ...adjacentStoryboardReferenceIds(draftRef.current),
    ])
    const additions = selected
      .filter((creation) => creation.kind === 'image' && !!creation.url && !existing.has(creation.id))
      .slice(0, Math.max(0, limit - scene.referenceCreationIds.length))
      .map((creation) => creation.id)
    if (!additions.length) {
      toast(scene.referenceCreationIds.length >= limit ? `${draftRef.current.model} already has its maximum ${limit} scene references` : 'Those Library images are already attached to this scene')
      return
    }
    updateScene(sceneId, (current) => ({
      ...current,
      referenceCreationIds: [...current.referenceCreationIds, ...additions].slice(0, limit),
    }))
  }

  const grabSceneReferenceFrame = async (sceneId: string) => {
    if (referenceImportingRef.current || referencesBlocked) return
    const currentScene = draftRef.current.scenes.find((scene) => scene.id === sceneId)
    if (!currentScene) return
    const limit = sceneReferenceLimit(draftRef.current)
    if (currentScene.referenceCreationIds.length >= limit) {
      toast(`${draftRef.current.model} already has its maximum ${limit} scene references`)
      return
    }
    referenceImportingRef.current = true
    setReferenceImporting(true)
    try {
      const grabbed = await resolve.grabFrame()
      if (!grabbed.ok || !grabbed.blobUrl) {
        toast(`Frame capture failed · ${grabbed.error || 'check Resolve and the playhead'}`)
        return
      }
      const [creation] = addCreations([{
        kind: 'image',
        url: grabbed.blobUrl,
        model: 'Storyboard scene reference',
        prompt: grabbed.name,
        meta: 'Storyboard scene reference · Resolve frame',
        fromTimeline: true,
      }])
      if (!creation) {
        URL.revokeObjectURL(grabbed.blobUrl)
        toast('The grabbed frame could not be saved as a scene reference')
        return
      }
      updateScene(sceneId, (scene) => ({
        ...scene,
        referenceCreationIds: scene.referenceCreationIds.includes(creation.id)
          ? scene.referenceCreationIds
          : [...scene.referenceCreationIds, creation.id].slice(0, sceneReferenceLimit(draftRef.current)),
      }))
    } finally {
      referenceImportingRef.current = false
      if (mountedRef.current) setReferenceImporting(false)
    }
  }

  const removeSceneReference = (sceneId: string, referenceId: string) => {
    if (referencesBlocked || referenceImportingRef.current) return
    const creationId = referenceId.replace(/^story-ref-/, '')
    updateScene(sceneId, (scene) => ({
      ...scene,
      referenceCreationIds: scene.referenceCreationIds.filter((id) => id !== creationId),
    }))
  }

  const changeWorkflowMode = (workflowMode: StoryboardDraft['workflowMode']) => {
    setStoryReferenceDialogOpen(false)
    setReferenceDialogSceneId(null)
    setContinuityDialogRole(null)
    updateDraft((current) => ({
      ...current,
      workflowMode,
      // The workflow decides how the final board is produced. Full Storyboard
      // always creates a generated board; By Scenes always preserves the
      // selected scene images in its deterministic local board.
      outputStrategy: workflowMode === 'full' ? 'single-generation' : 'scene-composite',
      // Story references remain global in By Scenes. They must never be
      // copied into a row, because a row-level single reference can mean
      // "reuse this exact image" while global references are context only.
      scenes: workflowMode === 'scenes'
        ? current.scenes.map((scene) => ({
          ...scene,
          referenceCreationIds: scene.referenceCreationIds.filter(
            (creationId) => !current.referenceCreationIds.includes(creationId),
          ),
        }))
        : current.scenes,
    }))
    setBoardRuntime({ state: 'idle' })
    setActiveBoardCandidateId(null)
  }

  const handleWorkflowModeKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentMode: StoryboardDraft['workflowMode'],
  ) => {
    let nextMode: StoryboardDraft['workflowMode'] | null = null
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      nextMode = currentMode === 'full' ? 'scenes' : 'full'
    } else if (event.key === 'Home') {
      nextMode = 'full'
    } else if (event.key === 'End') {
      nextMode = 'scenes'
    }
    if (!nextMode) return
    event.preventDefault()
    const group = event.currentTarget.parentElement
    changeWorkflowMode(nextMode)
    requestAnimationFrame(() => {
      group?.querySelector<HTMLButtonElement>(`[data-workflow-mode="${nextMode}"]`)
        ?.focus()
    })
  }

  const changeEnhancerModel = (model: string) => {
    setEnhancerModel(model)
    saveValue(ENHANCER_PREF_KEY, model)
  }

  const enhanceCompleteStory = async () => {
    if (referencesBlocked || briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning') return
    const current = draftRef.current
    const isSceneWorkflow = current.workflowMode === 'scenes'
    const storySnapshot = isSceneWorkflow ? current.storySummary : current.storyBrief
    const referenceSnapshot = [...referenceImagesRef.current]
    const promptingReferences = storyboardPromptingReferences(current, referenceSnapshot, creationsById)
    const contextSnapshot = buildStoryboardEnhancementContext(current)
    if (!canEnhancePrompt(storySnapshot, promptingReferences, SCENE_PROMPT_MIN_LENGTH)) return
    const controller = new AbortController()
    controllersRef.current.set('brief:enhance', controller)
    setBriefRuntime({ state: 'enhancing' })
    try {
      const result = await enhancePrompt({
        rough: storySnapshot,
        targetModel: isSceneWorkflow
          ? `Complete story context for storyboard scenes generated with ${current.model}`
          : `Complete storyboard planned for ${current.model}`,
        mediaKind: 'workflow',
        purpose: 'story-brief',
        chatModel: enhancerModel,
        maxLength: Math.min(
          ENHANCE_MAX_LENGTH,
          isSceneWorkflow ? STORYBOARD_MAX_STORY_SUMMARY_LENGTH : STORYBOARD_MAX_STORY_BRIEF_LENGTH,
        ),
        style: current.style || undefined,
        references: promptingReferences,
        supportingContext: {
          label: 'current storyboard context',
          text: contextSnapshot,
          instruction: STORYBOARD_CONTEXT_INSTRUCTION,
        },
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onSpend(result.credits ?? 0)
      const latestStory = isSceneWorkflow ? draftRef.current.storySummary : draftRef.current.storyBrief
      if (latestStory !== storySnapshot || draftRef.current.workflowMode !== current.workflowMode) {
        toast('Complete story context changed while AI was working · your newer text was kept')
        setBriefRuntime({ state: 'idle' })
        return
      }
      if (buildStoryboardEnhancementContext(draftRef.current) !== contextSnapshot) {
        toast('Storyboard context changed while AI was working · improve again to use the latest scenes')
        setBriefRuntime({ state: 'idle' })
        return
      }
      updateDraft((latest) => isSceneWorkflow
        ? { ...latest, storySummary: result.text }
        : { ...latest, storyBrief: result.text })
      setBriefRuntime({ state: 'idle', note: actionNote('Improved', result.credits) })
    } catch (error) {
      if (controller.signal.aborted) return
      setBriefRuntime({ state: 'error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      controllersRef.current.delete('brief:enhance')
    }
  }

  const enhanceScene = async (sceneId: string) => {
    if (referencesBlocked || inFlightSceneIdsRef.current.has(sceneId)) return
    const currentDraft = draftRef.current
    const scene = currentDraft.scenes.find((item) => item.id === sceneId)
    if (!scene) return
    const latestCreationsById = new Map(getCreations().map((creation) => [creation.id, creation]))
    const sceneReferences = currentDraft.workflowMode === 'scenes'
      ? referencesFromCreationIds(
        [...new Set([...currentDraft.referenceCreationIds, ...scene.referenceCreationIds])],
        latestCreationsById,
        scene.title.trim() || 'Scene',
      )
      : referenceImagesRef.current
    const promptingReferences = storyboardPromptingReferences(currentDraft, sceneReferences, latestCreationsById)
    if (!canEnhancePrompt(scene.prompt, promptingReferences, SCENE_PROMPT_MIN_LENGTH)) return
    const promptSnapshot = scene.prompt
    const modelSnapshot = currentDraft.model
    const styleSnapshot = currentDraft.style
    const promptMaxSnapshot = storyboardScenePromptMax(modelSnapshot, styleSnapshot, {
      previous: Boolean(currentDraft.previousStoryboardCreationId),
      next: Boolean(currentDraft.nextStoryboardCreationId),
      globalReferenceCount: new Set(currentDraft.referenceCreationIds).size,
      currentReferenceCount: currentDraft.workflowMode === 'scenes'
        ? new Set(scene.referenceCreationIds.filter((creationId) => !currentDraft.referenceCreationIds.includes(creationId))).size
        : 0,
      sceneOrdinal: currentDraft.scenes.findIndex((item) => item.id === sceneId),
      sceneCount: currentDraft.scenes.length,
    })
    const contextSnapshot = buildStoryboardEnhancementContext(currentDraft, sceneId)
    const controller = new AbortController()
    controllersRef.current.set(`enhance:${sceneId}`, controller)
    setSceneRuntime(sceneId, { state: 'enhancing' })
    try {
      const result = await enhancePrompt({
        rough: promptSnapshot,
        targetModel: modelSnapshot,
        mediaKind: 'image',
        purpose: 'story-scene',
        chatModel: enhancerModel,
        maxLength: promptMaxSnapshot,
        style: styleSnapshot || undefined,
        references: promptingReferences,
        supportingContext: {
          label: 'complete storyboard context',
          text: contextSnapshot,
          instruction: STORYBOARD_CONTEXT_INSTRUCTION,
        },
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onSpend(result.credits ?? 0)
      const latest = draftRef.current.scenes.find((item) => item.id === sceneId)
      if (!latest) return
      if (latest.prompt !== promptSnapshot) {
        toast('Scene changed while AI was working · your newer text was kept')
        setSceneRuntime(sceneId, { state: 'idle' })
        return
      }
      if (buildStoryboardEnhancementContext(draftRef.current, sceneId) !== contextSnapshot) {
        toast('Storyboard context changed while AI was working · improve again to use the latest scenes')
        setSceneRuntime(sceneId, { state: 'idle' })
        return
      }
      updateScene(sceneId, (current) => ({ ...current, prompt: result.text }))
      setSceneRuntime(sceneId, { state: 'idle', note: actionNote('Improved', result.credits) })
    } catch (error) {
      if (controller.signal.aborted) return
      setSceneRuntime(sceneId, { state: 'error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      controllersRef.current.delete(`enhance:${sceneId}`)
    }
  }

  const generateScene = useCallback(async (
    sceneSnapshot: StoryboardScene,
    settings: GenerationSnapshot,
    ordinal: number,
    alreadyClaimed = false,
  ): Promise<boolean> => {
    const sceneId = sceneSnapshot.id
    const requestedVersions = clampStoryboardVersionCount(settings.versionCount)
    if (!alreadyClaimed) {
      if (inFlightSceneIdsRef.current.has(sceneId)) return false
      inFlightSceneIdsRef.current.add(sceneId)
    }
    const promptSnapshot = sceneSnapshot.prompt.trim()
    const inputFingerprint = sceneInputFingerprintFromSnapshot(promptSnapshot, settings, ordinal)
    const generationMetadata = {
      promptSnapshot,
      inputFingerprint,
      model: settings.model,
      aspect: settings.aspect,
      resolution: settings.resolution,
      extras: { ...settings.extras },
      attachedCreationIds: [] as string[],
    }
    const availableReferenceIds = getCreations()
      .filter((creation) => creation.kind === 'image' && Boolean(creation.url))
      .map((creation) => creation.id)
    const missingReferenceIds = findMissingStoryboardReferenceIds(settings.referenceCreationIds, availableReferenceIds)
    if (missingReferenceIds.length || settings.references.length !== settings.referenceCreationIds.length) {
      inFlightSceneIdsRef.current.delete(sceneId)
      setSceneRuntime(sceneId, {
        state: 'error',
        error: 'One or more scene references are still restoring from Library. Generation was not started.',
      })
      return false
    }
    if (promptSnapshot.length < SCENE_PROMPT_MIN_LENGTH) {
      if (settings.allowExactReferenceReuse && !promptSnapshot && settings.exactReferenceCreationIds.length === 1) {
        const referenceCreationId = settings.exactReferenceCreationIds[0]
        const creation = getCreations().find((item) => item.id === referenceCreationId && item.kind === 'image' && !!item.url)
        if (!creation) {
          inFlightSceneIdsRef.current.delete(sceneId)
          setSceneRuntime(sceneId, { state: 'error', error: 'This scene reference is still restoring from Library.' })
          return false
        }
        const candidate: StoryboardSceneCandidate = {
          creationId: creation.id,
          promptSnapshot: '',
          inputFingerprint,
          model: settings.model,
          aspect: settings.aspect,
          resolution: settings.resolution,
          extras: { ...settings.extras },
          createdAt: creation.createdAt,
        }
        updateDraft((current) => ({
          ...current,
          scenes: current.scenes.map((scene) => scene.id === sceneId ? {
            ...scene,
            candidates: appendStoryboardCandidates(scene, [candidate]),
            approvedCreationId: creation.id,
            approvedPromptSnapshot: '',
          } : scene),
        }))
        setActiveCandidateIds((current) => ({ ...current, [sceneId]: creation.id }))
        setSceneRuntime(sceneId, { state: 'idle', note: 'Exact reference ready' })
        inFlightSceneIdsRef.current.delete(sceneId)
        return true
      }
      inFlightSceneIdsRef.current.delete(sceneId)
      setSceneRuntime(sceneId, {
        state: 'error',
        error: settings.allowExactReferenceReuse && !promptSnapshot && settings.exactReferenceCreationIds.length > 1
          ? 'Add a prompt to explain how the attached references should be used, or keep one exact image.'
          : 'Describe this scene with at least 3 characters.',
      })
      return false
    }
    const compiledPrompt = effectiveScenePrompt(promptSnapshot, settings.style, {
      previous: settings.previousStoryboardAttached,
      next: settings.nextStoryboardAttached,
      globalReferenceCount: settings.globalReferenceCount,
      currentReferenceCount: settings.sceneReferenceCount,
      sceneOrdinal: ordinal,
      sceneCount: settings.sceneCount,
    })
    const providerPromptMax = IMAGE_MODEL_CONFIG[settings.model].promptMax
    if (promptCharacterCount(compiledPrompt) > providerPromptMax) {
      inFlightSceneIdsRef.current.delete(sceneId)
      setSceneRuntime(sceneId, {
        state: 'error',
        error: `${settings.model} accepts ${providerPromptMax.toLocaleString()} prompt characters including the selected visual direction. Shorten this scene before generating.`,
      })
      return false
    }

    const controller = new AbortController()
    let jobId: string | null = null
    controllersRef.current.set(`generate:${sceneId}`, controller)
    setSceneRuntime(sceneId, {
      state: 'generating',
      requestedVersions,
      generation: generationMetadata,
    })
    try {
      const estimate = imageRunEstimate(
        settings.model,
        settings.resolution,
        settings.extras,
        requestedVersions,
        { referenceCount: settings.references.length },
      )
      const result = await runImage({
        jobTitle: `Storyboard · ${sceneLabel(ordinal)}${requestedVersions > 1 ? ` · ${requestedVersions} versions` : ''}`,
        model: settings.model,
        prompt: compiledPrompt,
        aspect: settings.aspect,
        resolution: settings.resolution,
        extras: settings.extras,
        refs: settings.references,
        count: requestedVersions,
      }, {
        signal: controller.signal,
        onJobCreated: (nextJobId) => {
          jobId = nextJobId
          sceneJobIdsRef.current.set(sceneId, nextJobId)
          setSceneRuntime(sceneId, {
            state: 'generating',
            jobId: nextJobId,
            requestedVersions,
            generation: generationMetadata,
          })
        },
      })
      if (controller.signal.aborted) return false
      const charged = result.credits ?? resolveCharged(estimate)
      onSpend(charged ?? 0)
      const urls = [...new Set(result.urls.filter(Boolean))].slice(0, requestedVersions)
      if (!urls.length) throw new Error('No frame was returned for this scene.')
      const savedCreations = addCreations(urls.map((url, versionIndex) => ({
        kind: 'image' as const,
        url,
        model: settings.model,
        prompt: promptSnapshot,
        meta: `Storyboard · ${sceneLabel(ordinal)} · Version ${versionIndex + 1}/${requestedVersions} · ${settings.aspect}${settings.resolution ? ` · ${settings.resolution}` : ''}`,
      })))
      const creations = [...new Map(savedCreations.map((creation) => [creation.id, creation])).values()]
      if (!creations.length) throw new Error('The generated frames could not be saved to Library.')
      const candidates: StoryboardSceneCandidate[] = creations.map((creation) => ({
        creationId: creation.id,
        promptSnapshot,
        inputFingerprint,
        model: settings.model,
        aspect: settings.aspect,
        resolution: settings.resolution,
        extras: { ...settings.extras },
        createdAt: creation.createdAt,
      }))
      const firstCreation = creations[0]
      const attached = draftRef.current.scenes.some((scene) => scene.id === sceneId)
      updateDraft((current) => ({
        ...current,
        scenes: current.scenes.map((scene) => {
          if (scene.id !== sceneId) return scene
          const existingApproval = findStoryboardCandidate(scene, scene.approvedCreationId)
          const keepExistingApproval = existingApproval?.inputFingerprint === inputFingerprint
          return {
            ...scene,
            candidates: appendStoryboardCandidates(scene, candidates),
            approvedCreationId: keepExistingApproval ? scene.approvedCreationId : firstCreation.id,
            approvedPromptSnapshot: keepExistingApproval ? scene.approvedPromptSnapshot : promptSnapshot,
          }
        }),
      }))
      setActiveCandidateIds((current) => ({ ...current, [sceneId]: firstCreation.id }))
      const fullyCompleted = creations.length >= requestedVersions && result.failedJobs === 0 && result.pendingJobs === 0
      const resultNote = requestedVersions > 1
        ? fullyCompleted
          ? `${creations.length} versions ready`
          : result.pendingJobs
            ? `${creations.length} of ${requestedVersions} versions ready · ${result.pendingJobs} still in Activity`
            : `${creations.length} of ${requestedVersions} versions ready`
        : result.pendingJobs ? 'Frame is finishing in Activity' : 'Frame ready'
      setSceneRuntime(sceneId, result.pendingJobs && jobId ? {
        state: 'pending',
        note: resultNote,
        jobId,
        requestedVersions,
        generation: {
          ...generationMetadata,
          attachedCreationIds: creations.map((creation) => creation.id),
        },
      } : {
        state: 'idle',
        note: resultNote,
        requestedVersions,
      })
      if (!attached) toast('Scene was removed · the generated frame is still safe in Library')
      return fullyCompleted
    } catch (error) {
      if (controller.signal.aborted || isGenerationExit(error)) {
        const job = jobId ? getJobs().find((item) => item.id === jobId) : undefined
        setSceneRuntime(sceneId, {
          state: 'idle',
          note: job && canBackgroundJob(job) ? 'Continuing in Activity' : 'Generation cancelled',
        })
        return false
      }
      setSceneRuntime(sceneId, { state: 'error', error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      controllersRef.current.delete(`generate:${sceneId}`)
      sceneJobIdsRef.current.delete(sceneId)
      inFlightSceneIdsRef.current.delete(sceneId)
    }
  }, [onSpend, setSceneRuntime, toast, updateDraft])

  const generateOne = (sceneId: string) => {
    if (referenceImportingRef.current || referencesBlocked) return
    const current = draftRef.current
    const scene = current.scenes.find((item) => item.id === sceneId)
    if (!scene) return
    const continuityConflict = findStoryboardContinuityReferenceConflict(current)
    if (continuityConflict) {
      toast(`One image cannot be both ${continuityConflict.roles.join(' and ')} · choose a different reference`)
      return
    }
    const ordinal = current.scenes.findIndex((item) => item.id === sceneId)
    const exactReferenceCreationIds = current.workflowMode === 'scenes'
      ? scene.referenceCreationIds.filter((creationId) => !current.referenceCreationIds.includes(creationId))
      : [...current.referenceCreationIds]
    const referenceCompile = compileStoryboardSceneReferenceManifest(current, exactReferenceCreationIds, ordinal + 1)
    if (!referenceCompile.ok) {
      setSceneRuntime(sceneId, { state: 'error', error: referenceCompile.error })
      toast(referenceCompile.error)
      return
    }
    const referenceCreationIds = referenceCompile.referenceCreationIds
    const references = referencesFromCreationIds(
      referenceCreationIds,
      new Map(getCreations().map((creation) => [creation.id, creation])),
      scene.title.trim() || sceneLabel(ordinal),
    )
    const versionCount = clampStoryboardVersionCount(scene.versionCount)
    const settings: GenerationSnapshot = {
      model: current.model,
      aspect: current.aspect,
      resolution: current.resolution,
      extras: { ...current.extras },
      style: current.style,
      references,
      referenceCreationIds,
      exactReferenceCreationIds,
      globalReferenceCount: referenceCompile.referenceManifest.filter((item) => item.scope === 'global').length,
      sceneReferenceCount: referenceCompile.referenceManifest.filter((item) => item.scope === 'scenes').length,
      previousStoryboardAttached: referenceCompile.previousStoryboardAttached,
      nextStoryboardAttached: referenceCompile.nextStoryboardAttached,
      sceneCount: current.scenes.length,
      allowExactReferenceReuse: current.workflowMode === 'scenes',
      versionCount,
    }
    void generateScene(scene, settings, ordinal)
  }

  const exitSceneGeneration = (sceneId: string) => {
    const controller = controllersRef.current.get(`generate:${sceneId}`)
    const jobId = sceneJobIdsRef.current.get(sceneId) ?? runtime[sceneId]?.jobId
    const job = jobId ? getJobs().find((item) => item.id === jobId) : undefined
    let backgrounded = false
    if (job) {
      if (canCancelJob(job)) cancelJob(job.id)
      else if (canBackgroundJob(job)) {
        continueJobInBackground(job.id)
        backgrounded = true
      }
    }
    controller?.abort()
    setSceneRuntime(sceneId, {
      state: 'idle',
      note: backgrounded ? 'Continuing in Activity' : 'Generation cancelled',
    })
    toast(backgrounded
      ? 'Frame continues in Activity · the result will be saved to Library'
      : 'Frame generation cancelled')
  }

  const generateAll = useCallback(async (
    sourceDraft?: StoryboardDraft,
    options: GenerateAllOptions = {},
  ) => {
    if (referenceImportingRef.current || referencesBlocked || batchRunning || Object.values(runtime).some((scene) => scene.state === 'enhancing' || scene.state === 'generating' || scene.state === 'pending')) return false
    const current = sourceDraft ?? draftRef.current
    const continuityConflict = findStoryboardContinuityReferenceConflict(current)
    if (continuityConflict) {
      toast(`One image cannot be both ${continuityConflict.roles.join(' and ')} · choose a different reference`)
      return false
    }
    const sharedVersionCount = clampStoryboardVersionCount(current.versionCount)
    const pending: StoryboardSceneVersionPlan[] = options.ensureRequestedVersions
      ? separateSceneVersionPlan(current, availableStoryboardImageIds(getCreations()))
        .filter(({ scene }) => (
          !inFlightSceneIdsRef.current.has(scene.id)
          && scene.prompt.trim().length >= SCENE_PROMPT_MIN_LENGTH
        ))
      : current.scenes.flatMap((scene, index) => {
        const action = storyboardSceneCompletionAction(
          scene,
          current.workflowMode === 'scenes',
          expectedSceneInputFingerprintForDraft(current, scene, index),
        )
        return !inFlightSceneIdsRef.current.has(scene.id) && (action === 'generate' || action === 'use-reference')
          ? [{ scene, versionCount: sharedVersionCount }]
          : []
      })
    if (!pending.length) {
      return options.ensureRequestedVersions
        ? separateSceneVersionPlan(current, availableStoryboardImageIds(getCreations())).length === 0
        : current.scenes.every((scene, index) => !isStoryboardApprovalStale(
          scene,
          expectedSceneInputFingerprintForDraft(current, scene, index),
        ) && isStoryboardSceneApproved(scene))
    }
    const compiledReferencesBySceneId = new Map<string, {
      referenceCreationIds: string[]
      globalReferenceCount: number
      sceneReferenceCount: number
      previousStoryboardAttached: boolean
      nextStoryboardAttached: boolean
    }>()
    for (const { scene } of pending) {
      const ordinal = current.scenes.findIndex((item) => item.id === scene.id)
      const currentReferenceCreationIds = current.workflowMode === 'scenes'
        ? scene.referenceCreationIds
        : current.referenceCreationIds
      const referenceCompile = compileStoryboardSceneReferenceManifest(
        current,
        currentReferenceCreationIds,
        ordinal + 1,
      )
      if (!referenceCompile.ok) {
        setSceneRuntime(scene.id, { state: 'error', error: referenceCompile.error })
        toast(referenceCompile.error)
        return false
      }
      compiledReferencesBySceneId.set(scene.id, {
        referenceCreationIds: referenceCompile.referenceCreationIds,
        globalReferenceCount: referenceCompile.referenceManifest.filter((item) => item.scope === 'global').length,
        sceneReferenceCount: referenceCompile.referenceManifest.filter((item) => item.scope === 'scenes').length,
        previousStoryboardAttached: referenceCompile.previousStoryboardAttached,
        nextStoryboardAttached: referenceCompile.nextStoryboardAttached,
      })
    }
    pending.forEach(({ scene }) => inFlightSceneIdsRef.current.add(scene.id))
    batchCancelRef.current = false
    setBatchCancelling(false)
    setBatchRunning(true)
    setBatchProgress({ complete: 0, total: pending.length })
    let cursor = 0
    let completed = 0
    let allSucceeded = true
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      for (;;) {
        if (!mountedRef.current || batchCancelRef.current) return
        const queueIndex = cursor
        cursor += 1
        const pendingScene = pending[queueIndex]
        if (!pendingScene) return
        const { scene, versionCount } = pendingScene
        const ordinal = current.scenes.findIndex((item) => item.id === scene.id)
        const latestCreations = new Map(getCreations().map((creation) => [creation.id, creation]))
        const usesSceneReferences = current.workflowMode === 'scenes'
        const exactReferenceCreationIds = usesSceneReferences
          ? scene.referenceCreationIds.filter((creationId) => !current.referenceCreationIds.includes(creationId))
          : [...current.referenceCreationIds]
        const referenceCompile = compiledReferencesBySceneId.get(scene.id)!
        const referenceCreationIds = referenceCompile.referenceCreationIds
        const references = referencesFromCreationIds(
          referenceCreationIds,
          latestCreations,
          scene.title.trim() || sceneLabel(ordinal),
        )
        const settings: GenerationSnapshot = {
          model: current.model,
          aspect: current.aspect,
          resolution: current.resolution,
          extras: { ...current.extras },
          style: current.style,
          references,
          referenceCreationIds,
          exactReferenceCreationIds,
          globalReferenceCount: referenceCompile.globalReferenceCount,
          sceneReferenceCount: referenceCompile.sceneReferenceCount,
          previousStoryboardAttached: referenceCompile.previousStoryboardAttached,
          nextStoryboardAttached: referenceCompile.nextStoryboardAttached,
          sceneCount: current.scenes.length,
          allowExactReferenceReuse: current.workflowMode === 'scenes',
          versionCount,
        }
        const succeeded = await generateScene(scene, settings, ordinal, true)
        if (!succeeded) allSucceeded = false
        completed += 1
        if (mountedRef.current) setBatchProgress({ complete: completed, total: pending.length })
      }
    })
    await Promise.allSettled(workers)
    if (!mountedRef.current) return
    const wasCancelled = batchCancelRef.current
    pending.forEach(({ scene }) => inFlightSceneIdsRef.current.delete(scene.id))
    setBatchRunning(false)
    setBatchCancelling(false)
    const approvedDraft = draftRef.current
    const approved = approvedDraft.scenes.filter((scene, index) => (
      isStoryboardSceneApproved(scene)
      && !isStoryboardApprovalStale(scene, expectedSceneInputFingerprintForDraft(approvedDraft, scene, index))
    )).length
    if (wasCancelled) {
      toast('Storyboard generation stopped · submitted frames continue safely in Activity')
    } else if (approved === draftRef.current.scenes.length && allSucceeded) {
      toast('Storyboard ready · every approved frame was preserved')
      window.setTimeout(() => finalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } else {
      toast('Generation finished · completed frames were kept')
    }
    return !wasCancelled && allSucceeded
  }, [batchRunning, generateScene, referencesBlocked, runtime, toast])

  const exitBatchGeneration = () => {
    if (!batchRunning || batchCancelling) return
    batchCancelRef.current = true
    setBatchCancelling(true)
    let backgrounded = 0
    controllersRef.current.forEach((controller, key) => {
      if (!key.startsWith('generate:')) return
      const sceneId = key.slice('generate:'.length)
      const jobId = sceneJobIdsRef.current.get(sceneId) ?? runtime[sceneId]?.jobId
      const job = jobId ? getJobs().find((item) => item.id === jobId) : undefined
      if (job) {
        if (canCancelJob(job)) cancelJob(job.id)
        else if (canBackgroundJob(job)) {
          continueJobInBackground(job.id)
          backgrounded += 1
        }
      }
      controller.abort()
    })
    toast(backgrounded
      ? `${backgrounded} submitted frame${backgrounded === 1 ? '' : 's'} will finish in Activity · remaining frames cancelled`
      : 'Stopping storyboard generation…')
  }

  const generateSingleBoard = async (
    sourceDraft?: StoryboardDraft,
    options: { skipConfirmation?: boolean } = {},
  ): Promise<boolean> => {
    if (
      controllersRef.current.has('board:generate')
      || referenceImportingRef.current
      || referencesBlocked
      || batchRunning
      || exportingBoard
    ) return false
    const current = sourceDraft ?? draftRef.current
    if (current.workflowMode !== 'full') {
      toast('Complete-board generation is available in Full Storyboard. By Scenes preserves its selected scene images.')
      return false
    }
    const compiled = compileGeneratedStoryboardBoard(current)
    if (!compiled.ok) {
      setBoardRuntime({ state: 'error', error: compiled.error })
      toast(compiled.error)
      return false
    }
    const latestCreations = new Map(getCreations().map((creation) => [creation.id, creation]))
    const references = referencesFromCreationIds(
      compiled.referenceCreationIds,
      latestCreations,
      'Complete storyboard',
    )
    if (references.length !== compiled.referenceCreationIds.length) {
      const error = 'One or more storyboard references are still restoring from Library. Generation was not started.'
      setBoardRuntime({ state: 'error', error })
      toast(error)
      return false
    }
    if (!isConnected()) {
      const error = 'Connect EasyField Cloud to generate the complete storyboard.'
      setBoardRuntime({ state: 'error', error })
      toast(error)
      return false
    }

    const requestedVersions = clampStoryboardVersionCount(current.versionCount)
    const estimate = imageRunEstimate(
      current.model,
      current.resolution,
      current.extras,
      requestedVersions,
      { referenceCount: references.length },
    )
    if (!options.skipConfirmation) {
      const confirmed = window.confirm(
        `Create the complete storyboard as ${requestedVersions === 1 ? 'one generated board image' : `${requestedVersions} generated board versions`}?\n\nEstimated cost: ${formatEstimate(estimate, false)}. Every result is saved to Library immediately.`,
      )
      if (!confirmed) return false
    }

    const controller = new AbortController()
    let jobId: string | null = null
    const generation = {
      promptSnapshot: compiled.prompt,
      inputFingerprint: compiled.inputFingerprint,
      model: current.model,
      aspect: current.aspect,
      resolution: current.resolution,
      extras: { ...current.extras },
      attachedCreationIds: [] as string[],
    }
    controllersRef.current.set('board:generate', controller)
    setBoardRuntime({ state: 'generating', requestedVersions, generation })
    try {
      const result = await runImage({
        jobTitle: `Storyboard · Complete board${requestedVersions > 1 ? ` · ${requestedVersions} versions` : ''}`,
        jobRecoveryMetadata: createStoryboardBoardJobMetadata(STORYBOARD_DRAFT_KEY, {
          requestedVersions,
          ...generation,
        }),
        model: current.model,
        prompt: compiled.prompt,
        aspect: current.aspect,
        resolution: current.resolution,
        extras: current.extras,
        refs: references,
        count: requestedVersions,
      }, {
        signal: controller.signal,
        onJobCreated: (nextJobId) => {
          jobId = nextJobId
          boardJobIdRef.current = nextJobId
          setBoardRuntime({
            state: 'generating',
            jobId: nextJobId,
            requestedVersions,
            generation,
          })
        },
      })
      if (controller.signal.aborted) return false
      const charged = result.credits ?? resolveCharged(estimate)
      onSpend(charged ?? 0)
      const urls = [...new Set(result.urls.filter(Boolean))].slice(0, requestedVersions)
      if (!urls.length) throw new Error('No complete storyboard image was returned.')
      const saved = addCreations(urls.map((url, versionIndex) => ({
        kind: 'image' as const,
        url,
        model: current.model,
        prompt: storyboardCompleteStory(current) || compiled.prompt,
        meta: `Complete storyboard · Single brief-driven generation · Version ${versionIndex + 1}/${requestedVersions} · ${current.aspect}${current.resolution ? ` · ${current.resolution}` : ''}`,
      })))
      if (!saved.length) throw new Error('The generated storyboard could not be saved to Library.')
      const candidates: StoryboardBoardCandidate[] = saved.map((creation) => ({
        creationId: creation.id,
        ...(jobId ? { jobId } : {}),
        strategy: 'single-generation',
        promptSnapshot: compiled.prompt,
        inputFingerprint: compiled.inputFingerprint,
        sourceSceneCreationIds: [],
        model: current.model,
        aspect: current.aspect,
        resolution: current.resolution,
        extras: { ...current.extras },
        createdAt: creation.createdAt,
      }))
      updateDraft((latest) => {
        const keepExistingApproval = latest.boardCandidates.some((candidate) => (
          candidate.creationId === latest.approvedBoardCreationId
          && candidate.strategy === 'single-generation'
          && candidate.inputFingerprint === compiled.inputFingerprint
        ))
        return {
          ...latest,
          boardCandidates: appendStoryboardBoardCandidates(latest, candidates),
          approvedBoardCreationId: keepExistingApproval ? latest.approvedBoardCreationId : candidates[0].creationId,
        }
      })
      setActiveBoardCandidateId(candidates[0].creationId)
      setLightbox(saved[0].url)
      const fullyCompleted = saved.length >= requestedVersions && result.failedJobs === 0 && result.pendingJobs === 0
      const note = requestedVersions > 1
        ? fullyCompleted
          ? `${saved.length} complete-board versions ready`
          : result.pendingJobs
            ? `${saved.length} of ${requestedVersions} versions ready · finishing in Activity`
            : `${saved.length} of ${requestedVersions} complete boards ready`
        : result.pendingJobs ? 'Complete board is finishing in Activity' : 'Complete board ready'
      setBoardRuntime(result.pendingJobs && jobId ? {
        state: 'pending',
        note,
        jobId,
        requestedVersions,
        generation: { ...generation, attachedCreationIds: saved.map((creation) => creation.id) },
      } : { state: 'idle', note, requestedVersions })
      toast(fullyCompleted
        ? `Complete storyboard saved · ${saved.length} version${saved.length === 1 ? '' : 's'}`
        : 'Finished board versions were saved · remaining work is visible in Activity')
      return fullyCompleted
    } catch (error) {
      if (controller.signal.aborted || isGenerationExit(error)) {
        const job = jobId ? getJobs().find((item) => item.id === jobId) : undefined
        setBoardRuntime({
          state: 'idle',
          note: job && canBackgroundJob(job) ? 'Continuing in Activity' : 'Board generation cancelled',
        })
        return false
      }
      const message = error instanceof Error ? error.message : String(error)
      setBoardRuntime({ state: 'error', error: message })
      toast(message)
      return false
    } finally {
      controllersRef.current.delete('board:generate')
      boardJobIdRef.current = null
    }
  }

  const exitBoardGeneration = () => {
    const controller = controllersRef.current.get('board:generate')
    const jobId = boardJobIdRef.current ?? boardRuntime.jobId
    const job = jobId ? getJobs().find((item) => item.id === jobId) : undefined
    if (jobId) ignoredBoardJobIdsRef.current.add(jobId)
    let backgrounded = false
    if (job) {
      if (canCancelJob(job)) cancelJob(job.id)
      else if (canBackgroundJob(job)) {
        continueJobInBackground(job.id)
        backgrounded = true
      }
    }
    controller?.abort()
    setBoardRuntime({ state: 'idle', note: backgrounded ? 'Continuing in Activity' : 'Board generation cancelled' })
    toast(backgrounded
      ? 'Complete board continues in Activity · every result is saved to Library'
      : 'Complete-board generation cancelled')
  }

  const generateFullStoryboardPackage = async (sourceDraft?: StoryboardDraft): Promise<boolean> => {
    const current = sourceDraft ?? draftRef.current
    if (current.workflowMode !== 'full') return false
    return generateSingleBoard(current)
  }

  const approveCandidate = (sceneId: string, creationId: string) => {
    updateScene(sceneId, (scene) => {
      const candidate = findStoryboardCandidate(scene, creationId)
      if (!candidate) return scene
      return {
        ...scene,
        approvedCreationId: creationId,
        approvedPromptSnapshot: candidate.promptSnapshot,
      }
    })
    setActiveCandidateIds((current) => ({ ...current, [sceneId]: creationId }))
  }

  const addCandidateToLibrary = (sceneId: string, candidateId: string) => {
    const scene = draftRef.current.scenes.find((item) => item.id === sceneId)
    const candidate = scene ? findStoryboardCandidate(scene, candidateId) : undefined
    const creation = candidate ? creationsById.get(candidate.creationId) : undefined
    if (!candidate || !creation?.url) {
      toast('This frame is not ready for Library yet')
      return
    }
    // Generated frames are persisted immediately for safety. Keep this action
    // idempotent so an editor can deliberately confirm the result without
    // creating duplicate Library records.
    toast('Frame already saved · opening Library')
    onOpenLibrary()
  }

  const downloadCandidate = (sceneId: string, candidateId: string) => {
    const current = draftRef.current
    const index = current.scenes.findIndex((item) => item.id === sceneId)
    const scene = index >= 0 ? current.scenes[index] : undefined
    const candidate = scene ? findStoryboardCandidate(scene, candidateId) : undefined
    const creation = candidate ? creationsById.get(candidate.creationId) : undefined
    if (!candidate || !creation?.url || index < 0) {
      toast('This frame is not ready to download yet')
      return
    }
    saveUrl(
      creation.url,
      `easyfield-storyboard-${String(index + 1).padStart(3, '0')}.${candidateExtension(candidate)}`,
    )
    toast('Downloading scene frame')
  }

  const downloadApprovedFrames = () => {
    let saved = 0
    draftRef.current.scenes.forEach((scene, index) => {
      const candidate = findStoryboardCandidate(scene, scene.approvedCreationId)
      const creation = candidate ? creationsById.get(candidate.creationId) : undefined
      if (!candidate || !creation?.url) return
      saveUrl(creation.url, `easyfield-storyboard-${String(index + 1).padStart(3, '0')}.${candidateExtension(candidate)}`)
      saved += 1
    })
    toast(saved ? `Saving ${saved} approved frame${saved === 1 ? '' : 's'}` : 'No approved frames are ready to save')
  }

  const approveBoardCandidate = (creationId: string) => {
    updateDraft((current) => current.boardCandidates.some((candidate) => (
      candidate.creationId === creationId
      && candidate.strategy === (current.workflowMode === 'full' ? 'single-generation' : 'scene-composite')
      && candidate.inputFingerprint === activeBoardFingerprint
    )) ? { ...current, approvedBoardCreationId: creationId } : current)
    setActiveBoardCandidateId(creationId)
  }

  const downloadBoardCandidate = (creationId: string) => {
    const candidate = draftRef.current.boardCandidates.find((item) => item.creationId === creationId)
    const creation = creationsById.get(creationId)
    if (!candidate || !creation?.url) {
      toast('This complete board is still restoring from Library')
      return
    }
    const extension = candidate.strategy === 'scene-composite' ? 'png' : candidateExtension(candidate)
    saveUrl(creation.url, `${safeExportName(draftRef.current.title)}-${candidate.strategy === 'scene-composite' ? 'exact' : 'generated'}.${extension}`)
    toast('Downloading complete storyboard')
  }

  const resolveAutoTimingForFinalBoard = async (source: StoryboardDraft): Promise<StoryboardDraft | null> => {
    if (source.workflowMode !== 'scenes' || !source.scenes.some((scene) => scene.durationMode === 'auto')) {
      return source
    }
    if (!isConnected()) {
      toast('Connect EasyField Cloud so Auto can pace the final storyboard from the complete story')
      return null
    }
    const controller = new AbortController()
    controllersRef.current.set('board:auto-timing', controller)
    setTimingResolving(true)
    setBoardRuntime({ state: 'idle', note: 'Choosing final pacing from the complete story and every scene…' })
    try {
      const result = await resolveStoryboardAutoTiming({
        completeStory: storyboardCompleteStory(source),
        scenes: source.scenes,
        chatModel: enhancerModel,
        references: completeStoryboardPromptingReferences(
          source,
          new Map(getCreations().map((creation) => [creation.id, creation])),
        ),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return null
      onSpend(result.chatCredits ?? 0)
      const resolved = applyStoryboardSceneDurationResolution(source.scenes, result.scenes)
      const next = { ...source, scenes: resolved.scenes }
      draftRef.current = next
      setDraft(next)
      setBoardRuntime({ state: 'idle', note: `Automatic pacing ready · ${resolved.totalDurationSeconds}s total` })
      return next
    } catch (error) {
      if (controller.signal.aborted) return null
      if (error instanceof ChatError) onSpend(error.credits ?? 0)
      const message = error instanceof Error ? error.message : 'Automatic storyboard timing failed. Try again.'
      setBoardRuntime({ state: 'error', error: message })
      toast(message)
      return null
    } finally {
      controllersRef.current.delete('board:auto-timing')
      if (mountedRef.current) setTimingResolving(false)
    }
  }

  const exportCompleteBoard = async (
    sourceDraft?: StoryboardDraft,
    timingAlreadyResolved = false,
  ): Promise<boolean> => {
    if (exportingBoard) return false
    let current = sourceDraft ?? draftRef.current
    if (!timingAlreadyResolved) {
      const resolved = await resolveAutoTimingForFinalBoard(current)
      if (!resolved) return false
      current = resolved
    }
    const effectiveTiming = effectiveStoryboardTiming(current)
    const explicitStory = storyboardCompleteStory(current)
    const authoredStory = current.scenes
      .flatMap((scene) => [scene.title.trim(), scene.prompt.trim(), scene.explanation.trim()])
      .filter(Boolean)
      .join('\n')
    const completeStory = explicitStory || authoredStory || 'Visual storyboard'
    const latestCreationsById = new Map(getCreations().map((creation) => [creation.id, creation]))
    const timings = storyboardSceneTimings(effectiveTiming.scenes)
    const sourceSceneCreationIds: string[] = []
    const exportScenes = current.scenes.map((scene, index) => {
      const candidate = findStoryboardCandidate(scene, scene.approvedCreationId)
      const creation = candidate ? latestCreationsById.get(candidate.creationId) : undefined
      sourceSceneCreationIds.push(candidate?.creationId ?? '')
      const timing = timings[index]
      return {
        ordinal: index + 1,
        title: scene.title.trim() || sceneLabel(index),
        description: scene.prompt,
        explanation: scene.explanation,
        durationSeconds: timing.durationSeconds,
        startSeconds: timing.startSeconds,
        imageUrl: creation?.url ?? '',
      }
    })
    if (exportScenes.some((scene) => !scene.imageUrl)) {
      toast('Approve a frame for every scene before exporting the complete board')
      return false
    }
    if (current.workflowMode === 'full' && !explicitStory) {
      toast('Add the complete story in Story Brief before exporting')
      return false
    }
    if (current.workflowMode === 'full' && exportScenes.some((scene) => !scene.description.trim() || !scene.explanation.trim())) {
      toast('Add a scene description and story explanation to every scene before exporting')
      return false
    }

    setExportingBoard(true)
    let exportJob: ReturnType<typeof startJob> | null = null
    try {
      await prepareJobLedger()
      exportJob = startJob({
        title: 'Export storyboard',
        subtitle: `${current.scenes.length} scenes · one image`,
        kind: 'image',
      })
      const activeExportJob = exportJob
      await activeExportJob.persisted
      activeExportJob.update({ status: 'running', detail: 'Rendering storyboard locally' })
      const blob = await renderStoryboardPng({
        title: current.title.trim() || 'EasyField Storyboard',
        story: completeStory,
        aspect: current.aspect,
        workflowMode: current.workflowMode,
        timingMode: effectiveTiming.timingMode,
        totalDurationSeconds: effectiveTiming.totalDurationSeconds,
        scenes: exportScenes,
      })
      const localUrl = URL.createObjectURL(blob)
      let ownsTemporaryUrl = true
      try {
        const [creation] = await addCreationsDurably([{
          kind: 'image',
          url: localUrl,
          model: 'EasyField Storyboard',
          prompt: completeStory,
          meta: `Complete storyboard · Exact selected frames · ${effectiveTiming.timingMode === 'none' ? '' : `${effectiveTiming.totalDurationSeconds}s · `}${current.scenes.length} scene${current.scenes.length === 1 ? '' : 's'} · 1920px PNG`,
          durability: 'local',
        }], {
          onSecured: async (securedItems) => {
            await activeExportJob.secureResults(securedItems.map((item) => item.url), securedItems.length, 'Storyboard secured locally · adding to Library')
          },
        })
        if (!creation) throw new Error('The complete storyboard could not be saved to Library.')
        await activeExportJob.commitResults([creation.url], 1, 'Storyboard saved locally')
        if (creation.url !== localUrl) {
          URL.revokeObjectURL(localUrl)
          ownsTemporaryUrl = false
        } else {
          // Development Library owns this Blob URL until the record is removed.
          ownsTemporaryUrl = false
        }
        const boardCandidate: StoryboardBoardCandidate = {
          creationId: creation.id,
          strategy: 'scene-composite',
          promptSnapshot: completeStory,
          inputFingerprint: exactStoryboardFingerprint(current, sourceSceneCreationIds),
          sourceSceneCreationIds,
          model: current.model,
          aspect: current.aspect,
          resolution: current.resolution,
          extras: { ...current.extras, format: 'PNG' },
          createdAt: creation.createdAt,
        }
        updateDraft((latest) => ({
          ...latest,
          boardCandidates: appendStoryboardBoardCandidates(latest, [boardCandidate]),
          approvedBoardCreationId: creation.id,
        }))
        setActiveBoardCandidateId(creation.id)
        saveUrl(creation.url, `${safeExportName(current.title)}.png`)
        setLightbox(creation.url)
        toast('Complete storyboard saved to Library and exported as one image')
      } catch (error) {
        if (ownsTemporaryUrl) URL.revokeObjectURL(localUrl)
        throw error
      }
      return true
    } catch (error) {
      exportJob?.fail(error)
      toast(error instanceof Error ? error.message : 'Could not build the complete storyboard image')
      return false
    } finally {
      if (mountedRef.current) setExportingBoard(false)
    }
  }

  const config = IMAGE_MODEL_CONFIG[draft.model]
  const connected = isConnected()
  const sceneExpectedInputFingerprints = draft.scenes.map((scene, index) => (
    expectedSceneInputFingerprintForDraft(draft, scene, index)
  ))
  const sceneApprovalIsCurrent = (scene: StoryboardScene, index: number): boolean => (
    isStoryboardSceneApproved(scene)
    && !isStoryboardApprovalStale(scene, sceneExpectedInputFingerprints[index])
  )
  const approvedCount = draft.scenes.filter(sceneApprovalIsCurrent).length
  const anySceneBusy = Object.values(runtime).some((scene) => scene.state === 'enhancing' || scene.state === 'generating' || scene.state === 'pending')
  const briefBusy = briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning'
  const boardBusy = boardRuntime.state === 'generating' || boardRuntime.state === 'pending' || exportingBoard || timingResolving
  const referenceLimit = config.maxReferenceImages
  const adjacentReferenceCount = adjacentStoryboardReferenceIds(draft).length
  const globalReferenceCount = new Set(draft.referenceCreationIds).size
  const globalReferenceLimitValue = globalReferenceLimit(draft)
  const sceneReferenceLimitValue = sceneReferenceLimit(draft)
  const largestCurrentReferenceCount = largestOrdinaryReferenceCount(draft)
  const activeGenerationReferenceCount = largestCurrentReferenceCount + adjacentReferenceCount
  const scenePromptLimits = draft.scenes.map((scene, sceneOrdinal) => storyboardScenePromptMax(draft.model, draft.style, {
    previous: Boolean(draft.previousStoryboardCreationId),
    next: Boolean(draft.nextStoryboardCreationId),
    globalReferenceCount,
    currentReferenceCount: draft.workflowMode === 'scenes'
      ? new Set(scene.referenceCreationIds.filter((creationId) => !draft.referenceCreationIds.includes(creationId))).size
      : 0,
    sceneOrdinal,
    sceneCount: draft.scenes.length,
  }))
  const referenceInputsLocked = referencesBlocked || referenceImporting || batchRunning || briefBusy || anySceneBusy || boardBusy
  const sceneReferenceCompiles = draft.scenes.map((scene, index) => compileStoryboardSceneReferenceManifest(
    draft,
    draft.workflowMode === 'scenes' ? scene.referenceCreationIds : draft.referenceCreationIds,
    index + 1,
  ))
  const sceneReferenceCompileError = draft.workflowMode === 'scenes'
    ? sceneReferenceCompiles.find((result) => !result.ok)
    : undefined
  const completionActions = draft.scenes.map((scene, index) => storyboardSceneCompletionAction(
    scene,
    draft.workflowMode === 'scenes',
    sceneExpectedInputFingerprints[index],
  ))
  const incompleteCount = draft.scenes.filter((scene, index) => {
    if (sceneApprovalIsCurrent(scene, index)) return false
    const action = completionActions[index]
    return action === 'missing'
      || action === 'ambiguous-references'
      || (action === 'generate' && scene.prompt.trim().length < SCENE_PROMPT_MIN_LENGTH)
  }).length
  const overLimitSceneCount = draft.scenes.filter((scene, index) => (
    !sceneApprovalIsCurrent(scene, index) && promptCharacterCount(scene.prompt) > scenePromptLimits[index]
  )).length
  const missingCount = draft.scenes.length - approvedCount
  const scenesNeedingGeneration = draft.scenes.filter((scene, index) => (
    !sceneApprovalIsCurrent(scene, index) && completionActions[index] === 'generate'
  ))
  const exactReferenceCount = completionActions.filter((action) => action === 'use-reference').length
  const hasAutoSceneTiming = draft.workflowMode === 'scenes'
    && draft.scenes.some((scene) => scene.durationMode === 'auto')
  const manualSceneTimingTotal = draft.scenes.reduce((sum, scene) => (
    sum + (scene.durationMode === 'manual' ? scene.durationSeconds : 0)
  ), 0)
  const boardVersionCount = clampStoryboardVersionCount(draft.versionCount)
  const sceneGenerationPlans: StoryboardSceneVersionPlan[] = draft.workflowMode === 'scenes'
    ? scenesNeedingGeneration.map((scene) => ({ scene, versionCount: boardVersionCount }))
    : []
  const generatedVersionCount = sceneGenerationPlans.reduce((sum, item) => sum + item.versionCount, 0)
  const estimate = combineStoryboardEstimates(sceneGenerationPlans.map(({ scene, versionCount }) => imageRunEstimate(
    draft.model,
    draft.resolution,
    draft.extras,
    versionCount,
    { referenceCount: Math.min(referenceLimit, (draft.workflowMode === 'scenes'
      ? new Set([...draft.referenceCreationIds, ...scene.referenceCreationIds]).size
      : referenceImages.length) + adjacentReferenceCount) },
  )))
  const singleBoardCompile = compileGeneratedStoryboardBoard(draft)
  const singleBoardEstimate = imageRunEstimate(
    draft.model,
    draft.resolution,
    draft.extras,
    boardVersionCount,
    { referenceCount: singleBoardCompile.ok ? singleBoardCompile.referenceCount : 0 },
  )
  const activeEstimate = draft.workflowMode === 'full' ? singleBoardEstimate : estimate
  const activeIncompleteCount = draft.workflowMode === 'full' ? 0 : incompleteCount
  const activeOverLimitSceneCount = draft.workflowMode === 'full' ? 0 : overLimitSceneCount
  const footerError = activeReferencesUnavailable
    || continuityReferencesUnavailable
    || activeOverLimitSceneCount > 0
    || Boolean(sceneReferenceCompileError)
    || (draft.workflowMode === 'full' && !singleBoardCompile.ok)
    || boardRuntime.state === 'error'
  const displayedStyle = draft.style || 'None'
  const showSceneWorkspace = draft.workflowMode === 'scenes'
  const effectiveTiming = effectiveStoryboardTiming(draft)
  const sceneTimings = storyboardSceneTimings(effectiveTiming.scenes)
  const sceneDurationOptions = useMemo(
    () => Array.from({
      length: Math.round(
        (STORYBOARD_MAX_SCENE_DURATION_SECONDS - STORYBOARD_MIN_SCENE_DURATION_SECONDS)
          / STORYBOARD_SCENE_DURATION_STEP_SECONDS,
      ) + 1,
    }, (_, index) => `${STORYBOARD_MIN_SCENE_DURATION_SECONDS + index * STORYBOARD_SCENE_DURATION_STEP_SECONDS}s`),
    [],
  )

  const finalScenes: StoryboardFinalSceneView[] = draft.scenes.map((scene, index) => {
    const candidate = findStoryboardCandidate(scene, scene.approvedCreationId)
    const creation = candidate ? creationsById.get(candidate.creationId) : undefined
    const timing = sceneTimings[index]
    return {
      id: scene.id,
      title: scene.title,
      prompt: scene.prompt,
      explanation: scene.explanation,
      durationSeconds: timing.durationSeconds,
      startSeconds: timing.startSeconds,
      endSeconds: timing.endSeconds,
      url: creation?.url ?? null,
      approved: sceneApprovalIsCurrent(scene, index),
      stale: isStoryboardApprovalStale(scene, sceneExpectedInputFingerprints[index]) || (
        !scene.prompt.trim()
        && scene.referenceCreationIds.length === 1
        && Boolean(scene.approvedCreationId)
        && scene.approvedCreationId !== scene.referenceCreationIds[0]
      ),
    }
  })
  const exactSourceCreationIds = draft.scenes.map((scene, index) => (
    sceneApprovalIsCurrent(scene, index)
      ? findStoryboardCandidate(scene, scene.approvedCreationId)?.creationId ?? ''
      : ''
  ))
  const activeBoardStrategy: StoryboardOutputStrategy = draft.workflowMode === 'full'
    ? 'single-generation'
    : 'scene-composite'
  const activeBoardFingerprint = activeBoardStrategy === 'single-generation'
    ? singleBoardCompile.ok ? singleBoardCompile.inputFingerprint : null
    : exactSourceCreationIds.every(Boolean)
      ? exactStoryboardFingerprint(draft, exactSourceCreationIds)
      : null
  const visibleBoardCandidates = draft.boardCandidates.filter((candidate) => candidate.strategy === activeBoardStrategy)
  const autoTimingPending = hasAutoSceneTiming
    && (!activeBoardFingerprint || !visibleBoardCandidates.some((candidate) => (
      candidate.inputFingerprint === activeBoardFingerprint
    )))
  const boardCandidateViews: StoryboardBoardCandidateView[] = visibleBoardCandidates.map((candidate) => ({
    id: candidate.creationId,
    url: creationsById.get(candidate.creationId)?.url ?? null,
    strategy: candidate.strategy,
    approved: candidate.creationId === draft.approvedBoardCreationId
      && candidate.inputFingerprint === activeBoardFingerprint,
    stale: !activeBoardFingerprint || candidate.inputFingerprint !== activeBoardFingerprint,
    model: candidate.strategy === 'single-generation' ? candidate.model : 'Exact scene frames',
  }))
  const selectedBoardCandidateId = activeBoardCandidateId
    && visibleBoardCandidates.some((candidate) => candidate.creationId === activeBoardCandidateId)
    ? activeBoardCandidateId
    : visibleBoardCandidates.find((candidate) => (
      candidate.creationId === draft.approvedBoardCreationId
      && candidate.inputFingerprint === activeBoardFingerprint
    ))?.creationId
      ?? [...visibleBoardCandidates].reverse().find((candidate) => candidate.inputFingerprint === activeBoardFingerprint)?.creationId
      ?? visibleBoardCandidates.at(-1)?.creationId
      ?? null
  const currentBoardRunCandidateIds = boardRuntime.jobId
    ? visibleBoardCandidates
      .filter((candidate) => candidate.jobId === boardRuntime.jobId)
      .map((candidate) => candidate.creationId)
    : boardRuntime.generation?.attachedCreationIds

  useEffect(() => {
    if (!draft.approvedBoardCreationId) return
    const approved = draft.boardCandidates.find((candidate) => (
      candidate.creationId === draft.approvedBoardCreationId
      && candidate.strategy === activeBoardStrategy
    ))
    if (!approved || (activeBoardFingerprint && approved.inputFingerprint === activeBoardFingerprint)) return
    updateDraft((current) => current.approvedBoardCreationId === approved.creationId
      ? { ...current, approvedBoardCreationId: null }
      : current)
  }, [activeBoardFingerprint, activeBoardStrategy, draft.approvedBoardCreationId, draft.boardCandidates, updateDraft])
  const everyExportImageReady = finalScenes.length > 0 && finalScenes.every((scene) => scene.approved && Boolean(scene.url))
  const fullStoryReady = draft.workflowMode === 'scenes' || Boolean(storyboardCompleteStory(draft))
  const everySceneExplained = draft.workflowMode === 'scenes'
    || finalScenes.every((scene) => Boolean(scene.prompt.trim() && scene.explanation.trim()))
  const completeBoardReady = everyExportImageReady && fullStoryReady && everySceneExplained
  const exportDisabledReason = approvedCount < draft.scenes.length
    ? draft.scenes.length === 1
      ? 'Approve a frame for this scene first.'
      : `Approve a frame for all ${draft.scenes.length} scenes first.`
    : !everyExportImageReady
      ? 'One or more approved images are still restoring from Library.'
      : !fullStoryReady
        ? draft.workflowMode === 'full'
          ? 'Add the complete story in Story Brief.'
          : 'Add the Complete Story Context used to guide every scene.'
        : 'Add a description and story explanation to every scene.'
  const referenceDialogScene = referenceDialogSceneId
    ? draft.scenes.find((scene) => scene.id === referenceDialogSceneId) ?? null
    : null
  const referenceDialogImages = referenceDialogScene ? sceneReferencesFor(referenceDialogScene) : []
  const continuityDialogImages = continuityDialogRole ? continuityReferenceImage(continuityDialogRole) : []
  const continuityDialogHasAsset = continuityDialogImages.length > 0
  const continuityDialogAtCapacity = !continuityDialogHasAsset && activeGenerationReferenceCount >= referenceLimit
  const continuityAttachAvailable = activeGenerationReferenceCount < referenceLimit
  const continuityAttachHint = referenceLimit === 0
    ? `${draft.model} does not accept image references.`
    : `${draft.model} has no free reference slot. Remove a current or adjacent reference first.`
  const continuityLibraryExcludedIds = [
    ...draft.referenceCreationIds,
    ...draft.scenes.flatMap((scene) => scene.referenceCreationIds),
    ...(continuityDialogRole === 'previous'
      ? draft.nextStoryboardCreationId ? [draft.nextStoryboardCreationId] : []
      : draft.previousStoryboardCreationId ? [draft.previousStoryboardCreationId] : []),
  ]

  const createFullStoryboardFromScenes = async () => {
    if (draftRef.current.workflowMode !== 'scenes' || batchRunning || exportingBoard || referenceImportingRef.current || referencesBlocked) return
    let current = draftRef.current
    const continuityConflict = findStoryboardContinuityReferenceConflict(current)
    if (continuityConflict) {
      toast(`One image cannot be both ${continuityConflict.roles.join(' and ')} · choose a different reference`)
      return
    }
    const currentActions = current.scenes.map((scene, index) => storyboardSceneCompletionAction(
      scene,
      true,
      expectedSceneInputFingerprintForDraft(current, scene, index),
    ))
    const invalidIndex = current.scenes.findIndex((scene, index) => {
      const action = currentActions[index]
      return action === 'missing'
        || action === 'ambiguous-references'
        || (action === 'generate' && scene.prompt.trim().length < SCENE_PROMPT_MIN_LENGTH)
    })
    if (invalidIndex >= 0) {
      const action = currentActions[invalidIndex]
      toast(action === 'ambiguous-references'
        ? `${sceneLabel(invalidIndex)} has multiple references but no prompt · describe how to use them or keep one exact image`
        : `${sceneLabel(invalidIndex)} needs a prompt or one exact reference image`)
      return
    }

    const latestCreations = new Map(getCreations().map((creation) => [creation.id, creation]))
    const availableImageReferenceIds = [...latestCreations.values()]
      .filter((creation) => creation.kind === 'image' && Boolean(creation.url))
      .map((creation) => creation.id)
    const missingArtifactIndex = current.scenes.findIndex((scene, index) => {
      const action = currentActions[index]
      if (action === 'preserve') {
        const candidate = findStoryboardCandidate(scene, scene.approvedCreationId)
        return !candidate || !latestCreations.get(candidate.creationId)?.url
      }
      if (action === 'use-reference') {
        const reference = latestCreations.get(scene.referenceCreationIds[0])
        return reference?.kind !== 'image' || !reference.url
      }
      if (action === 'generate') {
        return findMissingStoryboardReferenceIds(
          orderedSceneGenerationReferenceIds(current, scene.referenceCreationIds),
          availableImageReferenceIds,
        ).length > 0
      }
      return false
    })
    if (missingArtifactIndex >= 0) {
      toast(`${sceneLabel(missingArtifactIndex)} is still restoring from Library · its image will not be replaced`)
      return
    }

    const timed = await resolveAutoTimingForFinalBoard(current)
    if (!timed) return
    current = timed

    const generationScenes = current.scenes.filter((_, index) => currentActions[index] === 'generate')
    if (generationScenes.length && !isConnected()) {
      toast('Connect EasyField Cloud to generate the missing scene frames')
      return
    }
    const currentEstimate = combineStoryboardEstimates(generationScenes.map((scene) => imageRunEstimate(
      current.model,
      current.resolution,
      current.extras,
      current.versionCount,
      { referenceCount: Math.min(
        IMAGE_MODEL_CONFIG[current.model].maxReferenceImages,
        orderedSceneGenerationReferenceIds(current, scene.referenceCreationIds).length,
      ) },
    )))
    if (generationScenes.length) {
      const exactCount = currentActions.filter((action) => action === 'use-reference').length
      const confirmed = window.confirm(
        `Create the complete storyboard now?\n\n${generationScenes.length} missing scene${generationScenes.length === 1 ? '' : 's'} × ${current.versionCount} version${current.versionCount === 1 ? '' : 's'} = ${generationScenes.length * current.versionCount} generated image${generationScenes.length * current.versionCount === 1 ? '' : 's'} (${formatEstimate(currentEstimate, false)}).${exactCount ? `\n${exactCount} reference-only scene${exactCount === 1 ? '' : 's'} will reuse the original image exactly at no generation cost.` : ''}\nExisting generated scenes will not be changed.`,
      )
      if (!confirmed) return
    }

    const succeeded = await generateAll(current)
    if (!succeeded) {
      toast('The complete board was not exported · every finished scene remains saved')
      return
    }
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()))
    const completed = draftRef.current
    if (!completed.scenes.every((scene, index) => (
      isStoryboardSceneApproved(scene)
      && !isStoryboardApprovalStale(scene, expectedSceneInputFingerprintForDraft(completed, scene, index))
    ))) {
      toast('Some scenes are still missing · completed frames were preserved')
      return
    }
    await exportCompleteBoard(completed, true)
  }

  return (
    <div className="ef-screen ef-legacy-workspace ef-storyboard-screen">
      <header className="ef-sub-header ef-storyboard-header">
        <button type="button" className="ef-back" onClick={handleBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Storyboard</span>
        <span className="ef-spacer" />
        <Dropdown options={IMAGE_MODELS} selected={draft.model} onSelect={changeModel} label="Image model" optionMeta={IMAGE_MODEL_META} />
        <span className="ef-sr-only" aria-live="polite">
          {saveState === 'loading' ? 'Loading storyboard' : saveState === 'saving' ? 'Saving storyboard' : saveState === 'error' ? 'Storyboard save issue' : 'Storyboard saved'} · {approvedCount} of {draft.scenes.length} scenes approved
        </span>
      </header>

      <div className="ef-scroll ef-create-scroll ef-storyboard-scroll">
        <section className="ef-story-setup" aria-labelledby="ef-story-setup-title">
          <div className="ef-story-setup-copy">
            <span>ONE IDEA · COMPLETE STORY</span>
            <h1 id="ef-story-setup-title">Start with the whole story—or direct every scene.</h1>
            <p>Write one complete Story Brief for a single generated board, or switch to scene boxes when you want to direct every frame yourself.</p>
          </div>

          <div className="ef-story-mode-switch" role="radiogroup" aria-label="Storyboard creation mode">
            <button
              type="button"
              role="radio"
              data-workflow-mode="full"
              aria-checked={draft.workflowMode === 'full'}
              tabIndex={draft.workflowMode === 'full' ? 0 : -1}
              className={draft.workflowMode === 'full' ? 'is-selected' : ''}
              disabled={referenceInputsLocked}
              onClick={() => changeWorkflowMode('full')}
              onKeyDown={(event) => handleWorkflowModeKeyDown(event, 'full')}
            >
              <span className="ef-story-mode-icon" aria-hidden="true"><Icon glyph="board" size={16} /></span>
              <span>
                <strong>Full storyboard</strong>
                <small>One brief → one complete generated board</small>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              data-workflow-mode="scenes"
              aria-checked={draft.workflowMode === 'scenes'}
              tabIndex={draft.workflowMode === 'scenes' ? 0 : -1}
              className={draft.workflowMode === 'scenes' ? 'is-selected' : ''}
              disabled={referenceInputsLocked}
              onClick={() => changeWorkflowMode('scenes')}
              onKeyDown={(event) => handleWorkflowModeKeyDown(event, 'scenes')}
            >
              <span className="ef-story-mode-icon" aria-hidden="true"><Icon glyph="film" size={16} /></span>
              <span>
                <strong>Storyboard by scenes</strong>
                <small>Add, write and generate each scene yourself</small>
              </span>
            </button>
          </div>

          <div className="ef-story-master-head">
            <label className="ef-story-title-field" htmlFor="storyboard-title">
              <span>STORYBOARD TITLE</span>
              <input
                id="storyboard-title"
                className="ef-story-title-input"
                value={draft.title}
                maxLength={STORYBOARD_MAX_TITLE_LENGTH}
                placeholder="Untitled storyboard"
                onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))}
              />
            </label>
          </div>

          {draft.workflowMode === 'full' ? (
            <div className="ef-story-full-flow">
              <label className="ef-field-label ef-story-brief-label" htmlFor="storyboard-story-brief">STORY BRIEF</label>
              <div className="ef-prompt-card ef-story-brief-card">
            <textarea
              id="storyboard-story-brief"
              className="ef-prompt-textarea ef-story-brief-textarea"
              value={draft.storyBrief}
              maxLength={STORYBOARD_MAX_STORY_BRIEF_LENGTH}
              rows={6}
              placeholder="Tell the complete story in one box. Include the characters, world, beginning, turning point and ending—or keep it simple and let the director propose the scenes."
              aria-busy={briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning'}
              onChange={(event) => {
                updateDraft((current) => ({ ...current, storyBrief: event.target.value }))
                if (briefRuntime.state === 'error' || briefRuntime.note) setBriefRuntime({ state: 'idle' })
              }}
            />
            <div className="ef-prompt-footer ef-story-brief-footer ef-story-prompt-footer">
              <button
                type="button"
                className={`ef-enhance-btn${briefRuntime.state === 'enhancing' ? ' loading' : ''}`}
                aria-label={!connected ? 'Connect EasyField Cloud to improve the Story Brief' : `Improve the Story Brief using the current storyboard and references with ${enhancerModel}`}
                title={!connected ? 'Connect EasyField Cloud to improve prompts' : `Uses the complete Story Brief and every attached reference · ${enhancerModel}`}
                disabled={!connected || (!canEnhancePrompt(draft.storyBrief, referencesForPrompting(referenceImages), SCENE_PROMPT_MIN_LENGTH) && adjacentReferenceCount === 0) || referenceInputsLocked}
                onClick={() => void enhanceCompleteStory()}
              >
                <Icon glyph="spark" size={12} />
              </button>
              <Dropdown
                options={AGENT_MODELS}
                selected={enhancerModel}
                onSelect={changeEnhancerModel}
                label="Prompt enhancer model"
                align="left"
                optionMeta={AGENT_MODEL_META}
              />
              <button
                type="button"
                className={`ef-story-scene-reference-trigger${referenceImages.length ? ' has-references' : ''}`}
                onClick={() => setStoryReferenceDialogOpen(true)}
                disabled={referenceInputsLocked || referenceLimit === 0}
                aria-haspopup="dialog"
                aria-expanded={storyReferenceDialogOpen}
                aria-label={`Choose references for the complete storyboard. ${referenceImages.length} of ${globalReferenceLimitValue} shared slots attached.`}
                title={referenceLimit === 0
                  ? 'The selected image model does not accept references'
                  : 'Choose references used by the Story Brief and complete generated board'}
              >
                <Icon glyph="img" size={13} />
                <span>Refs</span>
                <b>{referenceImages.length}</b>
              </button>
              <span className="ef-spacer" />
              {briefRuntime.state === 'enhancing'
                ? <span className="ef-enhance-note" role="status">✨ improving…</span>
                : briefRuntime.state === 'planning'
                  ? <span className="ef-enhance-note" role="status">✨ preparing storyboard…</span>
                  : briefRuntime.note
                    ? <span className="ef-enhance-note" role="status">✨ {briefRuntime.note}</span>
                    : <span className={draft.storyBrief.length > STORYBOARD_MAX_STORY_BRIEF_LENGTH * 0.9 ? 'ef-char-count is-near-limit' : 'ef-char-count'}>{draft.storyBrief.length} / {STORYBOARD_MAX_STORY_BRIEF_LENGTH}</span>}
                </div>
              </div>

            </div>
          ) : (
            <div className="ef-story-summary ef-story-summary--scenes">
              <label htmlFor="storyboard-story-summary-scenes">COMPLETE STORY CONTEXT</label>
              <p id="storyboard-story-summary-help">AI uses this, every scene row and all attached references whenever you improve a scene. It also appears in the one-image export.</p>
              <div className="ef-prompt-card ef-story-context-card">
                <textarea
                  id="storyboard-story-summary-scenes"
                  className="ef-prompt-textarea ef-story-context-textarea"
                  value={draft.storySummary}
                  maxLength={STORYBOARD_MAX_STORY_SUMMARY_LENGTH}
                  rows={3}
                  placeholder="Describe the overall story arc, characters, continuity and ending that connect these scenes."
                  aria-describedby="storyboard-story-summary-help"
                  aria-busy={briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning'}
                  onChange={(event) => {
                    updateDraft((current) => ({ ...current, storySummary: event.target.value }))
                    if (briefRuntime.state === 'error' || briefRuntime.note) setBriefRuntime({ state: 'idle' })
                  }}
                />
                <div className="ef-prompt-footer ef-story-prompt-footer">
                  <button
                    type="button"
                    className={`ef-enhance-btn${briefRuntime.state === 'enhancing' ? ' loading' : ''}`}
                    aria-label={!connected
                      ? 'Connect EasyField Cloud to improve the Complete Story Context'
                      : `Improve the Complete Story Context using every scene row and all shared references with ${enhancerModel}`}
                    title={!connected
                      ? 'Connect EasyField Cloud to improve prompts'
                      : `Uses every scene row and every shared story reference · ${enhancerModel}`}
                    disabled={!connected || (draft.storySummary.trim().length < SCENE_PROMPT_MIN_LENGTH && !referenceImages.length && adjacentReferenceCount === 0) || referenceInputsLocked}
                    onClick={() => void enhanceCompleteStory()}
                  >
                    <Icon glyph="spark" size={12} />
                  </button>
                  <Dropdown
                    options={AGENT_MODELS}
                    selected={enhancerModel}
                    onSelect={changeEnhancerModel}
                    label="Prompt enhancer model"
                    align="left"
                    optionMeta={AGENT_MODEL_META}
                  />
                  <button
                    type="button"
                    className={`ef-story-scene-reference-trigger${referenceImages.length ? ' has-references' : ''}`}
                    onClick={() => setStoryReferenceDialogOpen(true)}
                    disabled={referenceInputsLocked || referenceLimit === 0}
                    aria-haspopup="dialog"
                    aria-expanded={storyReferenceDialogOpen}
                    aria-label={`Choose references used by every storyboard scene. ${referenceImages.length} of ${globalReferenceLimitValue} shared slots attached.`}
                    title={referenceLimit === 0
                      ? 'The selected image model does not accept references'
                      : 'Choose shared references used to improve and generate every scene'}
                  >
                    <Icon glyph="img" size={13} />
                    <span>Refs</span>
                    <b>{referenceImages.length}</b>
                  </button>
                  <span className="ef-spacer" />
                  {briefRuntime.state === 'enhancing'
                    ? <span className="ef-enhance-note" role="status">✨ improving…</span>
                    : briefRuntime.note
                      ? <span className="ef-enhance-note" role="status">✨ {briefRuntime.note}</span>
                      : <span className={draft.storySummary.length > STORYBOARD_MAX_STORY_SUMMARY_LENGTH * 0.9 ? 'ef-char-count is-near-limit' : 'ef-char-count'}>{draft.storySummary.length} / {STORYBOARD_MAX_STORY_SUMMARY_LENGTH}</span>}
                </div>
              </div>
            </div>
          )}

          {briefRuntime.error && (
            <div className="ef-story-scene-error" role="alert">{briefRuntime.error}</div>
          )}

          <button
            type="button"
            className="ef-story-settings-toggle"
            aria-expanded={visualSettingsOpen}
            aria-controls="storyboard-visual-settings"
            onClick={() => setVisualSettingsOpen((open) => !open)}
          >
            <span>
              <strong>Visual settings</strong>
              <small>{displayedStyle} · {draft.aspect}{draft.resolution ? ` · ${draft.resolution}` : ''}</small>
            </span>
            <b aria-hidden="true">⌄</b>
          </button>

          <div id="storyboard-visual-settings" className="ef-story-output-settings" hidden={!visualSettingsOpen}>
            <ChipField label="STYLE" options={[...STORYBOARD_STYLE_OPTIONS]} selected={displayedStyle} onSelect={(style) => updateDraft((current) => ({ ...current, style: style === 'None' ? '' : style }))} chipClassName="ef-style-chip" presentation="dropdown" />
            <ChipField label="ASPECT" options={config.aspectRatios} selected={draft.aspect} onSelect={(aspect) => updateDraft((current) => ({ ...current, aspect }))} presentation={config.aspectRatios.length >= 6 ? 'dropdown' : 'chips'} />
            {config.resolutions.length > 0 && (
              <ChipField label="RESOLUTION" options={config.resolutions} selected={draft.resolution} onSelect={(resolution) => updateDraft((current) => ({ ...current, resolution }))} />
            )}
            {config.extraOptions.map((option) => (
              <ChipField
                key={option.key}
                label={option.label}
                options={option.values}
                selected={draft.extras[option.key]}
                onSelect={(value) => updateDraft((current) => ({ ...current, extras: { ...current.extras, [option.key]: value } }))}
              />
            ))}
          </div>

          <StoryboardContinuityAdvanced
            open={advancedOpen}
            previous={previousStoryboardAsset}
            next={nextStoryboardAsset}
            disabled={referenceInputsLocked}
            disabledHint={continuityReferencesUnavailable
              ? 'Library storage is unavailable right now.'
              : continuityReferencesRestoring
                ? 'Restoring adjacent storyboards from Library…'
                : referenceImporting
                  ? 'Adding storyboard context…'
                  : referenceLimit === 0
                    ? `${draft.model} does not accept image references.`
                    : referenceInputsLocked
                      ? 'Continuity is locked while Storyboard is working.'
                      : undefined}
            canAttachPrevious={continuityAttachAvailable}
            canAttachNext={continuityAttachAvailable}
            previousAttachHint={continuityAttachHint}
            nextAttachHint={continuityAttachHint}
            referenceCount={activeGenerationReferenceCount}
            referenceLimit={referenceLimit}
            onToggle={() => setAdvancedOpen((open) => !open)}
            onChoose={(role) => setContinuityDialogRole(role)}
            onRemove={removeContinuityReference}
            onPreview={setLightbox}
          />

          {draft.workflowMode === 'full' && (
            <StoryboardTimingEditor
              timingMode={draft.timingMode}
              totalDurationSeconds={effectiveTiming.totalDurationSeconds}
              disabled={referenceInputsLocked}
              onTimingModeChange={changeTimingMode}
              onTotalDurationChange={changeTotalDuration}
            />
          )}
        </section>

        {showSceneWorkspace && (
          <>
            <div className="ef-story-scenes-head">
              <div>
                <span>SCENE PLAN</span>
                <h2>Direct every frame.</h2>
              </div>
              <p>{approvedCount
                ? `${approvedCount} approved frame${approvedCount === 1 ? '' : 's'} will be reused exactly as selected.`
                : `Add up to ${STORYBOARD_MAX_SCENES} scene boxes and direct each frame yourself.`}</p>
            </div>

            <div className="ef-story-scenes">
              {draft.scenes.map((scene, index) => {
            const approvedCandidateId = scene.approvedCreationId ?? undefined
            const activeCandidateId = activeCandidateIds[scene.id] ?? approvedCandidateId ?? scene.candidates.at(-1)?.creationId
            const candidateViews: StoryboardCandidateView[] = scene.candidates.map((candidate) => ({
              id: candidate.creationId,
              url: creationsById.get(candidate.creationId)?.url ?? null,
              model: candidate.model,
              createdAt: candidate.createdAt,
              approved: candidate.creationId === approvedCandidateId,
            }))
            const sceneRuntime = runtime[scene.id] ?? { state: 'idle' as const }
            const sceneReferenceCount = draft.workflowMode === 'scenes'
              ? scene.referenceCreationIds.length
              : referenceImages.length
            const sceneGenerationReferenceCount = draft.workflowMode === 'scenes'
              ? new Set([...draft.referenceCreationIds, ...scene.referenceCreationIds]).size
              : referenceImages.length
            const sceneVersionCount = clampStoryboardVersionCount(scene.versionCount)
            const sceneVersionEstimate = formatEstimate(imageRunEstimate(
              draft.model,
              draft.resolution,
              draft.extras,
              sceneVersionCount,
              { referenceCount: Math.min(referenceLimit, sceneGenerationReferenceCount + adjacentReferenceCount) },
            ), false)
            return (
              <StoryboardSceneCard
                key={scene.id}
                index={index}
                total={draft.scenes.length}
                title={scene.title}
                prompt={scene.prompt}
                explanation={scene.explanation}
                timingMode={draft.timingMode}
                durationMode={scene.durationMode}
                sceneTimingControl={draft.workflowMode === 'scenes'}
                durationSeconds={sceneTimings[index].durationSeconds}
                startSeconds={sceneTimings[index].startSeconds}
                endSeconds={sceneTimings[index].endSeconds}
                durationOptions={sceneDurationOptions}
                maxLength={scenePromptLimits[index]}
                runState={sceneRuntime.state}
                error={sceneRuntime.error}
                statusNote={sceneRuntime.note}
                candidates={candidateViews}
                activeCandidateId={activeCandidateId}
                approvalStale={isStoryboardApprovalStale(scene, sceneExpectedInputFingerprints[index]) || (
                  !scene.prompt.trim()
                  && scene.referenceCreationIds.length === 1
                  && Boolean(scene.approvedCreationId)
                  && scene.approvedCreationId !== scene.referenceCreationIds[0]
                )}
                connected={connected}
                batchRunning={referenceInputsLocked}
                generationJob={sceneRuntime.jobId ? jobsById.get(sceneRuntime.jobId) ?? null : null}
                enhancerModel={enhancerModel}
                referenceCount={sceneReferenceCount}
                referenceLimit={sceneReferenceLimitValue}
                contextReferenceCount={(draft.workflowMode === 'scenes' ? globalReferenceCount : 0) + adjacentReferenceCount}
                sceneReferencesEnabled={draft.workflowMode === 'scenes'}
                sceneGenerationEnabled
                exactReferenceIsApproved={draft.workflowMode === 'scenes' && scene.referenceCreationIds.length === 1 && scene.approvedCreationId === scene.referenceCreationIds[0]}
                versionCount={sceneVersionCount}
                generationVersionCount={sceneRuntime.requestedVersions ?? sceneVersionCount}
                versionEstimate={sceneVersionEstimate}
                canEnhanceFromReferences={referenceImages.length > 0}
                onEnhancerModelChange={changeEnhancerModel}
                onOpenReferences={() => setReferenceDialogSceneId(scene.id)}
                onVersionCountChange={(versionCount) => updateScene(scene.id, (current) => ({
                  ...current,
                  versionCount: clampStoryboardVersionCount(versionCount),
                }))}
                onTitleChange={(title) => updateScene(scene.id, (current) => ({ ...current, title }))}
                onPromptChange={(prompt) => {
                  updateScene(scene.id, (current) => ({ ...current, prompt }))
                  if (runtime[scene.id]?.error || runtime[scene.id]?.note) setSceneRuntime(scene.id, { state: 'idle' })
                }}
                onExplanationChange={(explanation) => updateScene(scene.id, (current) => ({ ...current, explanation }))}
                onDurationChange={(durationSeconds) => changeSceneDuration(scene.id, durationSeconds)}
                onDurationChoice={(durationMode, durationSeconds) => changeSceneTiming(scene.id, durationMode, durationSeconds)}
                onEnhance={() => void enhanceScene(scene.id)}
                onGenerate={() => generateOne(scene.id)}
                onExitGeneration={() => exitSceneGeneration(scene.id)}
                onSelectCandidate={(candidateId) => setActiveCandidateIds((current) => ({ ...current, [scene.id]: candidateId }))}
                onApproveCandidate={(candidateId) => approveCandidate(scene.id, candidateId)}
                onAddCandidateToLibrary={(candidateId) => addCandidateToLibrary(scene.id, candidateId)}
                onDownloadCandidate={(candidateId) => downloadCandidate(scene.id, candidateId)}
                onPreview={setLightbox}
                onMoveUp={() => moveScene(scene.id, -1)}
                onMoveDown={() => moveScene(scene.id, 1)}
                onRemove={() => removeScene(scene.id)}
              />
            )
              })}
            </div>

            <div className={`ef-story-scenes-timing-summary${hasAutoSceneTiming ? ' is-auto' : ''}`} role="status" aria-live="polite">
              <span>SCENE TIMING</span>
              {hasAutoSceneTiming ? (
                <div>
                  <strong>Auto at final creation</strong>
                  <small>The final total and every Auto scene are paced from the complete story when you create the board.</small>
                </div>
              ) : (
                <div>
                  <strong>{manualSceneTimingTotal}s total</strong>
                  <small>{draft.scenes.length} manual scene{draft.scenes.length === 1 ? '' : 's'} · 1–5 seconds · 0.5-second steps</small>
                </div>
              )}
            </div>

            {draft.workflowMode === 'scenes' && (
              <div className="ef-story-scenes-actions">
                <button
                  type="button"
                  className="ef-story-add-scene"
                  onClick={addScene}
                  disabled={draft.scenes.length >= STORYBOARD_MAX_SCENES || batchRunning || briefBusy}
                >
                  <span>+</span> Add scene
                </button>
              </div>
            )}

            <div ref={finalRef} className="ef-story-complete-results">
                <StoryboardFinalStrip
                  scenes={finalScenes}
                  timingMode={effectiveTiming.timingMode}
                  totalDurationSeconds={effectiveTiming.totalDurationSeconds}
                  autoTimingPending={autoTimingPending}
                  onPreview={setLightbox}
                  onDownloadAll={downloadApprovedFrames}
                  onOpenLibrary={onOpenLibrary}
                  onExportBoard={() => void exportCompleteBoard()}
                  exporting={exportingBoard}
                  canExportBoard={completeBoardReady}
                  exportDisabledReason={exportDisabledReason}
              />
              {(boardCandidateViews.length > 0
                || exportingBoard
                || boardRuntime.state === 'generating'
                || boardRuntime.state === 'pending') && (
                <StoryboardBoardResults
                  candidates={boardCandidateViews}
                  selectedCandidateId={selectedBoardCandidateId}
                  state={exportingBoard || boardRuntime.state === 'generating'
                    ? 'loading'
                    : boardRuntime.state === 'pending'
                      ? 'pending'
                      : boardRuntime.state === 'error'
                        ? 'error'
                        : 'idle'}
                  requestedVersions={activeBoardStrategy === 'single-generation' ? boardVersionCount : 1}
                  currentRunCandidateIds={currentBoardRunCandidateIds}
                  statusNote={exportingBoard ? 'Assembling exact scene frames locally…' : boardRuntime.note}
                  error={boardRuntime.error}
                  disabled={boardBusy}
                  title={activeBoardStrategy === 'single-generation'
                    ? 'Choose the complete generated board.'
                    : 'Your exact scene-frame board.'}
                  onSelectCandidate={setActiveBoardCandidateId}
                  onUseCandidate={approveBoardCandidate}
                  onPreview={(url) => setLightbox(url)}
                  onCancel={boardRuntime.state === 'generating' || boardRuntime.state === 'pending' ? exitBoardGeneration : undefined}
                  onOpenLibrary={onOpenLibrary}
                  onDownloadCandidate={downloadBoardCandidate}
                />
              )}
            </div>
          </>
        )}

        {draft.workflowMode === 'full' && (boardCandidateViews.length > 0
          || boardRuntime.state === 'generating'
          || boardRuntime.state === 'pending') && (
          <div ref={finalRef} className="ef-story-complete-results ef-story-complete-results--full">
            <StoryboardBoardResults
              candidates={boardCandidateViews}
              selectedCandidateId={selectedBoardCandidateId}
              state={boardRuntime.state === 'generating'
                ? 'loading'
                : boardRuntime.state === 'pending'
                  ? 'pending'
                  : boardRuntime.state === 'error'
                    ? 'error'
                    : 'idle'}
              requestedVersions={boardVersionCount}
              currentRunCandidateIds={currentBoardRunCandidateIds}
              statusNote={boardRuntime.note}
              error={boardRuntime.error}
              disabled={boardBusy}
              title="Choose the complete generated board."
              onSelectCandidate={setActiveBoardCandidateId}
              onUseCandidate={approveBoardCandidate}
              onPreview={(url) => setLightbox(url)}
              onCancel={boardRuntime.state === 'generating' || boardRuntime.state === 'pending' ? exitBoardGeneration : undefined}
              onOpenLibrary={onOpenLibrary}
              onDownloadCandidate={downloadBoardCandidate}
            />
          </div>
        )}
      </div>

      {(showSceneWorkspace || draft.workflowMode === 'full') && (
        <footer className="ef-create-footer ef-story-footer ef-story-footer--package" aria-label="Storyboard generation summary">
          <div className="ef-story-footer-options">
            <StoryboardVersionPicker
              value={boardVersionCount}
              onChange={(versionCount) => updateDraft((current) => ({
                ...current,
                versionCount: clampStoryboardVersionCount(versionCount),
              }))}
              label={draft.workflowMode === 'full' ? 'STORYBOARD VERSIONS' : 'VERSIONS PER MISSING SCENE'}
              ariaLabel={draft.workflowMode === 'full'
                ? 'Complete storyboard versions to generate'
                : 'Versions generated for every missing storyboard scene'}
              disabled={referenceInputsLocked}
              compact
            />
          </div>
          <div
            id="storyboard-footer-message"
            className={`ef-create-footer-message ${footerError ? 'is-error' : (connected || !generatedVersionCount) && !activeIncompleteCount && !activeReferencesRestoring && !continuityReferencesRestoring ? 'is-ready' : 'is-help'}`}
            role={footerError ? 'alert' : 'status'}
            aria-live="polite"
          >
            {!hydrated
              ? 'Restoring storyboard draft…'
              : continuityReferencesUnavailable
                ? 'An adjacent storyboard is unavailable from Library · generation is paused to protect continuity'
                : activeReferencesUnavailable
                ? 'Saved Storyboard references are unavailable · generation is paused to protect continuity'
                : continuityReferencesRestoring
                  ? 'Restoring adjacent storyboard continuity from Library…'
                  : activeReferencesRestoring
                  ? 'Restoring saved Storyboard references…'
                  : draft.workflowMode === 'full'
                    ? boardRuntime.state === 'generating' || boardRuntime.state === 'pending'
                        ? `${boardRuntime.note ?? `Creating ${boardVersionCount} complete board version${boardVersionCount === 1 ? '' : 's'}`} · finished results are already safe`
                        : boardRuntime.state === 'error'
                          ? `✕ ${boardRuntime.error}`
                          : !singleBoardCompile.ok
                            ? `✕ ${singleBoardCompile.error}`
                            : !connected
                              ? 'Connect EasyField Cloud to generate the complete storyboard'
                              : `Complete board · ${formatEstimate(singleBoardEstimate, false)}`
                    : batchRunning
                      ? `Generating ${batchProgress.complete}/${batchProgress.total} scenes · ${boardVersionCount} version${boardVersionCount === 1 ? '' : 's'} each · completed results are already safe`
                      : sceneReferenceCompileError && !sceneReferenceCompileError.ok
                        ? `✕ ${sceneReferenceCompileError.error}`
                      : !connected && (scenesNeedingGeneration.length > 0 || hasAutoSceneTiming)
                        ? hasAutoSceneTiming
                          ? 'Connect EasyField Cloud so Auto can choose final timing from the complete story'
                          : 'Connect EasyField Cloud to generate missing scene frames'
                        : overLimitSceneCount
                          ? `✕ ${overLimitSceneCount} scene prompt${overLimitSceneCount === 1 ? ' is' : 's are'} over ${draft.model}'s ${config.promptMax.toLocaleString()}-character limit`
                          : incompleteCount
                            ? `${incompleteCount} scene${incompleteCount === 1 ? ' needs' : 's need'} a description`
                            : missingCount
                              ? `${approvedCount ? `Keeps ${approvedCount} approved · ` : ''}${scenesNeedingGeneration.length ? `generates ${scenesNeedingGeneration.length} scene${scenesNeedingGeneration.length === 1 ? '' : 's'} × ${boardVersionCount}` : ''}${scenesNeedingGeneration.length && exactReferenceCount ? ' · ' : ''}${exactReferenceCount ? `reuses ${exactReferenceCount} exact reference${exactReferenceCount === 1 ? '' : 's'}` : ''}`
                              : `Ready to assemble · ${approvedCount}/${draft.scenes.length} selected`}
          </div>
          <button
            type="button"
            className={`ef-generate ef-create-footer-action ef-story-generate-all${batchRunning || boardRuntime.state === 'generating' || boardRuntime.state === 'pending' ? ' is-cancel' : ''}`}
            onClick={batchRunning
              ? exitBatchGeneration
              : boardRuntime.state === 'generating' || boardRuntime.state === 'pending'
                ? exitBoardGeneration
                : draft.workflowMode === 'full'
                  ? () => void generateFullStoryboardPackage()
                  : () => void createFullStoryboardFromScenes()}
            disabled={batchRunning
              ? batchCancelling
              : boardRuntime.state === 'generating' || boardRuntime.state === 'pending'
                ? false
                : draft.workflowMode === 'full'
                  ? !hydrated || !connected || referencesBlocked || referenceImporting || briefBusy || anySceneBusy || timingResolving || !singleBoardCompile.ok
                  : !hydrated || (!connected && (scenesNeedingGeneration.length > 0 || hasAutoSceneTiming)) || referenceInputsLocked || !!incompleteCount || !!overLimitSceneCount}
            aria-describedby="storyboard-footer-message"
          >
            {!batchRunning && boardRuntime.state !== 'generating' && boardRuntime.state !== 'pending' && <Icon glyph="spark" color="#0E0E13" size={15} />}
            <span className="ef-story-footer-action-copy">
              <strong>{batchRunning
                ? batchCancelling ? 'Stopping…' : `Cancel · ${batchProgress.complete}/${batchProgress.total}`
                : boardRuntime.state === 'generating' || boardRuntime.state === 'pending'
                  ? 'Cancel generation'
                  : timingResolving
                    ? 'Choosing automatic timing…'
                  : draft.workflowMode === 'full'
                    ? `Generate ${boardVersionCount} storyboard${boardVersionCount === 1 ? '' : 's'}`
                    : 'Create full storyboard'}</strong>
              {!batchRunning && boardRuntime.state !== 'generating' && boardRuntime.state !== 'pending' && (
                <small>{formatEstimate(activeEstimate, false)}</small>
              )}
            </span>
          </button>
        </footer>
      )}

      {storyReferenceDialogOpen && (
        <StoryboardReferencePicker
          open
          scope="story"
          sceneLabel={draft.title.trim() || (draft.workflowMode === 'scenes' ? 'Complete Story Context' : 'Complete storyboard')}
          images={referenceImages}
          max={globalReferenceLimitValue}
          locked={referenceInputsLocked || (globalReferenceLimitValue === 0 && referenceLimit > 0)}
          lockedHint={globalReferenceLimitValue === 0 && referenceLimit > 0
            ? adjacentReferenceCount >= referenceLimit
              ? 'Adjacent storyboards use every available model reference slot. Remove one in Advanced to add shared story references.'
              : 'Scene-specific references use every remaining model slot. Remove one from a scene to add a shared story reference.'
            : referencesUnavailable
            ? 'Library storage is unavailable · saved Storyboard references were not sent.'
            : referencesRestoring
              ? 'Restoring saved Storyboard references…'
              : referenceImporting
                ? 'Adding reference images…'
                : 'References are locked while Storyboard is working.'}
          onAddFiles={(files) => void addReferenceFiles(files)}
          onChooseLibrary={addReferenceCreations}
          onGrabPlayhead={() => void grabReferenceFrame()}
          onRemove={removeReferenceImage}
          libraryExcludedIds={[
            ...continuityReferenceIds,
            ...draft.scenes.flatMap((scene) => scene.referenceCreationIds),
          ]}
          onClose={() => setStoryReferenceDialogOpen(false)}
        />
      )}

      {referenceDialogScene && (
        <StoryboardReferencePicker
          open
          sceneLabel={referenceDialogScene.title.trim() || sceneLabel(draft.scenes.findIndex((scene) => scene.id === referenceDialogScene.id))}
          images={referenceDialogImages}
          max={sceneReferenceLimitValue}
          locked={referenceImporting || referencesBlocked || batchRunning || anySceneBusy || (sceneReferenceLimitValue === 0 && referenceLimit > 0)}
          lockedHint={sceneReferenceLimitValue === 0 && referenceLimit > 0
            ? globalReferenceCount + adjacentReferenceCount >= referenceLimit
              ? 'Shared story and adjacent storyboard references use every model slot. Remove one before adding a scene reference.'
              : 'This model has no available scene-reference slot.'
            : activeReferencesUnavailable
            ? 'Library storage is unavailable right now.'
            : activeReferencesRestoring
              ? 'Restoring scene references from Library…'
              : referenceImporting ? 'Adding scene references…' : 'References are locked while Storyboard is working.'}
          onAddFiles={(files) => void addSceneReferenceFiles(referenceDialogScene.id, files)}
          onChooseLibrary={(creations) => addSceneReferenceCreations(referenceDialogScene.id, creations)}
          onGrabPlayhead={() => void grabSceneReferenceFrame(referenceDialogScene.id)}
          onRemove={(referenceId) => removeSceneReference(referenceDialogScene.id, referenceId)}
          libraryExcludedIds={[...continuityReferenceIds, ...draft.referenceCreationIds]}
          onClose={() => setReferenceDialogSceneId(null)}
        />
      )}
      {continuityDialogRole && (
        <StoryboardReferencePicker
          open
          scope="continuity"
          continuityRole={continuityDialogRole}
          sceneLabel={continuityDialogRole === 'previous' ? 'Previous storyboard' : 'Next storyboard'}
          images={continuityDialogImages}
          max={1}
          locked={referenceInputsLocked || continuityDialogAtCapacity || referenceLimit === 0}
          lockedHint={continuityReferencesUnavailable
            ? 'Library storage is unavailable right now.'
            : continuityReferencesRestoring
              ? 'Restoring adjacent storyboard context…'
              : continuityDialogAtCapacity
                ? `${draft.model} has no free reference slot · remove a current or adjacent reference first.`
                : referenceImporting
                  ? 'Adding storyboard context…'
                  : referenceInputsLocked
                    ? 'Continuity is locked while Storyboard is working.'
                    : undefined}
          onAddFiles={(files) => void addContinuityFiles(continuityDialogRole, files)}
          onChooseLibrary={(selected) => addContinuityCreations(continuityDialogRole, selected)}
          onGrabPlayhead={() => void grabContinuityFrame(continuityDialogRole)}
          onRemove={() => removeContinuityReference(continuityDialogRole)}
          libraryExcludedIds={continuityLibraryExcludedIds}
          onClose={() => setContinuityDialogRole(null)}
        />
      )}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
