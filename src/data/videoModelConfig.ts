// Per-model video generation options, sourced from published cloud API
// schemas. Verified 2026-07-13 — frame inputs, reference
// images, video/audio inputs, exclusivity, and duration ranges/gating.
//
// Input families:
//  - firstFrame / lastFrame: start & end still frames for image-to-video.
//  - referenceImages: subject/consistency reference images.
//  - video / audio: uploadable video and audio inputs (reference clips, motion
//    driver, continuation clip, or lip-sync voice — see each `label`).
//  - framesRefsExclusive: the schema documents frames vs the reference/multimodal
//    bucket as mutually exclusive for some models. `inBucket` marks which
//    video/audio inputs belong to that exclusive bucket (locked in frame mode).
import type { MultiShotRules } from './videoMultiShot.ts'
import { HAPPY_HORSE_PROMPT_MAX, PROVIDER_UNPUBLISHED_PROMPT_MAX } from './promptLimits.ts'

export type FrameMode = 'frames' | 'references' | 'text'

export interface VideoModelOption {
  key: string
  label: string
  values: string[]
}

// Which exclusivity group a video/audio input belongs to:
//  - 'frame': part of the first/last-frame side (locked when references are used)
//  - 'bucket': part of the reference/multimodal bucket (locked in frame mode)
//  - 'free': always available, never locked
export type MediaSide = 'frame' | 'bucket' | 'free'

export interface VideoMediaInput {
  max: number
  label: string
  addLabel: string
  side: MediaSide
}

export interface VideoModelConfig {
  firstFrame: boolean
  lastFrame: boolean
  // The model can use a video as the Extend source/reference. This is explicit
  // because not every generic video input is semantically valid for Extend.
  extendVideoReference?: boolean
  referenceImages: boolean
  maxReferenceImages: number
  framesRefsExclusive: boolean
  video?: VideoMediaInput
  audio?: VideoMediaInput
  aspectRatios: string[]
  resolutions: string[]
  durations: string[]
  durationDefault: string
  /** Provider prompt ceiling, or EasyField's explicit fallback when the schema omits one. */
  promptMax: number
  durationFor?: (ctx: { resolution: string; mode: FrameMode }) => string[]
  extraOptions: VideoModelOption[]
  // Creative extras from the active cloud schema.
  negativePrompt?: boolean
  webSearch?: boolean
  multiShot?: MultiShotRules
  characterRefs?: { max: number }
  voices?: { max: number; presets: string[] }
}

const range = (min: number, max: number, step = 1): string[] => {
  const out: string[] = []
  for (let v = min; v <= max; v += step) out.push(String(v))
  return out
}

// Native audio-generation toggle (output), distinct from uploaded audio input.
const GEN_AUDIO_OPTION: VideoModelOption = { key: 'audio', label: 'GENERATE AUDIO', values: ['On', 'Off'] }

const SEEDANCE_VIDEO: VideoMediaInput = { max: 3, label: 'REFERENCE VIDEOS', addLabel: 'video', side: 'bucket' }
const SEEDANCE_AUDIO: VideoMediaInput = { max: 3, label: 'REFERENCE AUDIO', addLabel: 'audio', side: 'bucket' }

export const VIDEO_MODEL_CONFIG: Record<string, VideoModelConfig> = {
  // Seedance 2 schema — reference_video_urls / reference_audio_urls
  // live in the multimodal-reference bucket (exclusive with first/last frames).
  'Seedance 2': {
    promptMax: 20_000,
    firstFrame: true,
    lastFrame: true,
    extendVideoReference: true,
    referenceImages: true,
    maxReferenceImages: 9,
    framesRefsExclusive: true,
    video: SEEDANCE_VIDEO,
    audio: SEEDANCE_AUDIO,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'Adaptive'],
    resolutions: ['480p', '720p', '1080p', '4K'],
    durations: range(4, 15),
    durationDefault: '5',
    extraOptions: [GEN_AUDIO_OPTION],
    webSearch: true,
  },
  'Seedance 2 Fast': {
    promptMax: 20_000,
    firstFrame: true,
    lastFrame: true,
    extendVideoReference: true,
    referenceImages: true,
    maxReferenceImages: 9,
    framesRefsExclusive: true,
    video: SEEDANCE_VIDEO,
    audio: SEEDANCE_AUDIO,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'Adaptive'],
    resolutions: ['480p', '720p'],
    durations: range(4, 15),
    durationDefault: '5',
    extraOptions: [GEN_AUDIO_OPTION],
    webSearch: true,
  },
  'Seedance 2 Mini': {
    promptMax: 20_000,
    firstFrame: true,
    lastFrame: true,
    extendVideoReference: true,
    referenceImages: true,
    maxReferenceImages: 9,
    framesRefsExclusive: true,
    video: SEEDANCE_VIDEO,
    audio: SEEDANCE_AUDIO,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'Adaptive'],
    resolutions: ['480p', '720p'],
    durations: range(4, 15),
    durationDefault: '5',
    extraOptions: [GEN_AUDIO_OPTION],
    webSearch: true,
  },
  // Kling 3 schema — recurring media is represented by the
  // dedicated named Element bank, never by generic flat reference buckets.
  'Kling 3': {
    firstFrame: true,
    lastFrame: true,
    referenceImages: false,
    maxReferenceImages: 0,
    framesRefsExclusive: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p', '4K'],
    durations: range(3, 15),
    durationDefault: '5',
    promptMax: 2500,
    extraOptions: [GEN_AUDIO_OPTION],
    multiShot: {
      minShots: 2,
      maxShots: 5,
      shotMin: 1,
      shotMax: 12,
      totalMin: 3,
      totalMax: 15,
      promptMax: 500,
      briefMax: 260,
    },
  },
  // Kling 3 Turbo image-to-video schema — single starting frame only.
  'Kling 3 Turbo': {
    firstFrame: true,
    lastFrame: false,
    referenceImages: false,
    maxReferenceImages: 0,
    framesRefsExclusive: false,
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p'],
    durations: range(3, 15),
    durationDefault: '5',
    promptMax: 2500,
    extraOptions: [],
  },
  // Kling Motion Control schema — character reference image + a
  // required driver video whose motion is transferred; no controllable duration.
  'Kling 3 Motion Control': {
    firstFrame: false,
    lastFrame: false,
    referenceImages: true,
    maxReferenceImages: 1,
    framesRefsExclusive: false,
    video: { max: 1, label: 'DRIVER VIDEO', addLabel: 'driver video', side: 'free' },
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [],
    durationDefault: '',
    promptMax: 2500,
    extraOptions: [
      { key: 'characterOrientation', label: 'CHARACTER ORIENTATION', values: ['Video', 'Image'] },
      { key: 'backgroundSource', label: 'BACKGROUND SOURCE', values: ['Video', 'Image'] },
    ],
  },
  // Hailuo 2.3 Pro image-to-video schema — single first frame; 10s blocked at 1080P.
  'Hailuo 2.3 Pro': {
    promptMax: 5_000,
    firstFrame: true,
    lastFrame: false,
    referenceImages: false,
    maxReferenceImages: 0,
    framesRefsExclusive: false,
    aspectRatios: [],
    resolutions: ['768P', '1080P'],
    durations: ['6', '10'],
    durationDefault: '6',
    durationFor: ({ resolution }) => (resolution === '1080P' ? ['6'] : ['6', '10']),
    extraOptions: [],
  },
  // The Runway cloud route does not expose
  // the underlying Runway model identity, so the UI intentionally stays generic.
  // imageUrl (first frame) switches to image-to-video; 1080p and 10s are mutually
  // exclusive (1080p ⇒ 5s only).
  'Runway AI Video': {
    promptMax: 1_800,
    firstFrame: true,
    lastFrame: false,
    referenceImages: false,
    maxReferenceImages: 0,
    framesRefsExclusive: false,
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    resolutions: ['720p', '1080p'],
    durations: ['5', '10'],
    durationDefault: '5',
    durationFor: ({ resolution }) => (resolution === '1080p' ? ['5'] : ['5', '10']),
    extraOptions: [],
  },
  // Veo 3.1 schema — no video/audio uploads (native audio output only).
  'Veo 3.1 Quality': {
    // The current Veo cloud schema publishes no prompt ceiling.
    promptMax: PROVIDER_UNPUBLISHED_PROMPT_MAX,
    firstFrame: true,
    lastFrame: true,
    referenceImages: false,
    maxReferenceImages: 0,
    framesRefsExclusive: false,
    aspectRatios: ['16:9', '9:16', 'Auto'],
    resolutions: ['720p', '1080p', '4K'],
    durations: ['4', '6', '8'],
    durationDefault: '8',
    extraOptions: [],
  },
  'Veo 3.1 Fast': {
    // The current Veo cloud schema publishes no prompt ceiling.
    promptMax: PROVIDER_UNPUBLISHED_PROMPT_MAX,
    firstFrame: true,
    lastFrame: true,
    referenceImages: true,
    maxReferenceImages: 3,
    framesRefsExclusive: true,
    aspectRatios: ['16:9', '9:16', 'Auto'],
    resolutions: ['720p', '1080p', '4K'],
    durations: ['4', '6', '8'],
    durationDefault: '8',
    durationFor: ({ mode }) => (mode === 'references' ? ['8'] : ['4', '6', '8']),
    extraOptions: [],
  },
  'Veo 3.1 Lite': {
    // The current Veo cloud schema publishes no prompt ceiling.
    promptMax: PROVIDER_UNPUBLISHED_PROMPT_MAX,
    firstFrame: true,
    lastFrame: true,
    referenceImages: true,
    maxReferenceImages: 3,
    framesRefsExclusive: true,
    aspectRatios: ['16:9', '9:16', 'Auto'],
    resolutions: ['720p', '1080p', '4K'],
    durations: ['4', '6', '8'],
    durationDefault: '8',
    durationFor: ({ mode }) => (mode === 'references' ? ['8'] : ['4', '6', '8']),
    extraOptions: [],
  },
  // Gemini Omni Video schema — reference images + one reference video
  // (audio_ids are generated voices, not uploads); all inputs coexist freely.
  'Gemini Omni Video': {
    promptMax: 20_000,
    firstFrame: false,
    lastFrame: false,
    referenceImages: true,
    maxReferenceImages: 7,
    framesRefsExclusive: false,
    video: { max: 1, label: 'REFERENCE VIDEO', addLabel: 'video', side: 'free' },
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4K'],
    durations: ['4', '6', '8', '10'],
    durationDefault: '8',
    extraOptions: [],
    characterRefs: { max: 3 },
    voices: {
      max: 3,
      presets: ['Achernar', 'Achird', 'Algenib', 'Alnilam', 'Gacrux', 'Schedar', 'Sulafat', 'Zubenelgenubi'],
    },
  },
  // Wan 2.7 schema — image-to-video (first/last frame + continuation
  // clip + lip-sync voice) and reference-to-video/r2v (up to 5 reference images +
  // reference voice) are separate, mutually-exclusive endpoints.
  'Wan 2.7 Video': {
    promptMax: 5_000,
    firstFrame: true,
    lastFrame: true,
    extendVideoReference: true,
    referenceImages: true,
    maxReferenceImages: 5,
    framesRefsExclusive: true,
    video: { max: 1, label: 'CONTINUATION CLIP', addLabel: 'clip', side: 'frame' },
    audio: { max: 1, label: 'VOICE AUDIO', addLabel: 'audio', side: 'free' },
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resolutions: ['720p', '1080p'],
    durations: range(2, 15),
    durationDefault: '5',
    extraOptions: [],
    negativePrompt: true,
  },
  // Happy Horse 1.1 schema — image inputs only.
  'Happy Horse 1.1': {
    // The T2V schema declares maxLength 4,999 (I2V describes 5,000).
    promptMax: HAPPY_HORSE_PROMPT_MAX,
    firstFrame: true,
    lastFrame: false,
    referenceImages: true,
    maxReferenceImages: 9,
    framesRefsExclusive: true,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'],
    resolutions: ['720p', '1080p'],
    durations: ['5', '10', '15'],
    durationDefault: '5',
    durationFor: ({ mode }) => (mode === 'references' ? range(3, 15) : ['5', '10', '15']),
    extraOptions: [],
  },
  // Grok Imagine image-to-video schema — image inputs only.
  'Grok Imagine Video': {
    promptMax: 5_000,
    firstFrame: false,
    lastFrame: false,
    referenceImages: true,
    maxReferenceImages: 7,
    framesRefsExclusive: false,
    aspectRatios: ['2:3', '3:2', '1:1', '16:9', '9:16'],
    resolutions: ['480p', '720p'],
    durations: range(6, 30),
    durationDefault: '6',
    extraOptions: [{ key: 'mode', label: 'MODE', values: ['Normal', 'Fun', 'Spicy'] }],
  },
  // Grok Imagine 1.5 Preview is a distinct schema,
  // not an alias for the generic Grok Imagine text/image-to-video endpoints.
  'Grok Imagine 1.5 Preview': {
    promptMax: 4_096,
    firstFrame: false,
    lastFrame: false,
    referenceImages: true,
    maxReferenceImages: 1,
    framesRefsExclusive: false,
    aspectRatios: ['Auto', '1:1', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['480p', '720p'],
    durations: range(1, 15),
    durationDefault: '8',
    extraOptions: [],
  },
  // Hailuo 2.3 Standard image-to-video schema — required first
  // frame; 10-second jobs are unavailable at 1080P.
  'Hailuo 2.3 Standard': {
    promptMax: 5_000,
    firstFrame: true,
    lastFrame: false,
    referenceImages: false,
    maxReferenceImages: 0,
    framesRefsExclusive: false,
    aspectRatios: [],
    resolutions: ['768P', '1080P'],
    durations: ['6', '10'],
    durationDefault: '6',
    durationFor: ({ resolution }) => (resolution === '1080P' ? ['6'] : ['6', '10']),
    extraOptions: [],
  },
}

function pickDefault(list: string[], preferred: string[]): string {
  for (const p of preferred) {
    if (list.includes(p)) return p
  }
  return list[0] ?? ''
}

export function defaultVideoOptionsFor(model: string): {
  aspect: string
  resolution: string
  duration: string
  extraOptionValues: Record<string, string>
} {
  const cfg = VIDEO_MODEL_CONFIG[model]
  const extraOptionValues: Record<string, string> = {}
  cfg.extraOptions.forEach((opt) => {
    extraOptionValues[opt.key] = opt.values[0]
  })
  return {
    aspect: pickDefault(cfg.aspectRatios, ['16:9', '1:1']),
    resolution: cfg.resolutions[0] ?? '',
    duration: cfg.durationDefault,
    extraOptionValues,
  }
}
