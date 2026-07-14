import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PromptCard } from '../components/PromptCard'
import { MaskCanvas } from '../components/MaskCanvas'
import { VideoSourcePanel } from '../components/VideoSourcePanel'
import { LibraryPickerButton } from '../components/LibraryPicker'
import { PriceEstimate } from '../components/PriceEstimate'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { Lightbox } from '../components/Lightbox'
import { resolve } from '../services/resolve'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { sendToTimeline } from '../services/timeline'
import { detectAvatarSubjects, isConnected, isGenerationExit, runAvatar, saveUrl } from '../services/run'
import { addCreations } from '../data/creations'
import { avatarRunEstimate, formatCharged, resolveCharged } from '../data/pricing'
import { AVATAR_MODEL_META } from '../data/modelPresentation'
import type { MediaFile, ReferenceImage } from '../data/referenceImage'
import type { EnhanceReference } from '../services/chat'
import { promptCharacterCount } from '../data/promptLimits'
import {
  AVATAR_MODEL_CONFIG,
  avatarModelsForWorkflow,
  isAvatarModelName,
  validateAvatarDraft,
  type AvatarSubjectLayout,
  type AvatarOptions as ProviderAvatarOptions,
} from '../data/avatar'

export type AvatarMode = 'portrait' | 'video-lipsync'
type Phase = 'form' | 'generating' | 'done'

const PORTRAIT_MODELS = avatarModelsForWorkflow('portrait')
const LIP_SYNC_MODELS = avatarModelsForWorkflow('video-lipsync')
const COUNTS = ['1', '2', '3', '4']
const SUBJECT_DETECTION_MAX_BYTES = 5 * 1024 * 1024

interface AvatarOptions {
  resolution: string
  fastMode: string
  seed: string
  negativePrompt: string
  numFrames: string
  framesPerSecond: string
  inferenceSteps: string
  guidanceScale: string
  shift: string
  volcMode: string
  separateVocal: string
  sceneDetection: string
  alignAudio: string
  reverseAlignment: string
  templateStart: string
}

const DEFAULT_OPTIONS: AvatarOptions = {
  resolution: '1080p',
  fastMode: 'Off',
  seed: '',
  negativePrompt: '',
  numFrames: '80',
  framesPerSecond: '16',
  inferenceSteps: '27',
  guidanceScale: '3.5',
  shift: '5',
  volcMode: 'Lite',
  separateVocal: 'Off',
  sceneDetection: 'Off',
  alignAudio: 'On',
  reverseAlignment: 'Off',
  templateStart: '0',
}

interface AvatarProps {
  onBack: () => void
  toast: (message: string) => void
  onSpend: (credits: number) => void
}

const maxPromptFor = (model: string) => model === 'OmniHuman 1.5' ? 300 : 5000
const ownsUrl = (item: ReferenceImage | MediaFile | null): item is Extract<ReferenceImage | MediaFile, { kind: 'upload' }> =>
  !!item && item.kind === 'upload' && item.url.startsWith('blob:')

async function mediaDuration(url: string, kind: 'audio' | 'video'): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolveDuration) => {
    const element = document.createElement(kind)
    const timeout = window.setTimeout(() => finish(undefined), 10000)
    let done = false
    const finish = (value: number | undefined) => {
      if (done) return
      done = true
      window.clearTimeout(timeout)
      element.pause()
      element.removeAttribute('src')
      element.remove()
      resolveDuration(value)
    }
    element.preload = 'metadata'
    element.hidden = true
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) ? element.duration : undefined)
    element.onerror = () => finish(undefined)
    document.body.append(element)
    element.src = url
    element.load()
  })
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolveBlob) => canvas.toBlob(resolveBlob, 'image/jpeg', quality))
}

/**
 * Cloud Subject Detection accepts JPG/PNG up to 5 MB. Timeline grabs
 * are lossless PNGs and can exceed that ceiling, so make a same-dimension JPEG
 * only for detection. The original image remains the Avatar generation source.
 */
async function subjectDetectionSource(source: ReferenceImage): Promise<ReferenceImage> {
  if (source.kind !== 'upload') throw new Error('Choose an image before finding people.')
  const mime = (source.mimeType ?? '').toLowerCase()
  if ((mime === 'image/jpeg' || mime === 'image/png') && (source.byteSize ?? Infinity) <= SUBJECT_DETECTION_MAX_BYTES) return source
  if (/^https?:\/\//i.test(source.url) && source.byteSize == null) return source

  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`The source image could not be prepared (${response.status}).`)
  const blob = await response.blob()
  if ((blob.type === 'image/jpeg' || blob.type === 'image/png') && blob.size <= SUBJECT_DETECTION_MAX_BYTES) {
    return { ...source, mimeType: blob.type, byteSize: blob.size }
  }
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('This device cannot prepare the portrait for subject detection.')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  let normalized: Blob | null = null
  for (const quality of [0.9, 0.82, 0.74, 0.64, 0.54, 0.44]) {
    normalized = await canvasJpeg(canvas, quality)
    if (normalized && normalized.size <= SUBJECT_DETECTION_MAX_BYTES) break
  }
  if (!normalized || normalized.size > SUBJECT_DETECTION_MAX_BYTES) {
    throw new Error('This image is too complex for Cloud Subject Detection. Export a JPG below 5 MB and try again.')
  }
  return {
    ...source,
    name: `${source.name.replace(/\.[^.]+$/, '') || 'avatar-subjects'}.jpg`,
    url: URL.createObjectURL(normalized),
    mimeType: 'image/jpeg',
    byteSize: normalized.size,
  }
}

function audioFileName(name: string): string {
  const base = name.replace(/[\\/\u0000-\u001f\u007f]/g, ' ').replace(/\.(wav|mp3|m4a|aac|ogg|flac)$/i, '').trim()
  return `${base || 'Timeline voice'}.wav`
}

export function Avatar({ onBack, toast, onSpend }: AvatarProps) {
  const [mode, setMode] = useState<AvatarMode>('portrait')
  const [model, setModel] = useState<string>(PORTRAIT_MODELS[0])
  const [phase, setPhase] = useState<Phase>('form')
  const [prompt, setPrompt] = useState('Natural delivery, steady eye contact, subtle facial expression and realistic head movement')
  const [options, setOptions] = useState<AvatarOptions>(DEFAULT_OPTIONS)
  const [count, setCount] = useState('1')
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [image, setImage] = useState<ReferenceImage | null>(null)
  const [video, setVideo] = useState<MediaFile | null>(null)
  const [audio, setAudio] = useState<MediaFile | null>(null)
  const [masks, setMasks] = useState<ReferenceImage[]>([])
  const [subjectLayout, setSubjectLayout] = useState<AvatarSubjectLayout | null>(null)
  const [subjectSourceId, setSubjectSourceId] = useState('')
  const [selectedSubjectId, setSelectedSubjectId] = useState('')
  const [subjectDetecting, setSubjectDetecting] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const [charged, setCharged] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [imageGrabPending, setImageGrabPending] = useState(false)
  const [videoGrabPending, setVideoGrabPending] = useState(false)
  const [audioGrabPending, setAudioGrabPending] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const idRef = useRef(1)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const activeRunRef = useRef(false)
  const cleanupRef = useRef({ image, video, audio, masks })
  const generation = useGenerationJobControl()

  useEffect(() => {
    cleanupRef.current = { image, video, audio, masks }
  }, [audio, image, masks, video])

  useEffect(() => () => {
    if (activeRunRef.current) return
    const current = cleanupRef.current
    if (ownsUrl(current.image)) URL.revokeObjectURL(current.image.url)
    if (ownsUrl(current.video)) URL.revokeObjectURL(current.video.url)
    if (ownsUrl(current.audio)) URL.revokeObjectURL(current.audio.url)
    current.masks.forEach((mask) => { if (ownsUrl(mask)) URL.revokeObjectURL(mask.url) })
  }, [])

  const nextId = (prefix: string) => `${prefix}-${idRef.current++}`
  const models = mode === 'portrait' ? PORTRAIT_MODELS : LIP_SYNC_MODELS
  const modelConfig = isAvatarModelName(model) ? AVATAR_MODEL_CONFIG[model] : AVATAR_MODEL_CONFIG[PORTRAIT_MODELS[0]]
  const supportsPrompt = modelConfig.prompt !== 'unsupported'
  const promptMax = modelConfig.promptMax || maxPromptFor(model)
  const promptOverLimit = promptCharacterCount(prompt) > promptMax
  const source = mode === 'portrait' ? image : video
  const sourceReady = source?.kind === 'upload' && !!source.url
  const audioReady = audio?.kind === 'upload' && !!audio.url
  const selectedSubject = masks.find((mask) => mask.id === selectedSubjectId) ?? null

  const setOption = (key: keyof AvatarOptions, value: string) => {
    setOptions((current) => ({ ...current, [key]: value }))
    setError('')
  }

  const clearSubjectCandidates = () => {
    setMasks((current) => {
      current.forEach((mask) => { if (ownsUrl(mask)) URL.revokeObjectURL(mask.url) })
      return []
    })
    setSelectedSubjectId('')
  }

  const resetSubjectReview = () => {
    clearSubjectCandidates()
    setSubjectLayout(null)
    setSubjectSourceId('')
  }

  const replaceImage = (next: ReferenceImage) => {
    if (ownsUrl(image) && image.url !== (next.kind === 'upload' ? next.url : '')) URL.revokeObjectURL(image.url)
    resetSubjectReview()
    setImage(next)
    setError('')
  }
  const replaceVideo = (next: MediaFile) => {
    if (ownsUrl(video) && video.url !== (next.kind === 'upload' ? next.url : '')) URL.revokeObjectURL(video.url)
    setVideo(next)
    setError('')
  }
  const replaceAudio = (next: MediaFile) => {
    if (ownsUrl(audio) && audio.url !== (next.kind === 'upload' ? next.url : '')) URL.revokeObjectURL(audio.url)
    setAudio(next)
    setError('')
  }

  const inspectImage = (file: File): ReferenceImage => ({
    id: nextId('avatar-image'),
    kind: 'upload',
    name: file.name,
    url: URL.createObjectURL(file),
    mimeType: file.type,
    byteSize: file.size,
  })

  const inspectMedia = async (file: File, kind: 'audio' | 'video'): Promise<MediaFile> => {
    const url = URL.createObjectURL(file)
    const durationSeconds = await mediaDuration(url, kind)
    return {
      id: nextId(`avatar-${kind}`),
      kind: 'upload',
      name: file.name,
      url,
      mimeType: file.type,
      byteSize: file.size,
      durationSeconds,
    }
  }

  const pickImage = (file: File) => replaceImage(inspectImage(file))
  const pickVideo = (file: File) => { void inspectMedia(file, 'video').then(replaceVideo) }
  const pickAudio = (file: File) => { void inspectMedia(file, 'audio').then(replaceAudio) }

  const grabImage = async () => {
    if (imageGrabPending) return
    setImageGrabPending(true)
    try {
      const grabbed = await resolve.grabEditImageSource()
      if (!grabbed.ok || !grabbed.blobUrl) throw new Error(grabbed.error || 'Place the playhead over an image or video frame.')
      replaceImage({ id: nextId('avatar-frame'), kind: 'upload', name: grabbed.name, url: grabbed.blobUrl, mimeType: 'image/png' })
      toast(grabbed.sourceKind === 'still-image' ? 'Source still loaded from the timeline' : 'Current timeline frame captured')
    } catch (reason) {
      toast(`Frame capture failed · ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setImageGrabPending(false)
    }
  }

  const grabVideo = async () => {
    if (videoGrabPending) return
    setVideoGrabPending(true)
    try {
      const grabbed = await resolve.grabEditVideoSource()
      if (!grabbed.ok || !grabbed.blobUrl) throw new Error(grabbed.error || 'Place the playhead over the video to lip-sync.')
      replaceVideo({
        id: nextId('avatar-video'),
        kind: 'upload',
        name: grabbed.name,
        url: grabbed.blobUrl,
        mimeType: 'video/mp4',
        durationSeconds: grabbed.durationSeconds,
      })
      toast('Exact trimmed timeline clip captured')
    } catch (reason) {
      toast(`Video capture failed · ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setVideoGrabPending(false)
    }
  }

  const grabAudio = async () => {
    if (audioGrabPending) return
    setAudioGrabPending(true)
    try {
      const grabbed = await resolve.grabAudio()
      if (!grabbed.ok || !grabbed.blobUrl) throw new Error(grabbed.error || 'Place the playhead over an audio clip.')
      const response = await fetch(grabbed.blobUrl)
      if (!response.ok) throw new Error(`Timeline audio could not be read (${response.status}).`)
      const blob = await response.blob()
      const file = new File([blob], audioFileName(grabbed.name), { type: blob.type || 'audio/wav', lastModified: Date.now() })
      URL.revokeObjectURL(grabbed.blobUrl)
      const next = await inspectMedia(file, 'audio')
      if (grabbed.durationSeconds && next.kind === 'upload') next.durationSeconds = grabbed.durationSeconds
      replaceAudio(next)
      toast('Timeline voice track captured')
    } catch (reason) {
      toast(`Audio capture failed · ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setAudioGrabPending(false)
    }
  }

  const switchMode = (nextMode: AvatarMode) => {
    if (phase === 'generating' || nextMode === mode) return
    if (nextMode === 'video-lipsync' && (masks.length || subjectLayout)) {
      resetSubjectReview()
      toast('Portrait speaker selection was cleared for video lip sync')
    }
    setMode(nextMode)
    setModel(nextMode === 'portrait' ? PORTRAIT_MODELS[0] : LIP_SYNC_MODELS[0])
    setError('')
  }

  const changeModel = (nextModel: string) => {
    setModel(nextModel)
    setAdvancedOpen(false)
    setError('')
    if (nextModel === 'OmniHuman 1.5') setOptions((current) => ({ ...current, resolution: current.resolution === '480p' || current.resolution === '580p' ? '720p' : current.resolution }))
    if (nextModel === 'InfiniteTalk' && !['480p', '720p'].includes(options.resolution)) setOption('resolution', '720p')
    if (nextModel === 'Wan 2.2 A14B Speech-to-Video Turbo' && !['480p', '580p', '720p'].includes(options.resolution)) setOption('resolution', '720p')
  }

  const chooseSubjectLayout = (nextLayout: Exclude<AvatarSubjectLayout, 'none'>) => {
    if (!image || image.kind !== 'upload') return
    clearSubjectCandidates()
    setSubjectLayout(nextLayout)
    setSubjectSourceId(image.id)
    setError('')
    if (nextLayout === 'multiple' && model !== 'OmniHuman 1.5') {
      changeModel('OmniHuman 1.5')
      toast('Switched to OmniHuman 1.5 · it is the verified model that can target one person in a group')
    }
  }

  const findSubjects = async () => {
    if (!image || image.kind !== 'upload' || subjectDetecting) return
    const sourceId = image.id
    setSubjectDetecting(true)
    setError('')
    clearSubjectCandidates()
    let prepared: ReferenceImage | null = null
    try {
      prepared = await subjectDetectionSource(image)
      const result = await detectAvatarSubjects(prepared, sourceId)
      if (!result.urls.length) throw new Error('No selectable person was found in this image.')
      const detected = result.urls.slice(0, 5).map((url, index): ReferenceImage => ({
        id: nextId('avatar-subject'),
        kind: 'upload',
        name: `Detected person ${index + 1}.png`,
        url,
        mimeType: 'image/png',
      }))
      setMasks(detected)
      setSubjectSourceId(sourceId)
      setSelectedSubjectId(detected.length === 1 ? detected[0].id : '')
      if (result.credits != null) onSpend(result.credits)
      toast(detected.length === 1 ? 'One person found and selected' : `${detected.length} people found · choose who should speak`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (prepared?.kind === 'upload' && prepared.url !== image.url && prepared.url.startsWith('blob:')) URL.revokeObjectURL(prepared.url)
      setSubjectDetecting(false)
    }
  }

  const enhancerReferences = useMemo<EnhanceReference[]>(() => {
    const references: EnhanceReference[] = []
    if (image?.kind === 'upload') references.push({ role: 'avatar portrait', label: image.name, imageUrl: image.url })
    if (selectedSubject?.kind === 'upload') references.push({ role: 'the only person who should speak', label: selectedSubject.name, imageUrl: selectedSubject.url })
    if (video?.kind === 'upload') references.push({ role: 'primary video to lip-sync', label: video.name })
    if (audio?.kind === 'upload') references.push({ role: 'voice performance and timing', label: audio.name })
    return references
  }, [audio, image, selectedSubject, video])

  const providerOptions = useMemo<Partial<ProviderAvatarOptions>>(() => {
    if (model === 'OmniHuman 1.5') {
      return {
        outputResolution: options.resolution === '1080p' ? '1080' : '720',
        fastMode: options.fastMode === 'On',
        seed: Number(options.seed || -1),
      }
    }
    if (model === 'InfiniteTalk') {
      const seed = Number(options.seed)
      return {
        resolution: options.resolution === '720p' ? '720p' : '480p',
        ...(seed >= 10_000 && seed <= 1_000_000 ? { seed } : {}),
      }
    }
    if (model === 'Wan 2.2 A14B Speech-to-Video Turbo') {
      const seed = Number(options.seed)
      return {
        resolution: ['480p', '580p', '720p'].includes(options.resolution) ? options.resolution as '480p' | '580p' | '720p' : '480p',
        numFrames: Number(options.numFrames),
        framesPerSecond: Number(options.framesPerSecond),
        ...(options.negativePrompt ? { negativePrompt: options.negativePrompt } : {}),
        numInferenceSteps: Number(options.inferenceSteps),
        guidanceScale: Number(options.guidanceScale),
        shift: Number(options.shift),
        ...(options.seed.trim() && Number.isInteger(seed) ? { seed } : {}),
        nsfwChecker: true,
      }
    }
    if (model === 'Volcengine Lip Sync') {
      const lite = options.volcMode === 'Lite'
      return {
        lipSyncMode: lite ? 'lite' : 'basic',
        separateVocal: options.separateVocal === 'On',
        ...(lite
          ? {
              alignAudio: options.alignAudio === 'On',
              alignAudioReverse: options.reverseAlignment === 'On',
              templateStartSeconds: Number(options.templateStart),
            }
          : { openSceneDetection: options.sceneDetection === 'On' }),
      }
    }
    return {}
  }, [model, options])

  const estimate = avatarRunEstimate(model, Number(count), {
    audioDurationSeconds: audio?.kind === 'upload' ? audio.durationSeconds : undefined,
    numFrames: Number(options.numFrames),
    framesPerSecond: Number(options.framesPerSecond),
    resolution: options.resolution,
  })

  const run = async () => {
    setError('')
    const controller = generation.begin()
    activeRunRef.current = true
    setPhase('generating')
    try {
      const result = await runAvatar({
        workflow: mode,
        model,
        prompt,
        image,
        video,
        audio,
        subjectLayout,
        subjectSourceId: subjectSourceId || undefined,
        masks: selectedSubject ? [selectedSubject] : [],
        maskSourceIds: selectedSubject ? [subjectSourceId] : [],
        rightsConfirmed,
        count: Number(count),
        options: providerOptions,
      }, { signal: controller.signal, onJobCreated: generation.attachJob })
      if (controller.signal.aborted) return
      if (!result.urls.length) throw new Error('The cloud service completed the task without returning a video.')
      const actual = result.credits ?? resolveCharged(estimate)
      setCharged(actual)
      onSpend(actual ?? 0)
      setResults(result.urls)
      addCreations(result.urls.map((url, index) => ({
        kind: 'video',
        url,
        model,
        prompt: prompt || `${mode === 'portrait' ? 'Avatar' : 'Lip sync'} ${index + 1}`,
        meta: `${mode === 'portrait' ? 'Portrait avatar' : 'Video lip sync'} · consent confirmed`,
      })))
      setPhase('done')
    } catch (reason) {
      if (controller.signal.aborted || isGenerationExit(reason)) {
        setPhase('form')
        return
      }
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('form')
    } finally {
      generation.finish(controller)
      activeRunRef.current = false
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    toast(outcome === 'backgrounded' ? 'Avatar continues in Activity · the result will be saved to Library' : 'Avatar generation cancelled')
  }

  const connected = isConnected()
  const selectedMasks = selectedSubject ? [selectedSubject] : []
  const draftValidation = validateAvatarDraft({
    model,
    rightsConfirmed,
    prompt: mode === 'video-lipsync' ? '' : prompt,
    image: mode === 'portrait' ? image : null,
    video: mode === 'video-lipsync' ? video : null,
    audio,
    subjectLayout: mode === 'portrait' ? subjectLayout ?? undefined : undefined,
    subjectSourceId: mode === 'portrait' ? subjectSourceId || undefined : undefined,
    masks: mode === 'portrait' ? selectedMasks : [],
    maskSourceIds: mode === 'portrait' && selectedSubject ? [subjectSourceId] : [],
    options: providerOptions,
  })
  const ready = sourceReady && audioReady && connected && draftValidation.valid
  const footerMessage = error
    ? `✕ ${error}`
    : !sourceReady
      ? mode === 'portrait' ? 'Add a portrait or character image.' : 'Add the exact video you want to lip-sync.'
      : !audioReady
        ? 'Add the voice or dialogue track that will drive the performance.'
        : mode === 'portrait' && !subjectLayout
          ? 'Confirm whether the portrait contains one person or multiple people.'
          : mode === 'portrait' && subjectLayout === 'multiple' && model !== 'OmniHuman 1.5'
            ? `${model} cannot target one speaker in a group. Use OmniHuman 1.5 or a single-person image.`
            : mode === 'portrait' && subjectLayout === 'multiple' && !selectedSubject
              ? 'Find the people in the image, then choose exactly one speaker.'
        : !rightsConfirmed
          ? 'Confirm you have permission to animate the person and voice.'
          : promptOverLimit
            ? `Shorten the prompt by ${(promptCharacterCount(prompt) - promptMax).toLocaleString()} characters.`
            : !draftValidation.valid
              ? draftValidation.issues[0]?.message ?? 'Review the Avatar inputs.'
            : !connected
              ? 'Connect EasyField Cloud to generate the avatar.'
              : 'Ready · source media stays unchanged and every result is saved to Library.'

  return (
    <div className="ef-screen ef-legacy-workspace ef-avatar-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Avatar</span>
        <span className="ef-spacer" />
        <Dropdown options={models} selected={model} onSelect={changeModel} label="Avatar model" optionMeta={AVATAR_MODEL_META} />
      </div>

      <div className="ef-scroll ef-create-scroll">
        <div className="ef-edit-mode-bar ef-avatar-mode-bar" role="group" aria-label="Avatar workflow">
          <span><small>WORKFLOW</small><strong>{mode === 'portrait' ? 'Animate a portrait' : 'Lip-sync an existing clip'}</strong></span>
          <div className="ef-setting-segmented">
            <button type="button" className={mode === 'portrait' ? 'is-selected' : ''} aria-pressed={mode === 'portrait'} onClick={() => switchMode('portrait')}>Portrait + audio</button>
            <button type="button" className={mode === 'video-lipsync' ? 'is-selected' : ''} aria-pressed={mode === 'video-lipsync'} onClick={() => switchMode('video-lipsync')}>Video lip sync</button>
          </div>
        </div>

        <div className="ef-avatar-source-grid">
          <section className="ef-avatar-source-card">
            <div className="ef-primary-media-heading">
              <span className="ef-field-label">{mode === 'portrait' ? 'PORTRAIT / CHARACTER' : 'VIDEO TO LIP-SYNC'}</span>
              <span>PRIMARY SOURCE</span>
            </div>
            {mode === 'portrait' ? (
              <MaskCanvas
                source={image}
                maskable={false}
                brushSize={20}
                color="#E26BD2"
                onPick={pickImage}
                onGrab={() => { void grabImage() }}
                grabPending={imageGrabPending}
                disabled={phase === 'generating'}
                onClearRef={() => undefined}
                emptyTitle="Choose a portrait or character"
                emptyDescription="Use a clear face image from Files, Library, or the Resolve timeline."
                sourceLabel="Choose the avatar portrait"
                uploadLabel="Upload image"
                grabLabel="Grab frame"
              />
            ) : (
              <VideoSourcePanel
                source={video}
                onPick={pickVideo}
                onGrab={() => { void grabVideo() }}
                grabPending={videoGrabPending}
                disabled={phase === 'generating'}
                title="Choose the video to lip-sync"
                description="Use a file or capture the clip exactly as it is trimmed on the Resolve timeline."
                groupLabel="Choose the source video for lip sync"
                uploadLabel="Upload video"
                grabLabel="Grab trimmed clip"
              />
            )}
          </section>

          <section className="ef-avatar-audio-card" aria-labelledby="ef-avatar-audio-title">
            <header>
              <span><small>VOICE SOURCE</small><strong id="ef-avatar-audio-title">Dialogue or performance audio</strong></span>
              {audio && <button type="button" className="ef-icon-btn" aria-label="Remove voice track" onClick={() => { if (ownsUrl(audio)) URL.revokeObjectURL(audio.url); setAudio(null) }}>×</button>}
            </header>
            {audio?.kind === 'upload' ? (
              <div className="ef-avatar-audio-ready">
                <span className="ef-avatar-audio-mark"><Icon glyph="vo" size={18} /></span>
                <div><strong>{audio.name}</strong><small>{audio.durationSeconds ? `${audio.durationSeconds.toFixed(1)} seconds` : 'Duration read by the cloud service'}</small></div>
                <audio src={audio.url} controls preload="metadata" aria-label={`Preview ${audio.name}`} />
              </div>
            ) : (
              <div className="ef-avatar-audio-empty">
                <span className="ef-avatar-audio-mark"><Icon glyph="vo" size={19} /></span>
                <strong>Add a clean voice track</strong>
                <p>The audio controls the words, timing and final duration.</p>
              </div>
            )}
            <div className="ef-avatar-audio-actions">
              <button type="button" className="ef-canvas-btn" disabled={phase === 'generating'} onClick={() => audioInputRef.current?.click()}><Icon glyph="up" size={12} /> Upload</button>
              <LibraryPickerButton
                kinds={['audio']}
                max={1}
                disabled={phase === 'generating'}
                className="ef-canvas-btn ef-library-source-btn"
                pickerTitle="Choose voice audio"
                confirmLabel="Use audio"
                onSelect={async ([creation]) => { if (creation) pickAudio(await copyLibraryCreationForWorkspace(creation)) }}
              />
              <button type="button" className="ef-canvas-btn ef-canvas-btn--grab" disabled={phase === 'generating' || audioGrabPending} onClick={() => { void grabAudio() }}><Icon glyph="playhead" size={12} /> {audioGrabPending ? 'Grabbing…' : 'Grab audio'}</button>
            </div>
            <input ref={audioInputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.wma" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) pickAudio(file) }} />
          </section>
        </div>

        {mode === 'portrait' && image?.kind === 'upload' && (
          <section className="ef-avatar-speaker-card" aria-labelledby="ef-avatar-speaker-title">
            <header>
              <span><small>SPEAKER TARGETING</small><strong id="ef-avatar-speaker-title">How many people are visible?</strong></span>
              <span className="ef-avatar-speaker-safety">REQUIRED</span>
            </header>
            <p className="ef-avatar-speaker-intro">A prompt cannot reliably choose a face. Confirm the source layout so the voice is never assigned to every person by accident.</p>
            <div className="ef-avatar-layout-choices" role="group" aria-label="People visible in portrait">
              <button type="button" aria-pressed={subjectLayout === 'single'} className={subjectLayout === 'single' ? 'is-selected' : ''} disabled={phase === 'generating' || subjectDetecting} onClick={() => chooseSubjectLayout('single')}>
                <span className="ef-avatar-layout-icon">1</span>
                <span><strong>One person</strong><small>Use the full portrait directly</small></span>
              </button>
              <button type="button" aria-pressed={subjectLayout === 'multiple'} className={subjectLayout === 'multiple' ? 'is-selected' : ''} disabled={phase === 'generating' || subjectDetecting} onClick={() => chooseSubjectLayout('multiple')}>
                <span className="ef-avatar-layout-icon">2+</span>
                <span><strong>Multiple people</strong><small>Detect and choose one speaker</small></span>
              </button>
            </div>

            {subjectLayout === 'single' && (
              <div className="ef-avatar-speaker-note is-safe"><span>✓</span><p><strong>Single-person source confirmed</strong><small>No speaker mask will be sent.</small></p></div>
            )}

            {subjectLayout === 'multiple' && model !== 'OmniHuman 1.5' && (
              <div className="ef-avatar-speaker-warning">
                <span>!</span>
                <p><strong>{model} has no verified face selector.</strong><small>Use OmniHuman or replace the source with a crop containing one person.</small></p>
                <button type="button" onClick={() => changeModel('OmniHuman 1.5')}>Use OmniHuman</button>
              </div>
            )}

            {subjectLayout === 'multiple' && model === 'OmniHuman 1.5' && (
              <div className="ef-avatar-subject-detection">
                <div className="ef-avatar-detection-head">
                  <span><small>OMNIHUMAN SUBJECT DETECTION</small><strong>{masks.length ? 'Choose exactly one speaker' : 'Find the people in this image'}</strong></span>
                  <button type="button" className="ef-avatar-detect-btn" disabled={subjectDetecting || phase === 'generating'} onClick={() => { void findSubjects() }}>
                    {subjectDetecting ? 'Finding people…' : masks.length ? 'Scan again' : 'Find people'}
                  </button>
                </div>
                <p className="ef-avatar-detection-copy">Runs one cloud detection task. If the service charges it, the exact credits are reported after the scan.</p>
                {subjectDetecting && <div className="ef-avatar-detection-progress" role="status"><span /><span>Analyzing faces and subjects…</span></div>}
                {masks.length > 0 && (
                  <div className="ef-avatar-subject-grid" role="radiogroup" aria-label="Choose the person who should speak">
                    {masks.map((mask, index) => {
                      const selected = mask.id === selectedSubjectId
                      return (
                        <button
                          key={mask.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={`Person ${index + 1}${selected ? ', selected to speak' : ''}`}
                          className={selected ? 'is-selected' : ''}
                          onClick={() => { setSelectedSubjectId(mask.id); setError('') }}
                        >
                          <span className="ef-avatar-subject-visual">
                            <img src={image.url} alt="" className="ef-avatar-subject-base" />
                            {mask.kind === 'upload' && <img src={mask.url} alt="" className="ef-avatar-subject-mask" />}
                          </span>
                          <span className="ef-avatar-subject-label"><strong>Person {index + 1}</strong><small>{selected ? 'Will speak' : 'Select speaker'}</small></span>
                          <span className="ef-avatar-subject-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {supportsPrompt && (
          <PromptCard
            prompt={prompt}
            onPromptChange={(value) => { setPrompt(value); setError('') }}
            maxLength={promptMax}
            enhancerKey="enhancer-avatar"
            targetModel={model}
            mediaKind="video"
            placeholder="Describe delivery, expression, gaze and motion…"
            references={enhancerReferences}
            contextKey={`${mode}:${model}:${image?.id ?? ''}:${video?.id ?? ''}:${audio?.id ?? ''}`}
            onSpend={onSpend}
          />
        )}

        {modelConfig.controls.length > 0 && <section className="ef-avatar-settings-card">
          <header>
            <span><small>MODEL CONTROLS</small><strong>{model}</strong></span>
            <button type="button" className="ef-avatar-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? 'Hide advanced' : 'Advanced'}</button>
          </header>

          {model === 'OmniHuman 1.5' && (
            <div className="ef-avatar-control-grid">
              <ChipField label="RESOLUTION" options={['720p', '1080p']} selected={options.resolution} onSelect={(value) => setOption('resolution', value)} />
              <ChipField label="FAST MODE" options={['Off', 'On']} selected={options.fastMode} onSelect={(value) => setOption('fastMode', value)} />
            </div>
          )}
          {model === 'InfiniteTalk' && <ChipField label="RESOLUTION" options={['480p', '720p']} selected={options.resolution} onSelect={(value) => setOption('resolution', value)} />}
          {model === 'Wan 2.2 A14B Speech-to-Video Turbo' && (
            <>
              <ChipField label="RESOLUTION" options={['480p', '580p', '720p']} selected={options.resolution} onSelect={(value) => setOption('resolution', value)} />
              <div className="ef-avatar-number-grid">
                <label><span>FRAMES · 40–120</span><input type="number" min={40} max={120} step={4} value={options.numFrames} onChange={(event) => setOption('numFrames', event.target.value)} /></label>
                <label><span>FPS · 4–60</span><input type="number" min={4} max={60} value={options.framesPerSecond} onChange={(event) => setOption('framesPerSecond', event.target.value)} /></label>
              </div>
            </>
          )}
          {model === 'Volcengine Lip Sync' && (
            <>
              <ChipField label="PROCESSING MODE" options={['Lite', 'Basic']} selected={options.volcMode} onSelect={(value) => { setOption('volcMode', value); if (value === 'Basic') setOption('reverseAlignment', 'Off') }} />
              <div className="ef-avatar-control-grid">
                <ChipField label="SEPARATE VOCAL" options={['Off', 'On']} selected={options.separateVocal} onSelect={(value) => setOption('separateVocal', value)} />
                {options.volcMode === 'Basic' ? (
                  <ChipField label="SCENE DETECTION" options={['Off', 'On']} selected={options.sceneDetection} onSelect={(value) => setOption('sceneDetection', value)} />
                ) : (
                  <ChipField label="ALIGN AUDIO" options={['Off', 'On']} selected={options.alignAudio} onSelect={(value) => { setOption('alignAudio', value); if (value === 'Off') setOption('reverseAlignment', 'Off') }} />
                )}
              </div>
            </>
          )}

          {advancedOpen && (
            <div className="ef-avatar-advanced-grid">
              {(model === 'OmniHuman 1.5' || model === 'InfiniteTalk') && (
                <label><span>SEED · AUTO WHEN EMPTY</span><input type="number" min={model === 'InfiniteTalk' ? 10000 : -1} max={model === 'InfiniteTalk' ? 1000000 : undefined} value={options.seed} placeholder={model === 'OmniHuman 1.5' ? '-1' : 'Automatic'} onChange={(event) => setOption('seed', event.target.value)} /></label>
              )}
              {model === 'Wan 2.2 A14B Speech-to-Video Turbo' && (
                <>
                  <label className="is-wide"><span>NEGATIVE PROMPT · MAX 500</span><textarea maxLength={500} value={options.negativePrompt} onChange={(event) => setOption('negativePrompt', event.target.value)} /></label>
                  <label><span>INFERENCE STEPS · 2–40</span><input type="number" min={2} max={40} value={options.inferenceSteps} onChange={(event) => setOption('inferenceSteps', event.target.value)} /></label>
                  <label><span>GUIDANCE · 1–10</span><input type="number" min={1} max={10} step={0.1} value={options.guidanceScale} onChange={(event) => setOption('guidanceScale', event.target.value)} /></label>
                  <label><span>SHIFT · 1–10</span><input type="number" min={1} max={10} step={0.1} value={options.shift} onChange={(event) => setOption('shift', event.target.value)} /></label>
                  <label><span>SEED · AUTO WHEN EMPTY</span><input type="number" value={options.seed} placeholder="Automatic" onChange={(event) => setOption('seed', event.target.value)} /></label>
                </>
              )}
              {model === 'Volcengine Lip Sync' && options.volcMode === 'Lite' && (
                <>
                  <label><span>TEMPLATE START · SECONDS</span><input type="number" min={0} step={0.1} value={options.templateStart} onChange={(event) => setOption('templateStart', event.target.value)} /></label>
                  <div className="ef-avatar-inline-option"><span>REVERSE ALIGNMENT</span><button type="button" className={options.reverseAlignment === 'On' ? 'is-on' : ''} disabled={options.alignAudio !== 'On'} onClick={() => setOption('reverseAlignment', options.reverseAlignment === 'On' ? 'Off' : 'On')}>{options.reverseAlignment}</button></div>
                </>
              )}
            </div>
          )}
        </section>}

        <ChipField label="VARIATIONS" options={COUNTS} selected={count} onSelect={setCount} />

        <label className={`ef-avatar-consent${rightsConfirmed ? ' is-confirmed' : ''}`}>
          <input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} />
          <span className="ef-avatar-consent-mark" aria-hidden="true">{rightsConfirmed ? '✓' : ''}</span>
          <span><strong>Rights & consent confirmed</strong><small>I have permission to animate this likeness and use this voice. The selected files are listed before the paid request.</small></span>
        </label>

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block ef-avatar-generating" role="status" aria-live="polite">
              <div className="ef-video-skeleton" style={{ aspectRatio: '16 / 9' }} aria-hidden="true" />
              <span className="ef-gen-caption">SYNCHRONIZING PERFORMANCE…</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun="avatar generation" />
          </>
        )}

        {phase === 'done' && results.length > 0 && (
          <section className="ef-avatar-results" aria-label="Avatar video results">
            <header><span><small>RESULTS</small><strong>{results.length} saved to Library</strong></span><span>{formatCharged(charged)}</span></header>
            <div className="ef-avatar-result-grid">
              {results.map((url, index) => (
                <article key={`${url}-${index}`}>
                  <video src={url} controls playsInline preload="metadata" aria-label={`Avatar result ${index + 1}`} />
                  <div>
                    <button type="button" className="ef-ghost-btn" onClick={() => saveUrl(url, `easyfield-avatar-${index + 1}.mp4`)}>Download</button>
                    <button type="button" className="ef-send-btn" onClick={() => { void sendToTimeline([{ url, name: `Avatar · ${model}` }], 'video', toast) }}>Send to timeline</button>
                  </div>
                </article>
              ))}
            </div>
            <button type="button" className="ef-ghost-btn ef-avatar-generate-again" onClick={() => { setPhase('form'); setError('') }}>↺ Generate another with these sources</button>
          </section>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Avatar generation summary">
          <PriceEstimate estimate={estimate} />
          <div className={`ef-create-footer-message ${error || !rightsConfirmed || promptOverLimit ? 'is-error' : ready ? 'is-ready' : 'is-help'}`} role={error ? 'alert' : 'status'} aria-live="polite">{footerMessage}</div>
          <button type="button" className="ef-generate ef-create-footer-action" disabled={!ready} onClick={() => { void run() }}><Icon glyph="avatar" size={14} color="#0E0E13" /> {mode === 'portrait' ? 'Create avatar' : 'Lip-sync video'}</button>
        </footer>
      )}

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
