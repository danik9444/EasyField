// Dedicated avatar / lip-sync model contracts from Kie's published Market API
// schemas. Verified 2026-07-13.
//
// This file deliberately separates provider capability from UI state. The
// request builder consumes the exact model/options below, while screens can use
// the same registry to show only compatible sources and controls. Unknown model
// names, unsupported options and known-invalid media fail closed before a paid
// task is submitted.

export type AvatarWorkflow = 'portrait' | 'video-lipsync'
export type AvatarSubjectLayout = 'single' | 'multiple' | 'none'

export const AVATAR_MODELS = [
  'Kling Avatar Pro',
  'Kling Avatar Standard',
  'OmniHuman 1.5',
  'InfiniteTalk',
  'Wan 2.2 A14B Speech-to-Video Turbo',
  'Volcengine Lip Sync',
] as const

export type AvatarModelName = typeof AVATAR_MODELS[number]

export const PORTRAIT_AVATAR_MODELS = AVATAR_MODELS.slice(0, 5) as readonly AvatarModelName[]
export const VIDEO_LIPSYNC_MODELS = [AVATAR_MODELS[5]] as const

export const DEFAULT_AVATAR_MODEL_BY_WORKFLOW: Readonly<Record<AvatarWorkflow, AvatarModelName>> = {
  portrait: 'Kling Avatar Pro',
  'video-lipsync': 'Volcengine Lip Sync',
}

export interface AvatarOptions {
  // OmniHuman
  outputResolution?: '720' | '1080'
  fastMode?: boolean
  // OmniHuman, InfiniteTalk and Wan. Each model validates its own range.
  seed?: number
  // InfiniteTalk and Wan
  resolution?: '480p' | '580p' | '720p'
  // Wan
  numFrames?: number
  framesPerSecond?: number
  negativePrompt?: string
  numInferenceSteps?: number
  guidanceScale?: number
  shift?: number
  nsfwChecker?: boolean
  // Volcengine
  lipSyncMode?: 'lite' | 'basic'
  separateVocal?: boolean
  openSceneDetection?: boolean
  alignAudio?: boolean
  alignAudioReverse?: boolean
  templateStartSeconds?: number
}

type AvatarOptionKey = keyof AvatarOptions

interface AvatarControlBase {
  key: AvatarOptionKey
  label: string
  /** Restrict a control to a selected Volcengine mode. */
  whenMode?: 'lite' | 'basic'
}

export type AvatarControlDefinition =
  | (AvatarControlBase & {
      control: 'select'
      values: readonly (string | number)[]
      defaultValue: string | number
    })
  | (AvatarControlBase & {
      control: 'toggle'
      defaultValue: boolean
    })
  | (AvatarControlBase & {
      control: 'number'
      min?: number
      max?: number
      step?: number
      integer?: boolean
      /** Undefined preserves the provider's random/automatic default. */
      defaultValue?: number
    })
  | (AvatarControlBase & {
      control: 'text'
      maxLength: number
      defaultValue?: string
    })

export interface AvatarMediaRules {
  mimeTypes: readonly string[]
  extensions: readonly string[]
  maxBytes: number
  maxDurationSeconds?: number
  /** OmniHuman documents audio as strictly shorter than 60 seconds. */
  durationMaximumExclusive?: boolean
  minShortSidePx?: number
  providerCompressesAboveShortSidePx?: number
  minFramesPerSecond?: number
  maxFramesPerSecond?: number
  minBitrateMbps?: number
  maxBitrateMbps?: number
}

export interface AvatarModelConfig {
  route: string
  workflow: AvatarWorkflow
  /** Whether Kie exposes a deterministic speaker selector for this endpoint. */
  speakerTargeting: 'single-subject-only' | 'subject-mask'
  prompt: 'required' | 'optional' | 'unsupported'
  /** Kling requires the prompt field but explicitly permits an empty string. */
  promptMayBeEmpty?: boolean
  promptMax: number
  image?: AvatarMediaRules
  video?: AvatarMediaRules
  audio: AvatarMediaRules
  maskMax?: number
  controls: readonly AvatarControlDefinition[]
}

const MB = 1024 * 1024

const IMAGE_JPEG_PNG_10MB: AvatarMediaRules = {
  mimeTypes: ['image/jpeg', 'image/png'],
  extensions: ['jpg', 'jpeg', 'png'],
  maxBytes: 10 * MB,
}

const IMAGE_JPEG_PNG_WEBP_10MB: AvatarMediaRules = {
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  extensions: ['jpg', 'jpeg', 'png', 'webp'],
  maxBytes: 10 * MB,
}

const AUDIO_COMMON_MIMES = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'audio/ogg'] as const
const AUDIO_COMMON_EXTENSIONS = ['mp3', 'wav', 'aac', 'm4a', 'mp4', 'ogg'] as const

const AUDIO_COMMON_10MB: AvatarMediaRules = {
  mimeTypes: AUDIO_COMMON_MIMES,
  extensions: AUDIO_COMMON_EXTENSIONS,
  maxBytes: 10 * MB,
}

const KLING_AUDIO: AvatarMediaRules = {
  mimeTypes: AUDIO_COMMON_MIMES,
  extensions: AUDIO_COMMON_EXTENSIONS,
  maxBytes: 100 * MB,
  maxDurationSeconds: 5 * 60,
}

const OMNIHUMAN_AUDIO: AvatarMediaRules = {
  ...AUDIO_COMMON_10MB,
  maxDurationSeconds: 60,
  durationMaximumExclusive: true,
}

const WAN_AUDIO: AvatarMediaRules = {
  mimeTypes: [...AUDIO_COMMON_MIMES, 'audio/flac', 'audio/x-ms-wma'],
  extensions: [...AUDIO_COMMON_EXTENSIONS, 'flac', 'wma'],
  maxBytes: 10 * MB,
}

const VOLCENGINE_VIDEO: AvatarMediaRules = {
  mimeTypes: ['video/mp4', 'video/quicktime'],
  extensions: ['mp4', 'mov'],
  maxBytes: 500 * MB,
  minShortSidePx: 360,
  providerCompressesAboveShortSidePx: 1080,
  minFramesPerSecond: 24,
  maxFramesPerSecond: 60,
  minBitrateMbps: 1,
  maxBitrateMbps: 30,
}

export const AVATAR_MODEL_CONFIG: Readonly<Record<AvatarModelName, AvatarModelConfig>> = {
  'Kling Avatar Pro': {
    route: 'kling/ai-avatar-pro',
    workflow: 'portrait',
    speakerTargeting: 'single-subject-only',
    prompt: 'required',
    promptMayBeEmpty: true,
    promptMax: 5_000,
    image: IMAGE_JPEG_PNG_10MB,
    audio: KLING_AUDIO,
    controls: [],
  },
  'Kling Avatar Standard': {
    route: 'kling/ai-avatar-standard',
    workflow: 'portrait',
    speakerTargeting: 'single-subject-only',
    prompt: 'required',
    promptMayBeEmpty: true,
    promptMax: 5_000,
    image: IMAGE_JPEG_PNG_10MB,
    audio: KLING_AUDIO,
    controls: [],
  },
  'OmniHuman 1.5': {
    route: 'omnihuman-1-5',
    workflow: 'portrait',
    speakerTargeting: 'subject-mask',
    prompt: 'optional',
    // Kie currently rejects OmniHuman submissions above 300 characters.
    // Keep this in the shared contract so both UI and preflight fail before a
    // paid request is accepted by the provider.
    promptMax: 300,
    image: IMAGE_JPEG_PNG_WEBP_10MB,
    audio: OMNIHUMAN_AUDIO,
    maskMax: 5,
    controls: [
      { key: 'outputResolution', label: 'OUTPUT RESOLUTION', control: 'select', values: ['720', '1080'], defaultValue: '1080' },
      { key: 'fastMode', label: 'FAST MODE', control: 'toggle', defaultValue: false },
      { key: 'seed', label: 'SEED', control: 'number', integer: true, defaultValue: -1 },
    ],
  },
  InfiniteTalk: {
    route: 'infinitalk/from-audio',
    workflow: 'portrait',
    speakerTargeting: 'single-subject-only',
    prompt: 'required',
    promptMax: 5_000,
    image: IMAGE_JPEG_PNG_WEBP_10MB,
    audio: AUDIO_COMMON_10MB,
    controls: [
      { key: 'resolution', label: 'RESOLUTION', control: 'select', values: ['480p', '720p'], defaultValue: '480p' },
      { key: 'seed', label: 'SEED', control: 'number', min: 10_000, max: 1_000_000, integer: true },
    ],
  },
  'Wan 2.2 A14B Speech-to-Video Turbo': {
    route: 'wan/2-2-a14b-speech-to-video-turbo',
    workflow: 'portrait',
    speakerTargeting: 'single-subject-only',
    prompt: 'required',
    promptMax: 5_000,
    image: IMAGE_JPEG_PNG_WEBP_10MB,
    audio: WAN_AUDIO,
    controls: [
      { key: 'numFrames', label: 'NUMBER OF FRAMES', control: 'number', min: 40, max: 120, step: 4, integer: true, defaultValue: 80 },
      { key: 'framesPerSecond', label: 'FRAMES PER SECOND', control: 'number', min: 4, max: 60, step: 1, integer: true, defaultValue: 16 },
      { key: 'resolution', label: 'RESOLUTION', control: 'select', values: ['480p', '580p', '720p'], defaultValue: '480p' },
      { key: 'negativePrompt', label: 'NEGATIVE PROMPT', control: 'text', maxLength: 500 },
      { key: 'numInferenceSteps', label: 'INFERENCE STEPS', control: 'number', min: 2, max: 40, step: 1, integer: true, defaultValue: 27 },
      { key: 'guidanceScale', label: 'GUIDANCE SCALE', control: 'number', min: 1, max: 10, step: 0.1, defaultValue: 3.5 },
      { key: 'shift', label: 'SHIFT', control: 'number', min: 1, max: 10, step: 0.1, defaultValue: 5 },
      { key: 'seed', label: 'SEED', control: 'number', integer: true },
      { key: 'nsfwChecker', label: 'SAFETY CHECK', control: 'toggle', defaultValue: true },
    ],
  },
  'Volcengine Lip Sync': {
    route: 'volcengine/video-to-video-lip-sync',
    workflow: 'video-lipsync',
    speakerTargeting: 'single-subject-only',
    prompt: 'unsupported',
    promptMax: 0,
    video: VOLCENGINE_VIDEO,
    audio: AUDIO_COMMON_10MB,
    controls: [
      { key: 'lipSyncMode', label: 'MODE', control: 'select', values: ['lite', 'basic'], defaultValue: 'lite' },
      { key: 'separateVocal', label: 'SEPARATE VOCAL', control: 'toggle', defaultValue: false },
      { key: 'openSceneDetection', label: 'SCENE DETECTION', control: 'toggle', defaultValue: false, whenMode: 'basic' },
      { key: 'alignAudio', label: 'ALIGN AUDIO', control: 'toggle', defaultValue: true, whenMode: 'lite' },
      { key: 'alignAudioReverse', label: 'REVERSE ALIGNMENT', control: 'toggle', defaultValue: false, whenMode: 'lite' },
      { key: 'templateStartSeconds', label: 'SOURCE START', control: 'number', min: 0, step: 0.1, defaultValue: 0, whenMode: 'lite' },
    ],
  },
}

export function isAvatarModelName(model: string): model is AvatarModelName {
  return Object.prototype.hasOwnProperty.call(AVATAR_MODEL_CONFIG, model)
}

export function requireAvatarModelConfig(model: string): AvatarModelConfig {
  if (!isAvatarModelName(model)) throw new Error(`${model || 'Unknown model'} is not a verified EasyField Avatar model.`)
  return AVATAR_MODEL_CONFIG[model]
}

export function avatarModelsForWorkflow(workflow: AvatarWorkflow): AvatarModelName[] {
  return AVATAR_MODELS.filter((model) => AVATAR_MODEL_CONFIG[model].workflow === workflow)
}

function defaultOptions(config: AvatarModelConfig): AvatarOptions {
  const values: Partial<Record<AvatarOptionKey, AvatarOptions[AvatarOptionKey]>> = {}
  config.controls.forEach((control) => {
    if (control.defaultValue !== undefined) {
      // The control registry is the source of truth for this model's option
      // types. The indexed assignment is safe after discriminating each union.
      ;(values as Record<string, unknown>)[control.key] = control.defaultValue
    }
  })
  return values as AvatarOptions
}

export function defaultAvatarOptionsFor(model: string): AvatarOptions {
  return defaultOptions(requireAvatarModelConfig(model))
}

function decimalStepMatches(value: number, min: number, step: number): boolean {
  const quotient = (value - min) / step
  return Math.abs(quotient - Math.round(quotient)) < 1e-8
}

function validateControlValue(control: AvatarControlDefinition, value: unknown): boolean {
  if (control.control === 'toggle') return typeof value === 'boolean'
  if (control.control === 'select') return control.values.includes(value as never)
  if (control.control === 'text') return typeof value === 'string' && Array.from(value).length <= control.maxLength
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (control.integer && !Number.isInteger(value)) return false
  if (control.min !== undefined && value < control.min) return false
  if (control.max !== undefined && value > control.max) return false
  if (control.step !== undefined && !decimalStepMatches(value, control.min ?? 0, control.step)) return false
  return true
}

/**
 * Validate exact provider option values and add documented defaults. Unknown or
 * cross-model fields throw instead of being silently ignored before billing.
 */
export function avatarOptionsForRequest(model: string, raw: Partial<AvatarOptions> = {}): AvatarOptions {
  const config = requireAvatarModelConfig(model)
  const controls = new Map(config.controls.map((control) => [control.key, control]))
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const control = controls.get(key as AvatarOptionKey)
    if (!control) throw new Error(`${model} does not support the ${key} option.`)
    if (!validateControlValue(control, value)) throw new Error(`${model} received an invalid value for ${control.label.toLowerCase()}.`)
  }
  const options = { ...defaultOptions(config), ...raw }
  if (
    model === 'Volcengine Lip Sync'
    && options.lipSyncMode === 'lite'
    && options.alignAudioReverse
    && options.alignAudio === false
  ) {
    throw new Error('Volcengine reverse alignment requires audio alignment to be enabled.')
  }
  return options
}

/** Stored drafts are sanitized without replaying stale values from another model. */
export function resolveAvatarOptions(model: string, stored?: Partial<AvatarOptions>): AvatarOptions {
  const config = requireAvatarModelConfig(model)
  const defaults = defaultOptions(config)
  if (!stored) return defaults
  const next: AvatarOptions = { ...defaults }
  config.controls.forEach((control) => {
    const value = stored[control.key]
    if (value !== undefined && validateControlValue(control, value)) {
      ;(next as Record<string, unknown>)[control.key] = value
    }
  })
  // A stale reverse-alignment toggle cannot survive when alignment is off.
  if (model === 'Volcengine Lip Sync' && next.alignAudio === false) next.alignAudioReverse = false
  return next
}

export interface AvatarFileMetadata {
  id?: string
  name?: string
  url?: string
  /** Browser File/Blob aliases. */
  type?: string
  size?: number
  /** Persisted Library/Resolve aliases. */
  mimeType?: string
  byteSize?: number
  durationSeconds?: number
  width?: number
  height?: number
  framesPerSecond?: number
  bitrateMbps?: number
}

export interface AvatarDraft {
  model: string
  rightsConfirmed: boolean
  prompt: string
  image?: AvatarFileMetadata | null
  video?: AvatarFileMetadata | null
  audio?: AvatarFileMetadata | null
  /** Required review of the people visible in the current portrait source. */
  subjectLayout?: AvatarSubjectLayout
  /** Binds the review to the current source so replacing an image invalidates it. */
  subjectSourceId?: string
  masks?: readonly AvatarFileMetadata[]
  /** Source identity for each selected subject mask, in the same order as masks. */
  maskSourceIds?: readonly string[]
  options?: Partial<AvatarOptions>
}

export interface AvatarValidationIssue {
  code: string
  field: 'model' | 'rights' | 'prompt' | 'image' | 'video' | 'audio' | 'subject' | 'masks' | 'options'
  message: string
  fileIndex?: number
}

export interface AvatarDeferredCheck {
  field: 'image' | 'video' | 'audio' | 'masks'
  code: 'type-unknown' | 'size-unknown' | 'duration-unknown' | 'dimensions-unknown' | 'fps-unknown' | 'bitrate-unknown'
  message: string
  fileIndex?: number
}

export interface AvatarValidationResult {
  valid: boolean
  issues: AvatarValidationIssue[]
  deferredChecks: AvatarDeferredCheck[]
}

function fileExtension(file: AvatarFileMetadata): string {
  const candidate = (file.name || file.url || '').split(/[?#]/, 1)[0]
  return candidate.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
}

function fileMime(file: AvatarFileMetadata): string {
  return (file.mimeType ?? file.type ?? '').trim().toLowerCase().split(';', 1)[0]
}

function fileBytes(file: AvatarFileMetadata): number | undefined {
  return file.byteSize ?? file.size
}

function pushFileIssue(
  issues: AvatarValidationIssue[],
  field: AvatarValidationIssue['field'],
  code: string,
  message: string,
  fileIndex?: number,
): void {
  issues.push({ code, field, message, ...(fileIndex === undefined ? {} : { fileIndex }) })
}

function validateMedia(
  file: AvatarFileMetadata,
  rules: AvatarMediaRules,
  field: 'image' | 'video' | 'audio' | 'masks',
  label: string,
  issues: AvatarValidationIssue[],
  deferredChecks: AvatarDeferredCheck[],
  fileIndex?: number,
): void {
  const mime = fileMime(file)
  const ext = fileExtension(file)
  if (!mime && !ext) {
    deferredChecks.push({ field, code: 'type-unknown', message: `${label} type must be verified before upload.`, ...(fileIndex === undefined ? {} : { fileIndex }) })
  } else {
    const mimeValid = !mime || rules.mimeTypes.includes(mime)
    const extensionValid = !ext || rules.extensions.includes(ext)
    if (!mimeValid || !extensionValid) {
      pushFileIssue(issues, field, 'unsupported-type', `${label} must be ${rules.extensions.map((value) => value.toUpperCase()).join(', ')}.`, fileIndex)
    }
  }

  const bytes = fileBytes(file)
  if (bytes === undefined) {
    deferredChecks.push({ field, code: 'size-unknown', message: `${label} file size must be verified before upload.`, ...(fileIndex === undefined ? {} : { fileIndex }) })
  } else if (!Number.isFinite(bytes) || bytes <= 0 || bytes > rules.maxBytes) {
    pushFileIssue(issues, field, 'invalid-size', `${label} must contain media and be no larger than ${Math.round(rules.maxBytes / MB)} MB.`, fileIndex)
  }

  if (rules.maxDurationSeconds !== undefined) {
    if (file.durationSeconds === undefined) {
      deferredChecks.push({ field, code: 'duration-unknown', message: `${label} duration must be verified before upload.`, ...(fileIndex === undefined ? {} : { fileIndex }) })
    } else {
      const invalid = !Number.isFinite(file.durationSeconds)
        || file.durationSeconds <= 0
        || (rules.durationMaximumExclusive
          ? file.durationSeconds >= rules.maxDurationSeconds
          : file.durationSeconds > rules.maxDurationSeconds)
      if (invalid) {
        const comparator = rules.durationMaximumExclusive ? 'shorter than' : 'no longer than'
        pushFileIssue(issues, field, 'invalid-duration', `${label} must be ${comparator} ${rules.maxDurationSeconds} seconds.`, fileIndex)
      }
    }
  }

  if (rules.minShortSidePx !== undefined) {
    if (file.width === undefined || file.height === undefined) {
      deferredChecks.push({ field, code: 'dimensions-unknown', message: `${label} dimensions must be verified before upload.`, ...(fileIndex === undefined ? {} : { fileIndex }) })
    } else {
      const shortSide = Math.min(file.width, file.height)
      if (!Number.isFinite(shortSide) || shortSide < rules.minShortSidePx) {
        pushFileIssue(issues, field, 'invalid-dimensions', `${label} must be at least ${rules.minShortSidePx}p on its shorter side.`, fileIndex)
      }
    }
  }

  if (rules.minFramesPerSecond !== undefined || rules.maxFramesPerSecond !== undefined) {
    if (file.framesPerSecond === undefined) {
      deferredChecks.push({ field, code: 'fps-unknown', message: `${label} frame rate must be verified before upload.`, ...(fileIndex === undefined ? {} : { fileIndex }) })
    } else if (
      !Number.isFinite(file.framesPerSecond)
      || file.framesPerSecond < (rules.minFramesPerSecond ?? -Infinity)
      || file.framesPerSecond > (rules.maxFramesPerSecond ?? Infinity)
    ) {
      pushFileIssue(issues, field, 'invalid-fps', `${label} frame rate must be ${rules.minFramesPerSecond}–${rules.maxFramesPerSecond} fps.`, fileIndex)
    }
  }

  if (rules.minBitrateMbps !== undefined || rules.maxBitrateMbps !== undefined) {
    if (file.bitrateMbps === undefined) {
      deferredChecks.push({ field, code: 'bitrate-unknown', message: `${label} bitrate must be verified before upload.`, ...(fileIndex === undefined ? {} : { fileIndex }) })
    } else if (
      !Number.isFinite(file.bitrateMbps)
      || file.bitrateMbps < (rules.minBitrateMbps ?? -Infinity)
      || file.bitrateMbps > (rules.maxBitrateMbps ?? Infinity)
    ) {
      pushFileIssue(issues, field, 'invalid-bitrate', `${label} bitrate must be ${rules.minBitrateMbps}–${rules.maxBitrateMbps} Mbps.`, fileIndex)
    }
  }
}

/**
 * Pure draft validation. Known invalid media blocks immediately; metadata that
 * is unavailable is returned as a deferred check for the run preflight to probe
 * before uploading or submitting paid work.
 */
export function validateAvatarDraft(draft: AvatarDraft): AvatarValidationResult {
  const issues: AvatarValidationIssue[] = []
  const deferredChecks: AvatarDeferredCheck[] = []
  if (!isAvatarModelName(draft.model)) {
    return {
      valid: false,
      issues: [{ code: 'unknown-model', field: 'model', message: `${draft.model || 'Unknown model'} is not a verified EasyField Avatar model.` }],
      deferredChecks,
    }
  }
  const config = AVATAR_MODEL_CONFIG[draft.model]
  const prompt = String(draft.prompt ?? '')

  if (!draft.rightsConfirmed) {
    issues.push({ code: 'rights-required', field: 'rights', message: 'Confirm that you have permission to animate or lip-sync this subject.' })
  }
  if (Array.from(prompt).length > config.promptMax) {
    issues.push({ code: 'prompt-too-long', field: 'prompt', message: `${draft.model} prompts are limited to ${config.promptMax.toLocaleString()} characters.` })
  }
  if (config.prompt === 'required' && !config.promptMayBeEmpty && !prompt.trim()) {
    issues.push({ code: 'prompt-required', field: 'prompt', message: `${draft.model} requires a direction prompt.` })
  }
  if (config.prompt === 'unsupported' && prompt.trim()) {
    issues.push({ code: 'prompt-unsupported', field: 'prompt', message: `${draft.model} lip-syncs the selected video and audio directly and does not accept a prompt.` })
  }

  const masks = draft.masks ?? []
  const maskSourceIds = draft.maskSourceIds ?? []

  if (config.workflow === 'portrait') {
    if (!draft.image) {
      issues.push({ code: 'image-required', field: 'image', message: 'Choose one portrait image.' })
    } else {
      validateMedia(draft.image, config.image!, 'image', 'Portrait image', issues, deferredChecks)
      const sourceId = draft.image.id?.trim() ?? ''
      const reviewedLayout = draft.subjectLayout === 'single'
        || draft.subjectLayout === 'multiple'
        || draft.subjectLayout === 'none'

      if (!reviewedLayout) {
        issues.push({ code: 'subject-review-required', field: 'subject', message: 'Review whether the portrait contains one person or multiple people before generating.' })
      } else {
        if (!sourceId || draft.subjectSourceId !== sourceId) {
          issues.push({ code: 'subject-review-stale', field: 'subject', message: 'Review the people in the current portrait again; the source image changed.' })
        }

        if (draft.subjectLayout === 'none') {
          issues.push({ code: 'no-subject-detected', field: 'subject', message: 'No person was identified in this portrait. Choose a clear face or character image.' })
        }

        if (draft.subjectLayout === 'single') {
          if (masks.length || maskSourceIds.length) {
            issues.push({ code: 'speaker-target-unexpected', field: 'masks', message: 'A single-person portrait must not include a speaker-selection mask.' })
          }
        }

        if (draft.subjectLayout === 'multiple') {
          if (config.speakerTargeting !== 'subject-mask') {
            issues.push({ code: 'multi-person-unsupported', field: 'subject', message: `${draft.model} cannot choose a speaker in a multi-person portrait. Use OmniHuman 1.5 or a single-person source.` })
          } else if (masks.length !== 1 || maskSourceIds.length !== 1) {
            issues.push({
              code: masks.length === 0 && maskSourceIds.length === 0 ? 'speaker-target-required' : 'speaker-target-count',
              field: 'masks',
              message: 'Choose exactly one detected person to speak in this portrait.',
            })
          } else {
            if (maskSourceIds[0] !== sourceId) {
              issues.push({ code: 'speaker-target-stale', field: 'masks', message: 'The selected speaker mask belongs to a different portrait. Detect and choose the speaker again.' })
            }
            validateMedia(masks[0], config.image!, 'masks', 'Selected speaker mask', issues, deferredChecks, 0)
          }
        }

        if (draft.subjectLayout !== 'multiple' && (masks.length || maskSourceIds.length) && draft.subjectLayout !== 'single') {
          issues.push({ code: 'speaker-target-unexpected', field: 'masks', message: 'Speaker selection is only valid for a reviewed multi-person portrait.' })
        }
      }
    }
    if (draft.video) issues.push({ code: 'video-unsupported', field: 'video', message: `${draft.model} accepts a portrait image, not a source video.` })
  } else {
    if (!draft.video) issues.push({ code: 'video-required', field: 'video', message: 'Choose one source video to lip-sync.' })
    else validateMedia(draft.video, config.video!, 'video', 'Source video', issues, deferredChecks)
    if (draft.image) issues.push({ code: 'image-unsupported', field: 'image', message: `${draft.model} accepts a source video, not a portrait image.` })
    if (masks.length || maskSourceIds.length) {
      issues.push({ code: 'masks-unsupported', field: 'masks', message: `${draft.model} does not accept portrait speaker masks.` })
    }
  }

  if (!draft.audio) issues.push({ code: 'audio-required', field: 'audio', message: 'Choose one voice audio file.' })
  else validateMedia(draft.audio, config.audio, 'audio', 'Voice audio', issues, deferredChecks)

  try {
    avatarOptionsForRequest(draft.model, draft.options)
  } catch (error) {
    issues.push({ code: 'invalid-options', field: 'options', message: error instanceof Error ? error.message : 'Avatar model options are invalid.' })
  }

  return { valid: issues.length === 0, issues, deferredChecks }
}
