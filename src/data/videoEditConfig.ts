// Per-model options for Edit Video, sourced from kie.ai's published API schemas
// (docs.kie.ai) for models whose INPUT includes a video. Verified 2026-07-13.
//
// "Everything that accepts a video" is eligible here: dedicated video-to-video
// editors (Runway Aleph, Wan 2.7 VideoEdit, HappyHorse) and multimodal
// reference-to-video models (Seedance 2 / Fast, Gemini Omni). Motion Control
// is a distinct two-input generation workflow and lives in Create Video.
//
// refImages / refVideos / refAudios = how many EXTRA reference assets the model
// accepts on top of the source clip (source occupies one video slot).
// Only creative options are surfaced; envelope + safety fields are omitted.

export interface VideoEditParam {
  key: string
  label: string
  control: 'dropdown' | 'chip'
  values: string[]
  default: string
}

export interface VideoEditModelConfig {
  /** Provider ceiling for the final prompt sent after EasyField context. */
  promptMax: number
  params: VideoEditParam[]
  refImages: number // extra reference images (0 = none)
  refVideos: number // extra reference videos beyond the source clip (0 = none)
  refAudios: number // uploaded reference audio files (0 = none)
}

const ASPECT_WAN27 = ['16:9', '9:16', '1:1', '4:3', '3:4'] // wan/2-7-videoedit
const ASPECT_SEEDANCE = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'Adaptive'] // bytedance/seedance-2
const ASPECT_GEMINI = ['16:9', '9:16'] // gemini-omni-video
const SEEDANCE_DURATIONS = ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'] // 4-15s

// Keyed by display name. Every model listed in CUSTOM_VIDEO_MODELS has a
// verified video input; the source clip remains separate from extra refs.
export const VIDEO_EDIT_CONFIG: Record<string, VideoEditModelConfig> = {
  // docs.kie.ai/runway-api/generate-aleph-video — prompt + videoUrl.
  'Runway Aleph': {
    promptMax: 2_048,
    refImages: 0,
    refVideos: 0,
    refAudios: 0,
    params: [],
  },
  // docs.kie.ai/market/wan/2-7-videoedit — duration "0 or 2-10" (0 = full source length).
  'Wan 2.7 Video Edit': {
    promptMax: 5_000,
    refImages: 1,
    refVideos: 0,
    refAudios: 0,
    params: [
      { key: 'aspect', label: 'ASPECT', control: 'dropdown', values: ASPECT_WAN27, default: '16:9' },
      { key: 'resolution', label: 'RESOLUTION', control: 'chip', values: ['720p', '1080p'], default: '1080p' },
      { key: 'duration', label: 'DURATION', control: 'dropdown', values: ['Full', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s'], default: 'Full' },
      { key: 'audio', label: 'AUDIO', control: 'chip', values: ['Auto', 'Origin'], default: 'Auto' },
    ],
  },
  // docs.kie.ai/market/happyhorse/video-edit — resolution + audio_setting, up to 5 ref images.
  'HappyHorse Video Edit': {
    promptMax: 5_000,
    refImages: 5,
    refVideos: 0,
    refAudios: 0,
    params: [
      { key: 'resolution', label: 'RESOLUTION', control: 'chip', values: ['720p', '1080p'], default: '1080p' },
      { key: 'audio', label: 'AUDIO', control: 'chip', values: ['Auto', 'Origin'], default: 'Auto' },
    ],
  },
  // docs.kie.ai/market/bytedance/seedance-2 — reference_video_urls (max 3, source is one),
  // reference_image_urls (max 9), reference_audio_urls (max 3, WAV/MP3,
  // 2-15s each and 15s total). duration 4-15s. generate_audio.
  'Seedance 2': {
    promptMax: 20_000,
    refImages: 9,
    refVideos: 2,
    refAudios: 3,
    params: [
      { key: 'resolution', label: 'RESOLUTION', control: 'chip', values: ['480p', '720p', '1080p', '4K'], default: '720p' },
      { key: 'aspect', label: 'ASPECT', control: 'dropdown', values: ASPECT_SEEDANCE, default: '16:9' },
      { key: 'duration', label: 'DURATION', control: 'dropdown', values: SEEDANCE_DURATIONS, default: '5s' },
      { key: 'audio', label: 'GENERATE AUDIO', control: 'chip', values: ['On', 'Off'], default: 'On' },
    ],
  },
  // docs.kie.ai/market/bytedance/seedance-2-fast — 480p/720p only.
  'Seedance 2 Fast': {
    promptMax: 20_000,
    refImages: 9,
    refVideos: 2,
    refAudios: 3,
    params: [
      { key: 'resolution', label: 'RESOLUTION', control: 'chip', values: ['480p', '720p'], default: '720p' },
      { key: 'aspect', label: 'ASPECT', control: 'dropdown', values: ASPECT_SEEDANCE, default: '16:9' },
      { key: 'duration', label: 'DURATION', control: 'dropdown', values: SEEDANCE_DURATIONS, default: '5s' },
      { key: 'audio', label: 'GENERATE AUDIO', control: 'chip', values: ['On', 'Off'], default: 'On' },
    ],
  },
  // docs.kie.ai/market/bytedance/seedance-2-mini — same multimodal reference
  // envelope as Seedance 2 Fast, with the economical Mini tier.
  'Seedance 2 Mini': {
    promptMax: 20_000,
    refImages: 9,
    refVideos: 2,
    refAudios: 3,
    params: [
      { key: 'resolution', label: 'RESOLUTION', control: 'chip', values: ['480p', '720p'], default: '720p' },
      { key: 'aspect', label: 'ASPECT', control: 'dropdown', values: ASPECT_SEEDANCE, default: '16:9' },
      { key: 'duration', label: 'DURATION', control: 'dropdown', values: SEEDANCE_DURATIONS, default: '5s' },
      { key: 'audio', label: 'GENERATE AUDIO', control: 'chip', values: ['On', 'Off'], default: 'On' },
    ],
  },
  // docs.kie.ai/market/gemini-omni-video — background/scene edit; 720p/1080p/4k, 4-10s, 7 ref images.
  'Gemini Omni Video': {
    promptMax: 20_000,
    refImages: 7,
    refVideos: 0,
    // The documented audio_ids are created by Gemini Omni Audio; they are not
    // raw reference-audio uploads and therefore are not exposed in this grid.
    refAudios: 0,
    params: [
      { key: 'aspect', label: 'ASPECT', control: 'dropdown', values: ASPECT_GEMINI, default: '16:9' },
      { key: 'resolution', label: 'RESOLUTION', control: 'chip', values: ['720p', '1080p', '4K'], default: '720p' },
      { key: 'duration', label: 'DURATION', control: 'dropdown', values: ['4s', '6s', '8s', '10s'], default: '4s' },
    ],
  },
}

// Family blocks stay contiguous; premium/current tiers precede faster tiers.
export const CUSTOM_VIDEO_MODELS = [
  'Seedance 2',
  'Seedance 2 Fast',
  'Seedance 2 Mini',
  'Runway Aleph',
  'Wan 2.7 Video Edit',
  'Gemini Omni Video',
  'HappyHorse Video Edit',
]
// docs.kie.ai/market/topaz/video-upscale — the only kie.ai video-file upscaler
// (Recraft is image-only; Grok upscale takes a task id, not a video).
export const VIDEO_UPSCALE_MODELS = ['Topaz Video Upscale']
export const TOPAZ_VIDEO_FACTORS = ['1×', '2×', '4×'] // upscale_factor 1 / 2 / 4 (default 2)

export function defaultVideoEditOptions(model: string): Record<string, string> {
  const values: Record<string, string> = {}
  VIDEO_EDIT_CONFIG[model]?.params.forEach((p) => {
    values[p.key] = p.default
  })
  return values
}

// Resolve a model's options from stored prefs, dropping anything no longer valid
// for the model's config and falling back to defaults.
export function resolveVideoEditOptions(model: string, stored?: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  VIDEO_EDIT_CONFIG[model]?.params.forEach((p) => {
    const s = stored?.[p.key]
    values[p.key] = s && p.values.includes(s) ? s : p.default
  })
  return values
}
