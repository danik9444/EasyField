import assert from 'node:assert/strict'
import test from 'node:test'
import { IMAGE_MODEL_CONFIG, IDEOGRAM_V3_EDIT_PROMPT_MAX } from '../src/data/imageModelConfig.ts'
import {
  buildImageEditRequest,
  buildImageInpaintRequest,
  buildImageRequest,
  buildMusicRequest,
  buildVideoEditRequest,
  buildVideoRequest,
  type VideoCtx,
} from '../src/data/kieModels.ts'
import {
  HAPPY_HORSE_CJK_PROMPT_MAX,
  HAPPY_HORSE_PROMPT_MAX,
  KIE_UNPUBLISHED_PROMPT_MAX,
  happyHorsePromptMax,
  promptCharacterCount,
  truncatePrompt,
} from '../src/data/promptLimits.ts'
import { VIDEO_EDIT_CONFIG } from '../src/data/videoEditConfig.ts'
import { VIDEO_MODEL_CONFIG } from '../src/data/videoModelConfig.ts'

const videoCtx = (overrides: Partial<VideoCtx> = {}): VideoCtx => ({
  prompt: 'A slow camera move',
  negativePrompt: '',
  aspect: '16:9',
  resolution: '720p',
  duration: '5',
  extras: { audio: 'On' },
  imageUrls: [],
  videoUrls: [],
  audioUrls: [],
  webSearch: false,
  ...overrides,
})

test('published Kie prompt ceilings are present on every image, video and edit adapter', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(IMAGE_MODEL_CONFIG).map(([name, config]) => [name, config.promptMax])),
    {
      'GPT Image 2': 20_000,
      'Seedream 5 Pro': 5_000,
      'Nano Banana Pro': 10_000,
      'Nano Banana 2': 20_000,
      'Nano Banana 2 Lite': 20_000,
      'Seedream 5 Lite': 3_000,
      'Seedream 4.5': 3_000,
      'Wan 2.7 Image': 5_000,
      'Qwen2 Image': 800,
      'Flux 2': 5_000,
    },
  )
  assert.equal(IDEOGRAM_V3_EDIT_PROMPT_MAX, 5_000)
  assert.deepEqual(
    Object.fromEntries(Object.entries(VIDEO_MODEL_CONFIG).map(([name, config]) => [name, config.promptMax])),
    {
      'Seedance 2': 20_000,
      'Seedance 2 Fast': 20_000,
      'Seedance 2 Mini': 20_000,
      'Kling 3': 2_500,
      'Kling 3 Turbo': 2_500,
      'Kling 3 Motion Control': 2_500,
      'Hailuo 2.3 Pro': 5_000,
      'Runway AI Video': 1_800,
      'Veo 3.1 Quality': KIE_UNPUBLISHED_PROMPT_MAX,
      'Veo 3.1 Fast': KIE_UNPUBLISHED_PROMPT_MAX,
      'Veo 3.1 Lite': KIE_UNPUBLISHED_PROMPT_MAX,
      'Gemini Omni Video': 20_000,
      'Wan 2.7 Video': 5_000,
      'Happy Horse 1.1': HAPPY_HORSE_PROMPT_MAX,
      'Grok Imagine Video': 5_000,
      'Grok Imagine 1.5 Preview': 4_096,
      'Hailuo 2.3 Standard': 5_000,
    },
  )
  assert.deepEqual(
    Object.fromEntries(Object.entries(VIDEO_EDIT_CONFIG).map(([name, config]) => [name, config.promptMax])),
    {
      'Runway Aleph': 2_048,
      'Wan 2.7 Video Edit': 5_000,
      'HappyHorse Video Edit': 5_000,
      'Seedance 2': 20_000,
      'Seedance 2 Fast': 20_000,
      'Seedance 2 Mini': 20_000,
      'Gemini Omni Video': 20_000,
    },
  )
})

test('prompt helpers count and truncate Unicode code points without splitting emoji', () => {
  assert.equal(promptCharacterCount('A🎬ב'), 3)
  assert.equal(truncatePrompt('A🎬ב', 2), 'A🎬')
  assert.equal(happyHorsePromptMax('An English scene'), HAPPY_HORSE_PROMPT_MAX)
  assert.equal(happyHorsePromptMax('一段场景'), HAPPY_HORSE_CJK_PROMPT_MAX)
})

test('image adapters enforce inclusive model ceilings and documented minimums', () => {
  const context = { aspect: '1:1', resolution: '1K', extras: {}, imageUrls: [] as string[] }
  assert.doesNotThrow(() => buildImageRequest('GPT Image 2', { ...context, prompt: '🎨'.repeat(20_000) }))
  assert.throws(
    () => buildImageRequest('GPT Image 2', { ...context, prompt: '🎨'.repeat(20_001) }),
    /20,000 characters or fewer/,
  )
  assert.throws(() => buildImageRequest('Seedream 5 Pro', { ...context, prompt: 'ab' }), /3–5,000 characters/)
  assert.throws(() => buildImageRequest('Seedream 5 Pro', { ...context, prompt: '  a' }), /3–5,000 characters/)
  assert.throws(() => buildImageRequest('Seedream 5 Lite', { ...context, prompt: 'ab' }), /3–3,000 characters/)
  assert.throws(() => buildImageRequest('Flux 2', { ...context, prompt: 'ab' }), /3–5,000 characters/)
  assert.throws(
    () => buildImageInpaintRequest('Ideogram V3 Edit', {
      prompt: 'x'.repeat(IDEOGRAM_V3_EDIT_PROMPT_MAX + 1),
      primarySourceUrl: 'https://cdn/source.png',
      maskUrl: 'https://cdn/mask.png',
    }),
    /5,000 characters or fewer/,
  )
})

test('edit validation counts EasyField context in the final provider prompt', () => {
  const imageContext = {
    prompt: 'x'.repeat(3_000),
    primarySourceUrl: 'https://cdn/source.png',
    referenceUrls: [] as string[],
    aspect: '1:1',
    resolution: '2K',
    extras: {},
  }
  assert.doesNotThrow(() => buildImageEditRequest('Seedream 4.5', imageContext))
  assert.throws(
    () => buildImageEditRequest('Seedream 4.5', { ...imageContext, referenceUrls: ['https://cdn/reference.png'] }),
    /3,000 characters or fewer/,
  )

  const videoContext = {
    prompt: 'x'.repeat(5_000),
    sourceUrl: 'https://cdn/source.mp4',
    refImageUrls: [] as string[],
    refVideoUrls: [] as string[],
    refAudioUrls: [] as string[],
    params: {},
    factor: '2×',
  }
  assert.doesNotThrow(() => buildVideoEditRequest('Wan 2.7 Video Edit', videoContext))
  assert.throws(
    () => buildVideoEditRequest('Wan 2.7 Video Edit', { ...videoContext, refImageUrls: ['https://cdn/reference.png'] }),
    /5,000 characters or fewer/,
  )
  assert.throws(
    () => buildVideoEditRequest('HappyHorse Video Edit', {
      ...videoContext,
      prompt: '界'.repeat(2_501),
    }),
    /2,500 characters or fewer/,
  )
  assert.throws(
    () => buildVideoEditRequest('Seedance 2', { ...videoContext, prompt: 'ab' }),
    /3–20,000 characters/,
  )
})

test('video adapters enforce Unicode, language-dependent, minimum and negative-prompt limits', () => {
  assert.doesNotThrow(() => buildVideoRequest('Runway AI Video', videoCtx({ prompt: '🎬'.repeat(1_800) })))
  assert.throws(
    () => buildVideoRequest('Runway AI Video', videoCtx({ prompt: '🎬'.repeat(1_801) })),
    /1,800 characters or fewer/,
  )
  assert.throws(() => buildVideoRequest('Seedance 2', videoCtx({ prompt: 'ab' })), /3–20,000 characters/)
  assert.doesNotThrow(() => buildVideoRequest('Happy Horse 1.1', videoCtx({ prompt: '界'.repeat(2_500) })))
  assert.throws(
    () => buildVideoRequest('Happy Horse 1.1', videoCtx({ prompt: '界'.repeat(2_501) })),
    /2,500 characters or fewer/,
  )
  assert.doesNotThrow(() => buildVideoRequest('Happy Horse 1.1', videoCtx({ prompt: 'x'.repeat(4_999) })))
  assert.throws(
    () => buildVideoRequest('Wan 2.7 Video', videoCtx({ negativePrompt: 'x'.repeat(501) })),
    /500 characters or fewer/,
  )
})

test('Suno validates simple and version-specific custom contracts before submission', () => {
  const base = {
    mode: 'Custom',
    instrumental: true,
    prompt: '',
    style: '',
    title: '',
    negativeTags: '',
    vocalGender: 'Any',
    sliders: { styleWeight: 0.5, weirdness: 0.5, audioWeight: 0.5 },
  }
  assert.doesNotThrow(() => buildMusicRequest({ ...base, version: 'V4', prompt: '🎵'.repeat(3_000), style: 'x'.repeat(200), title: 'x'.repeat(80) }))
  assert.throws(() => buildMusicRequest({ ...base, version: 'V4', prompt: 'x'.repeat(3_001) }), /3,000 characters or fewer/)
  assert.throws(() => buildMusicRequest({ ...base, version: 'V4', style: 'x'.repeat(201) }), /200 characters or fewer/)
  assert.doesNotThrow(() => buildMusicRequest({ ...base, version: 'V5_5', prompt: 'x'.repeat(5_000), style: 'x'.repeat(1_000) }))
  assert.throws(() => buildMusicRequest({ ...base, version: 'V5', title: 'x'.repeat(81) }), /80 characters or fewer/)
  assert.throws(() => buildMusicRequest({ ...base, version: 'V5', mode: 'Simple', prompt: 'x'.repeat(501) }), /500 characters or fewer/)
})
