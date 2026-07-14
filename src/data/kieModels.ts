// Per-model request builders: map the panel's UI state to each kie.ai model's
// EXACT documented `input` (Market jobs API) or request body (Veo / Runway /
// Aleph / Suno). Field names, enums and defaults are taken verbatim from the
// model's kie.ai OpenAPI doc (docs.kie.ai/...). Verified 2026-07-11.
//
// A model runs in whichever mode the supplied inputs imply: reference images →
// reference/edit variant, start/end frames → image-to-video, otherwise the
// text-to-x variant. Media URLs here are ALREADY hosted (uploaded via
// services/kie.uploadUrl) — builders never see local blobs.
import type { KieRequest } from '../services/kie'
import { IDEOGRAM_V3_EDIT_PROMPT_MAX, IMAGE_MODEL_CONFIG } from './imageModelConfig.ts'
import { VIDEO_MODEL_CONFIG } from './videoModelConfig.ts'
import { VIDEO_EDIT_CONFIG } from './videoEditConfig.ts'
import {
  assertPromptCharacterLimit,
  happyHorsePromptMax,
  promptCharacterCount,
} from './promptLimits.ts'
import {
  DIALOGUE_LANGUAGE_CODES,
  type DialogueSettings,
  type TtsSettings,
} from './elevenLabsConfig.ts'
import {
  DEFAULT_MULTI_SHOT_RULES,
  compileMultiShotProviderScenes,
  validateMultiShotDraft,
} from './videoMultiShot.ts'
import {
  KLING_ELEMENT_MAX,
  toKlingProviderElement,
  type KlingHostedElement,
  type KlingProviderElement,
} from './klingElements.ts'
import {
  avatarOptionsForRequest,
  requireAvatarModelConfig,
  type AvatarOptions,
  type AvatarSubjectLayout,
} from './avatar.ts'

const job = (model: string, input: Record<string, unknown>): KieRequest => ({ family: 'jobs', model, input })

// ---- value mappers ---------------------------------------------------------
const lc = (v?: string) => (v ? v.toLowerCase() : v)
// kie.ai uses lowercase "4k" for Seedance / Veo / Omni resolution.
const res4k = (r: string) => (r === '4K' ? '4k' : r)
// Seedance / adaptive aspect is lowercase.
const asp = (a: string) => (a === 'Adaptive' ? 'adaptive' : a)
// Seedream/Flux quality tier: Basic = 2K, High = 4K.
const seedreamQuality = (r: string) => (r === '4K' ? 'high' : 'basic')
const intDur = (d?: string) => Math.max(1, Math.round(Number(d) || 5))
const stripX = (f: string) => f.replace(/[×x]/g, '').trim() || '2'
const topazFactor = (factor: string, allowed: readonly string[], media: string) => {
  const normalized = stripX(factor)
  if (!allowed.includes(normalized)) throw new Error(`Topaz ${media} upscale factor must be ${allowed.join(', ')}.`)
  return normalized
}
const stripS = (d?: string) => (d ? d.replace(/s$/i, '') : d)
const nanoFmt = (f?: string) => (f === 'JPG' ? 'jpg' : 'png')
const qwenFmt = (f?: string) => (f === 'JPEG' ? 'jpeg' : 'png')

// ===========================================================================
// IMAGES  (Create Image + Edit Image · Custom)
// ===========================================================================
export interface ImageCtx {
  prompt: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  imageUrls: string[] // hosted reference/source images
}

export function buildImageRequest(model: string, c: ImageCtx): KieRequest {
  const refs = c.imageUrls
  const has = refs.length > 0
  const config = IMAGE_MODEL_CONFIG[model]
  if (config) {
    const minimum = model === 'Seedream 5 Pro' || model === 'Seedream 5 Lite' || model === 'Flux 2' ? 3 : 0
    assertPromptCharacterLimit(c.prompt, config.promptMax, `${model} prompt`, minimum)
  }
  switch (model) {
    case 'GPT Image 2':
      return has
        ? job('gpt-image-2-image-to-image', { prompt: c.prompt, input_urls: refs, aspect_ratio: c.aspect || 'auto', ...(c.resolution ? { resolution: c.resolution } : {}) })
        : job('gpt-image-2-text-to-image', { prompt: c.prompt, aspect_ratio: c.aspect || 'auto', ...(c.resolution ? { resolution: c.resolution } : {}) })
    case 'Nano Banana Pro':
      return job('nano-banana-pro', { prompt: c.prompt, ...(has ? { image_input: refs } : {}), aspect_ratio: c.aspect || '1:1', resolution: c.resolution || '1K', output_format: nanoFmt(c.extras.format) })
    case 'Nano Banana 2':
      return job('nano-banana-2', { prompt: c.prompt, ...(has ? { image_input: refs } : {}), aspect_ratio: c.aspect || 'auto', resolution: c.resolution || '1K', output_format: nanoFmt(c.extras.format) })
    case 'Nano Banana 2 Lite':
      return job('nano-banana-2-lite', { prompt: c.prompt, aspect_ratio: c.aspect || 'auto', ...(has ? { image_urls: refs } : {}) })
    case 'Seedream 5 Pro': {
      if (refs.length > 10) throw new Error('Seedream 5 Pro accepts at most 10 reference images.')
      const common = {
        prompt: c.prompt,
        aspect_ratio: c.aspect || '1:1',
        quality: c.resolution === '2K' ? 'high' : 'basic',
        output_format: qwenFmt(c.extras.format),
        // Kie's schema defaults this to false (filter disabled). EasyField keeps
        // provider filtering explicitly enabled instead of exposing an unsafe
        // opt-out in the creative controls.
        nsfw_checker: true,
      }
      return has
        ? job('seedream/5-pro-image-to-image', { ...common, image_urls: refs })
        : job('seedream/5-pro-text-to-image', common)
    }
    case 'Seedream 5 Lite':
      return has
        ? job('seedream/5-lite-image-to-image', { prompt: c.prompt, image_urls: refs, aspect_ratio: c.aspect || '1:1', quality: seedreamQuality(c.resolution) })
        : job('seedream/5-lite-text-to-image', { prompt: c.prompt, aspect_ratio: c.aspect || '1:1', quality: seedreamQuality(c.resolution) })
    case 'Seedream 4.5':
      return has
        ? job('seedream/4.5-edit', { prompt: c.prompt, image_urls: refs, aspect_ratio: c.aspect || '1:1', quality: seedreamQuality(c.resolution) })
        : job('seedream/4.5-text-to-image', { prompt: c.prompt, aspect_ratio: c.aspect || '1:1', quality: seedreamQuality(c.resolution) })
    case 'Wan 2.7 Image':
      return has
        ? job('wan/2-7-image', { prompt: c.prompt, input_urls: refs, resolution: c.resolution || '2K' })
        : job('wan/2-7-image', { prompt: c.prompt, ...(c.aspect ? { aspect_ratio: c.aspect } : {}), resolution: c.resolution || '2K' })
    case 'Qwen2 Image': {
      const t2i = ['1:1', '3:4', '4:3', '9:16', '16:9']
      const size = has ? c.aspect || '16:9' : t2i.includes(c.aspect) ? c.aspect : '16:9'
      return has
        ? job('qwen2/image-edit', { prompt: c.prompt, image_url: refs[0], image_size: size, output_format: qwenFmt(c.extras.format), seed: 0 })
        : job('qwen2/text-to-image', { prompt: c.prompt, image_size: size, output_format: qwenFmt(c.extras.format), seed: 0 })
    }
    case 'Flux 2': {
      const variant = c.extras.variant === 'Pro' ? 'pro' : 'flex'
      const kind = has ? 'image-to-image' : 'text-to-image'
      return job(`flux-2/${variant}-${kind}`, { prompt: c.prompt, ...(has ? { input_urls: refs } : {}), aspect_ratio: c.aspect || '1:1', resolution: c.resolution || '1K' })
    }
    default:
      return job('nano-banana-2', { prompt: c.prompt, aspect_ratio: c.aspect || 'auto' })
  }
}

export interface ImageEditCtx {
  prompt: string
  primarySourceUrl: string
  referenceUrls: string[]
  aspect: string
  resolution: string
  extras: Record<string, string>
}

const primaryEditPrompt = (prompt: string, hasSupportingReferences: boolean): string =>
  hasSupportingReferences
    ? [
        'Edit image 1 only; it is the primary image being edited.',
        'Images 2 and later are supporting visual references only. Do not replace image 1 or transfer their composition unless the edit instruction explicitly asks for it.',
        '',
        `Edit instruction: ${prompt}`,
      ].join('\n')
    : prompt

// Edit Image has a stricter contract than Create Image: the primary source and
// supporting references cannot be collapsed into an untyped list at the call
// site. Unknown models fail closed so a paid edit can never fall back to T2I.
export function buildImageEditRequest(model: string, c: ImageEditCtx): KieRequest {
  const config = IMAGE_MODEL_CONFIG[model]
  if (!config) throw new Error(`${model} is not a verified EasyField image-edit model.`)
  if (!c.primarySourceUrl.trim()) throw new Error('A primary image is required for editing.')
  const supportingLimit = Math.max(0, config.maxReferenceImages - 1)
  if (c.referenceUrls.length > supportingLimit) {
    throw new Error(`${model} accepts at most ${supportingLimit} supporting reference image${supportingLimit === 1 ? '' : 's'}.`)
  }
  return buildImageRequest(model, {
    prompt: primaryEditPrompt(c.prompt, c.referenceUrls.length > 0),
    aspect: c.aspect,
    resolution: c.resolution,
    extras: c.extras,
    imageUrls: [c.primarySourceUrl, ...c.referenceUrls],
  })
}

export interface ImageInpaintCtx {
  prompt: string
  primarySourceUrl: string
  maskUrl: string
}

export function buildImageInpaintRequest(model: string, c: ImageInpaintCtx): KieRequest {
  if (model !== 'Ideogram V3 Edit') throw new Error(`${model} is not a verified EasyField inpaint model.`)
  if (!c.primarySourceUrl.trim()) throw new Error('A primary image is required for inpainting.')
  if (!c.maskUrl.trim()) throw new Error('Paint a mask before running Inpaint.')
  if (!c.prompt.trim()) throw new Error('Describe what should replace the painted area.')
  assertPromptCharacterLimit(c.prompt, IDEOGRAM_V3_EDIT_PROMPT_MAX, 'Ideogram V3 Edit prompt')
  return job('ideogram/v3-edit', {
    prompt: c.prompt,
    image_url: c.primarySourceUrl,
    mask_url: c.maskUrl,
    rendering_speed: 'BALANCED',
    expand_prompt: true,
  })
}

// ===========================================================================
// AVATAR  (Photo + audio generation / existing-video lip sync)
// ===========================================================================
export interface AvatarCtx {
  prompt: string
  imageUrl?: string
  videoUrl?: string
  audioUrl: string
  /** Reviewed people layout for portrait sources; required before submission. */
  subjectLayout?: AvatarSubjectLayout
  /** OmniHuman subject masks created by its dedicated detection endpoint. */
  maskUrls?: string[]
  options?: Partial<AvatarOptions>
}

function requiredHostedAvatarUrl(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? ''
  if (!/^https?:\/\//i.test(normalized)) throw new Error(`${label} must be uploaded before Avatar generation.`)
  return normalized
}

/** Exact Kie helper used to obtain source-bound OmniHuman speaker masks. */
export function buildAvatarSubjectDetectionRequest(imageUrl: string): KieRequest {
  return job('omnihuman-1-5/subject-detection', {
    image_url: requiredHostedAvatarUrl(imageUrl, 'Portrait image'),
  })
}

function assertAvatarPrompt(
  model: string,
  prompt: string,
  mode: 'required' | 'optional' | 'unsupported',
  maximum: number,
  mayBeEmpty = false,
): string {
  const value = String(prompt ?? '')
  if (mode === 'unsupported') {
    if (value.trim()) throw new Error(`${model} does not accept a prompt.`)
    return ''
  }
  if (mode === 'required' && !mayBeEmpty && !value.trim()) throw new Error(`${model} requires a direction prompt.`)
  assertPromptCharacterLimit(value, maximum, `${model} prompt`, 0)
  return value
}

/**
 * Exact Kie Market request serialization for every selectable Avatar model.
 * Unknown models and cross-mode sources fail closed; there is no fallback
 * request because silently routing paid work to a different avatar model would
 * be unsafe.
 */
export function buildAvatarRequest(model: string, c: AvatarCtx): KieRequest {
  const config = requireAvatarModelConfig(model)
  const prompt = assertAvatarPrompt(model, c.prompt, config.prompt, config.promptMax, config.promptMayBeEmpty)
  const audioUrl = requiredHostedAvatarUrl(c.audioUrl, 'Voice audio')
  const options = avatarOptionsForRequest(model, c.options)

  if (config.workflow === 'portrait') {
    if (c.videoUrl) throw new Error(`${model} accepts a portrait image, not a source video.`)
    const imageUrl = requiredHostedAvatarUrl(c.imageUrl, 'Portrait image')
    const maskUrls = c.maskUrls ?? []
    if (!c.subjectLayout) throw new Error('Review whether the portrait contains one person or multiple people before generating.')
    if (c.subjectLayout === 'none') throw new Error('No person was identified in this portrait.')
    if (c.subjectLayout === 'single' && maskUrls.length) {
      throw new Error('A single-person portrait must not include a speaker-selection mask.')
    }
    if (c.subjectLayout === 'multiple') {
      if (config.speakerTargeting !== 'subject-mask') {
        throw new Error(`${model} cannot choose a speaker in a multi-person portrait.`)
      }
      if (maskUrls.length !== 1) throw new Error('Choose exactly one detected person to speak in this portrait.')
    }
    const hostedMasks = maskUrls.map((url, index) => requiredHostedAvatarUrl(url, `Speaker mask ${index + 1}`))

    switch (model) {
      case 'Kling Avatar Pro':
      case 'Kling Avatar Standard':
        return job(config.route, {
          image_url: imageUrl,
          audio_url: audioUrl,
          // The field is required by Kie even though an empty value is valid.
          prompt,
        })
      case 'OmniHuman 1.5':
        return job(config.route, {
          image_url: imageUrl,
          audio_url: audioUrl,
          ...(hostedMasks.length ? { mask_url: hostedMasks } : {}),
          ...(prompt ? { prompt } : {}),
          output_resolution: options.outputResolution ?? '1080',
          pe_fast_mode: options.fastMode ?? false,
          seed: options.seed ?? -1,
        })
      case 'InfiniteTalk':
        return job(config.route, {
          image_url: imageUrl,
          audio_url: audioUrl,
          prompt,
          resolution: options.resolution ?? '480p',
          ...(options.seed === undefined ? {} : { seed: options.seed }),
        })
      case 'Wan 2.2 A14B Speech-to-Video Turbo':
        return job(config.route, {
          prompt,
          image_url: imageUrl,
          audio_url: audioUrl,
          num_frames: options.numFrames ?? 80,
          frames_per_second: options.framesPerSecond ?? 16,
          resolution: options.resolution ?? '480p',
          ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          num_inference_steps: options.numInferenceSteps ?? 27,
          guidance_scale: options.guidanceScale ?? 3.5,
          shift: options.shift ?? 5,
          nsfw_checker: options.nsfwChecker ?? true,
        })
      default:
        // Config.workflow narrows this branch conceptually, but retain an
        // explicit runtime guard when untyped persisted state reaches it.
        throw new Error(`${model} is not a verified portrait Avatar model.`)
    }
  }

  if (c.imageUrl) throw new Error(`${model} accepts a source video, not a portrait image.`)
  if (c.subjectLayout) throw new Error(`${model} does not use portrait subject review for video lip sync.`)
  if (c.maskUrls?.length) throw new Error(`${model} does not accept subject masks.`)
  const videoUrl = requiredHostedAvatarUrl(c.videoUrl, 'Source video')
  if (model !== 'Volcengine Lip Sync') throw new Error(`${model} is not a verified video lip-sync model.`)

  const mode = options.lipSyncMode ?? 'lite'
  if (mode === 'basic') {
    return job(config.route, {
      mode,
      video_url: videoUrl,
      audio_url: audioUrl,
      separate_vocal: options.separateVocal ?? false,
      open_scenedet: options.openSceneDetection ?? false,
    })
  }
  return job(config.route, {
    mode,
    video_url: videoUrl,
    audio_url: audioUrl,
    separate_vocal: options.separateVocal ?? false,
    align_audio: options.alignAudio ?? true,
    align_audio_reverse: options.alignAudioReverse ?? false,
    templ_start_seconds: options.templateStartSeconds ?? 0,
  })
}

// ===========================================================================
// VIDEO  (Create Video)
// ===========================================================================
export interface VideoCtx {
  prompt: string
  negativePrompt: string
  aspect: string
  resolution: string
  duration: string
  extras: Record<string, string>
  firstFrameUrl?: string
  lastFrameUrl?: string
  imageUrls: string[]
  videoUrls: string[]
  audioUrls: string[]
  /** Validated and hosted named elements shared across Kling shots. */
  hostedKlingElements?: KlingHostedElement[]
  webSearch: boolean
  multiShot?: boolean
  shots?: Array<{ prompt: string; duration: number; referenceTags?: string[] }>
  // Omni accepts IDs created by its dedicated character/audio endpoints. Raw
  // files and preset display names are deliberately not accepted as IDs.
  characterIds?: string[]
  audioIds?: string[]
  grokTaskId?: string
  grokIndex?: string
}

const SEEDANCE_MODEL: Record<string, string> = {
  'Seedance 2': 'bytedance/seedance-2',
  'Seedance 2 Fast': 'bytedance/seedance-2-fast',
  'Seedance 2 Mini': 'bytedance/seedance-2-mini',
}
const VEO_MODEL: Record<string, string> = {
  'Veo 3.1 Quality': 'veo3',
  'Veo 3.1 Fast': 'veo3_fast',
  'Veo 3.1 Lite': 'veo3_lite',
}

function seedance(kieModel: string, c: VideoCtx): KieRequest {
  const common = {
    generate_audio: c.extras.audio !== 'Off',
    resolution: res4k(c.resolution || '720p'),
    aspect_ratio: asp(c.aspect || '16:9'),
    duration: intDur(c.duration),
  }
  if (
    (c.firstFrameUrl || c.lastFrameUrl)
    && (c.imageUrls.length || c.videoUrls.length || c.audioUrls.length)
  ) {
    throw new Error('Seedance endpoint frames and multimodal references are mutually exclusive.')
  }
  if (c.imageUrls.length || c.videoUrls.length || c.audioUrls.length) {
    return job(kieModel, {
      prompt: c.prompt,
      ...(c.imageUrls.length ? { reference_image_urls: c.imageUrls } : {}),
      ...(c.videoUrls.length ? { reference_video_urls: c.videoUrls } : {}),
      ...(c.audioUrls.length ? { reference_audio_urls: c.audioUrls } : {}),
      ...common,
    })
  }
  if (c.firstFrameUrl || c.lastFrameUrl) {
    return job(kieModel, {
      prompt: c.prompt,
      ...(c.firstFrameUrl ? { first_frame_url: c.firstFrameUrl } : {}),
      ...(c.lastFrameUrl ? { last_frame_url: c.lastFrameUrl } : {}),
      ...common,
    })
  }
  return job(kieModel, { prompt: c.prompt, ...common, ...(c.webSearch ? { web_search: true } : {}) })
}

function veo(modelId: string, c: VideoCtx): KieRequest {
  const body: Record<string, unknown> = {
    prompt: c.prompt,
    model: modelId,
    aspect_ratio: c.aspect || '16:9',
    resolution: res4k(c.resolution || '720p'),
    duration: intDur(c.duration),
  }
  if ((c.firstFrameUrl || c.lastFrameUrl) && c.imageUrls.length) {
    throw new Error('Veo endpoint frames and reference-image mode are mutually exclusive.')
  }
  if (c.imageUrls.length) {
    body.generationType = 'REFERENCE_2_VIDEO'
    body.imageUrls = c.imageUrls.slice(0, 3)
  } else if (c.firstFrameUrl || c.lastFrameUrl) {
    body.generationType = 'FIRST_AND_LAST_FRAMES_2_VIDEO'
    body.imageUrls = [c.firstFrameUrl, c.lastFrameUrl].filter(Boolean)
  } else {
    body.generationType = 'TEXT_2_VIDEO'
  }
  return { family: 'veo', body }
}

function klingElements(c: VideoCtx): KlingProviderElement[] {
  if (c.imageUrls.length || c.videoUrls.length || c.audioUrls.length) {
    throw new Error('Kling 3 references must be defined as named Elements; flat image, video and audio buckets are not supported.')
  }
  const elements = (c.hostedKlingElements ?? []).map(toKlingProviderElement)
  if (elements.length > KLING_ELEMENT_MAX) {
    throw new Error(`Kling 3 supports at most ${KLING_ELEMENT_MAX} reference elements. Remove one element before generating.`)
  }
  const names = new Set<string>()
  elements.forEach((element) => {
    if (names.has(element.name)) throw new Error(`Kling element tag @${element.name} must be unique.`)
    names.add(element.name)
  })
  return elements
}

function withKlingElementTags(prompt: string, elements: KlingProviderElement[]): string {
  const trimmed = prompt.trim()
  const missing = elements
    .map((element) => `@${element.name}`)
    .filter((tag) => !trimmed.includes(tag))
  return [trimmed, ...missing].filter(Boolean).join(' ')
}

function klingPromptWeight(prompt: string, elements: readonly KlingProviderElement[]): number {
  let weight = promptCharacterCount(prompt)
  elements.forEach((element) => {
    const tag = `@${element.name}`
    if (prompt.includes(tag)) weight += 37 - promptCharacterCount(tag)
  })
  return weight
}

function kling3(c: VideoCtx): KieRequest {
  const elements = klingElements(c)
  if (elements.length && !c.firstFrameUrl) {
    throw new Error('Kling 3 requires a first frame whenever an @element reference is used.')
  }
  const common = {
    sound: c.extras.audio !== 'Off',
    aspect_ratio: c.aspect || '16:9',
    mode: c.resolution === '4K' ? '4K' : c.resolution === '1080p' ? 'pro' : 'std',
    ...(elements.length ? { kling_elements: elements } : {}),
  }

  if (c.multiShot) {
    if (c.lastFrameUrl) throw new Error('Kling 3 multi-shot supports a first frame only; remove the last frame.')
    const sourceShots = c.shots ?? []
    const elementTags = elements.map((element) => `@${element.name}`)
    const draftScenes = sourceShots.map((shot, index) => ({
      id: `provider-shot-${index + 1}`,
      prompt: shot.prompt,
      duration: String(shot.duration),
      referenceTags: shot.referenceTags,
    }))
    const issue = validateMultiShotDraft({
      brief: c.prompt,
      scenes: draftScenes,
      elementTags,
      rules: DEFAULT_MULTI_SHOT_RULES,
    })
    if (issue) throw new Error(issue)
    const shots = compileMultiShotProviderScenes({
      brief: c.prompt,
      scenes: draftScenes,
      elementTags,
      rules: DEFAULT_MULTI_SHOT_RULES,
    })
    const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0)
    return job('kling-3.0/video', {
      multi_shots: true,
      ...(c.firstFrameUrl ? { image_urls: [c.firstFrameUrl] } : {}),
      duration: String(totalDuration),
      ...common,
      multi_prompt: shots,
    })
  }

  if (c.lastFrameUrl && !c.firstFrameUrl) {
    throw new Error('Kling 3 needs a first frame before a last frame can be used.')
  }
  const frameUrls = [c.firstFrameUrl, c.lastFrameUrl].filter((url): url is string => !!url)
  const prompt = withKlingElementTags(c.prompt, elements)
  if (klingPromptWeight(prompt, elements) > 2500) throw new Error('Kling 3 prompts are limited to 2,500 weighted characters; every Element tag uses 37.')
  return job('kling-3.0/video', {
    prompt,
    ...(frameUrls.length ? { image_urls: frameUrls } : {}),
    duration: String(intDur(c.duration)),
    ...common,
    multi_shots: false,
  })
}

export function buildVideoRequest(model: string, c: VideoCtx): KieRequest {
  const neg = c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}
  if (c.multiShot && model !== 'Kling 3') {
    throw new Error('Multi-shot generation is currently supported only by Kling 3.')
  }
  const config = VIDEO_MODEL_CONFIG[model]
  if (config && model !== 'Kling 3') {
    const maximum = model === 'Happy Horse 1.1' ? happyHorsePromptMax(c.prompt) : config.promptMax
    const minimum = SEEDANCE_MODEL[model] ? 3 : 0
    assertPromptCharacterLimit(c.prompt, maximum, `${model} prompt`, minimum)
  }
  if (SEEDANCE_MODEL[model]) return seedance(SEEDANCE_MODEL[model], c)
  if (VEO_MODEL[model]) return veo(VEO_MODEL[model], c)

  switch (model) {
    case 'Kling 3':
      return kling3(c)
    case 'Kling 3 Turbo': {
      if (c.lastFrameUrl || c.imageUrls.length || c.videoUrls.length || c.audioUrls.length || (c.hostedKlingElements?.length ?? 0) > 0) {
        throw new Error('Kling 3 Turbo accepts text or one starting image only; remove endpoint and reference media that this endpoint cannot send.')
      }
      return c.firstFrameUrl
        ? job('kling/v3-turbo-image-to-video', { prompt: c.prompt, image_urls: [c.firstFrameUrl], duration: String(intDur(c.duration)), resolution: c.resolution || '720p' })
        : job('kling/v3-turbo-text-to-video', { prompt: c.prompt, duration: String(intDur(c.duration)), aspect_ratio: c.aspect || '16:9', resolution: c.resolution || '720p' })
    }
    case 'Kling 3 Motion Control':
      if (c.firstFrameUrl || c.lastFrameUrl || c.audioUrls.length || (c.hostedKlingElements?.length ?? 0) > 0) {
        throw new Error('Kling 3 Motion Control accepts one character image and one driver video only.')
      }
      if (c.imageUrls.length !== 1 || c.videoUrls.length !== 1) {
        throw new Error('Kling 3 Motion Control requires exactly one character image and one driver video.')
      }
      return job('kling-3.0/motion-control', {
        prompt: c.prompt,
        input_urls: c.imageUrls.slice(0, 1),
        video_urls: c.videoUrls.slice(0, 1),
        mode: c.resolution === '1080p' ? '1080p' : '720p',
        character_orientation: c.extras.characterOrientation === 'Image' ? 'image' : 'video',
        background_source: c.extras.backgroundSource === 'Image' ? 'input_image' : 'input_video',
      })
    case 'Gemini Omni Video': {
      const characterIds = c.characterIds ?? []
      const audioIds = c.audioIds ?? []
      if (c.videoUrls.length > 1) throw new Error('Gemini Omni supports at most 1 reference video.')
      if (characterIds.length > 3) throw new Error('Gemini Omni supports at most 3 character IDs.')
      if (audioIds.length > 3) throw new Error('Gemini Omni supports at most 3 audio IDs.')
      const quota = c.imageUrls.length + c.videoUrls.length * 2 + characterIds.length
      if (quota > 7) {
        throw new Error('Gemini Omni inputs exceed its 7-unit quota (image=1, video=2, character=1).')
      }
      return job('gemini-omni-video', {
        prompt: c.prompt,
        ...(c.imageUrls.length ? { image_urls: c.imageUrls } : {}),
        ...(c.videoUrls.length ? { video_list: [{ url: c.videoUrls[0], start: 0, ends: intDur(c.duration) }] } : {}),
        ...(characterIds.length ? { character_ids: characterIds } : {}),
        ...(audioIds.length ? { audio_ids: audioIds } : {}),
        duration: String(intDur(c.duration)),
        ...(c.aspect ? { aspect_ratio: c.aspect } : {}),
        resolution: res4k(c.resolution || '720p'),
      })
    }
    case 'Wan 2.7 Video':
      assertPromptCharacterLimit(c.negativePrompt, 500, 'Wan 2.7 negative prompt')
      if (c.lastFrameUrl && c.imageUrls.length) {
        throw new Error('Wan first/last-frame mode and reference-image mode are mutually exclusive.')
      }
      if (c.imageUrls.length) {
        return job('wan/2-7-r2v', {
          prompt: c.prompt, ...neg,
          reference_image: c.imageUrls.slice(0, 5),
          ...(c.videoUrls.length ? { reference_video: c.videoUrls.slice(0, 5) } : {}),
          ...(c.firstFrameUrl ? { first_frame: c.firstFrameUrl } : {}),
          ...(c.audioUrls[0] ? { reference_voice: c.audioUrls[0] } : {}),
          resolution: c.resolution || '1080p', aspect_ratio: c.aspect || '16:9', duration: intDur(c.duration),
        })
      }
      if (c.firstFrameUrl || c.lastFrameUrl || c.videoUrls[0]) {
        return job('wan/2-7-image-to-video', {
          prompt: c.prompt, ...neg,
          ...(c.firstFrameUrl ? { first_frame_url: c.firstFrameUrl } : {}),
          ...(c.lastFrameUrl ? { last_frame_url: c.lastFrameUrl } : {}),
          ...(c.videoUrls[0] ? { first_clip_url: c.videoUrls[0] } : {}),
          ...(c.audioUrls[0] ? { driving_audio_url: c.audioUrls[0] } : {}),
          resolution: c.resolution || '1080p', duration: intDur(c.duration),
        })
      }
      return job('wan/2-7-text-to-video', {
        prompt: c.prompt, ...neg,
        ...(c.audioUrls[0] ? { audio_url: c.audioUrls[0] } : {}),
        resolution: c.resolution || '1080p', ratio: c.aspect || '16:9', duration: intDur(c.duration),
      })
    case 'Happy Horse 1.1':
      if (c.imageUrls.length) return job('happyhorse-1-1/reference-to-video', { prompt: c.prompt, reference_image: c.imageUrls.slice(0, 9), resolution: c.resolution || '1080p', aspect_ratio: c.aspect || '16:9', duration: intDur(c.duration) })
      if (c.firstFrameUrl) return job('happyhorse-1-1/image-to-video', { prompt: c.prompt, image_urls: [c.firstFrameUrl], resolution: c.resolution || '1080p', duration: intDur(c.duration) })
      return job('happyhorse-1-1/text-to-video', { prompt: c.prompt, resolution: c.resolution || '1080p', aspect_ratio: c.aspect || '16:9', duration: intDur(c.duration) })
    case 'Grok Imagine Video': {
      const duration = intDur(c.duration)
      const mode = lc(c.extras.mode) || 'normal'
      const aspect = c.aspect || (c.imageUrls.length || c.grokTaskId ? '16:9' : '2:3')
      const resolution = c.resolution || '480p'
      if (!c.prompt.trim() && !c.imageUrls.length && !c.grokTaskId) throw new Error('Grok Imagine text-to-video requires a prompt.')
      if (duration < 6 || duration > 30) throw new Error('Original Grok Imagine supports 6–30 seconds.')
      if (!['normal', 'fun', 'spicy'].includes(mode)) throw new Error('Choose Normal, Fun, or Spicy mode for original Grok Imagine.')
      if (!['480p', '720p'].includes(resolution)) throw new Error('Original Grok Imagine supports 480p or 720p.')
      if (!['2:3', '3:2', '1:1', '16:9', '9:16'].includes(aspect)) throw new Error('Choose a supported Grok Imagine aspect ratio.')
      if (c.imageUrls.length > 7) throw new Error('Original Grok Imagine accepts at most 7 reference images.')
      if (c.grokTaskId && c.imageUrls.length) throw new Error('Use either a prior Grok task or external images, not both.')
      if (c.imageUrls.length && mode === 'spicy') throw new Error('Spicy mode is unavailable with external Grok reference images.')

      // Kie's regular I2V schema and both official examples serialize duration
      // as a string; Preview 1.5 deliberately uses an integer instead.
      const common = { prompt: c.prompt, mode, duration: String(duration), resolution, aspect_ratio: aspect, nsfw_checker: true }
      if (c.grokTaskId) {
        const index = Number(c.grokIndex) || 0
        if (c.grokTaskId.length > 100) throw new Error('The prior Grok task ID must be 100 characters or fewer.')
        if (!Number.isInteger(index) || index < 0 || index > 5) throw new Error('Choose a Grok image index from 0 to 5.')
        return job('grok-imagine/image-to-video', { task_id: c.grokTaskId, index, ...common })
      }
      if (c.imageUrls.length) return job('grok-imagine/image-to-video', { image_urls: c.imageUrls, ...common })
      return job('grok-imagine/text-to-video', common)
    }
    case 'Grok Imagine 1.5 Preview': {
      const duration = intDur(c.duration)
      if (!c.prompt.trim()) throw new Error('Grok Imagine 1.5 Preview requires a prompt.')
      if (c.imageUrls.length > 1) throw new Error('Grok Imagine 1.5 Preview accepts at most one reference image.')
      if (duration < 1 || duration > 15) throw new Error('Grok Imagine 1.5 Preview supports 1–15 seconds.')
      if (!['480p', '720p'].includes(c.resolution || '480p')) throw new Error('Grok Imagine 1.5 Preview supports 480p or 720p.')
      if (!['Auto', 'auto', '1:1', '16:9', '9:16', '3:2', '2:3'].includes(c.aspect || 'Auto')) throw new Error('Choose a supported Grok Imagine 1.5 aspect ratio.')
      return job('grok-imagine-video-1-5-preview', {
        prompt: c.prompt,
        ...(c.imageUrls[0] ? { image_urls: [c.imageUrls[0]] } : {}),
        aspect_ratio: c.aspect === 'Auto' ? 'auto' : c.aspect || 'auto',
        resolution: c.resolution || '480p',
        duration,
        nsfw_checker: true,
      })
    }
    case 'Runway AI Video':
      return {
        family: 'runway',
        body: {
          prompt: c.prompt,
          duration: Number(c.duration) || 5,
          quality: c.resolution || '720p',
          aspectRatio: c.aspect || '16:9',
          ...(c.firstFrameUrl ? { imageUrl: c.firstFrameUrl } : {}),
        },
      }
    case 'Hailuo 2.3 Pro': {
      if (!c.firstFrameUrl) throw new Error('Hailuo 2.3 Pro requires a first-frame image.')
      if (c.resolution.toUpperCase() === '1080P' && stripS(c.duration) === '10') throw new Error('Hailuo 2.3 Pro supports 1080P output at 6 seconds only.')
      return job('hailuo/2-3-image-to-video-pro', {
        prompt: c.prompt,
        image_url: c.firstFrameUrl,
        duration: stripS(c.duration) || '6',
        resolution: c.resolution || '768P',
      })
    }
    case 'Hailuo 2.3 Standard': {
      if (!c.firstFrameUrl) throw new Error('Hailuo 2.3 Standard requires a first-frame image.')
      if (c.resolution.toUpperCase() === '1080P' && stripS(c.duration) === '10') throw new Error('Hailuo 2.3 Standard supports 1080P output at 6 seconds only.')
      return job('hailuo/2-3-image-to-video-standard', {
        prompt: c.prompt,
        image_url: c.firstFrameUrl,
        duration: stripS(c.duration) || '6',
        resolution: c.resolution || '768P',
        nsfw_checker: true,
      })
    }
    default:
      return job('bytedance/seedance-2', { prompt: c.prompt, resolution: '720p', aspect_ratio: '16:9', duration: intDur(c.duration) })
  }
}

// Video models that REQUIRE a start frame / source to run (image-to-video only).
export const VIDEO_NEEDS_FRAME = new Set(['Hailuo 2.3 Standard', 'Hailuo 2.3 Pro'])

// ===========================================================================
// EDIT VIDEO  (prompt edit + contextual upscale utility)
// ===========================================================================
export interface VideoEditCtx {
  prompt: string
  sourceUrl: string
  refImageUrls: string[]
  refVideoUrls: string[]
  refAudioUrls: string[]
  params: Record<string, string>
  factor: string
}

export function buildVideoUpscaleRequest(sourceUrl: string, factor: string): KieRequest {
  return job('topaz/video-upscale', {
    video_url: sourceUrl,
    upscale_factor: topazFactor(factor, ['1', '2', '4'], 'video'),
    nsfw_checker: true,
  })
}

export function buildVideoEditRequest(model: string, c: VideoEditCtx): KieRequest {
  const p = c.params
  const hasSupportingReferences = c.refImageUrls.length > 0 || c.refVideoUrls.length > 0 || c.refAudioUrls.length > 0
  const prompt = hasSupportingReferences
    ? [
        'Transform the primary video source. It is the edit target.',
        'All other attached images, videos, and audio are supporting references only; do not replace the primary source unless the edit instruction explicitly asks for it.',
        '',
        `Edit instruction: ${c.prompt}`,
      ].join('\n')
    : c.prompt
  const config = VIDEO_EDIT_CONFIG[model]
  if (config) {
    const maximum = model === 'HappyHorse Video Edit' ? happyHorsePromptMax(prompt) : config.promptMax
    const minimum = model === 'Seedance 2' || model === 'Seedance 2 Fast' || model === 'Seedance 2 Mini' ? 3 : 0
    assertPromptCharacterLimit(prompt, maximum, `${model} prompt`, minimum)
  }
  const acceptsReferenceAudio = model === 'Seedance 2' || model === 'Seedance 2 Fast' || model === 'Seedance 2 Mini'
  if (c.refAudioUrls.length && !acceptsReferenceAudio) {
    throw new Error(`${model} does not accept uploaded reference audio in Kie.`)
  }
  if (c.refAudioUrls.length > 3) throw new Error('Seedance accepts at most 3 reference audio files.')
  if (c.refAudioUrls.some((url) => !url.trim())) throw new Error('Reference audio URLs cannot be empty.')
  switch (model) {
    case 'Runway Aleph':
      return {
        family: 'aleph',
        body: {
          prompt,
          videoUrl: c.sourceUrl,
        },
      }
    case 'Wan 2.7 Video Edit':
      return job('wan/2-7-videoedit', {
        prompt,
        video_url: c.sourceUrl,
        ...(c.refImageUrls[0] ? { reference_image: c.refImageUrls[0] } : {}),
        resolution: p.resolution || '1080p',
        ...(p.aspect ? { aspect_ratio: p.aspect } : {}),
        duration: p.duration === 'Full' || !p.duration ? 0 : parseInt(p.duration, 10),
        audio_setting: p.audio === 'Origin' ? 'origin' : 'auto',
      })
    case 'HappyHorse Video Edit':
      return job('happyhorse/video-edit', {
        prompt,
        video_url: c.sourceUrl,
        ...(c.refImageUrls.length ? { reference_image: c.refImageUrls } : {}),
        resolution: p.resolution || '1080p',
        audio_setting: p.audio === 'Origin' ? 'origin' : 'auto',
      })
    case 'Seedance 2':
    case 'Seedance 2 Fast':
    case 'Seedance 2 Mini': {
      const kieModel = model === 'Seedance 2 Fast'
        ? 'bytedance/seedance-2-fast'
        : model === 'Seedance 2 Mini'
          ? 'bytedance/seedance-2-mini'
          : 'bytedance/seedance-2'
      return job(kieModel, {
        prompt,
        reference_video_urls: [c.sourceUrl, ...c.refVideoUrls].slice(0, 3),
        ...(c.refImageUrls.length ? { reference_image_urls: c.refImageUrls } : {}),
        ...(c.refAudioUrls.length ? { reference_audio_urls: c.refAudioUrls } : {}),
        generate_audio: p.audio !== 'Off',
        resolution: res4k(p.resolution || '720p'),
        aspect_ratio: asp(p.aspect || '16:9'),
        duration: intDur(stripS(p.duration)),
      })
    }
    case 'Gemini Omni Video': {
      const secs = Number(stripS(p.duration)) || 4
      return job('gemini-omni-video', {
        prompt,
        ...(c.refImageUrls.length ? { image_urls: c.refImageUrls.slice(0, 7) } : {}),
        video_list: [{ url: c.sourceUrl, start: 0, ends: secs }],
        duration: String(secs),
        ...(p.aspect ? { aspect_ratio: p.aspect } : {}),
        resolution: res4k(p.resolution || '720p'),
      })
    }
    default:
      throw new Error(`${model} is not a verified EasyField video-reference model.`)
  }
}

// ===========================================================================
// EDIT IMAGE  (Upscale · Remove BG)
// ===========================================================================
export function buildImageUpscaleRequest(model: string, sourceUrl: string, factor: string): KieRequest {
  // Topaz exposes upscale_factor; Recraft Crisp Upscale takes only the image.
  if (model === 'Recraft Crisp Upscale') return job('recraft/crisp-upscale', { image_url: sourceUrl })
  return job('topaz/image-upscale', {
    image_url: sourceUrl,
    upscale_factor: topazFactor(factor, ['1', '2', '4', '8'], 'image'),
    nsfw_checker: true,
  })
}

export function buildRemoveBgRequest(sourceUrl: string): KieRequest {
  return job('recraft/remove-background', { image_url: sourceUrl })
}

// ===========================================================================
// AUDIO  (Voice Over · Create Music · Sound Effects)
// ===========================================================================
const assertLength = (value: string, maximum: number, label: string) =>
  assertPromptCharacterLimit(value, maximum, label)

const assertRange = (value: number, min: number, max: number, label: string) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`)
}

export function buildTtsRequest(modelId: string, voice: string, text: string, settings: TtsSettings): KieRequest {
  if (!text.trim()) throw new Error('Voice-over text is required.')
  assertLength(text, 5000, 'Voice-over text')
  assertLength(settings.previousText, 5000, 'Previous context')
  assertLength(settings.nextText, 5000, 'Next context')
  assertRange(settings.stability, 0, 1, 'Stability')
  assertRange(settings.similarity, 0, 1, 'Similarity')
  assertRange(settings.style, 0, 1, 'Style')
  assertRange(settings.speed, 0.7, 1.2, 'Speed')
  const model = modelId === 'turbo-2-5' ? 'elevenlabs/text-to-speech-turbo-2-5' : 'elevenlabs/text-to-speech-multilingual-v2'
  const languageCode = settings.languageCode.trim().toLowerCase()
  if (modelId === 'turbo-2-5' && languageCode && !/^[a-z]{2}$/.test(languageCode)) {
    throw new Error('Turbo v2.5 language must be a two-letter ISO 639-1 code.')
  }
  return job(model, {
    text,
    voice,
    stability: settings.stability,
    similarity_boost: settings.similarity,
    style: settings.style,
    speed: settings.speed,
    timestamps: settings.timestamps,
    previous_text: settings.previousText,
    next_text: settings.nextText,
    // Kie's schema warns that language enforcement is supported by Turbo v2.5
    // only. Never leak a saved Turbo language into Multilingual v2.
    ...(modelId === 'turbo-2-5' && languageCode ? { language_code: languageCode } : {}),
  })
}

export function buildDialogueRequest(lines: Array<{ voice: string; text: string }>, settings: DialogueSettings): KieRequest {
  const dialogue = lines.filter((line) => line.text.trim()).map((line) => ({ text: line.text, voice: line.voice }))
  const totalLength = dialogue.reduce((sum, line) => sum + promptCharacterCount(line.text), 0)
  if (!dialogue.length) throw new Error('Add at least one dialogue line.')
  if (totalLength > 5000) throw new Error('Dialogue text must total 5,000 characters or fewer.')
  if (settings.stability !== 0 && settings.stability !== 0.5 && settings.stability !== 1) {
    throw new Error('Dialogue stability must be exactly 0, 0.5, or 1.')
  }
  const languageCode = settings.languageCode.trim().toLowerCase()
  if (!DIALOGUE_LANGUAGE_CODES.has(languageCode)) throw new Error('Choose a language supported by Eleven v3 Dialogue.')
  return job('elevenlabs/text-to-dialogue-v3', {
    dialogue,
    stability: settings.stability,
    ...(languageCode ? { language_code: languageCode } : {}),
  })
}

export const SOUND_EFFECT_KEYS = [
  'Any',
  'Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bm',
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const

export interface SoundEffectCtx {
  model: 'V5_5' | 'V5'
  prompt: string
  loop: boolean
  bpm: number
  key: (typeof SOUND_EFFECT_KEYS)[number]
  grabLyrics: boolean
}

export function buildSoundEffectRequest(sound: SoundEffectCtx): KieRequest {
  const prompt = sound.prompt.trim()
  if (!prompt) throw new Error('Describe the sound effect before generating.')
  assertPromptCharacterLimit(prompt, 500, 'Suno Sounds prompt')
  if (sound.model !== 'V5_5' && sound.model !== 'V5') throw new Error('Choose Suno Sounds v5.5 or v5.')
  if (!Number.isInteger(sound.bpm) || sound.bpm < 1 || sound.bpm > 300) {
    throw new Error('BPM must be a whole number from 1 to 300.')
  }
  if (!SOUND_EFFECT_KEYS.includes(sound.key)) throw new Error('Choose a supported Suno key.')

  return {
    family: 'sounds',
    body: {
      prompt,
      model: sound.model,
      soundLoop: sound.loop,
      soundTempo: sound.bpm,
      ...(sound.key === 'Any' ? {} : { soundKey: sound.key }),
      grabLyrics: sound.grabLyrics,
    },
  }
}

export interface MusicCtx {
  version: string
  mode: string
  instrumental: boolean
  prompt: string
  style: string
  title: string
  negativeTags: string
  vocalGender: string
  sliders: Record<string, number>
}

export function buildMusicRequest(m: MusicCtx): KieRequest {
  const custom = m.mode === 'Custom'
  if (custom) {
    const legacyV4 = m.version === 'V4'
    assertPromptCharacterLimit(m.prompt, legacyV4 ? 3_000 : 5_000, 'Suno custom prompt')
    assertPromptCharacterLimit(m.style, legacyV4 ? 200 : 1_000, 'Suno style')
    assertPromptCharacterLimit(m.title, 80, 'Suno title')
  } else {
    assertPromptCharacterLimit(m.prompt, 500, 'Suno simple prompt')
  }
  const body: Record<string, unknown> = {
    prompt: m.prompt,
    customMode: custom,
    instrumental: m.instrumental,
    model: m.version,
    // kie.ai marks callBackUrl required; we poll for the result, so a placeholder
    // is fine (the failed callback POST is harmless and ignored).
    callBackUrl: 'https://easyfield.app/kie/callback',
  }
  if (custom) {
    if (m.style) body.style = m.style
    if (m.title) body.title = m.title
    if (m.negativeTags) body.negativeTags = m.negativeTags
    if (m.vocalGender && m.vocalGender !== 'Any') body.vocalGender = m.vocalGender === 'Male' ? 'm' : 'f'
    body.styleWeight = m.sliders.styleWeight
    body.weirdnessConstraint = m.sliders.weirdness
    body.audioWeight = m.sliders.audioWeight
  }
  return { family: 'suno', body }
}
