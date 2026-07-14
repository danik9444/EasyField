import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  KLING_ELEMENT_AUDIO_MAX_DURATION_MS,
  KLING_ELEMENT_AUDIO_MIN_DURATION_MS,
  KLING_ELEMENT_IMAGE_EXTENSIONS,
  KLING_ELEMENT_IMAGE_MAX,
  KLING_ELEMENT_IMAGE_MAX_BYTES,
  KLING_ELEMENT_IMAGE_MAX_ASPECT_RATIO,
  KLING_ELEMENT_IMAGE_MIME_TYPES,
  KLING_ELEMENT_IMAGE_MIN_ASPECT_RATIO,
  KLING_ELEMENT_IMAGE_MIN_HEIGHT,
  KLING_ELEMENT_IMAGE_MIN_WIDTH,
  KLING_ELEMENT_MAX,
  KLING_ELEMENT_VIDEO_EXTENSIONS,
  KLING_ELEMENT_VIDEO_MIME_TYPES,
  KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS,
  KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS,
  validateKlingElementDraft,
  type KlingElementAudioDraft,
  type KlingElementDraft,
  type KlingElementFileLike,
  type KlingElementVideoMediaDraft,
} from '../data/klingElements'
import type { Creation } from '../data/creations'
import { Icon } from '../icons'
import { resolve, type Grab } from '../services/resolve'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { LibraryPickerButton } from './LibraryPicker'
import { Lightbox } from './Lightbox'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const IMAGE_ACCEPT = '.jpg,.jpeg,.png,image/jpeg,image/png'
const VIDEO_ACCEPT = '.mp4,.mov,video/mp4,video/quicktime'
const AUDIO_ACCEPT = 'audio/*'

type VisualMode = 'images' | 'video'
type PreviewKind = 'image' | 'video'

interface PreviewReference {
  url: string
  owned: boolean
}

export interface KlingElementEditorProps {
  open: boolean
  element?: KlingElementDraft | null
  existingCount: number
  existingNames: readonly string[]
  makeId: () => string
  onSave: (element: KlingElementDraft) => void | Promise<void>
  onCancel: () => void
  toast: (message: string) => void
}

function cleanName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function extension(name: string): string {
  return name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
}

function normalizedMime(type: string): string {
  return type.trim().toLowerCase().split(';', 1)[0]
}

function fileMime(file: KlingElementFileLike): string {
  return file.type ?? file.mimeType ?? ''
}

function fileSize(file: KlingElementFileLike): number {
  return file.size ?? file.byteSize ?? 0
}

function matchesType(file: KlingElementFileLike, mimes: readonly string[], extensions: readonly string[]): boolean {
  const mime = normalizedMime(fileMime(file))
  const ext = extension(file.name)
  const mimeMatches = !!mime && mimes.includes(mime)
  const extensionMatches = !!ext && extensions.includes(ext)
  if (mime && ext) return mimeMatches && extensionMatches
  return mimeMatches || extensionMatches
}

function isImageFile(file: KlingElementFileLike): boolean {
  const size = fileSize(file)
  return matchesType(file, KLING_ELEMENT_IMAGE_MIME_TYPES, KLING_ELEMENT_IMAGE_EXTENSIONS)
    && Number.isFinite(size)
    && size > 0
    && size <= KLING_ELEMENT_IMAGE_MAX_BYTES
}

function isVideoFile(file: KlingElementFileLike): boolean {
  const size = fileSize(file)
  return matchesType(file, KLING_ELEMENT_VIDEO_MIME_TYPES, KLING_ELEMENT_VIDEO_EXTENSIONS)
    && Number.isFinite(size)
    && size > 0
}

function isBrowserFile(file: KlingElementFileLike): file is File {
  return typeof File !== 'undefined' && file instanceof File
}

function embeddedUrl(file: KlingElementFileLike): string | null {
  const value = (file as KlingElementFileLike & { url?: unknown }).url
  return typeof value === 'string' && /^(blob:|data:|https?:)/i.test(value) ? value : null
}

function previewFor(file: KlingElementFileLike): PreviewReference | null {
  if (isBrowserFile(file)) return { url: URL.createObjectURL(file), owned: true }
  const url = embeddedUrl(file)
  return url ? { url, owned: false } : null
}

function revokePreview(reference: PreviewReference | undefined): void {
  if (reference?.owned) URL.revokeObjectURL(reference.url)
}

function mediaKey(file: KlingElementFileLike, index = 0): string {
  return `${file.id ?? 'file'}:${file.name}:${fileSize(file)}:${index}`
}

function withExtension(name: string, fallback: string, ext: string): string {
  const clean = name.replace(/[\\/\u0000-\u001f\u007f]/g, ' ').trim() || fallback
  return extension(clean) ? clean : `${clean}.${ext}`
}

function formatSeconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Duration unavailable'
  return `${(milliseconds / 1_000).toFixed(milliseconds % 1_000 === 0 ? 0 : 1)}s`
}

function formatDuration(milliseconds: number): string {
  return milliseconds > 0 ? formatSeconds(milliseconds) : 'Duration unavailable'
}

async function probeDuration(file: File, kind: 'video' | 'audio'): Promise<number> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<number>((resolveDuration) => {
      const media = document.createElement(kind)
      let settled = false
      const finish = (value = 0) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        media.onloadedmetadata = null
        media.onerror = null
        media.removeAttribute('src')
        media.load()
        resolveDuration(Number.isFinite(value) && value > 0 ? Math.round(value * 1_000) : 0)
      }
      const timer = window.setTimeout(() => finish(), 6_000)
      media.preload = 'metadata'
      media.onloadedmetadata = () => finish(media.duration)
      media.onerror = () => finish()
      media.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function probeImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return dimensions
    } catch {
      // Fall through to the HTML image decoder for browser/WebKit variants.
    }
  }

  const url = URL.createObjectURL(file)
  try {
    return await new Promise<{ width: number; height: number } | null>((resolveDimensions) => {
      const image = new Image()
      let settled = false
      const finish = (dimensions: { width: number; height: number } | null) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        image.onload = null
        image.onerror = null
        image.removeAttribute('src')
        resolveDimensions(dimensions)
      }
      const timer = window.setTimeout(() => finish(null), 6_000)
      image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => finish(null)
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function allowedImageDimensions(width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false
  if (width < KLING_ELEMENT_IMAGE_MIN_WIDTH || height < KLING_ELEMENT_IMAGE_MIN_HEIGHT) return false
  const aspectRatio = width / height
  return aspectRatio >= KLING_ELEMENT_IMAGE_MIN_ASPECT_RATIO && aspectRatio <= KLING_ELEMENT_IMAGE_MAX_ASPECT_RATIO
}

function withImageDimensions(file: File, width: number, height: number): File & KlingElementFileLike {
  // Preserve the original File/Blob identity so run.ts can upload its bytes;
  // only provider preflight metadata is attached to the browser-owned object.
  return Object.assign(file, { width, height })
}

async function fileFromGrab(grab: Grab, fallbackName: string, extensionName: string, fallbackType: string): Promise<File> {
  if (!grab.ok || !grab.blobUrl) throw new Error(grab.error || 'Timeline capture did not return media.')
  try {
    const response = await fetch(grab.blobUrl)
    if (!response.ok) throw new Error(`Timeline capture could not be read (${response.status}).`)
    const blob = await response.blob()
    if (!blob.size) throw new Error('Timeline capture was empty.')
    return new File(
      [blob],
      withExtension(grab.name, fallbackName, extensionName),
      { type: blob.type || fallbackType, lastModified: Date.now() },
    )
  } finally {
    URL.revokeObjectURL(grab.blobUrl)
  }
}

function emptyVideo(file: KlingElementFileLike, durationMs: number): KlingElementVideoMediaDraft {
  const safeDuration = Math.max(0, Math.round(durationMs))
  return {
    kind: 'video',
    file,
    durationMs: safeDuration,
    startTimeMs: 0,
    endTimeMs: safeDuration > 0 ? Math.min(safeDuration, KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS) : 0,
  }
}

export function KlingElementEditor({
  open,
  element,
  existingCount,
  existingNames,
  makeId,
  onSave,
  onCancel,
  toast,
}: KlingElementEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const onCancelRef = useRef(onCancel)
  const previewRefs = useRef(new Map<KlingElementFileLike, PreviewReference>())
  const wasOpenRef = useRef(false)
  const makeIdRef = useRef(makeId)
  const titleId = useId()
  const descriptionId = useId()
  const errorId = useId()

  const [draftId, setDraftId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visualMode, setVisualMode] = useState<VisualMode>('images')
  const [images, setImages] = useState<KlingElementFileLike[]>([])
  const [video, setVideo] = useState<KlingElementVideoMediaDraft | null>(null)
  const [audio, setAudio] = useState<KlingElementAudioDraft | null>(null)
  const [previewUrls, setPreviewUrls] = useState(new Map<KlingElementFileLike, PreviewReference>())
  const [lightbox, setLightbox] = useState<{ url: string; kind: PreviewKind } | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sourceBusy, setSourceBusy] = useState<'images' | 'video' | 'audio' | null>(null)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    makeIdRef.current = makeId
  }, [makeId])

  const replacePreviews = (files: readonly KlingElementFileLike[]) => {
    previewRefs.current.forEach(revokePreview)
    const next = new Map<KlingElementFileLike, PreviewReference>()
    files.forEach((file) => {
      const preview = previewFor(file)
      if (preview) next.set(file, preview)
    })
    previewRefs.current = next
    setPreviewUrls(next)
  }

  const ensurePreview = (file: KlingElementFileLike) => {
    if (previewRefs.current.has(file)) return
    const preview = previewFor(file)
    if (!preview) return
    const next = new Map(previewRefs.current)
    next.set(file, preview)
    previewRefs.current = next
    setPreviewUrls(next)
  }

  const forgetPreview = (file: KlingElementFileLike) => {
    const current = previewRefs.current.get(file)
    if (!current) return
    revokePreview(current)
    const next = new Map(previewRefs.current)
    next.delete(file)
    previewRefs.current = next
    setPreviewUrls(next)
  }

  useEffect(() => {
    const opening = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!opening) return

    const nextId = element?.id || makeIdRef.current()
    const nextImages = element?.media?.kind === 'images' ? [...element.media.files] : []
    const nextVideo = element?.media?.kind === 'video' ? { ...element.media } : null
    const nextAudio = element?.audio ? { ...element.audio } : null
    setDraftId(nextId)
    setName(element?.name ?? '')
    setDescription(element?.description ?? '')
    setVisualMode(element?.media?.kind ?? 'images')
    setImages(nextImages)
    setVideo(nextVideo)
    setAudio(nextAudio)
    setAttempted(false)
    setBusy(false)
    setSourceBusy(null)
    setSaveError('')
    setLightbox(null)
    replacePreviews([
      ...nextImages,
      ...(nextVideo ? [nextVideo.file] : []),
      ...(nextAudio ? [nextAudio.file] : []),
    ])

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => nameRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      previousFocus?.focus()
    }
    // Reset only when a closed editor opens. Parent re-renders must not erase work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => {
    previewRefs.current.forEach(revokePreview)
    previewRefs.current.clear()
  }, [])

  const draft = useMemo<KlingElementDraft>(() => ({
    id: draftId,
    name,
    description,
    media: visualMode === 'images'
      ? { kind: 'images', files: images }
      : video,
    audio,
  }), [audio, description, draftId, images, name, video, visualMode])

  const validation = useMemo(() => validateKlingElementDraft(draft), [draft])
  const normalizedName = cleanName(name).toLocaleLowerCase()
  const originalName = cleanName(element?.name ?? '').toLocaleLowerCase()
  const duplicateName = !!normalizedName && existingNames.some((candidate) => {
    const normalizedCandidate = cleanName(candidate).toLocaleLowerCase()
    return normalizedCandidate === normalizedName && normalizedCandidate !== originalName
  })
  const atElementLimit = !element && existingCount >= KLING_ELEMENT_MAX
  const validationMessage = atElementLimit
    ? `Kling supports at most ${KLING_ELEMENT_MAX} shared elements.`
    : duplicateName
      ? 'Use a unique element name so shots remain unambiguous.'
      : validation.issues[0]?.message ?? ''
  const nameIssue = attempted && (!cleanName(name) || duplicateName)
  const descriptionIssue = attempted && !cleanName(description)
  const mediaIssue = attempted && validation.issues.some((issue) => issue.field === 'media')
  const audioIssue = attempted && validation.issues.some((issue) => issue.field === 'audio')

  const addImages = async (files: readonly File[]) => {
    const remaining = KLING_ELEMENT_IMAGE_MAX - images.length
    if (remaining <= 0) {
      toast(`Kling accepts up to ${KLING_ELEMENT_IMAGE_MAX} images in one element.`)
      return
    }
    setSourceBusy('images')
    try {
      const candidates = files.filter((file) => {
        if (isImageFile(file)) return true
        toast(`${file.name || 'Image'} must be JPG or PNG and no larger than 10 MB.`)
        return false
      })
      const probed = await Promise.all(candidates.map(async (file) => {
        const dimensions = await probeImageDimensions(file)
        if (!dimensions) {
          toast(`${file.name || 'Image'} could not be decoded. Choose a readable JPG or PNG.`)
          return null
        }
        if (!allowedImageDimensions(dimensions.width, dimensions.height)) {
          toast(`${file.name || 'Image'} must be at least 300×300 px with an aspect ratio from 1:2.5 to 2.5:1.`)
          return null
        }
        return withImageDimensions(file, dimensions.width, dimensions.height)
      }))
      const valid = probed.filter((file): file is File & KlingElementFileLike => file !== null)
      const accepted = valid.slice(0, remaining)
      accepted.forEach(ensurePreview)
      setImages((current) => [...current, ...accepted])
      setVisualMode('images')
      setAttempted(false)
      setSaveError('')
      if (valid.length > accepted.length) toast(`Only ${accepted.length} added · this element allows ${KLING_ELEMENT_IMAGE_MAX} images.`)
    } finally {
      setSourceBusy(null)
    }
  }

  const setVideoFile = async (file: File) => {
    if (!isVideoFile(file)) {
      toast(`${file.name || 'Video'} must be an MP4 or MOV file.`)
      return
    }
    setSourceBusy('video')
    try {
      const durationMs = await probeDuration(file, 'video')
      if (video?.file) forgetPreview(video.file)
      ensurePreview(file)
      setVideo(emptyVideo(file, durationMs))
      setVisualMode('video')
      setAttempted(false)
      setSaveError('')
      if (!durationMs) toast('Video duration could not be detected · enter it before saving.')
    } finally {
      setSourceBusy(null)
    }
  }

  const setAudioFile = async (file: File) => {
    setSourceBusy('audio')
    try {
      const durationMs = await probeDuration(file, 'audio')
      if (audio?.file) forgetPreview(audio.file)
      ensurePreview(file)
      setAudio({ file, durationMs })
      setAttempted(false)
      setSaveError('')
      if (!durationMs) toast('Audio duration could not be detected · enter it before saving.')
    } finally {
      setSourceBusy(null)
    }
  }

  const addFromLibrary = async (kind: 'image' | 'video' | 'audio', creations: Creation[]) => {
    setSourceBusy(kind === 'image' ? 'images' : kind)
    try {
      const files = await Promise.all(creations.map(copyLibraryCreationForWorkspace))
      if (kind === 'image') await addImages(files)
      else if (kind === 'video' && files[0]) await setVideoFile(files[0])
      else if (files[0]) await setAudioFile(files[0])
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Library media could not be copied.'
      toast(message)
    } finally {
      setSourceBusy(null)
    }
  }

  const grabImage = async () => {
    if (images.length >= KLING_ELEMENT_IMAGE_MAX) return
    setSourceBusy('images')
    try {
      const grab = await resolve.grabFrame()
      const file = await fileFromGrab(grab, 'Timeline frame', 'png', 'image/png')
      await addImages([file])
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Timeline frame capture failed.')
    } finally {
      setSourceBusy(null)
    }
  }

  const grabVideo = async () => {
    setSourceBusy('video')
    try {
      const grab = await resolve.grabClip()
      const file = await fileFromGrab(grab, 'Timeline clip', 'mp4', 'video/mp4')
      await setVideoFile(file)
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Timeline clip capture failed.')
    } finally {
      setSourceBusy(null)
    }
  }

  const grabAudio = async () => {
    setSourceBusy('audio')
    try {
      const grab = await resolve.grabAudio()
      const file = await fileFromGrab(grab, 'Timeline audio', 'wav', 'audio/wav')
      await setAudioFile(file)
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Timeline audio capture failed.')
    } finally {
      setSourceBusy(null)
    }
  }

  const removeImage = (file: KlingElementFileLike) => {
    forgetPreview(file)
    setImages((current) => current.filter((candidate) => candidate !== file))
  }

  const removeVideo = () => {
    if (video?.file) forgetPreview(video.file)
    setVideo(null)
  }

  const removeAudio = () => {
    if (audio?.file) forgetPreview(audio.file)
    setAudio(null)
  }

  const setVideoDuration = (seconds: number) => {
    if (!video) return
    const durationMs = Math.max(0, Math.round(seconds * 1_000))
    const startTimeMs = Math.min(video.startTimeMs, Math.max(0, durationMs - KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS))
    const endTimeMs = durationMs > 0
      ? Math.min(durationMs, Math.max(startTimeMs + KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS, Math.min(video.endTimeMs || durationMs, startTimeMs + KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS)))
      : 0
    setVideo({ ...video, durationMs, startTimeMs, endTimeMs })
  }

  const setVideoStart = (startTimeMs: number) => {
    if (!video) return
    const maxStart = Math.max(0, video.durationMs - KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS)
    const nextStart = Math.min(maxStart, Math.max(0, Math.round(startTimeMs)))
    const nextEnd = Math.min(
      video.durationMs,
      Math.max(nextStart + KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS, Math.min(video.endTimeMs, nextStart + KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS)),
    )
    setVideo({ ...video, startTimeMs: nextStart, endTimeMs: nextEnd })
  }

  const setVideoEnd = (endTimeMs: number) => {
    if (!video) return
    const minimum = video.startTimeMs + KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS
    const maximum = Math.min(video.durationMs, video.startTimeMs + KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS)
    setVideo({ ...video, endTimeMs: Math.min(maximum, Math.max(minimum, Math.round(endTimeMs))) })
  }

  const close = () => {
    if (!busy && !sourceBusy) onCancelRef.current()
  }

  const save = async () => {
    setAttempted(true)
    setSaveError('')
    if (validationMessage) {
      setSaveError(validationMessage)
      return
    }
    setBusy(true)
    try {
      await onSave({ ...draft, name: cleanName(name), description: cleanName(description) })
      setBusy(false)
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'The element could not be saved.')
      setBusy(false)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (lightbox) setLightbox(null)
      else close()
      return
    }
    if (event.key !== 'Tab' || lightbox || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((node) => node.getAttribute('aria-hidden') !== 'true')
    if (!focusable.length) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const handleImages = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length) void addImages(files)
  }

  const handleVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void setVideoFile(file)
  }

  const handleAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void setAudioFile(file)
  }

  if (!open || typeof document === 'undefined') return null

  const videoPreview = video ? previewUrls.get(video.file) : undefined
  const audioPreview = audio ? previewUrls.get(audio.file) : undefined
  const needsVideoTrim = !!video && video.durationMs > KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS
  const newElementNumber = Math.min(KLING_ELEMENT_MAX, existingCount + (element ? 0 : 1))

  return createPortal(
    <div
      className="ef-kling-element-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={dialogRef}
        className="ef-kling-element-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId}${saveError ? ` ${errorId}` : ''}`}
        aria-busy={busy || !!sourceBusy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="ef-kling-element-header">
          <span className="ef-kling-element-mark" aria-hidden="true"><Icon glyph="avatar" size={17} /></span>
          <div>
            <span>KLING 3 · ELEMENT {String(newElementNumber).padStart(2, '0')}</span>
            <h2 id={titleId}>{element ? 'Edit Element' : 'Create Element'}</h2>
            <p id={descriptionId}>Define the subject once, then reuse it in Standard clips or select it per shot.</p>
          </div>
          <button type="button" className="ef-kling-element-close" disabled={busy || !!sourceBusy} onClick={close} aria-label="Close element editor">×</button>
        </header>

        <div className="ef-kling-element-scroll ef-scroll">
          <section className="ef-kling-element-copy" aria-label="Element identity">
            <label>
              <span>Name <b aria-hidden="true">*</b></span>
              <input
                ref={nameRef}
                value={name}
                maxLength={120}
                aria-invalid={nameIssue}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaveError('')
                }}
                placeholder="Enter element name"
                autoComplete="off"
              />
              {nameIssue && <small>{duplicateName ? 'Choose a unique name.' : 'Name is required.'}</small>}
            </label>
            <label>
              <span>Description <b aria-hidden="true">*</b></span>
              <textarea
                value={description}
                maxLength={500}
                aria-invalid={descriptionIssue}
                onChange={(event) => {
                  setDescription(event.target.value)
                  setSaveError('')
                }}
                placeholder="Describe identity, appearance, wardrobe and details that must remain consistent"
              />
              {descriptionIssue && <small>Description is required.</small>}
            </label>
          </section>

          <section className={`ef-kling-element-source${mediaIssue ? ' has-error' : ''}`} aria-label="Character media">
            <div className="ef-kling-element-section-head">
              <div>
                <h3>Character media <b aria-hidden="true">*</b></h3>
                <p>Choose 2–4 qualified images or exactly one video as the visual reference.</p>
              </div>
              <div className="ef-kling-element-modes" role="radiogroup" aria-label="Character media type">
                <button type="button" role="radio" aria-checked={visualMode === 'images'} className={visualMode === 'images' ? 'is-selected' : ''} onClick={() => setVisualMode('images')}>Images</button>
                <button type="button" role="radio" aria-checked={visualMode === 'video'} className={visualMode === 'video' ? 'is-selected' : ''} onClick={() => setVisualMode('video')}>Video</button>
              </div>
            </div>

            {visualMode === 'images' ? (
              <>
                <div className="ef-kling-element-source-actions">
                  <button type="button" disabled={images.length >= KLING_ELEMENT_IMAGE_MAX || !!sourceBusy} onClick={() => imageInputRef.current?.click()}><Icon glyph="up" size={13} /> Upload</button>
                  <LibraryPickerButton
                    kinds={['image']}
                    max={KLING_ELEMENT_IMAGE_MAX - images.length}
                    disabled={!!sourceBusy}
                    onSelect={(creations) => addFromLibrary('image', creations)}
                    className="ef-kling-element-source-button"
                    ariaLabel="Choose character images from Library"
                    pickerTitle="Choose character images"
                    confirmLabel="Add images"
                  />
                  <button type="button" disabled={images.length >= KLING_ELEMENT_IMAGE_MAX || !!sourceBusy} onClick={() => void grabImage()}><Icon glyph="playhead" size={13} /> Grab frame</button>
                  <span>{images.length} / {KLING_ELEMENT_IMAGE_MAX}</span>
                </div>
                {images.length ? (
                  <div className="ef-kling-element-image-grid">
                    {images.map((file, index) => {
                      const preview = previewUrls.get(file)
                      return (
                        <article key={mediaKey(file, index)}>
                          {preview ? (
                            <button type="button" className="ef-kling-element-thumb" onClick={() => setLightbox({ url: preview.url, kind: 'image' })} aria-label={`Preview ${file.name}`}>
                              <img src={preview.url} alt="" />
                            </button>
                          ) : (
                            <span className="ef-kling-element-thumb is-placeholder"><Icon glyph="img" size={20} /></span>
                          )}
                          <div><strong title={file.name}>{file.name}</strong><small>{file.width && file.height ? `${file.width}×${file.height} · ` : ''}{(fileSize(file) / 1_048_576).toFixed(1)} MB</small></div>
                          <button type="button" className="ef-kling-element-remove" onClick={() => removeImage(file)} aria-label={`Remove ${file.name}`}>×</button>
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <button type="button" className="ef-kling-element-dropzone" onClick={() => imageInputRef.current?.click()}>
                    <span><Icon glyph="up" size={20} /></span>
                    <strong>Upload character images</strong>
                    <small>JPG/PNG · 2–4 files · ≤10 MB each · ≥300×300 px · ratio 1:2.5–2.5:1</small>
                  </button>
                )}
                <input ref={imageInputRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={handleImages} />
              </>
            ) : (
              <>
                <div className="ef-kling-element-source-actions">
                  <button type="button" disabled={!!sourceBusy} onClick={() => videoInputRef.current?.click()}><Icon glyph="up" size={13} /> Upload</button>
                  <LibraryPickerButton
                    kinds={['video']}
                    max={1}
                    disabled={!!sourceBusy}
                    onSelect={(creations) => addFromLibrary('video', creations)}
                    className="ef-kling-element-source-button"
                    ariaLabel="Choose character video from Library"
                    pickerTitle="Choose a character video"
                    confirmLabel="Use video"
                  />
                  <button type="button" disabled={!!sourceBusy} onClick={() => void grabVideo()}><Icon glyph="playhead" size={13} /> Grab clip</button>
                  <span>{video ? '1 / 1' : '0 / 1'}</span>
                </div>
                {video ? (
                  <article className="ef-kling-element-media-card">
                    {videoPreview ? (
                      <button type="button" className="ef-kling-element-media-preview" onClick={() => setLightbox({ url: videoPreview.url, kind: 'video' })} aria-label={`Preview ${video.file.name}`}>
                        <video src={videoPreview.url} muted playsInline preload="metadata" />
                        <span aria-hidden="true">▶</span>
                      </button>
                    ) : (
                      <span className="ef-kling-element-media-preview is-placeholder"><Icon glyph="vid" size={24} /></span>
                    )}
                    <div className="ef-kling-element-media-copy">
                      <strong title={video.file.name}>{video.file.name}</strong>
                      <small>{formatDuration(video.durationMs)} · MP4/MOV</small>
                    </div>
                    <button type="button" className="ef-kling-element-remove" onClick={removeVideo} aria-label={`Remove ${video.file.name}`}>×</button>
                  </article>
                ) : (
                  <button type="button" className="ef-kling-element-dropzone" onClick={() => videoInputRef.current?.click()}>
                    <span><Icon glyph="film" size={20} /></span>
                    <strong>Upload character video</strong>
                    <small>MP4/MOV · exactly 1 file · source ≥3s · effective segment 3–8s</small>
                  </button>
                )}
                <input ref={videoInputRef} type="file" accept={VIDEO_ACCEPT} hidden onChange={handleVideo} />

                {video && video.durationMs <= 0 && (
                  <label className="ef-kling-element-duration-fallback">
                    <span>Source duration</span>
                    <div><input type="number" min="3" step="0.1" value="" placeholder="Seconds" onChange={(event) => setVideoDuration(Number(event.target.value))} /><small>Required when metadata cannot be read</small></div>
                  </label>
                )}

                {video && needsVideoTrim && (
                  <div className="ef-kling-element-trim" role="group" aria-label="Effective video segment">
                    <div><span>EFFECTIVE SEGMENT</span><strong>{formatSeconds(video.startTimeMs)} – {formatSeconds(video.endTimeMs)} · {formatSeconds(video.endTimeMs - video.startTimeMs)}</strong></div>
                    <label>
                      <span>Start</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, video.durationMs - KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS)}
                        step={100}
                        value={video.startTimeMs}
                        onChange={(event) => setVideoStart(Number(event.target.value))}
                        aria-label="Effective segment start"
                      />
                      <output>{formatSeconds(video.startTimeMs)}</output>
                    </label>
                    <label>
                      <span>End</span>
                      <input
                        type="range"
                        min={video.startTimeMs + KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS}
                        max={Math.min(video.durationMs, video.startTimeMs + KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS)}
                        step={100}
                        value={video.endTimeMs}
                        onChange={(event) => setVideoEnd(Number(event.target.value))}
                        aria-label="Effective segment end"
                      />
                      <output>{formatSeconds(video.endTimeMs)}</output>
                    </label>
                    <small>Kling uses a 3–8 second section from longer reference videos.</small>
                  </div>
                )}
              </>
            )}
            {mediaIssue && <p className="ef-kling-element-inline-error">{validation.issues.find((issue) => issue.field === 'media')?.message}</p>}
          </section>

          <section className={`ef-kling-element-source is-audio${audioIssue ? ' has-error' : ''}`} aria-label="Voice or sound reference">
            <div className="ef-kling-element-section-head">
              <div>
                <h3>Voice or sound reference <small>optional</small></h3>
                <p>Add audio to guide the element voice, tone or sound.</p>
              </div>
            </div>
            <div className="ef-kling-element-source-actions">
              <button type="button" disabled={!!sourceBusy} onClick={() => audioInputRef.current?.click()}><Icon glyph="up" size={13} /> Upload</button>
              <LibraryPickerButton
                kinds={['audio']}
                max={1}
                disabled={!!sourceBusy}
                onSelect={(creations) => addFromLibrary('audio', creations)}
                className="ef-kling-element-source-button"
                ariaLabel="Choose voice or sound from Library"
                pickerTitle="Choose voice or sound"
                confirmLabel="Use audio"
              />
              <button type="button" disabled={!!sourceBusy} onClick={() => void grabAudio()}><Icon glyph="playhead" size={13} /> Grab audio</button>
              <span>{audio ? '1 / 1' : '0 / 1'}</span>
            </div>
            {audio ? (
              <article className="ef-kling-element-media-card is-audio">
                <span className="ef-kling-element-media-preview"><Icon glyph="music" size={22} /></span>
                <div className="ef-kling-element-media-copy">
                  <strong title={audio.file.name}>{audio.file.name}</strong>
                  <small>{formatDuration(audio.durationMs)} · required range 5–30s</small>
                  {audioPreview && <audio src={audioPreview.url} controls preload="metadata" aria-label={`Preview ${audio.file.name}`} />}
                  {audio.durationMs <= 0 && (
                    <label className="ef-kling-element-inline-duration">
                      <span>Duration</span>
                      <input
                        type="number"
                        min={KLING_ELEMENT_AUDIO_MIN_DURATION_MS / 1_000}
                        max={KLING_ELEMENT_AUDIO_MAX_DURATION_MS / 1_000}
                        step="0.1"
                        placeholder="Seconds"
                        onChange={(event) => setAudio({ ...audio, durationMs: Math.max(0, Math.round(Number(event.target.value) * 1_000)) })}
                      />
                    </label>
                  )}
                </div>
                <button type="button" className="ef-kling-element-remove" onClick={removeAudio} aria-label={`Remove ${audio.file.name}`}>×</button>
              </article>
            ) : (
              <button type="button" className="ef-kling-element-dropzone is-audio" onClick={() => audioInputRef.current?.click()}>
                <span><Icon glyph="music" size={20} /></span>
                <strong>Upload audio reference</strong>
                <small>Optional · exactly 1 audio file · 5–30 seconds</small>
              </button>
            )}
            <input ref={audioInputRef} type="file" accept={AUDIO_ACCEPT} hidden onChange={handleAudio} />
            {audioIssue && <p className="ef-kling-element-inline-error">{validation.issues.find((issue) => issue.field === 'audio')?.message}</p>}
          </section>
        </div>

        <footer className="ef-kling-element-actions">
          <div>
            <span>{newElementNumber} / {KLING_ELEMENT_MAX} Elements</span>
            {saveError && <p id={errorId} role="alert">{saveError}</p>}
          </div>
          <button type="button" className="is-secondary" disabled={busy || !!sourceBusy} onClick={close}>Cancel</button>
          <button type="button" className="is-primary" disabled={busy || !!sourceBusy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save Element'}</button>
        </footer>
      </div>
      {lightbox && <Lightbox url={lightbox.url} kind={lightbox.kind} onClose={() => setLightbox(null)} />}
    </div>,
    document.body,
  )
}
