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

const kie = (
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
  provider: 'kie',
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

const plannedKie = (
  id: string,
  name: string,
  tools: ToolId[],
  capabilities: string[],
  inputKinds: ModelDefinition['inputKinds'],
  outputKinds: ModelDefinition['outputKinds'],
  unavailableReason = 'EasyField workflow adapter is planned',
): ModelDefinition => ({
  ...kie(id, name, tools, capabilities, inputKinds, outputKinds),
  validated: false,
  available: false,
  unavailableReason,
})

export const VALIDATED_MODELS: ModelDefinition[] = [
  local('local-media-analysis', 'EasyField Local Analysis', ['culling', 'broll'], ['Private', 'Offline', 'No credits']),
  local('local-librosa-beat', 'librosa Beat Analysis', ['beat'], ['BPM', 'Beat confidence', 'Private + offline']),
  local('local-whisper', 'Local Whisper', ['transcribe'], ['Hebrew + English', 'Word timestamps', 'Offline']),
  resolveModel('resolve-fusion', 'Resolve Fusion Titles', ['captions'], ['Editable', 'Native Resolve', 'Alpha render']),
  kie('topaz-image-upscale', 'Topaz Image Upscale', ['upscale'], ['JPG + PNG + WEBP', '1× + 2× + 4× + 8×', 'Up to 20,000 px output'], ['image'], ['image'], 'best', 'Automatically selected for still-image sources.'),
  kie('topaz-video-upscale', 'Topaz Video Upscale', ['upscale'], ['MP4 + MOV + MKV', '1× + 2× + 4×', 'Exact trimmed timeline clips'], ['video'], ['video'], 'best', 'Automatically selected for video sources.'),
  kie('gemini-3-1-pro', 'Gemini 3.1 Pro', ['storyboard', 'animations'], ['Long context', 'Image reference', 'Structured output'], ['image'], ['transcript']),
  kie('seedream-5-pro', 'Seedream 5 Pro', ['storyboard', 'angles'], ['Precision editing', 'Multilingual text', '1K + 2K'], ['image'], ['image'], 'best', 'Latest verified Seedream Pro image adapter.'),
  kie('nano-banana-pro', 'Nano Banana Pro', ['storyboard', 'angles'], ['Reference images', 'Image generation', 'Image editing'], ['image'], ['image']),
  kie('kling-avatar-pro', 'Kling Avatar Pro', ['avatar'], ['Portrait + audio', 'Up to 5 minutes', 'Pro quality'], ['image', 'audio'], ['video'], 'best', 'Highest-quality verified Kling Avatar endpoint.'),
  kie('kling-avatar-standard', 'Kling Avatar Standard', ['avatar'], ['Portrait + audio', 'Up to 5 minutes', 'Standard tier'], ['image', 'audio'], ['video'], 'value', 'Faster verified Kling Avatar endpoint.'),
  kie('omnihuman-1-5', 'OmniHuman 1.5', ['avatar'], ['720p + 1080p', 'Portrait + audio', 'Up to 5 subject masks'], ['image', 'audio'], ['video']),
  kie('infinitalk-audio', 'InfiniteTalk', ['avatar'], ['480p + 720p', 'Portrait + audio', 'Seed control'], ['image', 'audio'], ['video']),
  kie('wan-2-2-speech-video', 'Wan 2.2 A14B Speech-to-Video Turbo', ['avatar'], ['Portrait + audio', '40–120 frames', 'Advanced inference controls'], ['image', 'audio'], ['video']),
  kie('volcengine-lip-sync', 'Volcengine Lip Sync', ['avatar'], ['Existing video + audio', 'Lite + Basic', 'Audio alignment'], ['video', 'audio'], ['video'], 'best', 'Dedicated verified video-to-video lip-sync endpoint.'),
  plannedKie('veo-3-1-extend', 'Veo 3.1 Extend', ['extend'], ['Veo task only', 'Forward continuation', 'Audio capable'], ['video'], ['video'], 'Requires a compatible Veo artifact and a dedicated continuation adapter'),
  plannedKie('grok-imagine-extend', 'Grok Imagine Extend', ['extend'], ['Kie task artifact', '6s + 10s', 'Inherits source format'], ['video'], ['video'], 'Requires a persisted Grok provider task ID; arbitrary uploads are not supported'),
  plannedKie('wan-2-7-extend', 'Wan 2.7 Continue', ['extend'], ['External clip', 'Forward continuation', 'Audio capable'], ['video', 'image'], ['video']),
  kie('seedance-transition', 'Seedance 2', ['transition'], ['First + last frame', 'Multiple resolutions', 'Optional sound'], ['image'], ['video']),
  kie('kling-3-transition', 'Kling 3', ['transition'], ['First + last frame', '4K option', 'Optional sound'], ['image'], ['video']),
  kie('wan-2-7-transition', 'Wan 2.7', ['transition'], ['First + last frame', '720p + 1080p', '2–15 seconds'], ['image'], ['video']),
  {
    ...kie('suno-sounds-v5-5', 'Suno Sounds v5.5', ['sfx'], ['Prompt ≤500', 'Loop option', 'BPM 1–300', 'Key'], [], ['audio'], 'best', 'Newest verified Suno Sounds adapter.'),
    priceCredits: 2.5,
    priceUnit: 'request',
  },
  {
    ...kie('suno-sounds-v5', 'Suno Sounds v5', ['sfx'], ['Prompt ≤500', 'Loop option', 'BPM 1–300', 'Key'], [], ['audio'], 'value', 'Current verified Suno Sounds compatibility model.'),
    priceCredits: 2.5,
    priceUnit: 'request',
  },
]

export function modelsForTool(toolId: ToolId): ModelDefinition[] {
  return VALIDATED_MODELS.filter((model) => model.tools.includes(toolId))
}
