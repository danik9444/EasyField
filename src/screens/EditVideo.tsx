import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PromptCard } from '../components/PromptCard'
import { VideoSourcePanel } from '../components/VideoSourcePanel'
import { MediaActionMenu, type MediaAction } from '../components/MediaActionMenu'
import { ReferenceImageGrid } from '../components/ReferenceImageGrid'
import { MediaFileGrid } from '../components/MediaFileGrid'
import { PriceEstimate } from '../components/PriceEstimate'
import { ProviderLogo } from '../components/ProviderLogo'
import { DurationSlider } from '../components/DurationSlider'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { resolve } from '../services/resolve'
import { sendToTimeline } from '../services/timeline'
import { runVideoEdit, isConnected, isGenerationExit } from '../services/run'
import { addCreation } from '../data/creations'
import { videoEditRunEstimate, resolveCharged, formatCharged } from '../data/pricing'
import {
  VIDEO_EDIT_CONFIG,
  CUSTOM_VIDEO_MODELS,
  VIDEO_UPSCALE_MODELS,
  TOPAZ_VIDEO_FACTORS,
  resolveVideoEditOptions,
} from '../data/videoEditConfig'
import { loadValue, saveValue } from '../data/prefs'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import { wavDurationSeconds } from '../data/audioMetadata'
import { VIDEO_EDIT_MODEL_META } from '../data/modelPresentation'
import type { MediaFile, ReferenceImage } from '../data/referenceImage'
import type { EnhanceReference } from '../services/chat'
import { promptCharacterCount } from '../data/promptLimits'

const PREFS_KEY = 'edit-video'
const UPSCALE_MODEL = VIDEO_UPSCALE_MODELS[0]
const DEFAULT_PROMPT = 'Relight the scene to golden-hour warmth and clean up the background'
const VIDEO_EDIT_REFERENCE_SCAFFOLD = [
  'Transform the primary video source. It is the edit target.',
  'All other attached images, videos, and audio are supporting references only; do not replace the primary source unless the edit instruction explicitly asks for it.',
  '',
  'Edit instruction: ',
].join('\n')

type Phase = 'form' | 'generating' | 'done'
type UtilityAction = 'upscale' | null

interface EditVideoProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
  // A source clip handed off from the Library.
  incomingSource?: { url: string; name?: string }
}

interface EditVideoPrefs {
  model?: string
  // Legacy migration from the operation-based screen.
  operation?: string
  customModel?: string
  upscaleFactor?: string
  prompt?: string
  perModel?: Record<string, Record<string, string>>
}

function loadEditVideoState(): EditVideoPrefs {
  try {
    const raw = loadValue(PREFS_KEY)
    return raw ? (JSON.parse(raw) as EditVideoPrefs) : {}
  } catch {
    return {}
  }
}

const revokeRef = (r: ReferenceImage) => {
  if (r.kind === 'upload') URL.revokeObjectURL(r.url)
}
const revokeMedia = (m: MediaFile) => {
  if (m.kind === 'upload') URL.revokeObjectURL(m.url)
}

const SEEDANCE_AUDIO_MAX_BYTES = 15 * 1024 * 1024
const SEEDANCE_AUDIO_MIN_SECONDS = 2
const SEEDANCE_AUDIO_MAX_SECONDS = 15

async function readAudioDuration(file: File): Promise<number> {
  if (/\.wav$/i.test(file.name)) {
    const parsed = wavDurationSeconds(await file.arrayBuffer())
    if (parsed != null) return parsed
  }

  const url = URL.createObjectURL(file)
  return await new Promise<number>((resolveDuration, rejectDuration) => {
    const audio = document.createElement('audio')
    const timeout = window.setTimeout(() => finish(new Error('Could not read the audio duration.')), 10000)
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timeout)
      audio.pause()
      audio.removeAttribute('src')
      audio.remove()
      URL.revokeObjectURL(url)
    }
    const finish = (value: number | Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (value instanceof Error) rejectDuration(value)
      else resolveDuration(value)
    }
    audio.preload = 'metadata'
    audio.hidden = true
    audio.onloadedmetadata = () => {
      const duration = audio.duration
      finish(Number.isFinite(duration) ? duration : new Error('Could not read the audio duration.'))
    }
    audio.onerror = () => finish(new Error('Could not read this audio file.'))
    document.body.append(audio)
    audio.src = url
    audio.load()
  })
}

async function inspectSeedanceAudio(file: File): Promise<{ mimeType: string; byteSize: number; durationSeconds: number }> {
  if (!/\.(wav|mp3)$/i.test(file.name)) throw new Error('Seedance accepts WAV or MP3 audio only.')
  if (file.size > SEEDANCE_AUDIO_MAX_BYTES) throw new Error('Reference audio must be 15 MB or smaller.')
  const durationSeconds = await readAudioDuration(file)
  if (durationSeconds < SEEDANCE_AUDIO_MIN_SECONDS || durationSeconds > SEEDANCE_AUDIO_MAX_SECONDS) {
    throw new Error('Reference audio must be between 2 and 15 seconds.')
  }
  return { mimeType: file.type, byteSize: file.size, durationSeconds }
}

function timelineAudioFileName(grabName: string): string {
  const clean = grabName
    .replace(/[\\/\u0000-\u001f\u007f]/g, ' ')
    .replace(/\.(wav|mp3|m4a)(?=\s|·|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${clean || 'Timeline audio'}.wav`
}

export function EditVideo({ onBack, toast, onSpend, incomingSource }: EditVideoProps) {
  const saved = useRef(loadEditVideoState()).current
  const [phase, setPhase] = useState<Phase>('form')
  const [charged, setCharged] = useState<number | null>(null)
  const [utilityAction, setUtilityAction] = useState<UtilityAction>(saved.operation === 'upscale' ? 'upscale' : null)
  const perModelRef = useRef<Record<string, Record<string, string>>>(saved.perModel ?? {})

  const savedModel = saved.model ?? saved.customModel ?? ''
  const initialActive = CUSTOM_VIDEO_MODELS.includes(savedModel) ? savedModel : CUSTOM_VIDEO_MODELS[0]
  const [model, setModel] = useState(initialActive)
  const [params, setParams] = useState<Record<string, string>>(() =>
    resolveVideoEditOptions(initialActive, perModelRef.current[initialActive]),
  )

  const [prompt, setPrompt] = useState(saved.prompt ?? DEFAULT_PROMPT)
  const [upscaleFactor, setUpscaleFactor] = useState(() =>
    TOPAZ_VIDEO_FACTORS.includes(saved.upscaleFactor ?? '') ? saved.upscaleFactor! : '2×',
  )

  const idRef = useRef(1)
  const nextId = () => `ev-${idRef.current++}`
  const borrowedUrl = incomingSource?.url
  const [source, setSource] = useState<MediaFile | null>(() =>
    incomingSource ? { id: nextId(), kind: 'upload', name: incomingSource.name ?? 'From library', url: incomingSource.url } : null,
  )
  const sourceRef = useRef<MediaFile | null>(source)
  const sourceCaptureIdRef = useRef(0)
  const autoGrabAttemptedRef = useRef(false)
  const sourceGrabPendingRef = useRef(false)
  const [sourceGrabPending, setSourceGrabPending] = useState(false)
  const [refImages, setRefImages] = useState<ReferenceImage[]>([])
  const [refVideos, setRefVideos] = useState<MediaFile[]>([])
  const [refAudios, setRefAudios] = useState<MediaFile[]>([])
  const audioAddingRef = useRef(false)

  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef({ source, refImages, refVideos, refAudios })
  const activeRunRef = useRef(false)
  const unmountedRef = useRef(false)
  const generation = useGenerationJobControl()

  // Never revoke the borrowed incomingSource URL — the Library still owns it.
  const revokeSource = (m: MediaFile | null) => {
    if (m?.kind === 'upload' && m.url !== borrowedUrl) URL.revokeObjectURL(m.url)
  }

  useEffect(() => {
    sourceRef.current = source
    cleanupRef.current = { source, refImages, refVideos, refAudios }
  })
  useEffect(
    () => {
      unmountedRef.current = false
      return () => {
        unmountedRef.current = true
        sourceCaptureIdRef.current += 1
        if (activeRunRef.current) return
        const c = cleanupRef.current
        revokeSource(c.source)
        c.refImages.forEach(revokeRef)
        c.refVideos.forEach(revokeMedia)
        c.refAudios.forEach(revokeMedia)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const replaceSource = useCallback((next: MediaFile) => {
    const previous = sourceRef.current
    if (previous?.kind === 'upload' && previous.url !== borrowedUrl && (next.kind !== 'upload' || previous.url !== next.url)) {
      URL.revokeObjectURL(previous.url)
    }
    sourceRef.current = next
    setSource(next)
    setUtilityAction(null)
    setPhase('form')
    setResultUrl(null)
    setCharged(null)
    setError(null)
  }, [borrowedUrl])

  const grabPrimarySource = useCallback(async (announce = true) => {
    if (activeRunRef.current || sourceGrabPendingRef.current) return
    const captureId = ++sourceCaptureIdRef.current
    sourceGrabPendingRef.current = true
    setSourceGrabPending(true)
    const grabbed = await resolve.grabEditVideoSource()
    if (captureId !== sourceCaptureIdRef.current || unmountedRef.current) {
      if (grabbed.ok && grabbed.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
      return
    }
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    if (!grabbed.ok || !grabbed.blobUrl) {
      toast(`Clip capture failed · ${grabbed.error || 'place the playhead over the video clip to edit'}`)
      return
    }
    replaceSource({
      id: nextId(),
      kind: 'upload',
      name: grabbed.name,
      url: grabbed.blobUrl,
      durationSeconds: grabbed.durationSeconds,
      mimeType: 'video/mp4',
    })
    if (announce) {
      const duration = grabbed.durationSeconds
      toast(`Trimmed timeline clip captured${duration ? ` · ${duration.toFixed(duration < 10 ? 2 : 1)}s` : ''}`)
    }
  }, [replaceSource, toast])

  // With no hand-off source, try the timeline once. Failed captures leave the
  // upload prompt intact instead of creating a clip-shaped placeholder.
  useEffect(() => {
    if (incomingSource || autoGrabAttemptedRef.current) return
    autoGrabAttemptedRef.current = true
    let alive = true
    // Defer one tick so React's development effect replay cannot submit the
    // same bridge capture twice. Also avoid a noisy grab request while Resolve
    // is known to be offline.
    const timer = window.setTimeout(() => void (async () => {
      const bridge = resolve.isBridgeConnected() ? resolve.getStatus() : await resolve.refreshStatus()
      if (!alive || !bridge.connected) return
      await grabPrimarySource(false)
    })(), 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [grabPrimarySource, incomingSource])

  const activeModel = model
  const activeModelRef = useRef(activeModel)
  useEffect(() => {
    activeModelRef.current = activeModel
  }, [activeModel])
  const cfg = activeModel ? VIDEO_EDIT_CONFIG[activeModel] : null
  const refImagesMax = cfg?.refImages ?? 0
  const refVideosMax = cfg?.refVideos ?? 0
  const refAudiosMax = cfg?.refAudios ?? 0

  // Feed the prompt enhancer: the source clip + any video refs contribute their
  // label/tag as text (vision can't watch video); reference images are shown.
  const enhanceRefs: EnhanceReference[] = [
    ...(source
      ? [
          source.kind === 'upload'
            ? ({ role: 'primary video being edited', label: source.name } as EnhanceReference)
            : ({ role: 'primary video being edited', note: `timeline clip at ${source.timecode}` } as EnhanceReference),
        ]
      : []),
    ...refImages.map(
      (r): EnhanceReference =>
        r.kind === 'upload'
          ? { role: 'supporting image reference — not the edit source', label: r.name, imageUrl: r.url }
          : { role: 'supporting image reference — not the edit source', note: `timeline frame at ${r.timecode}` },
    ),
    ...refVideos.map(
      (m): EnhanceReference =>
        m.kind === 'upload'
          ? { role: 'supporting video reference — not the edit source', label: m.name }
          : { role: 'supporting video reference — not the edit source', note: `timeline clip at ${m.timecode}` },
    ),
    ...refAudios.map(
      (m): EnhanceReference =>
        m.kind === 'upload'
          ? { role: 'supporting audio reference', label: m.name }
          : { role: 'supporting audio reference', note: `timeline audio at ${m.timecode}` },
    ),
  ]

  // Persist on every change; each model remembers its own options.
  useEffect(() => {
    if (activeModel) perModelRef.current = { ...perModelRef.current, [activeModel]: params }
    saveValue(
      PREFS_KEY,
      JSON.stringify({
        model,
        operation: utilityAction ?? 'custom',
        upscaleFactor,
        prompt,
        perModel: perModelRef.current,
      } satisfies EditVideoPrefs),
    )
  }, [model, utilityAction, upscaleFactor, prompt, params, activeModel])

  const stashActive = () => {
    if (activeModel) perModelRef.current = { ...perModelRef.current, [activeModel]: params }
  }
  const loadModelParams = (model: string) => setParams(resolveVideoEditOptions(model, perModelRef.current[model]))

  // Trim reference inputs to the new model's capacity.
  const trimRefs = (model: string | null) => {
    const c = model ? VIDEO_EDIT_CONFIG[model] : null
    const maxI = c?.refImages ?? 0
    const maxV = c?.refVideos ?? 0
    const maxA = c?.refAudios ?? 0
    setRefImages((prev) => {
      if (prev.length <= maxI) return prev
      prev.slice(maxI).forEach(revokeRef)
      return prev.slice(0, maxI)
    })
    setRefVideos((prev) => {
      if (prev.length <= maxV) return prev
      prev.slice(maxV).forEach(revokeMedia)
      return prev.slice(0, maxV)
    })
    setRefAudios((prev) => {
      if (prev.length <= maxA) return prev
      prev.slice(maxA).forEach(revokeMedia)
      return prev.slice(0, maxA)
    })
  }

  const changeModel = (nextModel: string) => {
    stashActive()
    setModel(nextModel)
    setUtilityAction(null)
    loadModelParams(nextModel)
    trimRefs(nextModel)
  }

  const setParam = (key: string, value: string) => setParams((prev) => ({ ...prev, [key]: value }))

  const pickSource = (file: File) => {
    if (activeRunRef.current) return
    sourceCaptureIdRef.current += 1
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    replaceSource({ id: nextId(), kind: 'upload', name: file.name, url: URL.createObjectURL(file) })
  }

  // Reference images
  const addRefImageFiles = (files: File[]) => {
    const remaining = refImagesMax - refImages.length
    if (remaining <= 0) return
    const toAdd: ReferenceImage[] = files
      .slice(0, remaining)
      .map((file) => ({ id: nextId(), kind: 'upload', name: file.name, url: URL.createObjectURL(file) }))
    setRefImages((prev) => [...prev, ...toAdd])
  }
  const grabRefImage = async () => {
    if (refImages.length >= refImagesMax) return
    const g = await resolve.grabFrame()
    if (!g.ok || !g.blobUrl) {
      toast(`Frame capture failed · ${g.error || 'check Resolve and the playhead'}`)
      return
    }
    const item: ReferenceImage = { id: nextId(), kind: 'upload', name: g.name, url: g.blobUrl }
    setRefImages((prev) => {
      if (prev.length >= refImagesMax) {
        revokeRef(item)
        return prev
      }
      return [...prev, item]
    })
  }
  const removeRefImage = (id: string) =>
    setRefImages((prev) => {
      const t = prev.find((r) => r.id === id)
      if (t) revokeRef(t)
      return prev.filter((r) => r.id !== id)
    })

  // Reference videos
  const addRefVideoFiles = (files: File[]) => {
    const remaining = refVideosMax - refVideos.length
    if (remaining <= 0) return
    const toAdd: MediaFile[] = files
      .slice(0, remaining)
      .map((file) => ({ id: nextId(), kind: 'upload', name: file.name, url: URL.createObjectURL(file) }))
    setRefVideos((prev) => [...prev, ...toAdd])
  }
  const grabRefVideo = async () => {
    if (refVideos.length >= refVideosMax) return
    const g = await resolve.grabClip()
    if (!g.ok || !g.blobUrl) {
      toast(`Reference clip capture failed · ${g.error || 'check Resolve and the playhead'}`)
      return
    }
    const item: MediaFile = { id: nextId(), kind: 'upload', name: g.name, url: g.blobUrl }
    setRefVideos((prev) => {
      if (prev.length >= refVideosMax) {
        revokeMedia(item)
        return prev
      }
      return [...prev, item]
    })
  }
  const removeRefVideo = (id: string) =>
    setRefVideos((prev) => {
      const t = prev.find((m) => m.id === id)
      if (t) revokeMedia(t)
      return prev.filter((m) => m.id !== id)
    })

  // Seedance accepts uploaded WAV/MP3 references only. Validate the provider's
  // file and duration envelope before the media can reach a paid request.
  const addRefAudioFiles = async (files: File[]) => {
    if (audioAddingRef.current) {
      toast('Audio files are still being checked')
      return
    }
    const remaining = refAudiosMax - refAudios.length
    if (remaining <= 0) return
    const modelAtStart = activeModel
    audioAddingRef.current = true
    const accepted: MediaFile[] = []
    let totalDuration = refAudios.reduce(
      (sum, item) => sum + (item.kind === 'upload' ? item.durationSeconds ?? 0 : 0),
      0,
    )
    try {
      for (const file of files.slice(0, remaining)) {
        try {
          const metadata = await inspectSeedanceAudio(file)
          if (totalDuration + metadata.durationSeconds > SEEDANCE_AUDIO_MAX_SECONDS) {
            throw new Error('Reference audio can be at most 15 seconds in total.')
          }
          totalDuration += metadata.durationSeconds
          accepted.push({ id: nextId(), kind: 'upload', name: file.name, url: URL.createObjectURL(file), ...metadata })
        } catch (reason) {
          toast(`${file.name} · ${reason instanceof Error ? reason.message : 'Audio validation failed'}`)
        }
      }
      if (unmountedRef.current || activeModelRef.current !== modelAtStart) accepted.forEach(revokeMedia)
      else if (accepted.length) setRefAudios((prev) => [...prev, ...accepted].slice(0, refAudiosMax))
    } finally {
      audioAddingRef.current = false
    }
  }
  const grabRefAudio = async () => {
    if (audioAddingRef.current || refAudios.length >= refAudiosMax) return
    const grabbed = await resolve.grabAudio()
    if (!grabbed.ok || !grabbed.blobUrl) {
      toast(`Audio capture failed · ${grabbed.error || 'place the playhead over an audio clip'}`)
      return
    }
    try {
      const response = await fetch(grabbed.blobUrl)
      if (!response.ok) throw new Error(`Timeline audio could not be read (${response.status}).`)
      const blob = await response.blob()
      if (!blob.size) throw new Error('Timeline audio capture was empty.')
      const file = new File(
        [blob],
        timelineAudioFileName(grabbed.name),
        { type: blob.type || 'audio/wav', lastModified: Date.now() },
      )
      await addRefAudioFiles([file])
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Timeline audio capture failed')
    } finally {
      URL.revokeObjectURL(grabbed.blobUrl)
    }
  }
  const removeRefAudio = (id: string) =>
    setRefAudios((prev) => {
      const item = prev.find((media) => media.id === id)
      if (item) revokeMedia(item)
      return prev.filter((media) => media.id !== id)
    })

  const mediaActions: MediaAction[] = source
    ? [{ id: 'upscale', label: 'Upscale clip…', description: 'Topaz · choose 1×, 2×, or 4×' }]
    : []

  const apply = async () => {
    setError(null)
    if (!utilityAction && promptOverLimit) {
      setError(`${activeModel} prompt is over its ${promptProviderMax.toLocaleString()}-character provider limit after EasyField's edit context is included.`)
      return
    }
    setPhase('generating')
    const controller = generation.begin()
    activeRunRef.current = true
    try {
      const res =
        utilityAction === 'upscale'
          ? await runVideoEdit({ operation: 'upscale', model: UPSCALE_MODEL, source, prompt: '', params: {}, refImages: [], refVideos: [], refAudios: [], factor: upscaleFactor }, { signal: controller.signal, onJobCreated: generation.attachJob })
          : await runVideoEdit(
              { operation: 'custom', model: activeModel, source, prompt, params, refImages, refVideos, refAudios, factor: upscaleFactor },
              { signal: controller.signal, onJobCreated: generation.attachJob },
            )
      if (controller.signal.aborted) return
      if (res.droppedPlayheads) toast(`${res.droppedPlayheads} timeline reference(s) skipped — upload files or connect DaVinci`)
      if (!res.urls.length) {
        setError('No clip was returned — please try again.')
        setPhase('form')
        return
      }
      const operation = utilityAction === 'upscale' ? 'upscale' : 'custom'
      const c = res.credits ?? resolveCharged(videoEditRunEstimate(operation, utilityAction === 'upscale' ? UPSCALE_MODEL : activeModel, params, upscaleFactor))
      setCharged(c)
      onSpend(c ?? 0)
      setResultUrl(res.urls[0])
      addCreation({ kind: 'video', url: res.urls[0], model: utilityAction === 'upscale' ? UPSCALE_MODEL : activeModel, prompt: utilityAction === 'upscale' ? 'Upscaled source clip' : prompt })
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
        const c = cleanupRef.current
        revokeSource(c.source)
        c.refImages.forEach(revokeRef)
        c.refVideos.forEach(revokeMedia)
        c.refAudios.forEach(revokeMedia)
      }
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    toast(outcome === 'backgrounded'
      ? 'Video edit continues in Activity · the result will be saved to Library'
      : 'Video edit cancelled')
  }

  const operation = utilityAction === 'upscale' ? 'upscale' : 'custom'
  const priceModel = utilityAction === 'upscale' ? UPSCALE_MODEL : activeModel
  const connected = isConnected()
  const editEstimate = videoEditRunEstimate(operation, priceModel, params, upscaleFactor)
  const spendApproval = getSpendApproval(editEstimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const sourceReady = source?.kind === 'upload' && !!source.url
  const promptMissing = !utilityAction && !prompt.trim()
  const promptProviderMax = VIDEO_EDIT_CONFIG[activeModel].promptMax
  const promptScaffoldLength = refImages.length + refVideos.length + refAudios.length > 0
    ? promptCharacterCount(VIDEO_EDIT_REFERENCE_SCAFFOLD)
    : 0
  const activePromptMax = Math.max(1, promptProviderMax - promptScaffoldLength)
  const promptOverLimit = !utilityAction && promptCharacterCount(prompt) > activePromptMax
  const footerHasError = !!error || spendBlocked || promptMissing || promptOverLimit
  const footerMessage = error
    ? `✕ ${error}`
    : !sourceReady
      ? 'Add or capture a source clip to run this edit.'
      : promptMissing
        ? 'Describe the edit you want to make.'
        : promptOverLimit
          ? `${activeModel} allows ${promptProviderMax.toLocaleString()} prompt characters including EasyField's source/reference instructions · shorten by ${(promptCharacterCount(prompt) - activePromptMax).toLocaleString()}.`
        : !connected
          ? 'Connect EasyField Cloud to run this edit'
          : spendBlocked
            ? spendApproval.reason
            : utilityAction === 'upscale'
              ? 'Upscale is ready · original clip remains unchanged'
              : 'Primary clip stays the edit source · references are guidance only'

  return (
    <div className="ef-screen ef-legacy-workspace ef-edit-video-screen ef-video-reference-edit-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Edit Video</span>
        <span className="ef-spacer" />
        <Dropdown options={CUSTOM_VIDEO_MODELS} selected={activeModel} onSelect={changeModel} label="Video edit model" optionMeta={VIDEO_EDIT_MODEL_META} />
      </div>

      <div className="ef-scroll ef-create-scroll">
        <div className="ef-primary-media-heading">
          <span className="ef-field-label">VIDEO TO EDIT</span>
          <span>PRIMARY SOURCE</span>
        </div>
        <MediaActionMenu
          label="Primary video"
          actions={mediaActions}
          disabled={!sourceReady || phase === 'generating' || sourceGrabPending}
          onSelect={(id) => setUtilityAction(id === 'upscale' ? 'upscale' : null)}
        >
          <VideoSourcePanel
            source={source}
            onPick={pickSource}
            onGrab={() => { void grabPrimarySource() }}
            grabPending={sourceGrabPending}
            disabled={phase === 'generating'}
          />
        </MediaActionMenu>

        {utilityAction === 'upscale' ? (
          <section className="ef-quick-action-card" aria-labelledby="ef-video-upscale-title">
            <header>
              <span><small>MEDIA ACTION</small><strong id="ef-video-upscale-title">Upscale source clip</strong></span>
              <button type="button" className="ef-icon-btn" aria-label="Close upscale settings" onClick={() => setUtilityAction(null)}>×</button>
            </header>
            <p>Topaz enhances the primary clip. The original and all edit references remain untouched.</p>
            <div className="ef-field">
              <span className="ef-field-label">MODEL</span>
              <span className="ef-model-static"><ProviderLogo brand="topaz" size={17} />{UPSCALE_MODEL}</span>
            </div>
            <ChipField label="FACTOR" options={TOPAZ_VIDEO_FACTORS} selected={upscaleFactor} onSelect={setUpscaleFactor} />
          </section>
        ) : (
          <>
            <PromptCard prompt={prompt} onPromptChange={(value) => { setPrompt(value); setError(null) }} maxLength={activePromptMax} enhancerKey="enhancer-edit-video" targetModel={activeModel} mediaKind="video" purpose="edit" references={enhanceRefs} onSpend={onSpend} />

            {refImagesMax > 0 && (
              <ReferenceImageGrid
                images={refImages}
                max={refImagesMax}
                onAddFiles={addRefImageFiles}
                onRemove={removeRefImage}
                onGrabPlayhead={grabRefImage}
                label="SUPPORTING IMAGE REFERENCES · NOT THE SOURCE"
              />
            )}
            {refVideosMax > 0 && (
              <MediaFileGrid
                label="SUPPORTING VIDEO REFERENCES · NOT THE SOURCE"
                addLabel="video"
                glyph="film"
                accept="video/*"
                items={refVideos}
                max={refVideosMax}
                onAddFiles={addRefVideoFiles}
                onRemove={removeRefVideo}
                onGrabPlayhead={grabRefVideo}
                grabLabel="clip"
              />
            )}
            {refAudiosMax > 0 && (
              <MediaFileGrid
                label="SUPPORTING AUDIO · WAV/MP3"
                addLabel="audio"
                glyph="music"
                accept=".wav,.mp3,audio/wav,audio/mpeg"
                items={refAudios}
                max={refAudiosMax}
                onAddFiles={addRefAudioFiles}
                onRemove={removeRefAudio}
                onGrabPlayhead={() => void grabRefAudio()}
                grabLabel="from timeline"
              />
            )}

            {VIDEO_EDIT_CONFIG[activeModel].params.map((p) =>
              p.key === 'duration' ? (
                <DurationSlider
                  key={p.key}
                  options={p.values}
                  value={params[p.key]}
                  onChange={(value) => setParam(p.key, value)}
                  ariaLabel={`${activeModel} duration`}
                />
              ) : p.control === 'dropdown' ? (
                <div className="ef-field" key={p.key}>
                  <span className="ef-field-label">{p.label}</span>
                  <Dropdown
                    options={p.values}
                    selected={params[p.key]}
                    onSelect={(v) => setParam(p.key, v)}
                    label={p.label}
                    align="left"
                    variant="field"
                  />
                </div>
              ) : (
                <ChipField key={p.key} label={p.label} options={p.values} selected={params[p.key]} onSelect={(v) => setParam(p.key, v)} />
              ),
            )}
          </>
        )}

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-atomic="true" aria-label={utilityAction === 'upscale' ? 'Upscaling video' : 'Editing video'}>
              <div className="ef-video-skeleton" style={{ aspectRatio: '16 / 9' }} aria-hidden="true" />
              <span className="ef-gen-caption">{utilityAction === 'upscale' ? 'UPSCALING…' : 'EDITING PRIMARY CLIP…'}</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun="edit" />
          </>
        )}

        {phase === 'done' && resultUrl && (
          <div className="ef-done-block" role="region" aria-label="Edited video result">
            <video className="ef-video-tile" src={resultUrl} controls playsInline aria-label="Preview edited video" style={{ aspectRatio: '16 / 9', width: '100%', objectFit: 'cover' }} />
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ Edit another</button>
              <button
                type="button"
                className="ef-send-btn"
                onClick={() => sendToTimeline([{ url: resultUrl, name: utilityAction === 'upscale' ? 'Upscaled clip' : prompt.slice(0, 40) || 'EasyField clip' }], 'video', toast)}
              >
                Send to timeline
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Video edit summary">
          <PriceEstimate estimate={editEstimate} />
          <div className={`ef-create-footer-message ${footerHasError ? 'is-error' : !sourceReady || !connected ? 'is-help' : 'is-ready'}`} role={footerHasError ? 'alert' : 'status'} aria-live="polite">
            {footerHasError && !error && <span aria-hidden="true">✕ </span>}
            {footerMessage}
          </div>
          <button type="button" className="ef-generate ef-create-footer-action" onClick={apply} disabled={!sourceReady || promptMissing || promptOverLimit || !connected || !spendApproval.approved}>
            <Icon glyph="spark" color="#0E0E13" size={13} /> {utilityAction === 'upscale' ? 'Upscale clip' : 'Apply edit'}
          </button>
        </footer>
      )}
    </div>
  )
}
