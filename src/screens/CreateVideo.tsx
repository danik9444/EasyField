import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PromptCard } from '../components/PromptCard'
import { ReferenceImageGrid } from '../components/ReferenceImageGrid'
import { FrameInputs } from '../components/FrameInputs'
import { MediaFileGrid } from '../components/MediaFileGrid'
import { StoryboardEditor, type Shot } from '../components/StoryboardEditor'
import { KlingElementEditor } from '../components/KlingElementEditor'
import { DurationSlider } from '../components/DurationSlider'
import { MultiSelectChips } from '../components/MultiSelectChips'
import { PriceEstimate } from '../components/PriceEstimate'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { videoRunEstimate, resolveCharged, formatCharged } from '../data/pricing'
import { resolve, type Grab, type ResolvePlacementAnchor } from '../services/resolve'
import { sendToTimeline, type TimelinePlacementContext } from '../services/timeline'
import { runVideo, isConnected, isGenerationExit, saveUrl } from '../services/run'
import { addCreations } from '../data/creations'
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL, VIDEO_MODEL_ALIASES } from '../data/models'
import { VIDEO_MODEL_CONFIG, defaultVideoOptionsFor, type FrameMode, type MediaSide } from '../data/videoModelConfig'
import { VIDEO_MODEL_META } from '../data/modelPresentation'
import {
  EXTEND_VIDEO_MODELS,
  supportsExtendVideoReference,
  supportsExtendMultiShot,
  supportsKlingElementsForWorkflow,
} from '../data/extendVideoConfig'
import { TRANSITION_VIDEO_MODELS } from '../data/transitionVideoConfig'
import { loadGenPrefs, saveGenPrefs } from '../data/prefs'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import type { ReferenceImage, MediaFile } from '../data/referenceImage'
import type { EnhanceReference } from '../services/chat'
import {
  MULTI_SHOT_CONTINUITY_DIRECTION,
  normalizeMultiShotScenes,
  totalMultiShotDuration,
  validateMultiShotDraft,
} from '../data/videoMultiShot'
import {
  KLING_ELEMENT_MAX,
  klingElementProviderTag,
  klingElementReferenceManifest,
  klingElementReferenceOptions,
  stripOrphanKlingSceneReferenceTags,
  validateKlingElementDrafts,
  type KlingElementDraft,
  type KlingElementFileLike,
} from '../data/klingElements'
import { validateKlingMotionDraft } from '../data/klingMotion'
import { happyHorsePromptMax } from '../data/promptLimits'

const COUNTS = ['1', '2', '3', '4']
const DEFAULT_COUNT = '1'
const NEG_PROMPT_MAX = 500
const CREATE_VIDEO_PREFS_KEY = 'create-video'
const EXTEND_VIDEO_PREFS_KEY = 'extend-video'
const TRANSITION_VIDEO_PREFS_KEY = 'transition-video'
const DEFAULT_CREATE_PROMPT = 'Slow push-in on a neon-lit street at night, rain reflecting the signs'
const DEFAULT_EXTEND_PROMPT = 'Continue the action naturally from the final frame, preserving subject, camera movement, lighting and scene continuity'
const DEFAULT_TRANSITION_PROMPT = 'Create a seamless cinematic bridge that preserves motion, lighting, perspective and visual continuity between these shots'

type Phase = 'form' | 'generating' | 'done'

interface VideoPerModel {
  aspect: string
  resolution: string
  duration: string
  extraOptionValues: Record<string, string>
  negativePrompt: string
  webSearch: string
  multiShotOn: boolean
  shots: Shot[]
  voices: string[]
}

// Resolve a model's settings from stored prefs, dropping values no longer valid
// for the model's config and falling back to defaults.
function resolveVideoSettings(model: string, stored?: VideoPerModel): VideoPerModel {
  const cfg = VIDEO_MODEL_CONFIG[model]
  const def = defaultVideoOptionsFor(model)
  const extraOptionValues: Record<string, string> = {}
  cfg.extraOptions.forEach((opt) => {
    const v = stored?.extraOptionValues?.[opt.key]
    extraOptionValues[opt.key] = v && opt.values.includes(v) ? v : opt.values[0]
  })
  const multiShotOn = !!cfg.multiShot && !!stored?.multiShotOn
  let migrationId = 0
  const shots: Shot[] = cfg.multiShot
    ? normalizeMultiShotScenes(stored?.shots, cfg.multiShot, () => `shot-migrated-${migrationId++}`)
    : []
  return {
    aspect: stored && cfg.aspectRatios.includes(stored.aspect) ? stored.aspect : def.aspect,
    resolution: stored && cfg.resolutions.includes(stored.resolution) ? stored.resolution : def.resolution,
    duration: stored && cfg.durations.includes(stored.duration) ? stored.duration : def.duration,
    extraOptionValues,
    negativePrompt: cfg.negativePrompt ? stored?.negativePrompt ?? '' : '',
    webSearch: cfg.webSearch ? (stored?.webSearch === 'On' ? 'On' : 'Off') : 'Off',
    multiShotOn,
    shots,
    // Omni's generation endpoint accepts persisted audio IDs, not the preset
    // display names this early UI stored. Clear them instead of replaying a
    // control whose value cannot be represented in the request contract.
    voices:
      model === 'Gemini Omni Video'
        ? []
        : cfg.voices
          ? stored?.voices?.filter((v) => cfg.voices!.presets.includes(v)) ?? []
          : [],
  }
}

export interface CreateVideoProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
  mode?: 'create' | 'extend' | 'transition'
}

function aspectToCss(aspect: string): string {
  const match = aspect.match(/^(\d+):(\d+)$/)
  return match ? `${match[1]} / ${match[2]}` : '16 / 9'
}

const revoke = (img: ReferenceImage | null) => {
  if (img?.kind === 'upload') URL.revokeObjectURL(img.url)
}
const revokeMedia = (m: MediaFile) => {
  if (m.kind === 'upload') URL.revokeObjectURL(m.url)
}

function persistKlingFile(file: KlingElementFileLike): KlingElementFileLike {
  if (file.url) return file
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      mimeType: file.type,
      byteSize: file.size,
      width: file.width,
      height: file.height,
      url: URL.createObjectURL(file),
    }
  }
  return file
}

function persistKlingElement(element: KlingElementDraft): KlingElementDraft {
  return {
    ...element,
    media: element.media?.kind === 'images'
      ? { ...element.media, files: element.media.files.map(persistKlingFile) }
      : element.media
        ? { ...element.media, file: persistKlingFile(element.media.file) }
        : null,
    audio: element.audio ? { ...element.audio, file: persistKlingFile(element.audio.file) } : null,
  }
}

function klingElementUrls(element: KlingElementDraft): string[] {
  const visual = element.media?.kind === 'images'
    ? element.media.files
    : element.media
      ? [element.media.file]
      : []
  return [...visual, ...(element.audio ? [element.audio.file] : [])]
    .map((file) => file.url)
    .filter((url): url is string => !!url && url.startsWith('blob:'))
}

function revokeRemovedKlingUrls(previous: readonly KlingElementDraft[], next: readonly KlingElementDraft[]): void {
  const kept = new Set(next.flatMap(klingElementUrls))
  previous.flatMap(klingElementUrls).forEach((url) => {
    if (!kept.has(url)) URL.revokeObjectURL(url)
  })
}

function probeMediaDuration(url: string, kind: 'video' | 'audio'): Promise<number | undefined> {
  return new Promise((resolveDuration) => {
    const media = document.createElement(kind)
    let settled = false
    const finish = (value?: number) => {
      if (settled) return
      settled = true
      media.onloadedmetadata = null
      media.onerror = null
      media.removeAttribute('src')
      media.load()
      resolveDuration(value && Number.isFinite(value) && value > 0 ? value : undefined)
    }
    const timer = window.setTimeout(() => finish(), 5000)
    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      window.clearTimeout(timer)
      finish(media.duration)
    }
    media.onerror = () => {
      window.clearTimeout(timer)
      finish()
    }
    media.src = url
  })
}

async function probeImageFileMetadata(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const metadata = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return metadata.width > 0 && metadata.height > 0 ? metadata : null
  } catch {
    return null
  }
}

function probeVideoMetadata(url: string): Promise<{ durationSeconds?: number; width?: number; height?: number }> {
  return new Promise((resolveMetadata) => {
    const video = document.createElement('video')
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      const durationSeconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined
      const width = video.videoWidth > 0 ? video.videoWidth : undefined
      const height = video.videoHeight > 0 ? video.videoHeight : undefined
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      video.load()
      resolveMetadata({ durationSeconds, width, height })
    }
    const timer = window.setTimeout(finish, 5_000)
    video.preload = 'metadata'
    video.onloadedmetadata = finish
    video.onerror = finish
    video.src = url
  })
}

interface StandardKlingElementBankProps {
  elements: readonly KlingElementDraft[]
  workflow: 'create' | 'extend'
  onAdd: () => void
  onEdit: (elementId: string) => void
  onDelete: (elementId: string) => void
}

function StandardKlingElementBank({ elements, workflow, onAdd, onEdit, onDelete }: StandardKlingElementBankProps) {
  const isExtend = workflow === 'extend'
  return (
    <section className="ef-kling-standard-bank" aria-label="Kling 3 Elements">
      <header>
        <div>
          <span>KLING 3 · ELEMENTS</span>
          <h2>Keep recurring subjects consistent.</h2>
          <p>
            Name each character or subject once. Every Element is included in this {isExtend ? 'extension' : 'Standard clip'}.
          </p>
        </div>
        <button
          type="button"
          disabled={elements.length >= KLING_ELEMENT_MAX}
          onClick={onAdd}
          title={elements.length >= KLING_ELEMENT_MAX ? 'Kling supports up to 3 Elements' : 'Create a named Element'}
        >
          <span aria-hidden="true">＋</span> Add Element
        </button>
      </header>
      {elements.length ? (
        <div className="ef-kling-standard-bank-list">
          {elements.map((element) => {
            const tag = klingElementProviderTag(element.id)
            const media = element.media?.kind === 'images'
              ? `${element.media.files.length} images`
              : element.media
                ? `Video ${((element.media.endTimeMs - element.media.startTimeMs) / 1_000).toFixed(1)}s`
                : 'Media missing'
            return (
              <article key={element.id}>
                <span className="ef-kling-standard-bank-icon" aria-hidden="true">
                  <Icon glyph={element.media?.kind === 'video' ? 'film' : 'avatar'} size={17} />
                </span>
                <div>
                  <strong>{element.name || 'Unnamed Element'}</strong>
                  <p>{element.description || 'Add a precise identity description.'}</p>
                  <small>{media}{element.audio ? ' · voice / sound' : ''} · {tag}</small>
                </div>
                <button type="button" onClick={() => onEdit(element.id)} aria-label={`Edit ${element.name || 'Element'}`}>Edit</button>
                <button type="button" className="is-remove" onClick={() => onDelete(element.id)} aria-label={`Delete ${element.name || 'Element'}`}>×</button>
              </article>
            )
          })}
        </div>
      ) : (
        <button type="button" className="ef-kling-standard-bank-empty" onClick={onAdd}>
          <span><Icon glyph="avatar" size={18} /></span>
          <strong>Add a character or recurring subject</strong>
          <small>Name · description · 2–4 images or one video · optional voice / sound</small>
        </button>
      )}
      <p className="ef-kling-standard-bank-note">
        <span aria-hidden="true">◎</span>{' '}
        {isExtend ? 'The captured shot-end frame anchors every Element in the extension.' : 'A first frame is required when Elements are used.'}
      </p>
    </section>
  )
}

export function CreateVideo({ onBack, toast, onSpend, mode: workspaceMode = 'create' }: CreateVideoProps) {
  const isExtend = workspaceMode === 'extend'
  const isTransition = workspaceMode === 'transition'
  const availableModels = isTransition ? TRANSITION_VIDEO_MODELS : isExtend ? EXTEND_VIDEO_MODELS : VIDEO_MODELS
  const prefsKey = isTransition ? TRANSITION_VIDEO_PREFS_KEY : isExtend ? EXTEND_VIDEO_PREFS_KEY : CREATE_VIDEO_PREFS_KEY
  const defaultPrompt = isTransition ? DEFAULT_TRANSITION_PROMPT : isExtend ? DEFAULT_EXTEND_PROMPT : DEFAULT_CREATE_PROMPT
  const screenTitle = isTransition ? 'Transition' : isExtend ? 'Extend Video' : 'Create Video'
  const modelLabel = isTransition ? 'Transition model' : isExtend ? 'Extend model' : 'Video model'
  const jobTitle = isTransition ? 'Create transition' : isExtend ? 'Extend video' : 'Create video'
  const libraryPrefix = isTransition ? 'Transition · ' : isExtend ? 'Extended · ' : ''
  const enhancerKey = isTransition ? 'enhancer-transition-video' : isExtend ? 'enhancer-extend-video' : 'enhancer-video'
  const actionLabel = isTransition ? 'Generate transition' : isExtend ? 'Extend' : 'Generate'
  const progressLabel = isTransition ? 'GENERATING TRANSITION' : isExtend ? 'EXTENDING' : 'RENDERING'
  const retryLabel = isTransition ? 'Create another transition' : isExtend ? 'Extend another' : 'Create another'
  const [phase, setPhase] = useState<Phase>('form')
  const [charged, setCharged] = useState<number | null>(null)
  const prefsRef = useRef(loadGenPrefs<VideoPerModel>(prefsKey))
  const initialModel = useMemo(() => {
    const saved = prefsRef.current.model
    const m = saved ? VIDEO_MODEL_ALIASES[saved] ?? saved : undefined
    return m && availableModels.includes(m)
      ? m
      : availableModels.includes(DEFAULT_VIDEO_MODEL)
        ? DEFAULT_VIDEO_MODEL
        : availableModels[0]
  }, [availableModels])
  const init = useMemo(
    () => resolveVideoSettings(initialModel, prefsRef.current.perModel?.[initialModel] ?? prefsRef.current.perModel?.[prefsRef.current.model ?? '']),
    [initialModel],
  )
  const [model, setModel] = useState(initialModel)
  const [count, setCount] = useState(prefsRef.current.count ?? DEFAULT_COUNT)
  const [aspect, setAspect] = useState(init.aspect)
  const [resolution, setResolution] = useState(init.resolution)
  const [duration, setDuration] = useState(init.duration)
  const [extraOptionValues, setExtraOptionValues] = useState(init.extraOptionValues)
  const [prompt, setPrompt] = useState(prefsRef.current.prompt ?? defaultPrompt)

  const idCounterRef = useRef(0)
  const nextId = () => `img-${idCounterRef.current++}`
  // A failed bridge grab must never become a source-shaped placeholder: paid
  // generation needs real bytes.
  const grabPlayheadImage = async (which: 'first' | 'last' | 'reference' = 'first'): Promise<{ image: ReferenceImage; capture: Grab } | null> => {
    const g = isTransition
      ? which === 'last'
        ? await resolve.grabShotStartFrame()
        : await resolve.grabShotEndFrame()
      : isExtend
        ? which === 'last'
          ? await resolve.grabShotStartFrame()
          : await resolve.grabShotEndFrame()
        : await resolve.grabFrame()
    if (!g.ok || !g.blobUrl) {
      const label = isTransition
        ? which === 'last' ? 'Incoming shot start' : 'Outgoing shot end'
        : isExtend ? which === 'last' ? 'Optional last frame' : 'Shot end' : 'Frame'
      toast(`${label} capture failed · ${g.error || 'check Resolve and the playhead'}`)
      return null
    }
    return {
      image: { id: nextId(), kind: 'upload', name: g.name, url: g.blobUrl },
      capture: g,
    }
  }

  const [firstFrame, setFirstFrame] = useState<ReferenceImage | null>(null)
  const [lastFrame, setLastFrame] = useState<ReferenceImage | null>(null)
  const [frameCaptures, setFrameCaptures] = useState<{ first: Grab | null; last: Grab | null }>({ first: null, last: null })
  const [refImages, setRefImages] = useState<ReferenceImage[]>([])
  const [refVideos, setRefVideos] = useState<MediaFile[]>([])
  const [refAudios, setRefAudios] = useState<MediaFile[]>([])
  const [extendSourceMode, setExtendSourceMode] = useState<'frame' | 'video'>('frame')

  // Creative extras (hydrated from prefs)
  const [negativePrompt, setNegativePrompt] = useState(init.negativePrompt)
  const [webSearch, setWebSearch] = useState(init.webSearch)
  const [multiShotOn, setMultiShotOn] = useState(init.multiShotOn)
  const [shots, setShots] = useState<Shot[]>(init.shots)
  const [klingElements, setKlingElements] = useState<KlingElementDraft[]>([])
  const [elementEditor, setElementEditor] = useState<{ shotId: string; elementId?: string } | null>(null)
  const [characterRefs, setCharacterRefs] = useState<MediaFile[]>([])
  const [voices, setVoices] = useState<string[]>(init.voices)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [videos, setVideos] = useState<{ id: string; url: string }[]>([])
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([])
  const [resultPlacement, setResultPlacement] = useState<TimelinePlacementContext | undefined>()
  const [error, setError] = useState<string | null>(null)
  const inputsRef = useRef({ firstFrame, lastFrame, refImages, refVideos, refAudios, characterRefs, klingElements })
  const activeRunRef = useRef(false)
  const unmountedRef = useRef(false)
  const generation = useGenerationJobControl()

  useEffect(() => {
    inputsRef.current = { firstFrame, lastFrame, refImages, refVideos, refAudios, characterRefs, klingElements }
  })

  useEffect(
    () => {
      unmountedRef.current = false
      return () => {
        unmountedRef.current = true
        if (activeRunRef.current) return
        const cur = inputsRef.current
        revoke(cur.firstFrame)
        revoke(cur.lastFrame)
        cur.refImages.forEach(revoke)
        cur.refVideos.forEach(revokeMedia)
        cur.refAudios.forEach(revokeMedia)
        cur.characterRefs.forEach(revokeMedia)
        revokeRemovedKlingUrls(cur.klingElements, [])
      }
    },
    [],
  )

  // Persist settings on every change; each model remembers its own config.
  useEffect(() => {
    const p = prefsRef.current
    p.model = model
    p.prompt = prompt
    p.count = count
    p.perModel = {
      ...p.perModel,
      [model]: {
        aspect,
        resolution,
        duration,
        extraOptionValues,
        negativePrompt,
        webSearch,
        multiShotOn,
        shots,
        voices,
      },
    }
    saveGenPrefs(prefsKey, p)
  }, [
    model,
    prompt,
    count,
    aspect,
    resolution,
    duration,
    extraOptionValues,
    negativePrompt,
    webSearch,
    multiShotOn,
    shots,
    voices,
    prefsKey,
  ])

  const config = VIDEO_MODEL_CONFIG[model]
  const maxReferenceImages = config.maxReferenceImages

  const multiShotAvailable = !isTransition
    && !!config.multiShot
    && (!isExtend || supportsExtendMultiShot(model))
  const multiShotActive = multiShotAvailable && multiShotOn
  const klingElementsActive = supportsKlingElementsForWorkflow(model, workspaceMode)
  const showRefGrid = !isExtend && !isTransition && config.referenceImages && !multiShotActive && !klingElementsActive
  // Kling multi-shot replaces the single prompt and restricts to a first frame only.
  const preparedShots = shots.map((shot) => ({
    prompt: shot.prompt.trim(),
    duration: Number(shot.duration),
    referenceTags: shot.referenceTags,
  }))
  const storyboardDuration = totalMultiShotDuration(shots)
  const requestDuration = multiShotActive ? String(storyboardDuration) : duration

  const sharedElementOptions = klingElementReferenceOptions(klingElements)
  const klingElementTags = klingElementsActive ? sharedElementOptions.map((option) => option.tag) : []
  const multiShotReferenceOptions = multiShotActive ? sharedElementOptions : []
  const modelPromptMax = model === 'Happy Horse 1.1' ? happyHorsePromptMax(prompt) : config.promptMax
  // The cloud contract counts every @element invocation as 37 characters; one separator is
  // appended with each tag in Standard mode.
  const standardPromptMax = klingElementsActive && !multiShotActive
    ? Math.max(1, modelPromptMax - klingElements.length * 38)
    : modelPromptMax
  const showAspectPicker = config.aspectRatios.length > 0 && !(model === 'Kling 3 Turbo' && !!firstFrame)
  const omniIdInputsUnavailable = model === 'Gemini Omni Video'
  // A motion-control driver is the model's primary source, so it remains in
  // the basic flow. Other video/audio inputs are optional references and can
  // safely live behind progressive disclosure.
  const supportsVideoSource = isExtend && supportsExtendVideoReference(model)
  const primaryVideoInput = isExtend
    ? supportsVideoSource && extendSourceMode === 'video'
    : model === 'Kling 3 Motion Control'
  const multiShotVideoInput = false
  const multiShotAudioInput = false
  const advancedVideoInput = !!config.video && !primaryVideoInput && !multiShotActive && !isExtend && !isTransition && !klingElementsActive
  const advancedAudioInput = !!config.audio && !multiShotActive && !isTransition && !klingElementsActive

  const sideActive = (side: MediaSide): boolean =>
    (config.video?.side === side && refVideos.length > 0) ||
    (config.audio?.side === side && refAudios.length > 0)

  const frameSideActive = !!firstFrame || !!lastFrame || sideActive('frame')
  const bucketActive = refImages.length > 0 || sideActive('bucket')
  const framesLocked = config.framesRefsExclusive && bucketActive
  const bucketLocked = config.framesRefsExclusive && frameSideActive

  const lockedForSide = (side: MediaSide): boolean =>
    side === 'frame' ? framesLocked : side === 'bucket' ? bucketLocked : false

  const mode: FrameMode = frameSideActive ? 'frames' : bucketActive ? 'references' : 'text'
  const allowedDurations = config.durations.length
    ? config.durationFor
      ? config.durationFor({ resolution, mode })
      : config.durations
    : []
  const allowedKey = allowedDurations.join(',')

  const advancedOptionCount =
    (advancedVideoInput ? 1 : 0) +
    (advancedAudioInput ? 1 : 0) +
    (omniIdInputsUnavailable
      ? 1
      : (config.characterRefs ? 1 : 0) + (config.voices ? 1 : 0)) +
    (config.negativePrompt ? 1 : 0) +
    config.extraOptions.length +
    (config.webSearch ? 1 : 0)
  const defaultExtraOptions = defaultVideoOptionsFor(model).extraOptionValues
  const customizedExtraCount = config.extraOptions.filter(
    (opt) => extraOptionValues[opt.key] !== defaultExtraOptions[opt.key],
  ).length
  const advancedActiveCount =
    (advancedVideoInput ? refVideos.length : 0) +
    (advancedAudioInput ? refAudios.length : 0) +
    (!omniIdInputsUnavailable ? characterRefs.length + voices.length : 0) +
    (negativePrompt.trim() ? 1 : 0) +
    (webSearch === 'On' ? 1 : 0) +
    customizedExtraCount

  useEffect(() => {
    if (allowedDurations.length && !allowedDurations.includes(duration)) {
      setDuration(allowedDurations.includes(config.durationDefault) ? config.durationDefault : allowedDurations[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedKey])

  useEffect(() => {
    if (model === 'Grok Imagine Video' && refImages.length > 0 && extraOptionValues.mode === 'Spicy') {
      setExtraOptionValues((current) => ({ ...current, mode: 'Normal' }))
    }
  }, [model, refImages.length, extraOptionValues.mode])

  const handleModelChange = (nextModel: string) => {
    const cfg = VIDEO_MODEL_CONFIG[nextModel]
    setAdvancedOpen(false)
    setError(null)

    let nf = firstFrame
    let nl = lastFrame
    if (!cfg.firstFrame && nf) {
      revoke(nf)
      nf = null
    }
    if (!cfg.lastFrame && nl) {
      revoke(nl)
      nl = null
    }

    let nr = refImages
    if (!cfg.referenceImages) {
      nr.forEach(revoke)
      nr = []
    } else if (nr.length > cfg.maxReferenceImages) {
      nr.slice(cfg.maxReferenceImages).forEach(revoke)
      nr = nr.slice(0, cfg.maxReferenceImages)
    }

    let nv = refVideos
    if (!cfg.video) {
      nv.forEach(revokeMedia)
      nv = []
    } else if (nv.length > cfg.video.max) {
      nv.slice(cfg.video.max).forEach(revokeMedia)
      nv = nv.slice(0, cfg.video.max)
    }

    let na = refAudios
    if (!cfg.audio) {
      na.forEach(revokeMedia)
      na = []
    } else if (na.length > cfg.audio.max) {
      na.slice(cfg.audio.max).forEach(revokeMedia)
      na = na.slice(0, cfg.audio.max)
    }

    const bucketHasContent =
      nr.length > 0 || (cfg.video?.side === 'bucket' && nv.length > 0) || (cfg.audio?.side === 'bucket' && na.length > 0)
    const frameHasContent =
      !!nf || !!nl || (cfg.video?.side === 'frame' && nv.length > 0) || (cfg.audio?.side === 'frame' && na.length > 0)
    // Frames and references are mutually exclusive for some models. If a switch
    // leaves BOTH sides populated, keep the references and clear the whole frame
    // side — including frame-side video/audio, not just the still frames — so the
    // two locks can't strand the user in a state neither grid lets them clear.
    if (cfg.framesRefsExclusive && bucketHasContent && frameHasContent) {
      revoke(nf)
      revoke(nl)
      nf = null
      nl = null
      if (cfg.video?.side === 'frame') {
        nv.forEach(revokeMedia)
        nv = []
      }
      if (cfg.audio?.side === 'frame') {
        na.forEach(revokeMedia)
        na = []
      }
    }

    setFirstFrame(nf)
    setLastFrame(nl)
    setRefImages(nr)
    setRefVideos(nv)
    setRefAudios(na)
    setFrameCaptures((current) => ({
      first: nf ? current.first : null,
      last: nl ? current.last : null,
    }))
    if (isExtend && !supportsExtendVideoReference(nextModel)) setExtendSourceMode('frame')

    // Character refs are ephemeral media — always cleared on model switch.
    characterRefs.forEach(revokeMedia)
    setCharacterRefs([])

    // Restore this model's remembered settings (or its defaults).
    const s = resolveVideoSettings(nextModel, prefsRef.current.perModel?.[nextModel])
    setModel(nextModel)
    setAspect(s.aspect)
    setResolution(s.resolution)
    setDuration(s.duration)
    setExtraOptionValues(s.extraOptionValues)
    setNegativePrompt(s.negativePrompt)
    setWebSearch(s.webSearch)
    const nextMultiShotAvailable = !isTransition
      && !!cfg.multiShot
      && (!isExtend || supportsExtendMultiShot(nextModel))
    setMultiShotOn(nextMultiShotAvailable ? s.multiShotOn : false)
    setShots(s.shots)
    setVoices(s.voices)
    if (nextMultiShotAvailable && s.multiShotOn && nl) {
      revoke(nl)
      setLastFrame(null)
      setFrameCaptures((current) => ({ ...current, last: null }))
      toast(isExtend
        ? 'Last frame removed · Kling 3 Multi-shot uses the captured shot-end as its only sequence anchor.'
        : 'Last frame removed · Kling 3 Multi-shot accepts one starting frame only.')
    }
  }

  const changeExtendSourceMode = (next: string) => {
    if (!isExtend) return
    if (next === 'Video reference') {
      if (!supportsVideoSource) return
      revoke(firstFrame)
      revoke(lastFrame)
      refImages.forEach(revoke)
      setFirstFrame(null)
      setLastFrame(null)
      setFrameCaptures({ first: null, last: null })
      setRefImages([])
      setExtendSourceMode('video')
      setError(null)
      return
    }
    refVideos.forEach(revokeMedia)
    refAudios.forEach(revokeMedia)
    setRefVideos([])
    setRefAudios([])
    setExtendSourceMode('frame')
    setError(null)
  }

  const pickFrame = (which: 'first' | 'last', file: File) => {
    const img: ReferenceImage = { id: nextId(), kind: 'upload', name: file.name, url: URL.createObjectURL(file) }
    if (which === 'first') {
      revoke(firstFrame)
      setFirstFrame(img)
      setFrameCaptures((current) => ({ ...current, first: null }))
    } else {
      revoke(lastFrame)
      setLastFrame(img)
      setFrameCaptures((current) => ({ ...current, last: null }))
    }
  }

  const clearFrame = (which: 'first' | 'last') => {
    if (which === 'first') {
      revoke(firstFrame)
      setFirstFrame(null)
      setFrameCaptures((current) => ({ ...current, first: null }))
    } else {
      revoke(lastFrame)
      setLastFrame(null)
      setFrameCaptures((current) => ({ ...current, last: null }))
    }
  }

  const addRefFiles = async (files: File[]) => {
    const remaining = maxReferenceImages - refImages.length
    if (remaining <= 0) return
    const toAdd = files.slice(0, remaining)
    const newItems = (await Promise.all(toAdd.map(async (file): Promise<ReferenceImage | null> => {
      const dimensions = await probeImageFileMetadata(file)
      const candidate: ReferenceImage = {
        id: nextId(),
        kind: 'upload',
        name: file.name,
        url: URL.createObjectURL(file),
        mimeType: file.type,
        byteSize: file.size,
        width: dimensions?.width,
        height: dimensions?.height,
      }
      if (model === 'Kling 3 Motion Control') {
        const validation = validateKlingMotionDraft({
          prompt: '',
          images: [candidate],
          videos: [],
          orientation: 'video',
        })
        const imageIssue = validation.issues.find((issue) => issue.field === 'images')
        if (imageIssue || !dimensions) {
          revoke(candidate)
          toast(imageIssue?.message ?? 'Character image metadata could not be read.')
          return null
        }
      }
      return candidate
    }))).filter((item): item is ReferenceImage => item !== null)
    setRefImages((prev) => [...prev, ...newItems])
    if (files.length > toAdd.length) {
      toast(`Only ${toAdd.length} added — ${model} allows up to ${maxReferenceImages} reference images`)
    }
  }

  const removeRefAt = (id: string) => {
    setRefImages((prev) => {
      const target = prev.find((r) => r.id === id)
      revoke(target ?? null)
      return prev.filter((r) => r.id !== id)
    })
  }

  const addMediaFiles = (
    files: File[],
    current: MediaFile[],
    setter: (updater: (prev: MediaFile[]) => MediaFile[]) => void,
    max: number,
    noun: string,
  ) => {
    const remaining = max - current.length
    if (remaining <= 0) return
    const acceptedFiles = files.slice(0, remaining)
    const toAdd: MediaFile[] = acceptedFiles.map((file) => ({
      id: nextId(),
      kind: 'upload',
      name: file.name,
      url: URL.createObjectURL(file),
      mimeType: file.type,
      byteSize: file.size,
    }))
    setter((prev) => [...prev, ...toAdd])
    acceptedFiles.forEach((file, index) => {
      const mediaKind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null
      const item = toAdd[index]
      if (!mediaKind || item.kind !== 'upload') return
      const probe: Promise<{ durationSeconds?: number; width?: number; height?: number }> = mediaKind === 'video'
        ? probeVideoMetadata(item.url)
        : probeMediaDuration(item.url, mediaKind).then((durationSeconds) => ({ durationSeconds }))
      void probe.then((metadata) => {
        if (!metadata.durationSeconds && !metadata.width && !metadata.height) return
        const candidate = { ...item, ...metadata }
        if (model === 'Kling 3 Motion Control' && mediaKind === 'video') {
          const validation = validateKlingMotionDraft({
            prompt: '',
            images: [{ name: 'known-valid.jpg', type: 'image/jpeg', size: 1, width: 400, height: 400 }],
            videos: [candidate],
            orientation: extraOptionValues.characterOrientation === 'Image' ? 'image' : 'video',
          })
          const videoIssue = validation.issues.find((issue) => issue.field === 'videos')
          if (videoIssue) {
            revokeMedia(item)
            setter((prev) => prev.filter((currentItem) => currentItem.id !== item.id))
            toast(videoIssue.message)
            return
          }
        }
        setter((prev) => prev.map((currentItem) => currentItem.id === item.id && currentItem.kind === 'upload' ? candidate : currentItem))
      })
    })
    if (files.length > toAdd.length) {
      toast(`Only ${toAdd.length} added — ${model} allows up to ${max} ${noun}`)
    }
  }

  // Grab the current timeline frame/clip on demand (nothing is auto-sampled).
  // First/last frame use pickFrame-style replace semantics: revoke the outgoing
  // upload before swapping in the new grab.
  const grabFrame = async (which: 'first' | 'last') => {
    const captured = await grabPlayheadImage(which)
    if (!captured) return
    if (which === 'first') {
      revoke(firstFrame)
      setFirstFrame(captured.image)
      setFrameCaptures((current) => ({ ...current, first: captured.capture }))
    } else {
      revoke(lastFrame)
      setLastFrame(captured.image)
      setFrameCaptures((current) => ({ ...current, last: captured.capture }))
    }
  }

  const grabRefImage = async () => {
    if (refImages.length >= maxReferenceImages) return
    const captured = await grabPlayheadImage('reference')
    if (!captured) return
    setRefImages((prev) => (prev.length >= maxReferenceImages ? prev : [...prev, captured.image]))
  }

  // A grab for the media grids — `grabber` selects clip (video), audio, or frame
  // (character refs are image references) so each grid captures the right medium.
  const grabClip = async (
    current: MediaFile[],
    setter: (updater: (prev: MediaFile[]) => MediaFile[]) => void,
    max: number,
    label: string,
    grabber: () => Promise<import('../services/resolve').Grab>,
  ) => {
    if (current.length >= max) return
    const g = await grabber()
    if (!g.ok || !g.blobUrl) {
      toast(`${label} capture failed · ${g.error || 'check Resolve and the playhead'}`)
      return
    }
    const item: MediaFile = {
      id: nextId(),
      kind: 'upload',
      name: g.name,
      url: g.blobUrl,
      durationSeconds: g.durationSeconds,
    }
    setter((prev) => {
      if (prev.length >= max) {
        revokeMedia(item)
        return prev
      }
      return [...prev, item]
    })
    if (item.kind === 'upload' && grabber === resolve.grabClip) {
      void probeVideoMetadata(item.url).then((metadata) => {
        setter((prev) => prev.map((currentItem) => currentItem.id === item.id && currentItem.kind === 'upload'
          ? { ...currentItem, ...metadata, durationSeconds: metadata.durationSeconds ?? currentItem.durationSeconds }
          : currentItem))
      })
    }
  }

  const removeMediaAt = (id: string, setter: (updater: (prev: MediaFile[]) => MediaFile[]) => void) => {
    setter((prev) => {
      const target = prev.find((m) => m.id === id)
      if (target) revokeMedia(target)
      return prev.filter((m) => m.id !== id)
    })
  }

  const openNewKlingElement = (shotId: string) => {
    if (klingElements.length >= KLING_ELEMENT_MAX) {
      toast(`Kling supports up to ${KLING_ELEMENT_MAX} named Elements per generation.`)
      return
    }
    setElementEditor({ shotId })
  }

  const openKlingElement = (shotId: string, elementId: string) => {
    if (!klingElements.some((element) => element.id === elementId)) return
    setElementEditor({ shotId, elementId })
  }

  const saveKlingElement = async (element: KlingElementDraft) => {
    if (!elementEditor) return
    const existing = klingElements.some((candidate) => candidate.id === element.id)
    const candidateElements = existing
      ? klingElements.map((candidate) => candidate.id === element.id ? element : candidate)
      : [...klingElements, element]
    const validation = validateKlingElementDrafts(candidateElements)
    if (!validation.valid) throw new Error(validation.issues[0]?.message || 'This Kling element is incomplete.')
    const storedElement = persistKlingElement(element)
    const nextElements = existing
      ? klingElements.map((candidate) => candidate.id === storedElement.id ? storedElement : candidate)
      : [...klingElements, storedElement]

    if (!existing && elementEditor.shotId !== 'standard') {
      const previousTags = klingElements.map((candidate) => klingElementProviderTag(candidate.id))
      const nextTag = klingElementProviderTag(storedElement.id)
      setShots((current) => current.map((shot) => {
        // Undefined means “all available”. Materialize that choice before the
        // new element is added so only the shot that created it selects it.
        const selected = shot.referenceTags === undefined ? previousTags : shot.referenceTags
        return shot.id === elementEditor.shotId
          ? { ...shot, referenceTags: Array.from(new Set([...selected, nextTag])) }
          : { ...shot, referenceTags: [...selected] }
      }))
    }
    revokeRemovedKlingUrls(klingElements, nextElements)
    setKlingElements(nextElements)
    setElementEditor(null)
    setError(null)
  }

  const deleteKlingElement = (elementId: string) => {
    const nextElements = klingElements.filter((element) => element.id !== elementId)
    if (nextElements.length === klingElements.length) return
    revokeRemovedKlingUrls(klingElements, nextElements)
    setKlingElements(nextElements)
    setShots((current) => stripOrphanKlingSceneReferenceTags(current, nextElements))
    setElementEditor((current) => current?.elementId === elementId ? null : current)
    setError(null)
  }

  const getValidationError = (): string | null => {
    if (isTransition) {
      if (!firstFrame && !lastFrame) return 'Add both transition frames before generating.'
      if (!firstFrame) return 'Add the rendered end frame of the outgoing shot.'
      if (!lastFrame) return 'Add the rendered start frame of the incoming shot.'
      const outgoing = frameCaptures.first
      const incoming = frameCaptures.last
      if (outgoing && incoming) {
        if (
          (outgoing.projectId && incoming.projectId && outgoing.projectId !== incoming.projectId)
          || (outgoing.timelineId && incoming.timelineId && outgoing.timelineId !== incoming.timelineId)
        ) {
          return 'Capture both transition frames from the same Resolve project and timeline.'
        }
        if (outgoing.itemId && incoming.itemId && outgoing.itemId === incoming.itemId) {
          return 'Choose two different shots: outgoing first, then incoming.'
        }
      }
    }
    if (isExtend) {
      if (extendSourceMode === 'frame' && !firstFrame) {
        return 'Grab the end frame of the shot under the playhead, or upload a start frame.'
      }
      if (extendSourceMode === 'video' && (!supportsVideoSource || refVideos.length === 0)) {
        return 'Add a reference video before extending from video.'
      }
    }
    if (!multiShotActive && Array.from(prompt).length > standardPromptMax) {
      return klingElementsActive
        ? `Shorten the prompt to ${standardPromptMax} characters so the selected Element tags fit the 2,500-character cloud request limit.`
        : `${model} prompts are limited to ${standardPromptMax.toLocaleString()} characters.`
    }
    if (klingElementsActive) {
      const elementValidation = validateKlingElementDrafts(klingElements)
      if (!elementValidation.valid) return elementValidation.issues[0]?.message || 'Complete every Kling reference element.'
      if (klingElements.length && !firstFrame) return 'Add a first frame before using Kling 3 Elements.'
    }
    if (multiShotActive) {
      const issue = validateMultiShotDraft({
        brief: MULTI_SHOT_CONTINUITY_DIRECTION,
        scenes: shots,
        elementTags: klingElementTags,
        rules: config.multiShot!,
      })
      if (issue) return issue
    }
    if (model === 'Kling 3') {
      if (!multiShotActive && lastFrame && !firstFrame) {
        return 'Add a first frame before using a Kling 3 last frame.'
      }
    }
    if (model === 'Kling 3 Motion Control') {
      const motionValidation = validateKlingMotionDraft({
        prompt,
        images: refImages,
        videos: refVideos,
        orientation: extraOptionValues.characterOrientation === 'Image' ? 'image' : 'video',
      })
      if (!motionValidation.valid) return motionValidation.issues[0]?.message || 'Complete the Motion Control inputs.'
    }
    if (model === 'Gemini Omni Video' && refImages.length + refVideos.length * 2 > 7) {
      return 'Gemini Omni inputs exceed its 7-unit quota (image=1, video=2).'
    }
    return null
  }

  const validationError = getValidationError()
  const connected = isConnected()
  const hasSharedVideoElement = klingElementsActive && klingElements.some((element) => element.media?.kind === 'video')
  const hasSharedImageElement = klingElementsActive && klingElements.some((element) => element.media?.kind === 'images')
  const priceContext = {
    hasVideoInput: refVideos.length > 0 || hasSharedVideoElement,
    hasImageInput: !!firstFrame || !!lastFrame || refImages.length > 0 || hasSharedImageElement,
    referenceMode: mode === 'references' || (klingElementsActive && klingElements.length > 0),
    inputDurationSeconds: model === 'Kling 3 Motion Control' && refVideos[0]?.kind === 'upload'
      ? refVideos[0].durationSeconds
      : undefined,
  }
  const estimate = videoRunEstimate(model, resolution, requestDuration, extraOptionValues, Number(count), priceContext)
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const footerMessage = !connected
    ? 'Connect EasyField Cloud from the credits badge on Home to generate.'
    : validationError ?? error ?? (spendBlocked ? spendApproval.reason : undefined) ?? (isTransition
      ? `Ready to generate ${count} transition${count === '1' ? '' : 's'}.`
      : multiShotActive
        ? `Ready to ${isExtend ? 'extend into' : 'generate'} ${count} connected sequence${count === '1' ? '' : 's'} · ${shots.length} shots · ${storyboardDuration}s.`
        : `Ready to ${isExtend ? 'extend' : 'generate'} ${count} clip${count === '1' ? '' : 's'}.`)
  const footerHasError = connected && !!(validationError || error || spendBlocked)

  const generate = async () => {
    setError(null)
    setSelectedVideoIds([])
    setResultPlacement(undefined)
    const issue = getValidationError()
    if (issue) {
      setError(issue)
      return
    }
    setPhase('generating')
    const controller = generation.begin()
    activeRunRef.current = true
    const effectivePrompt = multiShotActive
      ? shots.map((shot, index) => `Shot ${index + 1}: ${shot.prompt.trim()}`).join('\n')
      : prompt
    const placementAnchor = (capture: Grab | null): ResolvePlacementAnchor | null => {
      if (!capture?.itemId || capture.itemStartFrame == null || capture.itemEndFrame == null) return null
      return {
        itemId: capture.itemId,
        startFrame: capture.itemStartFrame,
        endFrame: capture.itemEndFrame,
        sourceStartFrame: capture.sourceStartFrame,
        sourceEndFrame: capture.sourceEndFrame,
        mediaPoolItemId: capture.mediaPoolItemId,
        trackIndex: capture.trackIndex,
      }
    }
    const transitionAnchors = [placementAnchor(frameCaptures.first), placementAnchor(frameCaptures.last)]
      .filter((anchor): anchor is ResolvePlacementAnchor => anchor != null)
    const placementSnapshot: TimelinePlacementContext | undefined = isTransition && frameCaptures.last?.captureFrame != null
      ? {
          recordFrame: frameCaptures.last.captureFrame,
          projectId: frameCaptures.last.projectId,
          timelineId: frameCaptures.last.timelineId,
          anchorItemId: frameCaptures.last.itemId,
          anchorItemStartFrame: frameCaptures.last.itemStartFrame,
          anchorItemEndFrame: frameCaptures.last.itemEndFrame,
          anchorItemSourceStartFrame: frameCaptures.last.sourceStartFrame,
          anchorItemSourceEndFrame: frameCaptures.last.sourceEndFrame,
          anchorMediaPoolItemId: frameCaptures.last.mediaPoolItemId,
          anchorTrackIndex: frameCaptures.last.trackIndex,
          validationAnchors: transitionAnchors,
        }
      : undefined
    try {
      const res = await runVideo(
        {
          jobTitle,
          workflow: workspaceMode,
          model,
          prompt: multiShotActive ? MULTI_SHOT_CONTINUITY_DIRECTION : prompt,
          negativePrompt,
          aspect,
          resolution,
          duration: requestDuration,
          extras: extraOptionValues,
          webSearch: webSearch === 'On',
          firstFrame,
          lastFrame: multiShotActive ? null : lastFrame,
          refImages: isTransition || klingElementsActive ? [] : refImages,
          refVideos: isTransition || klingElementsActive ? [] : refVideos,
          refAudios: isTransition || klingElementsActive ? [] : refAudios,
          klingElements: klingElementsActive ? klingElements : [],
          multiShot: isTransition ? false : multiShotActive,
          shots: isTransition ? [] : preparedShots,
          characterRefs: isTransition ? [] : characterRefs,
          voices: isTransition ? [] : voices,
          count: Number(count),
        },
        { signal: controller.signal, onJobCreated: generation.attachJob },
      )
      if (controller.signal.aborted) return
      if (res.droppedPlayheads) toast(`${res.droppedPlayheads} timeline input(s) skipped — upload files or connect DaVinci`)
      if (res.failedJobs) toast(`${res.failedJobs} clip request${res.failedJobs === 1 ? '' : 's'} failed — completed results were kept`)
      if (res.pendingJobs) toast(`${res.pendingJobs} clip request${res.pendingJobs === 1 ? ' is' : 's are'} still being tracked in Activity`)
      if (!res.urls.length) {
        setError('No clip was returned — please try again.')
        setPhase('form')
        return
      }
      const c = res.credits ?? resolveCharged(videoRunEstimate(model, resolution, requestDuration, extraOptionValues, Number(count), priceContext))
      setCharged(c)
      onSpend(c ?? 0)
      setVideos(res.urls.map((url, i) => ({ id: `vid-${i}`, url })))
      setResultPlacement(placementSnapshot)
      addCreations(res.urls.map((url) => ({ kind: 'video', url, model, prompt: effectivePrompt, meta: `${libraryPrefix}${resolution}${requestDuration ? ` · ${requestDuration}s` : ''}` })))
      setPhase('done')
    } catch (e) {
      if (controller.signal.aborted || isGenerationExit(e)) {
        setPhase('form')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setPhase('form')
    } finally {
      generation.finish(controller)
      activeRunRef.current = false
      if (unmountedRef.current) {
        const cur = inputsRef.current
        revoke(cur.firstFrame)
        revoke(cur.lastFrame)
        cur.refImages.forEach(revoke)
        cur.refVideos.forEach(revokeMedia)
        cur.refAudios.forEach(revokeMedia)
        cur.characterRefs.forEach(revokeMedia)
        revokeRemovedKlingUrls(cur.klingElements, [])
      }
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    toast(outcome === 'backgrounded'
      ? `${isTransition ? 'Transition' : isExtend ? 'Extension' : 'Generation'} continues in Activity · the result will be saved to Library`
      : `${isTransition ? 'Transition' : isExtend ? 'Extension' : 'Generation'} cancelled`)
  }

  const showFrames = isTransition || (isExtend ? extendSourceMode === 'frame' : config.firstFrame || config.lastFrame)
  const showExtendLastFrame = isExtend && extendSourceMode === 'frame' && config.lastFrame && !multiShotActive
  // Extend always uses the large boundary-frame presentation. A model that
  // accepts only the captured shot end should not collapse back to the legacy
  // 84 x 54 thumbnail just because it has no optional destination frame.
  const useBoundaryFrameLayout = isTransition || (isExtend && extendSourceMode === 'frame')

  // Everything attached feeds the prompt enhancer. Uploaded video is sampled
  // into chronological frames, so sequence/shot enhancement sees the actual
  // visual source instead of only its file name.
  const frameRef = (img: ReferenceImage | null, role: string): EnhanceReference | null =>
    !img
      ? null
      : img.kind === 'upload'
        ? { role, label: img.name, imageUrl: img.url }
        : { role, note: `timeline frame at ${img.timecode}` }
  const mediaRef = (m: MediaFile, role: string, kind: 'image' | 'video' | 'audio'): EnhanceReference =>
    m.kind === 'upload'
      ? {
          role,
          label: m.name,
          imageUrl: kind === 'image' ? m.url : undefined,
          videoUrl: kind === 'video' ? m.url : undefined,
          durationSeconds: m.durationSeconds,
          note: kind === 'audio' ? 'Audio is attached to generation; prompt enhancement uses its name and duration.' : undefined,
        }
      : { role, note: `timeline ${role} at ${m.timecode}` }
  const klingFileRef = (
    file: KlingElementFileLike,
    role: string,
    kind: 'image' | 'video' | 'audio',
    durationSeconds?: number,
  ): EnhanceReference => ({
    role,
    label: file.name,
    imageUrl: kind === 'image' ? file.url : undefined,
    videoUrl: kind === 'video' ? file.url : undefined,
    durationSeconds,
    note: kind === 'audio'
      ? 'Optional voice or sound reference for this shared Kling element.'
      : file.url ? undefined : 'Shared element media is attached to generation.',
  })
  const klingEnhanceRefs: EnhanceReference[] = klingElementsActive
    ? klingElements.flatMap((element) => {
        const role = `shared element ${element.name} · ${element.description}`
        const visual = element.media?.kind === 'images'
          ? element.media.files.map((file) => klingFileRef(file, role, 'image'))
          : element.media
            ? [klingFileRef(element.media.file, role, 'video', element.media.durationMs / 1_000)]
            : []
        return [
          ...visual,
          ...(element.audio ? [klingFileRef(element.audio.file, `${role} audio`, 'audio', element.audio.durationMs / 1_000)] : []),
        ]
      })
    : []
  const enhanceRefs: EnhanceReference[] = [
    frameRef(firstFrame, isTransition ? 'outgoing shot end frame' : isExtend ? 'shot end frame' : 'first frame'),
    frameRef(multiShotActive ? null : lastFrame, isTransition
      ? 'incoming shot start frame'
      : isExtend ? 'optional target last frame' : 'last frame'),
    ...(multiShotActive || klingElementsActive ? [] : refImages.map((r) => frameRef(r, 'reference image'))),
    ...characterRefs.map((m) => mediaRef(m, 'character reference', 'image')),
    ...(multiShotActive || klingElementsActive ? [] : refVideos.map((m) => mediaRef(m, 'video reference', 'video'))),
    ...(multiShotActive || klingElementsActive ? [] : refAudios.map((m) => mediaRef(m, 'audio reference', 'audio'))),
    ...klingEnhanceRefs,
  ].filter((x): x is EnhanceReference => x !== null)

  const referenceManifest = [
    ...enhanceRefs.map((reference) => {
    const durationLabel = reference.durationSeconds ? ` · ${reference.durationSeconds.toFixed(1)}s` : ''
    return `${reference.role}${reference.label ? ` · ${reference.label}` : ''}${durationLabel}${reference.note ? ` · ${reference.note}` : ''}`
    }),
    ...(klingElementsActive ? klingElementReferenceManifest(klingElements) : []),
  ]
  const multiShotContextVersion = JSON.stringify({
    model,
    aspect,
    resolution,
    sound: extraOptionValues.audio !== 'Off',
    first: firstFrame?.id,
    images: refImages.map((item) => item.id),
    videos: refVideos.map((item) => [item.id, item.kind === 'upload' ? item.durationSeconds : undefined]),
    audios: refAudios.map((item) => [item.id, item.kind === 'upload' ? item.durationSeconds : undefined]),
    elements: klingElementsActive ? klingElements.map((element) => [
      element.id,
      element.name,
      element.description,
      element.media?.kind,
      ...(element.media?.kind === 'images' ? element.media.files.map((file) => file.name) : element.media ? [element.media.file.name] : []),
      element.audio?.file.name,
    ]) : [],
  })

  const changeMultiShotMode = (on: boolean) => {
    if (!config.multiShot || !multiShotAvailable) return
    setMultiShotOn(on)
    setError(null)
    if (!on) return
    setShots(normalizeMultiShotScenes(shots, config.multiShot, nextId))
    if (lastFrame) {
      revoke(lastFrame)
      setLastFrame(null)
      setFrameCaptures((current) => ({ ...current, last: null }))
      toast(isExtend
        ? 'Last frame removed · Kling 3 Multi-shot uses the captured shot-end as its only sequence anchor.'
        : 'Last frame removed · Kling 3 Multi-shot accepts one starting frame only.')
    }
  }

  return (
    <div className={`ef-screen ef-legacy-workspace ef-create-video-screen${isExtend ? ' ef-extend-video-screen' : ''}${isTransition ? ' ef-transition-video-screen' : ''}`}>
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">{screenTitle}</span>
        <span className="ef-spacer" />
        <Dropdown options={availableModels} selected={model} onSelect={handleModelChange} label={modelLabel} optionMeta={VIDEO_MODEL_META} />
      </div>

      <div className="ef-scroll ef-create-scroll">
        {multiShotAvailable && (
          <div className="ef-edit-mode-bar ef-multishot-mode-bar">
            <span>
              <small>DIRECTING MODE</small>
              <strong>{multiShotActive
                ? isExtend ? 'Continue the shot into one connected sequence with an ordered shot plan' : 'One connected sequence with an ordered shot plan'
                : isExtend ? 'Continue the shot as one continuous clip' : 'One prompt creates one continuous clip'}</strong>
            </span>
            <div className="ef-setting-segmented" role="radiogroup" aria-label="Video directing mode">
              <button type="button" role="radio" aria-checked={!multiShotActive} className={!multiShotActive ? 'is-selected' : ''} onClick={() => changeMultiShotMode(false)}>Standard</button>
              <button type="button" role="radio" aria-checked={multiShotActive} className={multiShotActive ? 'is-selected' : ''} onClick={() => changeMultiShotMode(true)}>Multi-shot</button>
            </div>
          </div>
        )}

        {isExtend && supportsVideoSource && (
          <ChipField
            label="EXTEND FROM"
            options={['Shot end frame', 'Video reference']}
            selected={extendSourceMode === 'video' ? 'Video reference' : 'Shot end frame'}
            onSelect={changeExtendSourceMode}
          />
        )}
        {showFrames && (
          <FrameInputs
            showFirst={isTransition || isExtend || config.firstFrame}
            showLast={isTransition || showExtendLastFrame || (!isExtend && config.lastFrame && !multiShotActive)}
            firstFrame={firstFrame}
            lastFrame={lastFrame}
            locked={framesLocked}
            lockedHint="Clear references to use frames"
            fieldLabel={isTransition ? 'TRANSITION FRAMES' : isExtend ? multiShotActive ? 'SEQUENCE START FRAME' : showExtendLastFrame ? 'EXTEND FRAMES' : 'SHOT END FRAME' : undefined}
            firstCaption={isTransition ? 'FIRST · OUT END' : isExtend ? multiShotActive ? 'SHOT END · SEQUENCE START' : showExtendLastFrame ? 'START · SHOT END' : 'SHOT END' : undefined}
            lastCaption={isTransition ? 'LAST · IN START' : isExtend ? 'LAST · OPTIONAL' : undefined}
            firstGrabLabel={isTransition
              ? 'Place the playhead inside the outgoing shot and grab its rendered last frame'
              : isExtend ? multiShotActive
                ? 'Grab the rendered end frame under the playhead to anchor the first shot of the sequence'
                : 'Grab the rendered end frame of the shot under the playhead' : undefined}
            lastGrabLabel={isTransition
              ? 'Place the playhead inside the incoming shot and grab its rendered first frame'
              : isExtend ? 'Optionally grab the rendered first frame of a target shot' : undefined}
            variant={useBoundaryFrameLayout ? 'transition' : 'default'}
            persistentGrab={isTransition || isExtend}
            showGrabText={useBoundaryFrameLayout}
            onPick={pickFrame}
            onGrab={grabFrame}
            onClear={clearFrame}
          />
        )}

        {isTransition && (
          <div className="ef-transition-capture-guide" role="note" aria-label="How to capture transition frames">
            <span><b>1</b>Playhead inside the outgoing shot, then Grab its end.</span>
            <span><b>2</b>Playhead inside the incoming shot, then Grab its start.</span>
          </div>
        )}

        {showExtendLastFrame && (
          <div className="ef-transition-capture-guide" role="note" aria-label="How Extend frames work">
            <span><b>1</b>Start continues from the rendered end of your outgoing shot.</span>
            <span><b>2</b>Last is optional; Grab a target shot start or upload any destination frame.</span>
          </div>
        )}

        {showRefGrid && (
          <ReferenceImageGrid
            images={refImages}
            max={maxReferenceImages}
            label={model === 'Kling 3 Motion Control' ? 'CHARACTER IMAGE' : undefined}
            onAddFiles={addRefFiles}
            onRemove={removeRefAt}
            onGrabPlayhead={grabRefImage}
            locked={bucketLocked}
            lockedHint="Clear frames to use references"
          />
        )}

        {multiShotVideoInput && config.video && (
          <MediaFileGrid
            label="SEQUENCE VIDEO REFERENCES"
            addLabel={config.video.addLabel}
            glyph="film"
            accept="video/*"
            items={refVideos}
            max={config.video.max}
            onAddFiles={(files) => addMediaFiles(files, refVideos, setRefVideos, config.video!.max, 'videos')}
            onRemove={(id) => removeMediaAt(id, setRefVideos)}
            onGrabPlayhead={() => grabClip(refVideos, setRefVideos, config.video!.max, 'Timeline clip', resolve.grabClip)}
            grabLabel="clip for the complete sequence"
          />
        )}

        {multiShotAudioInput && config.audio && (
          <MediaFileGrid
            label="OPTIONAL PAIRED AUDIO REFERENCES"
            addLabel={config.audio.addLabel}
            glyph="music"
            accept="audio/*"
            items={refAudios}
            max={config.audio.max}
            onAddFiles={(files) => addMediaFiles(files, refAudios, setRefAudios, config.audio!.max, 'audio files')}
            onRemove={(id) => removeMediaAt(id, setRefAudios)}
            onGrabPlayhead={() => grabClip(refAudios, setRefAudios, config.audio!.max, 'Timeline audio', resolve.grabAudio)}
            grabLabel="audio paired by reference order"
          />
        )}

        {config.video && primaryVideoInput && (
          <MediaFileGrid
            label={config.video.label}
            addLabel={config.video.addLabel}
            glyph="film"
            accept="video/*"
            items={refVideos}
            max={config.video.max}
            onAddFiles={(files) => addMediaFiles(files, refVideos, setRefVideos, config.video!.max, 'videos')}
            onRemove={(id) => removeMediaAt(id, setRefVideos)}
            onGrabPlayhead={() => grabClip(refVideos, setRefVideos, config.video!.max, 'Timeline clip', resolve.grabClip)}
            grabLabel={isExtend ? 'shot under playhead as a source reference' : 'clip'}
            locked={lockedForSide(config.video.side)}
            lockedHint={config.video.side === 'frame' ? 'Clear references to use frames' : 'Clear frames to use references'}
          />
        )}

        {klingElementsActive && !multiShotActive && (
          <StandardKlingElementBank
            elements={klingElements}
            workflow={isExtend ? 'extend' : 'create'}
            onAdd={() => openNewKlingElement('standard')}
            onEdit={(elementId) => openKlingElement('standard', elementId)}
            onDelete={deleteKlingElement}
          />
        )}

        {klingElementTags.length > 0 && (
          <div className="ef-anim-hint">
            {multiShotActive
              ? `All references inform the shared sequence. Choose per shot where ${klingElementTags.join(', ')} should be explicitly invoked.`
              : `Kling references will be attached as ${klingElementTags.join(', ')} and added to the prompt automatically.`}
          </div>
        )}

        {multiShotActive ? (
          <StoryboardEditor
            continuityDirection={MULTI_SHOT_CONTINUITY_DIRECTION}
            shots={shots}
            rules={config.multiShot!}
            onChange={setShots}
            makeId={nextId}
            targetModel={model}
            aspect={aspect}
            resolution={resolution}
            sound={extraOptionValues.audio !== 'Off'}
            references={enhanceRefs}
            referenceManifest={referenceManifest}
            referenceOptions={multiShotReferenceOptions}
            onAddElement={openNewKlingElement}
            onEditElement={openKlingElement}
            onDeleteElement={deleteKlingElement}
            elementLimitReached={klingElements.length >= KLING_ELEMENT_MAX}
            contextVersion={multiShotContextVersion}
            enhancerKey={`${enhancerKey}-multi-shot`}
            onSpend={onSpend}
          />
        ) : (
          <PromptCard prompt={prompt} onPromptChange={setPrompt} maxLength={standardPromptMax} enhancerKey={enhancerKey} targetModel={model} mediaKind="video" references={enhanceRefs} onSpend={onSpend} />
        )}

        {showAspectPicker && (
          <div className="ef-field">
            <span className="ef-field-label">ASPECT</span>
            <Dropdown options={config.aspectRatios} selected={aspect} onSelect={setAspect} label="Aspect ratio" align="left" variant="field" />
          </div>
        )}

        {config.resolutions.length > 0 && (
          <ChipField label="RESOLUTION" options={config.resolutions} selected={resolution} onSelect={setResolution} />
        )}

        {allowedDurations.length > 0 && !multiShotActive && (
          <DurationSlider
            options={allowedDurations}
            value={duration}
            onChange={setDuration}
            ariaLabel={`${screenTitle} duration`}
          />
        )}

        <ChipField label={multiShotActive ? 'SEQUENCES' : 'CLIPS'} options={COUNTS} selected={count} onSelect={setCount} />

        {advancedOptionCount > 0 && (
          <>
            <button
              id={`${workspaceMode}-video-advanced-toggle`}
              type="button"
              className="ef-advanced-toggle"
              aria-expanded={advancedOpen}
              aria-controls={`${workspaceMode}-video-advanced-options`}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span className="ef-advanced-toggle-label">Advanced options</span>
              <span className="ef-advanced-summary">
                {advancedActiveCount > 0
                  ? `${advancedActiveCount} configured`
                  : `${advancedOptionCount} settings`}
              </span>
              <span className="ef-advanced-chevron" aria-hidden="true">⌄</span>
            </button>

            <div
              id={`${workspaceMode}-video-advanced-options`}
              className="ef-advanced-region"
              role="region"
              aria-labelledby={`${workspaceMode}-video-advanced-toggle`}
              hidden={!advancedOpen}
            >
              {config.video && advancedVideoInput && (
                <MediaFileGrid
                  label={config.video.label}
                  addLabel={config.video.addLabel}
                  glyph="film"
                  accept="video/*"
                  items={refVideos}
                  max={config.video.max}
                  onAddFiles={(files) => addMediaFiles(files, refVideos, setRefVideos, config.video!.max, 'videos')}
                  onRemove={(id) => removeMediaAt(id, setRefVideos)}
                  onGrabPlayhead={() => grabClip(refVideos, setRefVideos, config.video!.max, 'Timeline clip', resolve.grabClip)}
                  grabLabel="clip"
                  locked={lockedForSide(config.video.side)}
                  lockedHint={config.video.side === 'frame' ? 'Clear references to use frames' : 'Clear frames to use references'}
                />
              )}

              {advancedAudioInput && config.audio && (
                <MediaFileGrid
                  label={config.audio.label}
                  addLabel={config.audio.addLabel}
                  glyph="music"
                  accept="audio/*"
                  items={refAudios}
                  max={config.audio.max}
                  onAddFiles={(files) => addMediaFiles(files, refAudios, setRefAudios, config.audio!.max, 'audio files')}
                  onRemove={(id) => removeMediaAt(id, setRefAudios)}
                  onGrabPlayhead={() => grabClip(refAudios, setRefAudios, config.audio!.max, 'Timeline audio', resolve.grabAudio)}
                  grabLabel="from timeline"
                  locked={lockedForSide(config.audio.side)}
                  lockedHint={config.audio.side === 'frame' ? 'Clear references to use frames' : 'Clear frames to use references'}
                />
              )}

              {config.characterRefs && !omniIdInputsUnavailable && (
                <MediaFileGrid
                  label="CHARACTER REFS"
                  addLabel="character"
                  glyph="avatar"
                  accept="image/*"
                  items={characterRefs}
                  max={config.characterRefs.max}
                  onAddFiles={(files) => addMediaFiles(files, characterRefs, setCharacterRefs, config.characterRefs!.max, 'characters')}
                  onRemove={(id) => removeMediaAt(id, setCharacterRefs)}
                  onGrabPlayhead={() => grabClip(characterRefs, setCharacterRefs, config.characterRefs!.max, 'Character frame', resolve.grabFrame)}
                  grabLabel="frame"
                />
              )}

              {config.voices && !omniIdInputsUnavailable && (
                <MultiSelectChips label="VOICES" options={config.voices.presets} selected={voices} max={config.voices.max} onChange={setVoices} />
              )}

              {omniIdInputsUnavailable && (
                <div className="ef-anim-hint">
                  Character and voice inputs are disabled for now: this cloud model requires saved character/audio IDs, not raw image uploads or preset names.
                </div>
              )}

              {config.negativePrompt && (
                <div className="ef-field">
                  <label className="ef-field-label" htmlFor={`${workspaceMode}-video-negative-prompt`}>NEGATIVE PROMPT</label>
                  <textarea
                    id={`${workspaceMode}-video-negative-prompt`}
                    className="ef-text-input"
                    rows={2}
                    placeholder="What to avoid in the video…"
                    value={negativePrompt}
                    maxLength={NEG_PROMPT_MAX}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                  />
                </div>
              )}

              {config.extraOptions.map((opt) => {
                const values = model === 'Grok Imagine Video' && opt.key === 'mode' && refImages.length > 0
                  ? opt.values.filter((value) => value !== 'Spicy')
                  : opt.values
                return (
                  <ChipField
                    key={opt.key}
                    label={opt.label}
                    options={values}
                    selected={extraOptionValues[opt.key]}
                    onSelect={(v) => setExtraOptionValues((prev) => ({ ...prev, [opt.key]: v }))}
                  />
                )
              })}

              {model === 'Grok Imagine Video' && refImages.length > 0 && (
                <div className="ef-anim-hint">External Grok references support Normal or Fun. Spicy is available only without external images.</div>
              )}

              {config.webSearch && (
                <ChipField label="WEB SEARCH" options={['Off', 'On']} selected={webSearch} onSelect={setWebSearch} />
              )}
            </div>
          </>
        )}

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-atomic="true" aria-label={`${isTransition ? 'Generating transition' : isExtend ? 'Extending' : 'Rendering'} ${count} ${multiShotActive ? 'sequence' : 'clip'}${count === '1' ? '' : 's'}`}>
              <div className={Number(count) > 1 ? 'ef-result-grid' : ''}>
                {Array.from({ length: Number(count) }, (_, i) => (
                  <div
                    key={i}
                    className="ef-video-skeleton"
                    style={{ aspectRatio: aspectToCss(aspect), animationDelay: `${i * 0.15}s` }}
                    aria-hidden="true"
                  />
                ))}
              </div>
              <span className="ef-gen-caption">{progressLabel} {count} {multiShotActive ? `SEQUENCE${count === '1' ? '' : 'S'}` : `CLIP${count === '1' ? '' : 'S'}`}…</span>
            </div>
            <GenerationCancelControl
              job={generation.job}
              onExit={exitGeneration}
              noun={isTransition ? 'transition' : isExtend ? 'extension' : 'generation'}
            />
          </>
        )}

        {phase === 'done' && videos.length > 0 && (
          <div className="ef-done-block" role="region" aria-label={`${videos.length} generated video results`}>
            <div className="ef-result-review-head">
              <span><strong>Choose results</strong><small>Review every take, then place only the clips you approve.</small></span>
              <em>{selectedVideoIds.length} / {videos.length}</em>
            </div>
            <div className={videos.length > 1 ? 'ef-result-grid' : ''}>
              {videos.map((v, index) => (
                <div className={'ef-result-choice' + (selectedVideoIds.includes(v.id) ? ' is-selected' : '')} key={v.id}>
                  <video
                    className="ef-video-tile"
                    src={v.url}
                    controls
                    playsInline
                    aria-label={`Generated video ${index + 1}`}
                    style={{ aspectRatio: aspectToCss(aspect), width: '100%', objectFit: 'cover' }}
                  />
                  <button
                    type="button"
                    className="ef-result-select"
                    aria-label={`${selectedVideoIds.includes(v.id) ? 'Deselect' : 'Select'} video ${index + 1} for timeline placement`}
                    aria-pressed={selectedVideoIds.includes(v.id)}
                    onClick={() => setSelectedVideoIds((current) => current.includes(v.id) ? current.filter((id) => id !== v.id) : [...current, v.id])}
                  >
                    {selectedVideoIds.includes(v.id) ? '✓' : '+'}
                  </button>
                </div>
              ))}
            </div>
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ {retryLabel}</button>
              <button type="button" className="ef-ghost-btn" onClick={() => videos.forEach((v, i) => saveUrl(v.url, `easyfield-${i + 1}.mp4`))}>↓ Save all</button>
              <button
                type="button"
                className="ef-send-btn"
                disabled={selectedVideoIds.length === 0}
                onClick={() => sendToTimeline(
                  videos.filter((v) => selectedVideoIds.includes(v.id)).map((v) => ({ url: v.url, name: (multiShotActive ? shots[0]?.prompt ?? '' : prompt).slice(0, 40) || 'EasyField clip' })),
                  'video',
                  toast,
                  resultPlacement,
                )}
              >
                {selectedVideoIds.length
                  ? resultPlacement
                    ? `Place ${selectedVideoIds.length} at captured cut`
                    : `Place ${selectedVideoIds.length} selected`
                  : 'Select to place'}
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Video generation summary">
          <PriceEstimate estimate={estimate} />
          <div
            id={`${workspaceMode}-video-footer-message`}
            className={`ef-create-footer-message ${footerHasError ? 'is-error' : connected ? 'is-ready' : 'is-help'}`}
            role={footerHasError ? 'alert' : 'status'}
            aria-live={footerHasError ? 'assertive' : 'polite'}
          >
            {footerHasError && <span aria-hidden="true">✕ </span>}
            {footerMessage}
          </div>
          <button
            type="button"
            className="ef-generate ef-create-footer-action"
            onClick={generate}
            disabled={!connected || !!validationError || !spendApproval.approved}
            aria-describedby={`${workspaceMode}-video-footer-message`}
          >
            <Icon glyph="spark" color="#0E0E13" size={13} /> {actionLabel}
          </button>
        </footer>
      )}

      <KlingElementEditor
        open={klingElementsActive && !!elementEditor}
        element={elementEditor?.elementId
          ? klingElements.find((element) => element.id === elementEditor.elementId) ?? null
          : null}
        existingCount={klingElements.length}
        existingNames={klingElements.map((element) => element.name)}
        makeId={() => `kling-${nextId()}`}
        onSave={saveKlingElement}
        onCancel={() => setElementEditor(null)}
        toast={toast}
      />
    </div>
  )
}
