// Selectable model catalogs for Create Image and SuperBrain.

export const IMAGE_MODELS = [
  'GPT Image 2',
  'Seedream 5 Pro',
  'Seedream 5 Lite',
  'Seedream 4.5',
  'Nano Banana Pro',
  'Nano Banana 2',
  'Nano Banana 2 Lite',
  'Flux 2',
  'Wan 2.7 Image',
  'Qwen2 Image',
]

export const DEFAULT_IMAGE_MODEL = 'Nano Banana Pro'

export const IMAGE_MODEL_ALIASES: Record<string, string> = {
  'Seedream 5.0 Pro': 'Seedream 5 Pro',
  'Wan 2.7': 'Wan 2.7 Image',
  'Qwen Image 2': 'Qwen2 Image',
}

export const VIDEO_MODELS = [
  'Seedance 2',
  'Seedance 2 Fast',
  'Seedance 2 Mini',
  'Kling 3',
  'Kling 3 Turbo',
  'Kling 3 Motion Control',
  'Veo 3.1 Quality',
  'Veo 3.1 Fast',
  'Veo 3.1 Lite',
  'Gemini Omni Video',
  'Grok Imagine 1.5 Preview',
  'Grok Imagine Video',
  'Wan 2.7 Video',
  'Hailuo 2.3 Pro',
  'Hailuo 2.3 Standard',
  'Runway AI Video',
  'Happy Horse 1.1',
]

// Defaults must never depend on catalog position: menu ordering is editorial.
export const DEFAULT_VIDEO_MODEL = 'Veo 3.1 Quality'

export const VIDEO_MODEL_ALIASES: Record<string, string> = {
  'Google Omni Video': 'Gemini Omni Video',
  'Wan 2.7': 'Wan 2.7 Video',
  'Grok Imagine 1.5': 'Grok Imagine 1.5 Preview',
  'Grok Imagine Video 1.5 Preview': 'Grok Imagine 1.5 Preview',
  'Runway Gen-4 Turbo': 'Runway AI Video',
  'Hailuo 2.3': 'Hailuo 2.3 Pro',
}

export const AGENT_MODELS = [
  'Fable 5',
  'Opus 4.8',
  'Sonnet 5',
  'Haiku 4.5',
  'GPT 5.6 Sol',
  'GPT 5.6 Terra',
  'GPT 5.6 Luna',
  'GPT 5.5',
  'Grok 4.5',
  'Grok 4.3',
  'Gemini 3.1 Pro',
  'Gemini 3.5 Flash',
]

// Menu order is editorial; keep the established default explicit.
export const DEFAULT_AGENT_MODEL = 'Opus 4.8'
