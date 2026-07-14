/**
 * Pure preflight contracts for the Kling 3 Motion Control endpoint.
 *
 * Browser Files, Library artifacts, hosted URLs and Resolve grabs can all be
 * represented structurally. Metadata is deliberately optional: known invalid
 * values are blocking, while unavailable values are returned as deferred
 * checks for a paid preflight to probe when the source is readable.
 */

export const KLING_MOTION_PROMPT_MAX = 2500
export const KLING_MOTION_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const KLING_MOTION_VIDEO_MAX_BYTES = 100 * 1024 * 1024
export const KLING_MOTION_MIN_DIMENSION_EXCLUSIVE_PX = 340
export const KLING_MOTION_MIN_ASPECT_RATIO = 2 / 5
export const KLING_MOTION_MAX_ASPECT_RATIO = 5 / 2
export const KLING_MOTION_VIDEO_MIN_DURATION_MS = 3_000
export const KLING_MOTION_VIDEO_MAX_DURATION_MS = 30_000
export const KLING_MOTION_IMAGE_ORIENTATION_MAX_DURATION_MS = 10_000

export const KLING_MOTION_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
export const KLING_MOTION_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const
export const KLING_MOTION_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const
export const KLING_MOTION_VIDEO_EXTENSIONS = ['mp4', 'mov'] as const

export type KlingMotionOrientation = 'image' | 'video'

export interface KlingMotionFileLike {
  id?: string
  name?: string
  url?: string
  /** Browser File/Blob aliases. */
  type?: string
  size?: number
  /** Persistable Library/Resolve aliases. */
  mimeType?: string
  byteSize?: number
  /** Probed pixel dimensions when the source is locally readable. */
  width?: number
  height?: number
  /** Either duration representation may be supplied by an existing caller. */
  durationMs?: number
  durationSeconds?: number
}

export interface KlingMotionDraft {
  prompt: string
  images: readonly KlingMotionFileLike[]
  videos: readonly KlingMotionFileLike[]
  orientation: KlingMotionOrientation | string
}

export type KlingMotionIssueCode =
  | 'prompt-too-long'
  | 'invalid-orientation'
  | 'image-count'
  | 'video-count'
  | 'image-type'
  | 'image-size'
  | 'image-dimensions'
  | 'image-aspect-ratio'
  | 'video-type'
  | 'video-size'
  | 'video-dimensions'
  | 'video-aspect-ratio'
  | 'video-duration'
  | 'image-orientation-video-duration'

export type KlingMotionDeferredCode =
  | 'image-type-unknown'
  | 'image-size-unknown'
  | 'image-dimensions-unknown'
  | 'video-type-unknown'
  | 'video-size-unknown'
  | 'video-dimensions-unknown'
  | 'video-duration-unknown'

export interface KlingMotionValidationIssue {
  code: KlingMotionIssueCode
  message: string
  field: 'prompt' | 'orientation' | 'images' | 'videos'
  fileIndex?: number
}

export interface KlingMotionDeferredCheck {
  code: KlingMotionDeferredCode
  message: string
  field: 'images' | 'videos'
  fileIndex: number
}

export interface KlingMotionValidationResult {
  valid: boolean
  issues: KlingMotionValidationIssue[]
  /** Non-blocking metadata a paid preflight should probe when possible. */
  deferredChecks: KlingMotionDeferredCheck[]
}

function normalizedMime(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().split(';', 1)[0]
}

function extension(file: KlingMotionFileLike): string {
  const candidate = (file.name || file.url || '').split(/[?#]/, 1)[0]
  const match = candidate.trim().toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] ?? ''
}

function fileMime(file: KlingMotionFileLike): string {
  return normalizedMime(file.mimeType ?? file.type)
}

function fileSize(file: KlingMotionFileLike): number | undefined {
  return file.byteSize ?? file.size
}

function fileDurationMs(file: KlingMotionFileLike): number | undefined {
  if (file.durationMs !== undefined) return file.durationMs
  if (file.durationSeconds !== undefined) return file.durationSeconds * 1_000
  return undefined
}

function typeState(
  file: KlingMotionFileLike,
  mimes: readonly string[],
  extensions: readonly string[],
): 'valid' | 'invalid' | 'unknown' {
  const mime = fileMime(file)
  const ext = extension(file)
  if (!mime && !ext) return 'unknown'
  const mimeMatches = mime ? mimes.includes(mime) : true
  const extensionMatches = ext ? extensions.includes(ext) : true
  return mimeMatches && extensionMatches ? 'valid' : 'invalid'
}

function knownDimensions(file: KlingMotionFileLike): { width: number; height: number } | null {
  if (file.width === undefined || file.height === undefined) return null
  return { width: file.width, height: file.height }
}

function promptLength(value: string): number {
  return Array.from(value).length
}

function pushDeferred(
  deferredChecks: KlingMotionDeferredCheck[],
  code: KlingMotionDeferredCode,
  message: string,
  field: KlingMotionDeferredCheck['field'],
  fileIndex: number,
): void {
  deferredChecks.push({ code, message, field, fileIndex })
}

function validateDimensions(
  file: KlingMotionFileLike,
  kind: 'image' | 'video',
  fileIndex: number,
  issues: KlingMotionValidationIssue[],
  deferredChecks: KlingMotionDeferredCheck[],
): void {
  const field = kind === 'image' ? 'images' : 'videos'
  const dimensions = knownDimensions(file)
  if (!dimensions) {
    pushDeferred(
      deferredChecks,
      `${kind}-dimensions-unknown`,
      `${kind === 'image' ? 'Character image' : 'Driver video'} dimensions are unavailable and should be probed before a paid request when possible.`,
      field,
      fileIndex,
    )
    return
  }

  const { width, height } = dimensions
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= KLING_MOTION_MIN_DIMENSION_EXCLUSIVE_PX
    || height <= KLING_MOTION_MIN_DIMENSION_EXCLUSIVE_PX
  ) {
    issues.push({
      code: `${kind}-dimensions`,
      message: `${kind === 'image' ? 'Character image' : 'Driver video'} width and height must both be greater than ${KLING_MOTION_MIN_DIMENSION_EXCLUSIVE_PX}px.`,
      field,
      fileIndex,
    })
    return
  }

  const ratio = width / height
  if (ratio < KLING_MOTION_MIN_ASPECT_RATIO || ratio > KLING_MOTION_MAX_ASPECT_RATIO) {
    issues.push({
      code: `${kind}-aspect-ratio`,
      message: `${kind === 'image' ? 'Character image' : 'Driver video'} aspect ratio must be between 2:5 and 5:2.`,
      field,
      fileIndex,
    })
  }
}

/** Validate only facts that are known; missing media metadata remains non-blocking. */
export function validateKlingMotionDraft(draft: KlingMotionDraft): KlingMotionValidationResult {
  const issues: KlingMotionValidationIssue[] = []
  const deferredChecks: KlingMotionDeferredCheck[] = []
  const images = Array.isArray(draft.images) ? draft.images : []
  const videos = Array.isArray(draft.videos) ? draft.videos : []

  if (promptLength(String(draft.prompt ?? '')) > KLING_MOTION_PROMPT_MAX) {
    issues.push({
      code: 'prompt-too-long',
      message: `Kling 3 Motion Control prompts are limited to ${KLING_MOTION_PROMPT_MAX} characters.`,
      field: 'prompt',
    })
  }
  if (draft.orientation !== 'image' && draft.orientation !== 'video') {
    issues.push({
      code: 'invalid-orientation',
      message: 'Character orientation must be image or video.',
      field: 'orientation',
    })
  }
  if (images.length !== 1) {
    issues.push({
      code: 'image-count',
      message: 'Kling 3 Motion Control requires exactly one character image.',
      field: 'images',
    })
  }
  if (videos.length !== 1) {
    issues.push({
      code: 'video-count',
      message: 'Kling 3 Motion Control requires exactly one driver video.',
      field: 'videos',
    })
  }

  images.forEach((file, fileIndex) => {
    const state = typeState(file, KLING_MOTION_IMAGE_MIME_TYPES, KLING_MOTION_IMAGE_EXTENSIONS)
    if (state === 'invalid') {
      issues.push({ code: 'image-type', message: 'Character image must be a JPG or PNG file.', field: 'images', fileIndex })
    } else if (state === 'unknown') {
      pushDeferred(deferredChecks, 'image-type-unknown', 'Character image type is unavailable and should be probed before a paid request when possible.', 'images', fileIndex)
    }

    const size = fileSize(file)
    if (size === undefined) {
      pushDeferred(deferredChecks, 'image-size-unknown', 'Character image size is unavailable and should be probed before a paid request when possible.', 'images', fileIndex)
    } else if (!Number.isFinite(size) || size < 0 || size > KLING_MOTION_IMAGE_MAX_BYTES) {
      issues.push({ code: 'image-size', message: 'Character image must not exceed 10MB.', field: 'images', fileIndex })
    }
    validateDimensions(file, 'image', fileIndex, issues, deferredChecks)
  })

  videos.forEach((file, fileIndex) => {
    const state = typeState(file, KLING_MOTION_VIDEO_MIME_TYPES, KLING_MOTION_VIDEO_EXTENSIONS)
    if (state === 'invalid') {
      issues.push({ code: 'video-type', message: 'Driver video must be an MP4 or MOV file.', field: 'videos', fileIndex })
    } else if (state === 'unknown') {
      pushDeferred(deferredChecks, 'video-type-unknown', 'Driver video type is unavailable and should be probed before a paid request when possible.', 'videos', fileIndex)
    }

    const size = fileSize(file)
    if (size === undefined) {
      pushDeferred(deferredChecks, 'video-size-unknown', 'Driver video size is unavailable and should be probed before a paid request when possible.', 'videos', fileIndex)
    } else if (!Number.isFinite(size) || size < 0 || size > KLING_MOTION_VIDEO_MAX_BYTES) {
      issues.push({ code: 'video-size', message: 'Driver video must not exceed 100MB.', field: 'videos', fileIndex })
    }
    validateDimensions(file, 'video', fileIndex, issues, deferredChecks)

    const durationMs = fileDurationMs(file)
    if (durationMs === undefined) {
      pushDeferred(deferredChecks, 'video-duration-unknown', 'Driver video duration is unavailable and should be probed before a paid request when possible.', 'videos', fileIndex)
    } else if (
      !Number.isFinite(durationMs)
      || durationMs < KLING_MOTION_VIDEO_MIN_DURATION_MS
      || durationMs > KLING_MOTION_VIDEO_MAX_DURATION_MS
    ) {
      issues.push({ code: 'video-duration', message: 'Driver video duration must be between 3 and 30 seconds.', field: 'videos', fileIndex })
    } else if (draft.orientation === 'image' && durationMs > KLING_MOTION_IMAGE_ORIENTATION_MAX_DURATION_MS) {
      issues.push({
        code: 'image-orientation-video-duration',
        message: 'Driver video duration must not exceed 10 seconds when character orientation is image.',
        field: 'videos',
        fileIndex,
      })
    }
  })

  return { valid: issues.length === 0, issues, deferredChecks }
}
