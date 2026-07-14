import type { DropdownOptionMeta } from '../components/Dropdown'
import { withProviderBrands } from './providerBrands.ts'

export const IMAGE_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'GPT Image 2': { group: 'GPT Image', eyebrow: 'OPENAI', description: 'High-resolution generation and edits with up to 16 inputs.' },
  'Seedream 5 Pro': { group: 'Seedream', eyebrow: 'SEEDREAM', badge: 'NEW · PRO', description: 'Latest Pro generation and precision editing at native 1K or 2K.' },
  'Seedream 5 Lite': { group: 'Seedream', eyebrow: 'SEEDREAM', badge: 'LITE', description: 'Text or reference-led stills at 2K or 4K.' },
  'Seedream 4.5': { group: 'Seedream', eyebrow: 'SEEDREAM', badge: '4.5', description: 'Earlier multi-reference generation and editing endpoint.' },
  'Nano Banana Pro': { group: 'Nano Banana', eyebrow: 'GOOGLE', badge: 'DEFAULT · PRO', description: 'General still generation with up to 8 reference images.' },
  'Nano Banana 2': { group: 'Nano Banana', eyebrow: 'GOOGLE', badge: '2', description: 'Generation and edits with up to 14 references and wide aspect support.' },
  'Nano Banana 2 Lite': { group: 'Nano Banana', eyebrow: 'GOOGLE', badge: '2 · LITE', description: 'Lite endpoint with up to 10 references; resolution is provider-managed.' },
  'Flux 2': { group: 'Flux', eyebrow: 'FLUX', description: 'Pro and Flex variants for generation or reference editing.' },
  'Wan 2.7 Image': { group: 'Wan', eyebrow: 'WAN', description: 'Dedicated Wan 2.7 still-image endpoint up to 4K.' },
  'Qwen2 Image': { group: 'Qwen', eyebrow: 'QWEN', description: 'Separate text generation and single-image edit endpoints.' },
})

export const VIDEO_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'Seedance 2': { group: 'Seedance', eyebrow: 'BYTEDANCE', badge: 'QUALITY', description: 'Full multimodal endpoint with text, frames, video and audio references.' },
  'Seedance 2 Fast': { group: 'Seedance', eyebrow: 'BYTEDANCE', badge: 'FAST', description: 'Faster Seedance 2 tier at 480p or 720p.' },
  'Seedance 2 Mini': { group: 'Seedance', eyebrow: 'BYTEDANCE', badge: 'MINI', description: 'Most economical Seedance 2 tier at 480p or 720p.' },
  'Kling 3': { group: 'Kling', eyebrow: 'KLING', badge: 'QUALITY', description: 'Standard or multi-shot generation with endpoint frames and named Elements.' },
  'Kling 3 Turbo': { group: 'Kling', eyebrow: 'KLING', badge: 'TURBO', description: 'Faster text or first-frame generation with 3–15 second duration.' },
  'Kling 3 Motion Control': { group: 'Kling', eyebrow: 'KLING', badge: 'MOTION', description: 'Specialized motion transfer from a driver video to a character.' },
  'Veo 3.1 Quality': { group: 'Google', eyebrow: 'GOOGLE · VEO', badge: 'QUALITY', description: 'Highest-fidelity Veo tier; supports endpoint frames and up to 4K.' },
  'Veo 3.1 Fast': { group: 'Google', eyebrow: 'GOOGLE · VEO', badge: 'FAST', description: 'Cost-efficient Veo tier with optional reference images.' },
  'Veo 3.1 Lite': { group: 'Google', eyebrow: 'GOOGLE · VEO', badge: 'LITE', description: 'Most economical documented Veo tier.' },
  'Gemini Omni Video': { group: 'Google', eyebrow: 'GOOGLE · GEMINI', badge: 'OMNI', description: 'Google multimodal video model with image and video references.' },
  'Grok Imagine 1.5 Preview': { group: 'Grok Imagine', eyebrow: 'GROK', badge: '1.5 · 1–15S', description: 'Preview endpoint: text or one optional reference image, 1–15 seconds.' },
  'Grok Imagine Video': { group: 'Grok Imagine', eyebrow: 'GROK', badge: 'ORIGINAL · 6–30S', description: 'Original endpoints: text or up to 7 references, 6–30 seconds.' },
  'Wan 2.7 Video': { group: 'Wan', eyebrow: 'WAN', badge: '2.7', description: 'Text, references, endpoint frames or an external continuation clip.' },
  'Hailuo 2.3 Pro': { group: 'Hailuo', eyebrow: 'HAILUO', badge: 'PRO', description: 'Premium first-frame image-to-video tier at 768P or 1080P.' },
  'Hailuo 2.3 Standard': { group: 'Hailuo', eyebrow: 'HAILUO', badge: 'STANDARD', description: 'Value first-frame tier at 768P or 1080P.' },
  'Runway AI Video': { group: 'Runway', eyebrow: 'RUNWAY', badge: 'KIE WRAPPER', description: 'Kie-managed Runway route; the underlying model identity is not exposed.' },
  'Happy Horse 1.1': { group: 'Happy Horse', eyebrow: 'HAPPYHORSE', badge: '1.1', description: 'Text, first-frame or multi-image reference generation.' },
})

export const AGENT_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'Fable 5': { group: 'Anthropic', eyebrow: 'ANTHROPIC', badge: 'CREATIVE', description: 'Top creative and narrative model in the Anthropic family.' },
  'Opus 4.8': { group: 'Anthropic', eyebrow: 'ANTHROPIC', badge: 'DEFAULT', description: 'Default planning and creative direction model.' },
  'Sonnet 5': { group: 'Anthropic', eyebrow: 'ANTHROPIC', badge: 'BALANCED', description: 'Balanced Anthropic creative planning route.' },
  'Haiku 4.5': { group: 'Anthropic', eyebrow: 'ANTHROPIC', badge: 'FAST', description: 'Compact and fast Anthropic chat route.' },
  'GPT 5.6 Sol': { group: 'OpenAI', eyebrow: 'OPENAI', badge: '5.6 · BEST', description: 'Highest-capability GPT 5.6 tier with multimodal input and deep reasoning.' },
  'GPT 5.6 Terra': { group: 'OpenAI', eyebrow: 'OPENAI', badge: '5.6 · BALANCED', description: 'Balanced GPT 5.6 tier for detailed planning and prompt development.' },
  'GPT 5.6 Luna': { group: 'OpenAI', eyebrow: 'OPENAI', badge: '5.6 · FAST', description: 'Fastest and most economical GPT 5.6 tier.' },
  'GPT 5.5': { group: 'OpenAI', eyebrow: 'OPENAI', badge: '5.5', description: 'Earlier Responses-based planning and prompt model.' },
  'Grok 4.5': { group: 'Grok', eyebrow: 'GROK', badge: '4.5', description: 'Newest Grok Responses model for complex planning and agentic work.' },
  'Grok 4.3': { group: 'Grok', eyebrow: 'GROK', badge: '4.3', description: 'Earlier Grok reasoning model with multimodal input.' },
  'Gemini 3.1 Pro': { group: 'Google Gemini', eyebrow: 'GOOGLE', badge: 'PRO', description: 'Long-context model; EasyField currently sends image references.' },
  'Gemini 3.5 Flash': { group: 'Google Gemini', eyebrow: 'GOOGLE', badge: 'FLASH', description: 'Fast Gemini endpoint for short planning turns.' },
})

export const MUSIC_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'v5.5': { group: 'Suno · Current', eyebrow: 'SUNO', badge: 'NEWEST', description: 'Current Suno generation version.' },
  v5: { group: 'Suno · Current', eyebrow: 'SUNO', badge: 'CURRENT', description: 'Current Suno v5 generation version.' },
  'v4.5+': { group: 'Suno · Legacy', eyebrow: 'SUNO', description: 'Older compatibility version.' },
  'v4.5': { group: 'Suno · Legacy', eyebrow: 'SUNO', description: 'Older compatibility version.' },
  'v4.5 All': { group: 'Suno · Legacy', eyebrow: 'SUNO', description: 'Older all-mode compatibility version.' },
  v4: { group: 'Suno · Legacy', eyebrow: 'SUNO', description: 'Legacy compatibility version.' },
})

export const SOUND_EFFECT_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'v5.5': { group: 'Suno Sounds', eyebrow: 'SUNO', badge: 'NEWEST', description: 'Newest verified Sounds model with loop, BPM and musical key controls.' },
  v5: { group: 'Suno Sounds', eyebrow: 'SUNO', badge: 'CURRENT', description: 'Current verified Sounds compatibility model with the same provider controls.' },
})

export const VOICE_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'Multilingual v2': { group: 'ElevenLabs · Narration', eyebrow: 'ELEVENLABS', badge: 'QUALITY', description: 'Single-voice multilingual narration with full voice controls.' },
  'Turbo v2.5': { group: 'ElevenLabs · Narration', eyebrow: 'ELEVENLABS', badge: 'TURBO', description: 'Faster single-voice endpoint with full voice controls.' },
  'Eleven v3 Dialogue': { group: 'ElevenLabs · Dialogue', eyebrow: 'ELEVENLABS', badge: 'MULTI-SPEAKER', description: 'Line-based multi-speaker dialogue with supported audio tags.' },
})

export const VIDEO_EDIT_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'Seedance 2': { group: 'Seedance', eyebrow: 'BYTEDANCE', badge: 'QUALITY', description: 'Quality multimodal transformation with the primary clip as video reference one.' },
  'Seedance 2 Fast': { group: 'Seedance', eyebrow: 'BYTEDANCE', badge: 'FAST', description: 'Faster multimodal transformation with the primary clip kept first.' },
  'Seedance 2 Mini': { group: 'Seedance', eyebrow: 'BYTEDANCE', badge: 'MINI', description: 'Economical reference-video tier at 480p or 720p.' },
  'Runway Aleph': { group: 'Runway', eyebrow: 'RUNWAY', description: 'General-purpose video transformation.' },
  'Wan 2.7 Video Edit': { group: 'Wan', eyebrow: 'WAN', badge: '2.7', description: 'Wan prompt-driven video edit endpoint.' },
  'Gemini Omni Video': { group: 'Google', eyebrow: 'GOOGLE · GEMINI', description: 'Reference-led scene transformation from one primary video input.' },
  'HappyHorse Video Edit': { group: 'Happy Horse', eyebrow: 'HAPPYHORSE', description: 'Happy Horse prompt edit endpoint.' },
})

export const AVATAR_MODEL_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'Kling Avatar Pro': { group: 'Kling Avatar', eyebrow: 'KLING', badge: 'PRO', description: 'Highest-quality Kling portrait animation from one image and a voice track.' },
  'Kling Avatar Standard': { group: 'Kling Avatar', eyebrow: 'KLING', badge: 'STANDARD', description: 'Faster Kling portrait animation from one image and a voice track.' },
  'OmniHuman 1.5': { group: 'OmniHuman', eyebrow: 'BYTEDANCE', badge: '1.5', description: 'High-fidelity audio-driven people, pets and illustrated characters up to 1080p.' },
  InfiniteTalk: { group: 'InfiniteTalk', eyebrow: 'INFINITALK', badge: 'AUDIO', description: 'Audio-driven portrait animation at 480p or 720p with reproducible seeds.' },
  'Wan 2.2 A14B Speech-to-Video Turbo': { group: 'Wan', eyebrow: 'WAN', badge: 'TURBO', description: 'Advanced speech-driven video with frame, FPS and inference controls.' },
  'Volcengine Lip Sync': { group: 'Volcengine', eyebrow: 'VOLCENGINE', badge: 'LIP SYNC', description: 'Synchronize a supplied voice track to an existing single-person video.' },
})

export const IMAGE_EDIT_SPECIALIST_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  'Flux Fill Pro': { group: 'Flux', eyebrow: 'FLUX', badge: 'PRO', description: 'Mask-based fill and inpainting.' },
  'Ideogram V3 Edit': { group: 'Ideogram', eyebrow: 'IDEOGRAM', badge: 'V3', description: 'Prompt and mask based image editing.' },
  'Topaz Image Upscale': { group: 'Topaz', eyebrow: 'TOPAZ', description: 'Resolution-aware image upscaling.' },
  'Recraft Crisp Upscale': { group: 'Recraft', eyebrow: 'RECRAFT', description: 'Crisp single-pass image enhancement.' },
})

export const ANIMATION_ENGINE_META: Record<string, DropdownOptionMeta> = withProviderBrands({
  HyperFrames: { group: 'Local render engines', badge: 'DEFAULT', description: 'Safe spec-driven motion graphics rendered locally.' },
  Remotion: { group: 'Local render engines', description: 'Local composition renderer with editable project output.' },
})
