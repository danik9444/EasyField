/**
 * Pure Kling 3 element contracts.
 *
 * The renderer can keep browser `File` objects (or Library/Resolve equivalents)
 * outside this module. Only the structural metadata needed for provider-safe
 * validation lives here, which also keeps the contract testable in Node where
 * `File` is not guaranteed to exist.
 */

export const KLING_ELEMENT_MAX = 3
export const KLING_ELEMENT_IMAGE_MIN = 2
export const KLING_ELEMENT_IMAGE_MAX = 4
export const KLING_ELEMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const KLING_ELEMENT_IMAGE_MIN_WIDTH = 300
export const KLING_ELEMENT_IMAGE_MIN_HEIGHT = 300
export const KLING_ELEMENT_IMAGE_MIN_ASPECT_RATIO = 1 / 2.5
export const KLING_ELEMENT_IMAGE_MAX_ASPECT_RATIO = 2.5
export const KLING_ELEMENT_VIDEO_MIN_DURATION_MS = 3_000
export const KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS = 3_000
export const KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS = 8_000
export const KLING_ELEMENT_AUDIO_MIN_DURATION_MS = 5_000
export const KLING_ELEMENT_AUDIO_MAX_DURATION_MS = 30_000

export const KLING_ELEMENT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
export const KLING_ELEMENT_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const
export const KLING_ELEMENT_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const
export const KLING_ELEMENT_VIDEO_EXTENSIONS = ['mp4', 'mov'] as const

export interface KlingElementFileLike {
  /** Stable local identity; optional because browser File does not provide it. */
  id?: string
  name: string
  /** Browser File/Blob metadata. */
  type?: string
  size?: number
  /** Persistable aliases used by ReferenceImage/MediaFile drafts. */
  mimeType?: string
  byteSize?: number
  /** Decoded image dimensions used by Kling's provider-specific preflight. */
  width?: number
  height?: number
  /** Object/data/hosted URL used by Library and Resolve-backed drafts. */
  url?: string
}

export interface KlingElementImageMediaDraft {
  kind: 'images'
  files: readonly KlingElementFileLike[]
}

export interface KlingElementVideoMediaDraft {
  kind: 'video'
  file: KlingElementFileLike
  /** Duration of the uploaded source, not only the selected segment. */
  durationMs: number
  /** Inclusive provider trim start in source-video milliseconds. */
  startTimeMs: number
  /** Exclusive provider trim end in source-video milliseconds. */
  endTimeMs: number
}

export type KlingElementMediaDraft = KlingElementImageMediaDraft | KlingElementVideoMediaDraft

export interface KlingElementAudioDraft {
  file: KlingElementFileLike
  durationMs: number
}

/** One shared element can be invoked by any number of multi-shot prompts. */
export interface KlingElementDraft {
  /** Immutable local identity used to derive a stable provider tag. */
  id: string
  name: string
  description: string
  media: KlingElementMediaDraft | null
  audio?: KlingElementAudioDraft | null
}

/** Uploaded URLs and trim metadata ready to cross the provider boundary. */
export interface KlingHostedElement {
  id: string
  name: string
  description: string
  providerName: string
  mediaKind: KlingElementMediaDraft['kind']
  inputUrls: readonly string[]
  audioUrl?: string
  startTimeMs?: number
  endTimeMs?: number
}

/** Exact `kling_elements` item shape accepted by the cloud endpoint. */
export interface KlingProviderElement {
  name: string
  description: string
  element_input_urls: string[]
  element_input_audio_urls?: string[]
  start_time?: number
  end_time?: number
}

export type KlingElementIssueCode =
  | 'missing-id'
  | 'missing-name'
  | 'missing-description'
  | 'missing-media'
  | 'image-count'
  | 'image-type'
  | 'image-size'
  | 'image-dimensions'
  | 'image-aspect-ratio'
  | 'video-type'
  | 'video-duration'
  | 'video-trim'
  | 'video-segment-duration'
  | 'audio-duration'
  | 'too-many-elements'
  | 'duplicate-provider-tag'

export interface KlingElementValidationIssue {
  code: KlingElementIssueCode
  message: string
  elementId?: string
  field?: 'id' | 'name' | 'description' | 'media' | 'audio' | 'elements'
  fileIndex?: number
}

export interface KlingElementValidationResult {
  valid: boolean
  issues: KlingElementValidationIssue[]
}

export interface KlingElementReferenceOption {
  elementId: string
  tag: string
  label: string
  description: string
  mediaKind: KlingElementMediaDraft['kind'] | 'missing'
}

const PROVIDER_NAME_MAX = 63
const PROVIDER_NAME_PATTERN = /^element_[a-z0-9_]+$/

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

function extension(name: string): string {
  const match = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] ?? ''
}

function normalizedMime(type: string): string {
  return type.trim().toLowerCase().split(';', 1)[0]
}

function fileMime(file: KlingElementFileLike): string {
  return file.mimeType ?? file.type ?? ''
}

function fileSize(file: KlingElementFileLike): number | undefined {
  return file.byteSize ?? file.size
}

function matchesDocumentedType(
  file: KlingElementFileLike,
  mimeTypes: readonly string[],
  extensions: readonly string[],
): boolean {
  const mime = normalizedMime(fileMime(file))
  const ext = extension(file.name)
  const mimeMatches = mime ? mimeTypes.includes(mime) : false
  const extensionMatches = ext ? extensions.includes(ext) : false

  // Some browser/Resolve blobs have no MIME or no filename extension. Accept a
  // single trustworthy signal, but reject contradictory metadata when both are
  // present so a renamed executable cannot pass as provider media.
  if (mime && ext) return mimeMatches && extensionMatches
  return mimeMatches || extensionMatches
}

function finiteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value)
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

function providerSlug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Derives a provider-safe name from immutable local identity, never mutable UI
 * copy. The short hash prevents two IDs that slugify alike from sharing a tag.
 */
export function klingElementProviderName(stableId: string): string {
  const identity = clean(stableId)
  const slug = providerSlug(identity) || 'reference'
  const suffix = stableHash(identity)
  const prefixBudget = PROVIDER_NAME_MAX - 'element__'.length - suffix.length
  return `element_${slug.slice(0, Math.max(1, prefixBudget))}_${suffix}`
}

export function klingElementProviderTag(stableId: string): string {
  return `@${klingElementProviderName(stableId)}`
}

export function isKlingElementProviderName(value: string): boolean {
  return value.length <= PROVIDER_NAME_MAX && PROVIDER_NAME_PATTERN.test(value)
}

function issue(
  code: KlingElementIssueCode,
  message: string,
  element: KlingElementDraft,
  field: KlingElementValidationIssue['field'],
  fileIndex?: number,
): KlingElementValidationIssue {
  return { code, message, elementId: element.id, field, ...(fileIndex === undefined ? {} : { fileIndex }) }
}

export function validateKlingElementDraft(element: KlingElementDraft): KlingElementValidationResult {
  const issues: KlingElementValidationIssue[] = []
  if (!clean(element.id)) issues.push(issue('missing-id', 'Element identity is missing.', element, 'id'))
  if (!clean(element.name)) issues.push(issue('missing-name', 'Element name is required.', element, 'name'))
  if (!clean(element.description)) issues.push(issue('missing-description', 'Element description is required.', element, 'description'))

  if (!element.media) {
    issues.push(issue('missing-media', 'Add 2–4 JPG/PNG images or one MP4/MOV video.', element, 'media'))
  } else if (element.media.kind === 'images') {
    if (element.media.files.length < KLING_ELEMENT_IMAGE_MIN || element.media.files.length > KLING_ELEMENT_IMAGE_MAX) {
      issues.push(issue('image-count', `Image elements require ${KLING_ELEMENT_IMAGE_MIN}–${KLING_ELEMENT_IMAGE_MAX} images.`, element, 'media'))
    }
    element.media.files.forEach((file, fileIndex) => {
      if (!matchesDocumentedType(file, KLING_ELEMENT_IMAGE_MIME_TYPES, KLING_ELEMENT_IMAGE_EXTENSIONS)) {
        issues.push(issue('image-type', `${file.name || `Image ${fileIndex + 1}`} must be JPG or PNG.`, element, 'media', fileIndex))
      }
      const size = fileSize(file)
      if (size === undefined || !Number.isFinite(size) || size < 0 || size > KLING_ELEMENT_IMAGE_MAX_BYTES) {
        issues.push(issue('image-size', `${file.name || `Image ${fileIndex + 1}`} must not exceed 10 MB.`, element, 'media', fileIndex))
      }
      const width = file.width ?? Number.NaN
      const height = file.height ?? Number.NaN
      const hasDimensions = finiteInteger(width) && finiteInteger(height)
      if (!hasDimensions) {
        issues.push(issue(
          'image-dimensions',
          `${file.name || `Image ${fileIndex + 1}`} dimensions could not be verified. Re-add the image to inspect it before generation.`,
          element,
          'media',
          fileIndex,
        ))
      } else if (width < KLING_ELEMENT_IMAGE_MIN_WIDTH || height < KLING_ELEMENT_IMAGE_MIN_HEIGHT) {
        issues.push(issue(
          'image-dimensions',
          `${file.name || `Image ${fileIndex + 1}`} must be at least ${KLING_ELEMENT_IMAGE_MIN_WIDTH}×${KLING_ELEMENT_IMAGE_MIN_HEIGHT} pixels.`,
          element,
          'media',
          fileIndex,
        ))
      } else {
        const aspectRatio = width / height
        if (aspectRatio < KLING_ELEMENT_IMAGE_MIN_ASPECT_RATIO || aspectRatio > KLING_ELEMENT_IMAGE_MAX_ASPECT_RATIO) {
          issues.push(issue(
            'image-aspect-ratio',
            `${file.name || `Image ${fileIndex + 1}`} aspect ratio must be between 1:2.5 and 2.5:1.`,
            element,
            'media',
            fileIndex,
          ))
        }
      }
    })
  } else {
    const { file, durationMs, startTimeMs, endTimeMs } = element.media
    if (!matchesDocumentedType(file, KLING_ELEMENT_VIDEO_MIME_TYPES, KLING_ELEMENT_VIDEO_EXTENSIONS)) {
      issues.push(issue('video-type', `${file.name || 'Video'} must be MP4 or MOV.`, element, 'media'))
    }
    if (!finiteInteger(durationMs) || durationMs < KLING_ELEMENT_VIDEO_MIN_DURATION_MS) {
      issues.push(issue('video-duration', 'Reference video duration must be at least 3 seconds.', element, 'media'))
    }
    const validTrim = finiteInteger(startTimeMs)
      && finiteInteger(endTimeMs)
      && startTimeMs >= 0
      && endTimeMs > startTimeMs
      && finiteInteger(durationMs)
      && endTimeMs <= durationMs
    if (!validTrim) {
      issues.push(issue('video-trim', 'Video start/end must be whole milliseconds inside the source duration.', element, 'media'))
    } else {
      const segmentDuration = endTimeMs - startTimeMs
      if (segmentDuration < KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS || segmentDuration > KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS) {
        issues.push(issue('video-segment-duration', 'The effective video segment must be 3–8 seconds.', element, 'media'))
      }
    }
  }

  if (element.audio) {
    const duration = element.audio.durationMs
    if (!finiteInteger(duration) || duration < KLING_ELEMENT_AUDIO_MIN_DURATION_MS || duration > KLING_ELEMENT_AUDIO_MAX_DURATION_MS) {
      issues.push(issue('audio-duration', 'Audio reference duration must be 5–30 seconds.', element, 'audio'))
    }
  }

  return { valid: issues.length === 0, issues }
}

export function validateKlingElementDrafts(elements: readonly KlingElementDraft[]): KlingElementValidationResult {
  const issues = elements.flatMap((element) => validateKlingElementDraft(element).issues)
  if (elements.length > KLING_ELEMENT_MAX) {
    issues.push({
      code: 'too-many-elements',
      message: `Kling supports at most ${KLING_ELEMENT_MAX} shared elements per generation.`,
      field: 'elements',
    })
  }

  const ownerByTag = new Map<string, string>()
  elements.forEach((element) => {
    const tag = klingElementProviderTag(element.id)
    const owner = ownerByTag.get(tag)
    if (owner !== undefined) {
      issues.push({
        code: 'duplicate-provider-tag',
        message: `Element tag ${tag} must be unique.`,
        elementId: element.id,
        field: 'id',
      })
    } else {
      ownerByTag.set(tag, element.id)
    }
  })

  return { valid: issues.length === 0, issues }
}

export function klingElementReferenceOptions(elements: readonly KlingElementDraft[]): KlingElementReferenceOption[] {
  return elements.map((element) => ({
    elementId: element.id,
    tag: klingElementProviderTag(element.id),
    label: clean(element.name) || 'Unnamed element',
    description: clean(element.description),
    mediaKind: element.media?.kind ?? 'missing',
  }))
}

/** Human-readable, URL-free context suitable for prompt enhancement and logs. */
export function klingElementReferenceManifest(elements: readonly KlingElementDraft[]): string[] {
  return elements.map((element) => {
    const tag = klingElementProviderTag(element.id)
    const media = !element.media
      ? 'media missing'
      : element.media.kind === 'images'
        ? `${element.media.files.length} image${element.media.files.length === 1 ? '' : 's'}`
        : `video ${(element.media.startTimeMs / 1_000).toFixed(1)}–${(element.media.endTimeMs / 1_000).toFixed(1)}s`
    const audio = element.audio ? ` · audio ${(element.audio.durationMs / 1_000).toFixed(1)}s` : ''
    return `${tag} · ${clean(element.name) || 'Unnamed element'} · ${clean(element.description) || 'No description'} · ${media}${audio}`
  })
}

/**
 * Removes deleted element tags from scenes without mutating either input.
 * `undefined` remains undefined because existing multi-shot semantics use it to
 * mean “all currently available elements”. An explicit empty array means none.
 */
export function stripOrphanKlingSceneReferenceTags<T extends { referenceTags?: string[] }>(
  scenes: readonly T[],
  elements: readonly KlingElementDraft[],
): T[] {
  const available = new Set(elements.map((element) => klingElementProviderTag(element.id)))
  return scenes.map((scene) => {
    if (scene.referenceTags === undefined) return { ...scene }
    const referenceTags = Array.from(new Set(scene.referenceTags.filter((tag) => available.has(tag))))
    return { ...scene, referenceTags }
  })
}

export function toKlingProviderElement(hosted: KlingHostedElement): KlingProviderElement {
  const providerName = clean(hosted.providerName)
  if (!isKlingElementProviderName(providerName)) {
    throw new Error(`Invalid Kling provider element name: ${hosted.providerName}`)
  }
  if (!clean(hosted.name)) throw new Error('Kling hosted elements require a display name.')
  if (providerName !== klingElementProviderName(hosted.id)) {
    throw new Error('Kling provider element name does not match its stable element identity.')
  }
  const description = clean(hosted.description)
  if (!description) throw new Error('Kling provider elements require a description.')
  if (hosted.inputUrls.some((url) => !clean(url))) throw new Error('Kling provider element media URLs cannot be empty.')
  if (hosted.mediaKind === 'images') {
    if (hosted.inputUrls.length < KLING_ELEMENT_IMAGE_MIN || hosted.inputUrls.length > KLING_ELEMENT_IMAGE_MAX) {
      throw new Error(`Kling image elements require ${KLING_ELEMENT_IMAGE_MIN}–${KLING_ELEMENT_IMAGE_MAX} hosted images.`)
    }
  } else {
    if (hosted.inputUrls.length !== 1) throw new Error('Kling video elements require exactly one hosted video.')
    const { startTimeMs, endTimeMs } = hosted
    if (!finiteInteger(startTimeMs ?? Number.NaN)
      || !finiteInteger(endTimeMs ?? Number.NaN)
      || (startTimeMs ?? -1) < 0
      || (endTimeMs ?? 0) <= (startTimeMs ?? -1)) {
      throw new Error('Kling video elements require ordered whole-millisecond start/end trim values.')
    }
    const segmentDuration = (endTimeMs ?? 0) - (startTimeMs ?? 0)
    if (segmentDuration < KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS || segmentDuration > KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS) {
      throw new Error('Kling video element effective duration must be 3–8 seconds.')
    }
  }
  const element: KlingProviderElement = {
    name: providerName,
    description,
    element_input_urls: [...hosted.inputUrls],
  }
  if (hosted.audioUrl) element.element_input_audio_urls = [hosted.audioUrl]
  if (hosted.mediaKind === 'video') {
    if (hosted.startTimeMs !== undefined) element.start_time = hosted.startTimeMs
    if (hosted.endTimeMs !== undefined) element.end_time = hosted.endTimeMs
  }
  return element
}
