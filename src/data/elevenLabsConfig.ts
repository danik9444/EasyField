// ElevenLabs audio via kie.ai. Three models are exposed:
//   elevenlabs/text-to-speech-multilingual-v2  — single-voice narration, $0.10 / 1k chars
//   elevenlabs/text-to-speech-turbo-2-5         — single-voice narration, fast, $0.05 / 1k chars
//   elevenlabs/text-to-dialogue-v3              — Eleven v3 multi-speaker dialogue + audio tags, $0.10 / 1k chars
// All share the same 66-voice preset library. The two narration models use the
// voice controls (stability, similarity, style, speed); the dialogue model takes
// a list of {voice, text} lines plus stability and language controls. Verified 2026-07-11
// against docs.kie.ai/market/elevenlabs/*.

export interface TtsModel {
  id: string
  label: string
  kind: 'tts' | 'dialogue'
}

export const ELEVEN_MODELS: TtsModel[] = [
  { id: 'multilingual-v2', label: 'Multilingual v2', kind: 'tts' },
  { id: 'turbo-2-5', label: 'Turbo v2.5', kind: 'tts' },
  { id: 'text-to-dialogue-v3', label: 'Eleven v3 Dialogue', kind: 'dialogue' },
]

export const modelKind = (id: string): 'tts' | 'dialogue' =>
  ELEVEN_MODELS.find((m) => m.id === id)?.kind ?? 'tts'

export interface TtsVoice {
  id: string
  label: string
}

export interface TtsSettings {
  stability: number
  similarity: number
  style: number
  speed: number
  timestamps: boolean
  previousText: string
  nextText: string
  languageCode: string
}

export type DialogueStability = 0 | 0.5 | 1

export interface DialogueSettings {
  stability: DialogueStability
  languageCode: string
}

export interface ElevenLanguage {
  code: string
  label: string
}

// Eleven v3's complete language_code enum from Kie's current schema. The same
// searchable list is used as a convenient ISO 639-1 picker for Turbo v2.5;
// an empty code means automatic detection.
export const ELEVEN_LANGUAGES: ElevenLanguage[] = [
  { code: '', label: 'Auto detect' },
  { code: 'af', label: 'Afrikaans · af' },
  { code: 'ar', label: 'Arabic · ar' },
  { code: 'hy', label: 'Armenian · hy' },
  { code: 'as', label: 'Assamese · as' },
  { code: 'az', label: 'Azerbaijani · az' },
  { code: 'be', label: 'Belarusian · be' },
  { code: 'bn', label: 'Bengali · bn' },
  { code: 'bs', label: 'Bosnian · bs' },
  { code: 'bg', label: 'Bulgarian · bg' },
  { code: 'ca', label: 'Catalan · ca' },
  { code: 'ceb', label: 'Cebuano · ceb' },
  { code: 'ny', label: 'Chichewa · ny' },
  { code: 'hr', label: 'Croatian · hr' },
  { code: 'cs', label: 'Czech · cs' },
  { code: 'da', label: 'Danish · da' },
  { code: 'nl', label: 'Dutch · nl' },
  { code: 'en', label: 'English · en' },
  { code: 'et', label: 'Estonian · et' },
  { code: 'fil', label: 'Filipino · fil' },
  { code: 'fi', label: 'Finnish · fi' },
  { code: 'fr', label: 'French · fr' },
  { code: 'gl', label: 'Galician · gl' },
  { code: 'ka', label: 'Georgian · ka' },
  { code: 'de', label: 'German · de' },
  { code: 'el', label: 'Greek · el' },
  { code: 'gu', label: 'Gujarati · gu' },
  { code: 'ha', label: 'Hausa · ha' },
  { code: 'he', label: 'Hebrew · he' },
  { code: 'hi', label: 'Hindi · hi' },
  { code: 'hu', label: 'Hungarian · hu' },
  { code: 'is', label: 'Icelandic · is' },
  { code: 'ga', label: 'Irish · ga' },
  { code: 'it', label: 'Italian · it' },
  { code: 'ja', label: 'Japanese · ja' },
  { code: 'jv', label: 'Javanese · jv' },
  { code: 'kn', label: 'Kannada · kn' },
  { code: 'kk', label: 'Kazakh · kk' },
  { code: 'ky', label: 'Kyrgyz · ky' },
  { code: 'ko', label: 'Korean · ko' },
  { code: 'lv', label: 'Latvian · lv' },
  { code: 'ln', label: 'Lingala · ln' },
  { code: 'lt', label: 'Lithuanian · lt' },
  { code: 'lb', label: 'Luxembourgish · lb' },
  { code: 'mk', label: 'Macedonian · mk' },
  { code: 'ms', label: 'Malay · ms' },
  { code: 'ml', label: 'Malayalam · ml' },
  { code: 'zh', label: 'Mandarin Chinese · zh' },
  { code: 'mr', label: 'Marathi · mr' },
  { code: 'ne', label: 'Nepali · ne' },
  { code: 'no', label: 'Norwegian · no' },
  { code: 'ps', label: 'Pashto · ps' },
  { code: 'fa', label: 'Persian · fa' },
  { code: 'pl', label: 'Polish · pl' },
  { code: 'pt', label: 'Portuguese · pt' },
  { code: 'pa', label: 'Punjabi · pa' },
  { code: 'ro', label: 'Romanian · ro' },
  { code: 'ru', label: 'Russian · ru' },
  { code: 'sr', label: 'Serbian · sr' },
  { code: 'sd', label: 'Sindhi · sd' },
  { code: 'sk', label: 'Slovak · sk' },
  { code: 'sl', label: 'Slovenian · sl' },
  { code: 'so', label: 'Somali · so' },
  { code: 'es', label: 'Spanish · es' },
  { code: 'sw', label: 'Swahili · sw' },
  { code: 'sv', label: 'Swedish · sv' },
  { code: 'ta', label: 'Tamil · ta' },
  { code: 'te', label: 'Telugu · te' },
  { code: 'th', label: 'Thai · th' },
  { code: 'tr', label: 'Turkish · tr' },
  { code: 'uk', label: 'Ukrainian · uk' },
  { code: 'ur', label: 'Urdu · ur' },
  { code: 'vi', label: 'Vietnamese · vi' },
  { code: 'cy', label: 'Welsh · cy' },
]

export const DIALOGUE_LANGUAGE_CODES = new Set(ELEVEN_LANGUAGES.map((language) => language.code))
export const TURBO_LANGUAGES = ELEVEN_LANGUAGES.filter((language) => !language.code || /^[a-z]{2}$/.test(language.code))
export const languageLabel = (code: string): string =>
  ELEVEN_LANGUAGES.find((language) => language.code === code)?.label ?? code
export const languageCode = (label: string): string =>
  ELEVEN_LANGUAGES.find((language) => language.label === label)?.code ?? ''

// Full kie.ai ElevenLabs preset voice library (id → display label).
export const ELEVEN_VOICES: TtsVoice[] = [
  { id: 'EkK5I93UQWFDigLMpZcX', label: 'James — Husky, Engaging & Bold' },
  { id: 'Z3R5wn05IrDiVCyEkUrK', label: 'Arabella — Mysterious & Emotive' },
  { id: 'NNl6r8mD7vthiJatiJt1', label: 'Bradford — Expressive & Articulate' },
  { id: 'YOq2y2Up4RgXP2HyXjE5', label: 'Xavier — Metallic Announcer' },
  { id: 'B8gJV1IhpuegLxdpXFOE', label: 'Kuon — Cheerful & Steady' },
  { id: '2zRM7PkgwBPiau2jvVXc', label: 'Monika Sogam — Deep & Natural' },
  { id: '1SM7GgM6IMuvQlz2BwM3', label: 'Mark — Casual & Light' },
  { id: '5l5f8iK3YPeGga21rQIX', label: 'Adeline — Feminine & Conversational' },
  { id: 'scOwDtmlUjD3prqpp97I', label: 'Sam — Support Agent' },
  { id: 'NOpBlnGInO9m6vDvFkFC', label: 'Spuds Oxley — Wise & Approachable' },
  { id: 'BZgkqPqms7Kj9ulSkVzn', label: 'Eve — Energetic & Happy' },
  { id: 'wo6udizrrtpIxWGp2qJk', label: 'Northern Terry' },
  { id: 'gU0LNdkMOQCOrPrwtbee', label: 'British Football Announcer' },
  { id: 'DGzg6RaUqxGRTHSBjfgF', label: 'Brock — Commanding Sergeant' },
  { id: 'x70vRnQBMBu4FAYhjJbO', label: 'Nathan — Virtual Radio Host' },
  { id: 'Sm1seazb4gs7RSlUVw7c', label: 'Anika — Friendly & Engaging' },
  { id: 'P1bg08DkjqiVEzOn76yG', label: 'Viraj — Rich & Soft' },
  { id: 'qDuRKMlYmrm8trt5QyBn', label: 'Taksh — Calm & Smooth' },
  { id: 'qXpMhyvQqiRxWQs4qSSB', label: 'Horatius — Energetic Character' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam — Social Media Creator' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum — Husky Trickster' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', label: 'Laura — Quirky Attitude' },
  { id: 'kPzsL2i3teMYv0FxEYQ6', label: 'Brittney — Youthful & Informative' },
  { id: 'UgBBYS2sOqTuMpoF3BR0', label: 'Mark — Natural Conversations' },
  { id: 'hpp4J3VqNfWAUOO0d1Us', label: 'Bella — Professional & Warm' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian — Deep & Comforting' },
  { id: 'uYXf8XasLslADfZ2MB4u', label: 'Hope — Bubbly & Girly' },
  { id: 'gs0tAILXbY5DNrJrsM6F', label: 'Jeff — Classy & Strong' },
  { id: 'DTKMou8ccj1ZaWGBiotd', label: 'Jamahal — Young & Vibrant' },
  { id: 'vBKc2FfBKJfcZNyEt1n6', label: 'Finn — Eager & Energetic' },
  { id: 'DYkrAHD8iwork3YSUBbs', label: 'Tom — Conversations & Books' },
  { id: '56AoDkrOh6qfVPDXZ7Pt', label: 'Cassidy — Crisp & Clear' },
  { id: 'eR40ATw9ArzDf9h3v7t7', label: 'Addison 2.0 — Australian Podcast' },
  { id: 'g6xIsTj2HwM6VR4iXFCw', label: 'Jessica Anne Bogart — Chatty' },
  { id: 'lcMyyd2HUfFzxdCaC4Ta', label: 'Lucy — Fresh & Casual' },
  { id: '6aDn1KB0hjpdcocrUkmq', label: 'Tiffany — Natural & Welcoming' },
  { id: 'Sq93GQT4X1lKDXsQcixO', label: 'Felix — Warm Contemporary RP' },
  { id: 'flHkNRp1BlvT73UL6gyz', label: 'Jessica Anne Bogart — Eloquent Villain' },
  { id: '9yzdeviXkFddZ4Oz8Mok', label: 'Lutz — Giggly & Cheerful' },
  { id: 'pPdl9cQBQq4p6mRkZy2Z', label: 'Emma — Adorable & Upbeat' },
  { id: 'zYcjlYFOd3taleS0gkk3', label: 'Edward — Loud & Confident' },
  { id: 'nzeAacJi50IvxcyDnMXa', label: 'Marshal — Funny Professor' },
  { id: 'ruirxsoakN0GWmGNIo04', label: 'John Morgan — Rugged Cowboy' },
  { id: 'TC0Zp7WVFzhA8zpTlRqV', label: 'Aria — Sultry Villain' },
  { id: 'ljo9gAlSqKOvF6D8sOsX', label: 'Viking Bjorn — Medieval Raider' },
  { id: 'PPzYpIqttlTYA83688JI', label: 'Pirate Marshal' },
  { id: '8JVbfL6oEdmuxKn5DK2C', label: 'Johnny Kid — Calm Narrator' },
  { id: 'iCrDUkL56s3C8sCRl7wb', label: 'Hope — Poetic & Captivating' },
  { id: 'wJqPPQ618aTW29mptyoc', label: 'Ana Rita — Smooth & Bright' },
  { id: 'EiNlNiXeDU1pqqOPrYMO', label: 'John Doe — Deep' },
  { id: '4YYIPFl9wE5c4L2eu2Gb', label: 'Burt Reynolds — Deep & Smooth' },
  { id: '6F5Zhi321D3Oq7v1oNT4', label: 'Hank — Engaging Narrator' },
  { id: 'YXpFCvM1S3JbWEJhoskW', label: 'Wyatt — Wise Rustic Cowboy' },
  { id: 'LG95yZDEHg6fCZdQjLqj', label: 'Phil — Passionate Announcer' },
  { id: 'CeNX9CMwmxDxUF5Q2Inm', label: 'Johnny Dynamite — Vintage DJ' },
  { id: 'aD6riP1btT197c6dACmy', label: 'Rachel M — British Presenter' },
  { id: 'mtrellq69YZsNwzUSyXh', label: 'Rex Thunder — Deep & Tough' },
  { id: 'dHd5gvgSOzSfduK4CvEg', label: 'Ed — Late Night Announcer' },
  { id: 'eVItLK1UvXctxuaRV2Oq', label: 'Jean — Playful Femme Fatale' },
  { id: 'esy0r39YPLQjOczyOib8', label: 'Britney — Calculative Villain' },
  { id: 'Tsns2HvNFKfGiNjllgqo', label: 'Sven — Emotional & Nice' },
  { id: '1U02n4nD6AdIZ9CjF053', label: 'Viraj — Smooth & Gentle' },
  { id: 'AeRdCCKzvd23BpJoofzx', label: 'Nathaniel — British & Calm' },
  { id: 'LruHrtVF6PSyGItzMNHS', label: 'Benjamin — Deep & Calming' },
  { id: '1wGbFxmAM3Fgw63G1zZJ', label: 'Allison — Soothing & Meditative' },
  { id: 'hqfrgApggtO1785R4Fsn', label: 'Theodore HQ — Serene & Grounded' },
  { id: 'MJ0RnG71ty4LH3dvNfSd', label: 'Leon — Soothing & Grounded' },
]

export const DEFAULT_TTS_MODEL = ELEVEN_MODELS[0].id
export const DEFAULT_VOICE = ELEVEN_VOICES[0].id

// Voice controls (shared by both models), with documented ranges + defaults.
export interface TtsSlider {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

export const TTS_SLIDERS: TtsSlider[] = [
  { key: 'stability', label: 'STABILITY', min: 0, max: 1, step: 0.01, default: 0.5 },
  { key: 'similarity', label: 'SIMILARITY', min: 0, max: 1, step: 0.01, default: 0.75 },
  { key: 'style', label: 'STYLE', min: 0, max: 1, step: 0.01, default: 0 },
  { key: 'speed', label: 'SPEED', min: 0.7, max: 1.2, step: 0.01, default: 1 },
]

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  stability: 0.5,
  similarity: 0.75,
  style: 0,
  speed: 1,
  timestamps: false,
  previousText: '',
  nextText: '',
  languageCode: '',
}

// Eleven v3 accepts exactly these values rather than an arbitrary range.
export const DIALOGUE_STABILITY_VALUES: DialogueStability[] = [0, 0.5, 1]
export const DEFAULT_DIALOGUE_SETTINGS: DialogueSettings = { stability: 0.5, languageCode: '' }

// Inline audio tags Eleven v3 understands — offered as quick-insert chips.
export const AUDIO_TAGS = ['[laughs]', '[whispers]', '[sighs]', '[excited]', '[sarcastic]', '[curious]']
