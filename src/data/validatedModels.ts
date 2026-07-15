import type { ModelDefinition, ToolId } from '../core/contracts'

const local = (id: string, name: string, tools: ToolId[], capabilities: string[]): ModelDefinition => ({
  id,
  name,
  provider: 'local',
  tools,
  inputKinds: tools.includes('transcribe') ? ['audio', 'video'] : ['video', 'audio'],
  outputKinds: tools.includes('transcribe') ? ['transcript'] : [],
  capabilities: capabilities.map((label) => ({ id: label.toLowerCase().replace(/\W+/g, '-'), label })),
  recommendedFor: capabilities,
  validated: true,
  available: true,
  recommendation: 'value',
  recommendationReason: 'Runs privately on this Mac with no credits.',
  priceCredits: 0,
  priceUnit: 'local',
})

const resolveModel = (id: string, name: string, tools: ToolId[], capabilities: string[]): ModelDefinition => ({
  id,
  name,
  provider: 'resolve',
  tools,
  inputKinds: ['transcript'],
  outputKinds: ['transcript'],
  capabilities: capabilities.map((label) => ({ id: label.toLowerCase().replace(/\W+/g, '-'), label })),
  recommendedFor: capabilities,
  validated: true,
  available: true,
  priceCredits: 0,
  priceUnit: 'local',
})

const cloud = (
  id: string,
  name: string,
  tools: ToolId[],
  capabilities: string[],
  inputKinds: ModelDefinition['inputKinds'],
  outputKinds: ModelDefinition['outputKinds'],
  recommendation?: ModelDefinition['recommendation'],
  recommendationReason?: string,
): ModelDefinition => ({
  id,
  name,
  provider: 'cloud',
  tools,
  inputKinds,
  outputKinds,
  capabilities: capabilities.map((label) => ({ id: label.toLowerCase().replace(/\W+/g, '-'), label })),
  recommendedFor: capabilities,
  validated: true,
  available: true,
  recommendation,
  recommendationReason,
})

const plannedCloud = (
  id: string,
  name: string,
  tools: ToolId[],
  capabilities: string[],
  inputKinds: ModelDefinition['inputKinds'],
  outputKinds: ModelDefinition['outputKinds'],
  unavailableReason = 'EasyField workflow adapter is planned',
): ModelDefinition => ({
  ...cloud(id, name, tools, capabilities, inputKinds, outputKinds),
  validated: false,
  available: false,
  unavailableReason,
})

export const VALIDATED_MODELS: ModelDefinition[] = [
  local('local-media-analysis', 'EasyField Local Analysis', ['culling', 'broll'], ['Private', 'Offline', 'No credits']),
  local('local-librosa-beat', 'librosa Beat Analysis', ['beat'], ['BPM', 'Beat confidence', 'Private + offline']),
  local('local-whisper', 'Local Whisper', ['transcribe'], ['Hebrew + English', 'Word timestamps', 'Offline']),
  resolveModel('resolve-fusion', 'Resolve Fusion Titles', ['captions'], ['Editable', 'Native Resolve', 'Alpha render']),
  cloud('topaz-image-upscale', 'Topaz Image Upscale', ['upscale'], ['JPG + PNG + WEBP', '1× + 2× + 4× + 8×', 'Up to 20,000 px output'], ['image'], ['image'], 'best', 'Automatically selected for still-image sources.'),
  cloud('topaz-video-upscale', 'Topaz Video Upscale', ['upscale'], ['MP4 + MOV + MKV', '1× + 2× + 4×', 'Exact trimmed timeline clips'], ['video'], ['video'], 'best', 'Automatically selected for video sources.'),
  cloud('gemini-3-1-pro', 'Gemini 3.1 Pro', ['storyboard', 'animations'], ['Long context', 'Image reference', 'Structured output'], ['image'], ['transcript']),
  cloud('gpt-image-2', 'GPT Image 2', ['angles'], ['Up to 16 references', '1K + 2K + 4K', 'Wide aspect ratios'], ['image'], ['image']),
  cloud('seedream-5-pro', 'Seedream 5 Pro', ['storyboard', 'angles'], ['Precision editing', 'Up to 10 references', '1K + 2K'], ['image'], ['image'], 'best', 'Latest verified Seedream Pro image adapter.'),
  cloud('seedream-5-lite', 'Seedream 5 Lite', ['angles'], ['Reference editing', 'Up to 14 references', '2K + 4K'], ['image'], ['image']),
  cloud('seedream-4-5', 'Seedream 4.5', ['angles'], ['Multi-reference editing', 'Up to 14 references', '2K + 4K'], ['image'], ['image']),
  cloud('nano-banana-pro', 'Nano Banana Pro', ['storyboard', 'angles'], ['Reference editing', 'Up to 8 references', '1K + 2K + 4K'], ['image'], ['image']),
  cloud('nano-banana-2', 'Nano Banana 2', ['angles'], ['Up to 14 references', '1K + 2K + 4K', 'Wide aspect ratios'], ['image'], ['image']),
  cloud('nano-banana-2-lite', 'Nano Banana 2 Lite', ['angles'], ['Up to 10 references', 'Provider-managed resolution', 'Wide aspect ratios'], ['image'], ['image'], 'value', 'Lowest-cost verified reference-image adapter in the Angles catalog.'),
  cloud('flux-2', 'Flux 2', ['angles'], ['Pro + Flex variants', 'Up to 8 references', '1K + 2K'], ['image'], ['image']),
  cloud('wan-2-7-image', 'Wan 2.7 Image', ['angles'], ['Up to 9 references', '1K + 2K + 4K', 'Dedicated image endpoint'], ['image'], ['image']),
  cloud('qwen2-image', 'Qwen2 Image', ['angles'], ['Single-image editing', 'Native 2K output', 'PNG + JPEG'], ['image'], ['image']),
  cloud('kling-avatar-pro', 'Kling Avatar Pro', ['avatar'], ['Portrait + audio', 'Up to 5 minutes', 'Pro quality'], ['image', 'audio'], ['video'], 'best', 'Highest-quality verified Kling Avatar endpoint.'),
  cloud('kling-avatar-standard', 'Kling Avatar Standard', ['avatar'], ['Portrait + audio', 'Up to 5 minutes', 'Standard tier'], ['image', 'audio'], ['video'], 'value', 'Faster verified Kling Avatar endpoint.'),
  cloud('omnihuman-1-5', 'OmniHuman 1.5', ['avatar'], ['720p + 1080p', 'Portrait + audio', 'Up to 5 subject masks'], ['image', 'audio'], ['video']),
  cloud('infinitalk-audio', 'InfiniteTalk', ['avatar'], ['480p + 720p', 'Portrait + audio', 'Seed control'], ['image', 'audio'], ['video']),
  cloud('wan-2-2-speech-video', 'Wan 2.2 A14B Speech-to-Video Turbo', ['avatar'], ['Portrait + audio', '40–120 frames', 'Advanced inference controls'], ['image', 'audio'], ['video']),
  cloud('volcengine-lip-sync', 'Volcengine Lip Sync', ['avatar'], ['Existing video + audio', 'Lite + Basic', 'Audio alignment'], ['video', 'audio'], ['video'], 'best', 'Dedicated verified video-to-video lip-sync endpoint.'),
  plannedCloud('veo-3-1-extend', 'Veo 3.1 Extend', ['extend'], ['Veo task only', 'Forward continuation', 'Audio capable'], ['video'], ['video'], 'Requires a compatible Veo artifact and a dedicated continuation adapter'),
  plannedCloud('grok-imagine-extend', 'Grok Imagine Extend', ['extend'], ['Cloud task artifact', '6s + 10s', 'Inherits source format'], ['video'], ['video'], 'Requires a persisted Grok provider task ID; arbitrary uploads are not supported'),
  plannedCloud('wan-2-7-extend', 'Wan 2.7 Continue', ['extend'], ['External clip', 'Forward continuation', 'Audio capable'], ['video', 'image'], ['video']),
  cloud('seedance-transition', 'Seedance 2', ['transition'], ['First + last frame', 'Multiple resolutions', 'Optional sound'], ['image'], ['video']),
  cloud('kling-3-transition', 'Kling 3', ['transition'], ['First + last frame', '4K option', 'Optional sound'], ['image'], ['video']),
  cloud('wan-2-7-transition', 'Wan 2.7', ['transition'], ['First + last frame', '720p + 1080p', '2–15 seconds'], ['image'], ['video']),
  {
    ...cloud('suno-sounds-v5-5', 'Suno Sounds v5.5', ['sfx'], ['Prompt ≤500', 'Loop option', 'BPM 1–300', 'Key'], [], ['audio'], 'best', 'Newest verified Suno Sounds adapter.'),
    priceCredits: 2.5,
    priceUnit: 'request',
  },
  {
    ...cloud('suno-sounds-v5', 'Suno Sounds v5', ['sfx'], ['Prompt ≤500', 'Loop option', 'BPM 1–300', 'Key'], [], ['audio'], 'value', 'Current verified Suno Sounds compatibility model.'),
    priceCredits: 2.5,
    priceUnit: 'request',
  },
]

export function modelsForTool(toolId: ToolId): ModelDefinition[] {
  return VALIDATED_MODELS.filter((model) => model.tools.includes(toolId))
}
