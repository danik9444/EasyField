import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { Lightbox } from '../components/Lightbox'
import { PriceEstimate } from '../components/PriceEstimate'
import { ReferenceImageGrid } from '../components/ReferenceImageGrid'
import {
  StoryboardFinalStrip,
  type StoryboardFinalSceneView,
} from '../components/StoryboardFinalStrip'
import {
  StoryboardSceneCard,
  type StoryboardCandidateView,
  type StoryboardSceneRunState,
} from '../components/StoryboardSceneCard'
import { StoryboardTimingEditor } from '../components/StoryboardTimingEditor'
import { Icon } from '../icons'
import { host } from '../services/host'
import { ChatError, canEnhancePrompt, enhancePrompt, planStoryboard, type EnhanceReference } from '../services/chat'
import { resolve } from '../services/resolve'
import { renderStoryboardPng } from '../services/storyboardExport'
import { isConnected, isGenerationExit, runImage, saveUrl } from '../services/run'
import { canBackgroundJob, canCancelJob, cancelJob, continueJobInBackground, getJobs, prepareJobLedger, startJob, useJobs } from '../services/jobCenter'
import { addCreations, addCreationsDurably, useCreations, usePersistenceState, type Creation } from '../data/creations'
import { IMAGE_MODEL_CONFIG, resolveImageOptions } from '../data/imageModelConfig'
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, IMAGE_MODELS } from '../data/models'
import { AGENT_MODEL_META, IMAGE_MODEL_META } from '../data/modelPresentation'
import { formatEstimate, imageRunEstimate, resolveCharged } from '../data/pricing'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import { loadValue, saveValue } from '../data/prefs'
import { isDecodableReferenceImageFile, type ReferenceImage } from '../data/referenceImage'
import { promptCharacterCount } from '../data/promptLimits'
import {
  STORYBOARD_MAX_CANDIDATES_PER_SCENE,
  STORYBOARD_MAX_PROMPT_LENGTH,
  STORYBOARD_MAX_SCENES,
  STORYBOARD_MAX_STORY_BRIEF_LENGTH,
  STORYBOARD_MAX_STORY_SUMMARY_LENGTH,
  STORYBOARD_MAX_TITLE_LENGTH,
  STORYBOARD_MIN_SCENES,
  STORYBOARD_STYLE_OPTIONS,
  adjustStoryboardSceneDuration,
  appendStoryboardSceneWithTiming,
  autoStoryboardTiming,
  buildStoryboardEnhancementContext,
  clampStoryboardTotalDuration,
  createDefaultStoryboardDraft,
  createStoryboardScene,
  distributeStoryboardDurations,
  findStoryboardCandidate,
  isStoryboardApprovalStale,
  isStoryboardSceneApproved,
  normalizeStoryboardDraft,
  removeStoryboardSceneWithTiming,
  reorderStoryboardScenes,
  scaleStoryboardDurations,
  selectPendingStoryboardScenes,
  storyboardCompleteStory,
  storyboardSceneTimings,
  storyboardSceneHasContent,
  type StoryboardDraft,
  type StoryboardScene,
  type StoryboardSceneCandidate,
  type StoryboardTimingMode,
} from '../data/storyboard'

const STORYBOARD_DRAFT_KEY = 'default:storyboard-v1'
const ENHANCER_PREF_KEY = 'enhancer-storyboard'
const ENHANCE_MAX_LENGTH = 6_000
const SCENE_PROMPT_MIN_LENGTH = 3
const STORYBOARD_CONTEXT_INSTRUCTION = 'Use the complete story and every ordered scene row only to prevent contradictions and preserve explicitly established continuity. Treat attached references as authoritative visual evidence. When the current field is blank, reference-led Auto may draft only that field for its selected Storyboard purpose. Never copy an action or fill a missing detail from another scene unless the current primary text explicitly refers to it.'

type SaveState = 'loading' | 'saved' | 'saving' | 'error'
type BriefRunState = 'idle' | 'enhancing' | 'planning' | 'error'

interface SceneRuntime {
  state: StoryboardSceneRunState
  error?: string
  note?: string
  jobId?: string
}

interface BriefRuntime {
  state: BriefRunState
  error?: string
  note?: string
}

type StoryboardReferenceImage = ReferenceImage & { creationId?: string }

interface GenerationSnapshot {
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  style: string
  references: ReferenceImage[]
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

function candidateExtension(candidate: StoryboardSceneCandidate): string {
  const format = candidate.extras.format?.toLocaleLowerCase()
  return format === 'jpeg' || format === 'jpg' ? 'jpg' : 'png'
}

function effectiveScenePrompt(prompt: string, style: string): string {
  const clean = prompt.trim()
  if (!style || style === 'None') return clean
  return `${clean}\n\nOverall visual direction: ${style}. Preserve every specific subject, action, environment and camera detail above.`
}

function storyboardScenePromptMax(model: string, style: string): number {
  const providerMax = IMAGE_MODEL_CONFIG[model]?.promptMax ?? STORYBOARD_MAX_PROMPT_LENGTH
  const styleScaffoldLength = promptCharacterCount(effectiveScenePrompt('', style))
  return Math.max(1, providerMax - styleScaffoldLength)
}

function applyAutomaticStoryboardTiming(draft: StoryboardDraft): StoryboardDraft {
  if (draft.timingMode !== 'auto') return draft
  const timing = autoStoryboardTiming(draft.scenes, storyboardCompleteStory(draft))
  return { ...draft, ...timing }
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
  const [activeCandidateIds, setActiveCandidateIds] = useState<Record<string, string>>({})
  const [visualSettingsOpen, setVisualSettingsOpen] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchCancelling, setBatchCancelling] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ complete: 0, total: 0 })
  const [exportingBoard, setExportingBoard] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [referenceImages, setReferenceImages] = useState<StoryboardReferenceImage[]>([])
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
  const referencesBlocked = referencesRestoring || referencesUnavailable

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
      const totalDurationSeconds = clampStoryboardTotalDuration(requestedDurationSeconds, current.scenes.length)
      return {
        ...current,
        totalDurationSeconds,
        scenes: scaleStoryboardDurations(current.scenes, totalDurationSeconds),
      }
    })
  }

  const changeTimingMode = (timingMode: StoryboardTimingMode) => {
    updateDraft((current) => {
      if (current.timingMode === timingMode) return current
      const next = { ...current, timingMode }
      return timingMode === 'manual'
        ? { ...next, scenes: scaleStoryboardDurations(next.scenes, next.totalDurationSeconds) }
        : next
    })
  }

  const evenlySplitSceneDurations = () => {
    updateDraft((current) => ({
      ...current,
      scenes: distributeStoryboardDurations(current.scenes, current.totalDurationSeconds),
    }))
  }

  const changeSceneDuration = (sceneId: string, durationSeconds: number) => {
    updateDraft((current) => ({
      ...current,
      scenes: adjustStoryboardSceneDuration(
        current.scenes,
        sceneId,
        durationSeconds,
        current.totalDurationSeconds,
      ),
    }))
  }

  const changeModel = (model: string) => {
    if (referencesBlocked) {
      toast(referencesUnavailable ? 'Library references are unavailable right now' : 'Restoring Storyboard references…')
      return
    }
    const workInFlight = referenceImporting
      || batchRunning
      || briefRuntime.state === 'enhancing'
      || briefRuntime.state === 'planning'
      || Object.values(runtime).some((scene) => scene.state === 'enhancing' || scene.state === 'generating')
    if (workInFlight) {
      toast('Wait for the current storyboard task before changing models')
      return
    }
    const options = resolveImageOptions(model)
    const nextReferenceLimit = IMAGE_MODEL_CONFIG[model].maxReferenceImages
    const currentReferences = referenceImagesRef.current
    if (currentReferences.length > nextReferenceLimit) {
      const removeCount = currentReferences.length - nextReferenceLimit
      const confirmed = window.confirm(
        `${model} accepts up to ${nextReferenceLimit} reference image${nextReferenceLimit === 1 ? '' : 's'}. Switch models and remove ${removeCount} extra reference${removeCount === 1 ? '' : 's'}?`,
      )
      if (!confirmed) return
      const kept = currentReferences.slice(0, nextReferenceLimit)
      releaseReferenceImages(currentReferences.slice(nextReferenceLimit))
      referenceImagesRef.current = kept
      setReferenceImages(kept)
      toast(`${model} keeps the first ${nextReferenceLimit} reference image${nextReferenceLimit === 1 ? '' : 's'}`)
    }
    updateDraft((current) => ({
      ...current,
      model,
      referenceCreationIds: referenceImagesRef.current.flatMap((reference) => reference.creationId ? [reference.creationId] : []),
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
      const limit = IMAGE_MODEL_CONFIG[model].maxReferenceImages
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
    const limit = IMAGE_MODEL_CONFIG[model].maxReferenceImages
    const current = referenceImagesRef.current
    const existingIds = new Set(current.flatMap((reference) => reference.creationId ? [reference.creationId] : []))
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
    const limit = IMAGE_MODEL_CONFIG[model].maxReferenceImages
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
      const latestLimit = IMAGE_MODEL_CONFIG[draftRef.current.model].maxReferenceImages
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

  const changeWorkflowMode = (workflowMode: StoryboardDraft['workflowMode']) => {
    updateDraft((current) => ({ ...current, workflowMode }))
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

  const enhanceStoryBrief = async () => {
    if (referencesBlocked || briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning') return
    const current = draftRef.current
    const briefSnapshot = current.storyBrief
    const contextSnapshot = buildStoryboardEnhancementContext(current)
    const promptReferences = referencesForPrompting(referenceImagesRef.current)
    if (!canEnhancePrompt(briefSnapshot, promptReferences, SCENE_PROMPT_MIN_LENGTH)) return
    const controller = new AbortController()
    controllersRef.current.set('brief:enhance', controller)
    setBriefRuntime({ state: 'enhancing' })
    try {
      const result = await enhancePrompt({
        rough: briefSnapshot,
        targetModel: `Complete storyboard planned for ${current.model}`,
        mediaKind: 'workflow',
        purpose: 'story-brief',
        chatModel: enhancerModel,
        maxLength: Math.min(ENHANCE_MAX_LENGTH, STORYBOARD_MAX_STORY_BRIEF_LENGTH),
        style: current.style || undefined,
        references: promptReferences,
        supportingContext: {
          label: 'current storyboard context',
          text: contextSnapshot,
          instruction: STORYBOARD_CONTEXT_INSTRUCTION,
        },
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onSpend(result.credits ?? 0)
      if (draftRef.current.storyBrief !== briefSnapshot) {
        toast('Story brief changed while AI was working · your newer text was kept')
        setBriefRuntime({ state: 'idle' })
        return
      }
      if (buildStoryboardEnhancementContext(draftRef.current) !== contextSnapshot) {
        toast('Storyboard context changed while AI was working · improve again to use the latest scenes')
        setBriefRuntime({ state: 'idle' })
        return
      }
      updateDraft((latest) => ({ ...latest, storyBrief: result.text }))
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
    const promptReferences = referencesForPrompting(referenceImagesRef.current)
    if (!scene || !canEnhancePrompt(scene.prompt, promptReferences, SCENE_PROMPT_MIN_LENGTH)) return
    const promptSnapshot = scene.prompt
    const modelSnapshot = currentDraft.model
    const styleSnapshot = currentDraft.style
    const promptMaxSnapshot = storyboardScenePromptMax(modelSnapshot, styleSnapshot)
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
        references: promptReferences,
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
    if (!alreadyClaimed) {
      if (inFlightSceneIdsRef.current.has(sceneId)) return false
      inFlightSceneIdsRef.current.add(sceneId)
    }
    const promptSnapshot = sceneSnapshot.prompt.trim()
    if (promptSnapshot.length < SCENE_PROMPT_MIN_LENGTH) {
      inFlightSceneIdsRef.current.delete(sceneId)
      setSceneRuntime(sceneId, { state: 'error', error: 'Describe this scene with at least 3 characters.' })
      return false
    }
    const compiledPrompt = effectiveScenePrompt(promptSnapshot, settings.style)
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
    setSceneRuntime(sceneId, { state: 'generating' })
    try {
      const estimate = imageRunEstimate(
        settings.model,
        settings.resolution,
        settings.extras,
        1,
        { referenceCount: settings.references.length },
      )
      const result = await runImage({
        jobTitle: `Storyboard · ${sceneLabel(ordinal)}`,
        model: settings.model,
        prompt: compiledPrompt,
        aspect: settings.aspect,
        resolution: settings.resolution,
        extras: settings.extras,
        refs: settings.references,
        count: 1,
      }, {
        signal: controller.signal,
        onJobCreated: (nextJobId) => {
          jobId = nextJobId
          sceneJobIdsRef.current.set(sceneId, nextJobId)
          setSceneRuntime(sceneId, { state: 'generating', jobId: nextJobId })
        },
      })
      if (controller.signal.aborted) return false
      const charged = result.credits ?? resolveCharged(estimate)
      onSpend(charged ?? 0)
      const url = result.urls[0]
      if (!url) throw new Error('No frame was returned for this scene.')
      const [creation] = addCreations([{
        kind: 'image',
        url,
        model: settings.model,
        prompt: promptSnapshot,
        meta: `Storyboard · ${sceneLabel(ordinal)} · ${settings.aspect}${settings.resolution ? ` · ${settings.resolution}` : ''}`,
      }])
      if (!creation) throw new Error('The generated frame could not be saved to Library.')
      const candidate: StoryboardSceneCandidate = {
        creationId: creation.id,
        promptSnapshot,
        model: settings.model,
        aspect: settings.aspect,
        resolution: settings.resolution,
        extras: { ...settings.extras },
        createdAt: creation.createdAt,
      }
      const attached = draftRef.current.scenes.some((scene) => scene.id === sceneId)
      updateDraft((current) => ({
        ...current,
        scenes: current.scenes.map((scene) => {
          if (scene.id !== sceneId) return scene
          return {
            ...scene,
            candidates: [...scene.candidates.filter((item) => item.creationId !== creation.id), candidate]
              .slice(-STORYBOARD_MAX_CANDIDATES_PER_SCENE),
            approvedCreationId: creation.id,
            approvedPromptSnapshot: promptSnapshot,
          }
        }),
      }))
      setActiveCandidateIds((current) => ({ ...current, [sceneId]: creation.id }))
      setSceneRuntime(sceneId, { state: 'idle', note: 'Frame ready' })
      if (!attached) toast('Scene was removed · the generated frame is still safe in Library')
      return true
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
    const ordinal = current.scenes.findIndex((item) => item.id === sceneId)
    const settings: GenerationSnapshot = {
      model: current.model,
      aspect: current.aspect,
      resolution: current.resolution,
      extras: { ...current.extras },
      style: current.style,
      references: referenceImagesRef.current.slice(0, IMAGE_MODEL_CONFIG[current.model].maxReferenceImages),
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

  const generateAll = useCallback(async (sourceDraft?: StoryboardDraft) => {
    if (referenceImportingRef.current || referencesBlocked || batchRunning || Object.values(runtime).some((scene) => scene.state === 'enhancing' || scene.state === 'generating')) return
    const current = sourceDraft ?? draftRef.current
    const pending = selectPendingStoryboardScenes(current.scenes, inFlightSceneIdsRef.current)
    if (!pending.length) return
    const settings: GenerationSnapshot = {
      model: current.model,
      aspect: current.aspect,
      resolution: current.resolution,
      extras: { ...current.extras },
      style: current.style,
      references: referenceImagesRef.current.slice(0, IMAGE_MODEL_CONFIG[current.model].maxReferenceImages),
    }
    pending.forEach((scene) => inFlightSceneIdsRef.current.add(scene.id))
    batchCancelRef.current = false
    setBatchCancelling(false)
    setBatchRunning(true)
    setBatchProgress({ complete: 0, total: pending.length })
    let cursor = 0
    let completed = 0
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      for (;;) {
        if (!mountedRef.current || batchCancelRef.current) return
        const queueIndex = cursor
        cursor += 1
        const scene = pending[queueIndex]
        if (!scene) return
        const ordinal = current.scenes.findIndex((item) => item.id === scene.id)
        await generateScene(scene, settings, ordinal, true)
        completed += 1
        if (mountedRef.current) setBatchProgress({ complete: completed, total: pending.length })
      }
    })
    await Promise.allSettled(workers)
    if (!mountedRef.current) return
    const wasCancelled = batchCancelRef.current
    pending.forEach((scene) => inFlightSceneIdsRef.current.delete(scene.id))
    setBatchRunning(false)
    setBatchCancelling(false)
    const approved = draftRef.current.scenes.filter(isStoryboardSceneApproved).length
    if (wasCancelled) {
      toast('Storyboard generation stopped · submitted frames continue safely in Activity')
    } else if (approved === draftRef.current.scenes.length) {
      toast('Storyboard ready · every approved frame was preserved')
      window.setTimeout(() => finalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } else {
      toast('Generation finished · completed frames were kept')
    }
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

  const buildFromStoryBrief = async (generateFrames: boolean) => {
    if (referenceImportingRef.current || referencesBlocked || briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning' || batchRunning || inFlightSceneIdsRef.current.size) return
    const current = draftRef.current
    const briefSnapshot = current.storyBrief
    if (briefSnapshot.trim().length < SCENE_PROMPT_MIN_LENGTH) return
    if (current.scenes.some(storyboardSceneHasContent)) {
      const confirmed = window.confirm('Replace the current scene plan with a new plan from the Story Brief? Existing generated images will remain safe in Library.')
      if (!confirmed) return
    }

    const controller = new AbortController()
    controllersRef.current.set('brief:plan', controller)
    setBriefRuntime({ state: 'planning' })
    try {
      const result = await planStoryboard({
        storyBrief: briefSnapshot,
        targetModel: current.model,
        chatModel: enhancerModel,
        timingMode: current.timingMode,
        totalDurationSeconds: current.timingMode === 'manual' ? current.totalDurationSeconds : undefined,
        style: current.style || undefined,
        scenePromptMax: storyboardScenePromptMax(current.model, current.style),
        references: referencesForPrompting(referenceImagesRef.current),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onSpend(result.chatCredits ?? 0)
      if (draftRef.current !== current) {
        toast('Storyboard changed while AI was planning · your newer edits were kept')
        setBriefRuntime({ state: 'idle' })
        return
      }

      const plannedSceneSeeds = result.scenes.map((scene) => ({
        ...createStoryboardScene(),
        title: scene.title,
        prompt: scene.prompt,
        explanation: scene.explanation,
        durationSeconds: scene.durationSeconds ?? 1,
      }))
      const plannedTotalDuration = current.timingMode === 'auto'
        ? clampStoryboardTotalDuration(
          result.totalDurationSeconds
            ?? result.scenes.reduce((sum, scene) => sum + (scene.durationSeconds ?? 0), 0),
          plannedSceneSeeds.length,
        )
        : clampStoryboardTotalDuration(current.totalDurationSeconds, plannedSceneSeeds.length)
      const plannedScenes = scaleStoryboardDurations(plannedSceneSeeds, plannedTotalDuration)
      const plannedDraft: StoryboardDraft = {
        ...draftRef.current,
        storySummary: result.summary,
        totalDurationSeconds: plannedTotalDuration,
        scenes: plannedScenes,
      }
      draftRef.current = plannedDraft
      setDraft(plannedDraft)
      setRuntime({})
      setActiveCandidateIds({})
      setBriefRuntime({ state: 'idle', note: actionNote(`${plannedScenes.length} scenes planned`, result.chatCredits) })
      toast(`${plannedScenes.length} scene${plannedScenes.length === 1 ? '' : 's'} planned from your Story Brief`)

      if (!generateFrames) return
      const frameEstimate = imageRunEstimate(
        plannedDraft.model,
        plannedDraft.resolution,
        plannedDraft.extras,
        plannedScenes.length,
        { referenceCount: Math.min(referenceImagesRef.current.length, IMAGE_MODEL_CONFIG[plannedDraft.model].maxReferenceImages) },
      )
      const spendApproval = getSpendApproval(frameEstimate, loadSettings().spendLimit)
      if (!spendApproval.approved) {
        toast(spendApproval.reason ?? 'This generation needs a new spending approval.')
        return
      }
      const confirmed = window.confirm(
        `Create all ${plannedScenes.length} storyboard frame${plannedScenes.length === 1 ? '' : 's'} now?\n\nEstimated image cost: ${formatEstimate(frameEstimate, false)}\nEvery finished frame is saved to Library immediately.`,
      )
      if (!confirmed) return
      await generateAll(plannedDraft)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof ChatError) onSpend(error.credits ?? 0)
      setBriefRuntime({ state: 'error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      controllersRef.current.delete('brief:plan')
    }
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

  const exportCompleteBoard = async () => {
    if (exportingBoard) return
    const current = draftRef.current
    const completeStory = storyboardCompleteStory(current)
    const timings = storyboardSceneTimings(current.scenes)
    const exportScenes = current.scenes.map((scene, index) => {
      const candidate = findStoryboardCandidate(scene, scene.approvedCreationId)
      const creation = candidate ? creationsById.get(candidate.creationId) : undefined
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
      return
    }
    if (!completeStory) {
      toast(current.workflowMode === 'full'
        ? 'Add the complete story in Story Brief before exporting'
        : 'Add the Complete Story Context before exporting')
      return
    }
    if (exportScenes.some((scene) => !scene.description.trim() || !scene.explanation.trim())) {
      toast('Add a scene description and story explanation to every scene before exporting')
      return
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
        timingMode: current.timingMode,
        totalDurationSeconds: current.totalDurationSeconds,
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
          meta: `Complete storyboard · ${current.timingMode === 'none' ? '' : `${current.totalDurationSeconds}s · `}${current.scenes.length} scene${current.scenes.length === 1 ? '' : 's'} · 1920px PNG`,
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
        saveUrl(creation.url, `${safeExportName(current.title)}.png`)
        setLightbox(creation.url)
        toast('Complete storyboard saved to Library and exported as one image')
      } catch (error) {
        if (ownsTemporaryUrl) URL.revokeObjectURL(localUrl)
        throw error
      }
    } catch (error) {
      exportJob?.fail(error)
      toast(error instanceof Error ? error.message : 'Could not build the complete storyboard image')
    } finally {
      if (mountedRef.current) setExportingBoard(false)
    }
  }

  const config = IMAGE_MODEL_CONFIG[draft.model]
  const scenePromptMax = storyboardScenePromptMax(draft.model, draft.style)
  const connected = isConnected()
  const approvedCount = draft.scenes.filter(isStoryboardSceneApproved).length
  const anySceneBusy = Object.values(runtime).some((scene) => scene.state === 'enhancing' || scene.state === 'generating')
  const briefBusy = briefRuntime.state === 'enhancing' || briefRuntime.state === 'planning'
  const referenceLimit = config.maxReferenceImages
  const referenceInputsLocked = referencesBlocked || referenceImporting || batchRunning || briefBusy || anySceneBusy
  const incompleteCount = draft.scenes.filter((scene) => scene.prompt.trim().length < SCENE_PROMPT_MIN_LENGTH && !isStoryboardSceneApproved(scene)).length
  const overLimitSceneCount = draft.scenes.filter((scene) => (
    !isStoryboardSceneApproved(scene) && promptCharacterCount(scene.prompt) > scenePromptMax
  )).length
  const missingCount = draft.scenes.length - approvedCount
  const estimate = imageRunEstimate(
    draft.model,
    draft.resolution,
    draft.extras,
    missingCount,
    { referenceCount: referenceImages.length },
  )
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const footerError = referencesUnavailable || spendBlocked || overLimitSceneCount > 0
  const displayedStyle = draft.style || 'None'
  const hasScenePlan = draft.scenes.some(storyboardSceneHasContent)
  const showSceneWorkspace = draft.workflowMode === 'scenes' || hasScenePlan
  const sceneTimings = storyboardSceneTimings(draft.scenes)
  const maximumSceneDuration = Math.max(1, draft.totalDurationSeconds - Math.max(0, draft.scenes.length - 1))
  const sceneDurationOptions = useMemo(
    () => Array.from({ length: maximumSceneDuration }, (_, index) => `${index + 1}s`),
    [maximumSceneDuration],
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
      approved: isStoryboardSceneApproved(scene),
      stale: isStoryboardApprovalStale(scene),
    }
  })
  const everyExportImageReady = finalScenes.length > 0 && finalScenes.every((scene) => scene.approved && Boolean(scene.url))
  const fullStoryReady = Boolean(storyboardCompleteStory(draft))
  const everySceneExplained = finalScenes.every((scene) => Boolean(scene.prompt.trim() && scene.explanation.trim()))
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

  return (
    <div className="ef-screen ef-legacy-workspace ef-storyboard-screen">
      <header className="ef-sub-header ef-storyboard-header">
        <button type="button" className="ef-back" onClick={handleBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Storyboard</span>
        <span className="ef-spacer" />
        <span className={`ef-story-save-state is-${saveState}`} aria-live="polite">
          {saveState === 'loading' ? 'Loading' : saveState === 'saving' ? 'Saving' : saveState === 'error' ? 'Save issue' : 'Saved'}
        </span>
        <span className="ef-story-progress"><strong>{approvedCount}</strong>/{draft.scenes.length}</span>
      </header>

      <div className="ef-scroll ef-create-scroll ef-storyboard-scroll">
        <section className="ef-story-setup" aria-labelledby="ef-story-setup-title">
          <div className="ef-story-setup-copy">
            <span>ONE IDEA · COMPLETE STORY</span>
            <h1 id="ef-story-setup-title">Start with the whole story—or direct every scene.</h1>
            <p>Write one Story Brief and let AI build the complete scene plan, or add scene boxes yourself. Every prompt remains editable before a frame is generated.</p>
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
                <small>One brief → AI builds the complete scene plan</small>
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
            <div className="ef-field ef-story-model-field">
              <span className="ef-field-label">IMAGE MODEL</span>
              <Dropdown options={IMAGE_MODELS} selected={draft.model} onSelect={changeModel} label="Image model" optionMeta={IMAGE_MODEL_META} />
            </div>
          </div>

          <div className="ef-story-references">
            <ReferenceImageGrid
              images={referenceImages}
              max={referenceLimit}
              onAddFiles={addReferenceFiles}
              onChooseLibrary={addReferenceCreations}
              libraryExcludedIds={activeReferenceCreationIds}
              onRemove={removeReferenceImage}
              onGrabPlayhead={grabReferenceFrame}
              locked={referenceInputsLocked || referenceLimit === 0}
              lockedHint={referencesUnavailable
                ? 'Library storage is unavailable · saved Storyboard references were not sent.'
                : referencesRestoring
                  ? 'Restoring saved Storyboard references…'
                  : referenceImporting
                    ? 'Adding reference images…'
                    : referenceInputsLocked
                      ? 'References are locked while Storyboard is working.'
                      : `${draft.model} does not accept reference images.`}
              label="STORY REFERENCES"
            />
            <p>
              Used as visual continuity for the scene plan and every generated frame.
              {' '}{draft.model} accepts up to {referenceLimit} reference image{referenceLimit === 1 ? '' : 's'}.
            </p>
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
            <div className="ef-prompt-footer ef-story-brief-footer">
              <button
                type="button"
                className={`ef-enhance-btn${briefRuntime.state === 'enhancing' ? ' loading' : ''}`}
                aria-label={!connected ? 'Connect EasyField Cloud to improve the Story Brief' : `Improve the Story Brief using the current storyboard and references with ${enhancerModel}`}
                title={!connected ? 'Connect EasyField Cloud to improve prompts' : `Uses the current scene plan and every attached reference · ${enhancerModel}`}
                disabled={!connected || !canEnhancePrompt(draft.storyBrief, referencesForPrompting(referenceImages), SCENE_PROMPT_MIN_LENGTH) || referenceInputsLocked}
                onClick={() => void enhanceStoryBrief()}
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
              <span className="ef-spacer" />
              {briefRuntime.state === 'enhancing'
                ? <span className="ef-enhance-note" role="status">✨ improving…</span>
                : briefRuntime.state === 'planning'
                  ? <span className="ef-enhance-note" role="status">✨ directing scenes…</span>
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
              <textarea
                id="storyboard-story-summary-scenes"
                value={draft.storySummary}
                maxLength={STORYBOARD_MAX_STORY_SUMMARY_LENGTH}
                rows={3}
                placeholder="Describe the overall story arc, characters, continuity and ending that connect these scenes."
                aria-describedby="storyboard-story-summary-help"
                onChange={(event) => updateDraft((current) => ({ ...current, storySummary: event.target.value }))}
              />
            </div>
          )}

          <StoryboardTimingEditor
            timingMode={draft.timingMode}
            totalDurationSeconds={draft.totalDurationSeconds}
            scenes={draft.scenes}
            disabled={referenceInputsLocked}
            onTimingModeChange={changeTimingMode}
            onTotalDurationChange={changeTotalDuration}
            onEvenSplit={evenlySplitSceneDurations}
          />

          {draft.workflowMode === 'full' && (
            <>
              <div className="ef-story-brief-actions">
                <button
                  type="button"
                  className="ef-story-plan-button"
                  disabled={!hydrated || !connected || draft.storyBrief.trim().length < SCENE_PROMPT_MIN_LENGTH || referenceInputsLocked}
                  onClick={() => void buildFromStoryBrief(false)}
                >
                  <Icon glyph="board" size={14} />
                  {briefRuntime.state === 'planning' ? 'Planning scenes…' : 'Build scene plan'}
                </button>
                <button
                  type="button"
                  className="ef-story-create-full"
                  disabled={!hydrated || !connected || draft.storyBrief.trim().length < SCENE_PROMPT_MIN_LENGTH || referenceInputsLocked}
                  onClick={() => void buildFromStoryBrief(true)}
                >
                  <Icon glyph="spark" size={14} />
                  Create full storyboard
                </button>
                <small>AI chooses the right number of scenes. “Create full storyboard” shows the image cost before generation.</small>
              </div>
              {briefRuntime.error && <div className="ef-story-scene-error" role="alert">{briefRuntime.error}</div>}
            </>
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
        </section>

        {showSceneWorkspace && (
          <>
            <div className="ef-story-scenes-head">
              <div>
                <span>SCENE PLAN</span>
                <h2>{draft.workflowMode === 'full' ? 'Review every frame.' : 'Direct every frame.'}</h2>
              </div>
              <p>{approvedCount ? `${approvedCount} approved frame${approvedCount === 1 ? '' : 's'} will be reused exactly as selected.` : draft.workflowMode === 'full' ? 'Every planned scene remains fully editable before generation.' : 'Add as many scene boxes as you need and direct each frame yourself.'}</p>
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
            return (
              <StoryboardSceneCard
                key={scene.id}
                index={index}
                total={draft.scenes.length}
                title={scene.title}
                prompt={scene.prompt}
                explanation={scene.explanation}
                timingMode={draft.timingMode}
                durationSeconds={sceneTimings[index].durationSeconds}
                startSeconds={sceneTimings[index].startSeconds}
                endSeconds={sceneTimings[index].endSeconds}
                durationOptions={sceneDurationOptions}
                maxLength={scenePromptMax}
                runState={sceneRuntime.state}
                error={sceneRuntime.error}
                statusNote={sceneRuntime.note}
                candidates={candidateViews}
                activeCandidateId={activeCandidateId}
                approvalStale={isStoryboardApprovalStale(scene)}
                connected={connected}
                batchRunning={referenceInputsLocked}
                generationJob={sceneRuntime.jobId ? jobsById.get(sceneRuntime.jobId) ?? null : null}
                enhancerModel={enhancerModel}
                canEnhanceFromReferences={referenceImages.length > 0}
                onEnhancerModelChange={changeEnhancerModel}
                onTitleChange={(title) => updateScene(scene.id, (current) => ({ ...current, title }))}
                onPromptChange={(prompt) => {
                  updateScene(scene.id, (current) => ({ ...current, prompt }))
                  if (runtime[scene.id]?.error || runtime[scene.id]?.note) setSceneRuntime(scene.id, { state: 'idle' })
                }}
                onExplanationChange={(explanation) => updateScene(scene.id, (current) => ({ ...current, explanation }))}
                onDurationChange={(durationSeconds) => changeSceneDuration(scene.id, durationSeconds)}
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

            {draft.workflowMode === 'scenes' && (
              <button
                type="button"
                className="ef-story-add-scene"
                onClick={addScene}
                disabled={draft.scenes.length >= STORYBOARD_MAX_SCENES || batchRunning || briefBusy}
              >
                <span>+</span> Add scene
              </button>
            )}

            <div ref={finalRef}>
              <StoryboardFinalStrip
                scenes={finalScenes}
                timingMode={draft.timingMode}
                totalDurationSeconds={draft.totalDurationSeconds}
                onPreview={setLightbox}
                onDownloadAll={downloadApprovedFrames}
                onOpenLibrary={onOpenLibrary}
                onExportBoard={() => void exportCompleteBoard()}
                exporting={exportingBoard}
                canExportBoard={completeBoardReady}
                exportDisabledReason={exportDisabledReason}
              />
            </div>
          </>
        )}
      </div>

      {showSceneWorkspace && (
        <footer className="ef-create-footer ef-story-footer" aria-label="Storyboard generation summary">
        <PriceEstimate estimate={estimate} />
        <div
          id="storyboard-footer-message"
          className={`ef-create-footer-message ${footerError ? 'is-error' : connected && !incompleteCount && !referencesRestoring ? 'is-ready' : 'is-help'}`}
          role={footerError ? 'alert' : 'status'}
          aria-live="polite"
        >
          {!hydrated
            ? 'Restoring storyboard draft…'
            : referencesUnavailable
              ? 'Saved Storyboard references are unavailable · generation is paused to protect continuity'
              : referencesRestoring
                ? 'Restoring saved Storyboard references…'
                : batchRunning
              ? `Generating ${batchProgress.complete}/${batchProgress.total} · completed frames are already safe`
              : !connected
                ? 'Connect EasyField Cloud to improve prompts, plan the story and generate frames'
                : spendBlocked
                  ? `✕ ${spendApproval.reason}`
                  : overLimitSceneCount
                    ? `✕ ${overLimitSceneCount} scene prompt${overLimitSceneCount === 1 ? ' is' : 's are'} over ${draft.model}'s ${config.promptMax.toLocaleString()}-character provider limit after visual direction`
                  : incompleteCount
                    ? `${incompleteCount} scene${incompleteCount === 1 ? ' needs' : 's need'} a description`
                    : missingCount
                      ? `${approvedCount ? `Keeps ${approvedCount} approved · ` : ''}generates ${missingCount} missing frame${missingCount === 1 ? '' : 's'}`
                      : `Storyboard ready · ${approvedCount}/${draft.scenes.length} approved`}
        </div>
        <button
          type="button"
          className={`ef-generate ef-create-footer-action ef-story-generate-all${batchRunning ? ' is-cancel' : ''}`}
          onClick={batchRunning ? exitBatchGeneration : () => void generateAll()}
          disabled={batchRunning
            ? batchCancelling
            : !hydrated || !connected || referenceInputsLocked || !!incompleteCount || !!overLimitSceneCount || !missingCount || !spendApproval.approved}
          aria-describedby="storyboard-footer-message"
        >
          {!batchRunning && <Icon glyph="spark" color="#0E0E13" size={13} />}
          {batchRunning
            ? batchCancelling ? 'Stopping…' : `Cancel batch · ${batchProgress.complete}/${batchProgress.total}`
            : approvedCount
              ? `Generate missing (${missingCount})`
              : `Generate all (${missingCount})`}
        </button>
        </footer>
      )}

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
