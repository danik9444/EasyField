export const PROVIDER_BRAND_IDS = [
  'openai',
  'anthropic',
  'bytedance',
  'google',
  'blackforest',
  'alibaba',
  'kuaishou',
  'xai',
  'minimax',
  'runway',
  'suno',
  'elevenlabs',
  'ideogram',
  'topaz',
  'recraft',
  'volcengine',
  'davinci',
  'hyperframes',
  'remotion',
  'easyfield',
  'librosa',
  'kie',
] as const

export type ProviderBrandId = typeof PROVIDER_BRAND_IDS[number]

export interface ProviderBrandDefinition {
  label: string
  color: string
}

export const PROVIDER_BRANDS: Record<ProviderBrandId, ProviderBrandDefinition> = {
  openai: { label: 'OpenAI', color: '#E7F5EF' },
  anthropic: { label: 'Anthropic', color: '#E58A65' },
  bytedance: { label: 'ByteDance', color: '#72A8FF' },
  google: { label: 'Google', color: '#8AB4F8' },
  blackforest: { label: 'Black Forest Labs', color: '#D8F56A' },
  alibaba: { label: 'Alibaba', color: '#FF8A3D' },
  kuaishou: { label: 'Kuaishou', color: '#FF6B45' },
  xai: { label: 'xAI', color: '#F4F4F5' },
  minimax: { label: 'MiniMax', color: '#F2647D' },
  runway: { label: 'Runway', color: '#D9D7FF' },
  suno: { label: 'Suno', color: '#F2F2F5' },
  elevenlabs: { label: 'ElevenLabs', color: '#F2F2F5' },
  ideogram: { label: 'Ideogram', color: '#E9E9F0' },
  topaz: { label: 'Topaz Labs', color: '#63D7FF' },
  recraft: { label: 'Recraft', color: '#FF6A55' },
  volcengine: { label: 'Volcengine', color: '#31A8FF' },
  davinci: { label: 'DaVinci Resolve', color: '#F3C24F' },
  hyperframes: { label: 'HyperFrames', color: '#42E4C6' },
  remotion: { label: 'Remotion', color: '#8B8CFF' },
  easyfield: { label: 'EasyField Local', color: '#E66FE1' },
  librosa: { label: 'librosa', color: '#62D6B5' },
  kie: { label: 'Kie.ai', color: '#B8B6C8' },
}

const MODEL_BRAND_BY_NAME: Record<string, ProviderBrandId> = {
  'GPT Image 2': 'openai',
  'Seedream 5 Pro': 'bytedance',
  'Seedream 5 Lite': 'bytedance',
  'Seedream 4.5': 'bytedance',
  'Nano Banana Pro': 'google',
  'Nano Banana 2': 'google',
  'Nano Banana 2 Lite': 'google',
  'Flux 2': 'blackforest',
  'Wan 2.7 Image': 'alibaba',
  'Qwen2 Image': 'alibaba',
  'Seedance 2': 'bytedance',
  'Seedance 2 Fast': 'bytedance',
  'Seedance 2 Mini': 'bytedance',
  'Kling 3': 'kuaishou',
  'Kling 3 Turbo': 'kuaishou',
  'Kling 3 Motion Control': 'kuaishou',
  'Kling Avatar Pro': 'kuaishou',
  'Kling Avatar Standard': 'kuaishou',
  'Kling AI Avatar Pro': 'kuaishou',
  'Kling AI Avatar Standard': 'kuaishou',
  'Veo 3.1 Quality': 'google',
  'Veo 3.1 Fast': 'google',
  'Veo 3.1 Lite': 'google',
  'Veo 3.1 Extend': 'google',
  'Gemini Omni Video': 'google',
  'Gemini 3.1 Pro': 'google',
  'Gemini 3.5 Flash': 'google',
  'Grok Imagine 1.5 Preview': 'xai',
  'Grok Imagine Video': 'xai',
  'Grok Imagine Extend': 'xai',
  'Grok 4.5': 'xai',
  'Grok 4.3': 'xai',
  'Wan 2.7 Video': 'alibaba',
  'Wan 2.7 Video Edit': 'alibaba',
  'Wan 2.7 Continue': 'alibaba',
  'Wan 2.7': 'alibaba',
  'Hailuo 2.3 Pro': 'minimax',
  'Hailuo 2.3 Standard': 'minimax',
  'Runway AI Video': 'runway',
  'Runway Aleph': 'runway',
  'Happy Horse 1.1': 'alibaba',
  'HappyHorse Video Edit': 'alibaba',
  'Fable 5': 'anthropic',
  'Opus 4.8': 'anthropic',
  'Sonnet 5': 'anthropic',
  'Haiku 4.5': 'anthropic',
  'GPT 5.6 Sol': 'openai',
  'GPT 5.6 Terra': 'openai',
  'GPT 5.6 Luna': 'openai',
  'GPT 5.5': 'openai',
  'v5.5': 'suno',
  v5: 'suno',
  'v4.5+': 'suno',
  'v4.5': 'suno',
  'v4.5 All': 'suno',
  v4: 'suno',
  'Multilingual v2': 'elevenlabs',
  'Turbo v2.5': 'elevenlabs',
  'Eleven v3 Dialogue': 'elevenlabs',
  'Flux Fill Pro': 'blackforest',
  'Ideogram V3 Edit': 'ideogram',
  'Topaz Image Upscale': 'topaz',
  'Topaz Video Upscale': 'topaz',
  'Recraft Crisp Upscale': 'recraft',
  'Recraft Remove BG': 'recraft',
  HyperFrames: 'hyperframes',
  Remotion: 'remotion',
  'EasyField Local Analysis': 'easyfield',
  'librosa Beat Analysis': 'librosa',
  'Local Whisper': 'openai',
  'Resolve Fusion Titles': 'davinci',
  'OmniHuman 1.5': 'bytedance',
  InfiniteTalk: 'kie',
  'InfiniteTalk From Audio': 'kie',
  'Wan 2.2 Speech-to-Video Turbo': 'alibaba',
  'Volcengine Lip Sync': 'volcengine',
  'Volcengine Video Lip Sync': 'volcengine',
  'Suno Sounds v5.5': 'suno',
  'Suno Sounds v5': 'suno',
}

const PROVIDER_FALLBACKS: Record<string, ProviderBrandId> = {
  local: 'easyfield',
  resolve: 'davinci',
  kie: 'kie',
}

export function resolveProviderBrand(
  modelName: string,
  context = '',
  provider?: string,
): ProviderBrandId | undefined {
  const exact = MODEL_BRAND_BY_NAME[modelName]
  if (exact) return exact

  const source = `${modelName} ${context}`.toLocaleLowerCase()
  if (/\b(gpt|openai|whisper)\b/.test(source)) return 'openai'
  if (/\b(anthropic|claude|fable|opus|sonnet|haiku)\b/.test(source)) return 'anthropic'
  if (/\b(seedream|seedance|omnihuman|bytedance)\b/.test(source)) return 'bytedance'
  if (/\b(google|gemini|veo|nano banana)\b/.test(source)) return 'google'
  if (/\b(flux|black forest)\b/.test(source)) return 'blackforest'
  if (/\b(alibaba|qwen|wan|happy ?horse)\b/.test(source)) return 'alibaba'
  if (/\b(kling|kuaishou)\b/.test(source)) return 'kuaishou'
  if (/\b(grok|xai|x\.ai)\b/.test(source)) return 'xai'
  if (/\b(hailuo|minimax)\b/.test(source)) return 'minimax'
  if (/\brunway\b/.test(source)) return 'runway'
  if (/\bsuno\b/.test(source)) return 'suno'
  if (/\belevenlabs?\b/.test(source)) return 'elevenlabs'
  if (/\bideogram\b/.test(source)) return 'ideogram'
  if (/\btopaz\b/.test(source)) return 'topaz'
  if (/\brecraft\b/.test(source)) return 'recraft'
  if (/\bvolcengine\b/.test(source)) return 'volcengine'
  if (/\b(resolve|blackmagic)\b/.test(source)) return 'davinci'
  if (/\bhyperframes?\b/.test(source)) return 'hyperframes'
  if (/\bremotion\b/.test(source)) return 'remotion'
  if (/\blibrosa\b/.test(source)) return 'librosa'
  if (/\b(easyfield|local analysis)\b/.test(source)) return 'easyfield'
  return provider ? PROVIDER_FALLBACKS[provider.toLocaleLowerCase()] : undefined
}

export function withProviderBrands<T extends Record<string, object>>(metadata: T): {
  [K in keyof T]: T[K] & { providerBrand: ProviderBrandId }
} {
  return Object.fromEntries(Object.entries(metadata).map(([modelName, meta]) => [
    modelName,
    { ...meta, providerBrand: resolveProviderBrand(modelName, JSON.stringify(meta)) ?? 'kie' },
  ])) as { [K in keyof T]: T[K] & { providerBrand: ProviderBrandId } }
}
