import assert from 'node:assert/strict'
import test from 'node:test'
import { IMAGE_MODEL_CONFIG } from '../src/data/imageModelConfig.ts'
import { VIDEO_MODEL_CONFIG } from '../src/data/videoModelConfig.ts'
import {
  buildImageRequest,
  buildImageEditRequest,
  buildImageInpaintRequest,
  buildDialogueRequest,
  buildMusicRequest,
  buildSoundEffectRequest,
  buildTtsRequest,
  buildVideoEditRequest,
  buildVideoRequest,
  type VideoCtx,
} from '../src/data/providerModels.ts'
import { IMAGE_MODELS, VIDEO_MODELS } from '../src/data/models.ts'
import { CUSTOM_VIDEO_MODELS, VIDEO_EDIT_CONFIG } from '../src/data/videoEditConfig.ts'
import { EXTEND_VIDEO_MODELS } from '../src/data/extendVideoConfig.ts'
import { TRANSITION_VIDEO_MODELS } from '../src/data/transitionVideoConfig.ts'
import {
  DIALOGUE_STABILITY_VALUES,
  ELEVEN_LANGUAGES,
  TTS_SLIDERS,
  TURBO_LANGUAGES,
} from '../src/data/elevenLabsConfig.ts'
import {
  klingElementProviderName,
  klingElementProviderTag,
  type KlingHostedElement,
} from '../src/data/klingElements.ts'

const videoCtx = (overrides: Partial<VideoCtx> = {}): VideoCtx => ({
  prompt: 'A slow camera move',
  negativePrompt: '',
  aspect: '16:9',
  resolution: '1080p',
  duration: '5',
  extras: { audio: 'On' },
  imageUrls: [],
  videoUrls: [],
  audioUrls: [],
  webSearch: false,
  ...overrides,
})

const jobInput = (request: ReturnType<typeof buildVideoRequest>): Record<string, unknown> => {
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  return request.input
}

test('Kling 3 sends first and last frames in API order', () => {
  const input = jobInput(
    buildVideoRequest(
      'Kling 3',
      videoCtx({ firstFrameUrl: 'https://cdn/first.png', lastFrameUrl: 'https://cdn/last.png' }),
    ),
  )

  assert.deepEqual(input.image_urls, ['https://cdn/first.png', 'https://cdn/last.png'])
  assert.equal(input.multi_shots, false)
})

test('every Transition model serializes the outgoing end before the incoming start', () => {
  const first = 'https://cdn/outgoing-end.png'
  const last = 'https://cdn/incoming-start.png'

  for (const model of TRANSITION_VIDEO_MODELS) {
    const request = buildVideoRequest(model, videoCtx({ firstFrameUrl: first, lastFrameUrl: last }))
    if (request.family === 'veo') {
      assert.equal(request.body.generationType, 'FIRST_AND_LAST_FRAMES_2_VIDEO', model)
      assert.deepEqual(request.body.imageUrls, [first, last], model)
    } else {
      assert.equal(request.family, 'jobs', model)
      if (request.family !== 'jobs') throw new Error(`Expected a Market job for ${model}`)
      if (model === 'Kling 3') assert.deepEqual(request.input.image_urls, [first, last], model)
      else {
        assert.equal(request.input.first_frame_url, first, model)
        assert.equal(request.input.last_frame_url, last, model)
      }
    }
  }
})

test('endpoint-frame modes reject incompatible reference buckets instead of silently dropping a transition edge', () => {
  for (const model of ['Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini']) {
    assert.throws(
      () => buildVideoRequest(model, videoCtx({
        firstFrameUrl: 'https://cdn/first.png',
        lastFrameUrl: 'https://cdn/last.png',
        videoUrls: ['https://cdn/reference.mp4'],
      })),
      /mutually exclusive/,
      model,
    )
  }
  for (const model of ['Veo 3.1 Fast', 'Veo 3.1 Lite']) {
    assert.throws(
      () => buildVideoRequest(model, videoCtx({
        firstFrameUrl: 'https://cdn/first.png',
        lastFrameUrl: 'https://cdn/last.png',
        imageUrls: ['https://cdn/reference.png'],
      })),
      /mutually exclusive/,
      model,
    )
  }
  assert.throws(
    () => buildVideoRequest('Wan 2.7 Video', videoCtx({
      firstFrameUrl: 'https://cdn/first.png',
      lastFrameUrl: 'https://cdn/last.png',
      imageUrls: ['https://cdn/reference.png'],
    })),
    /mutually exclusive/,
  )
})

test('Kling 3 multi-shot uses multi_prompt and the summed duration', () => {
  const input = jobInput(
    buildVideoRequest(
      'Kling 3',
      videoCtx({
        multiShot: true,
        firstFrameUrl: 'https://cdn/first.png',
        shots: [
          { prompt: 'Wide establishing shot', duration: 3 },
          { prompt: 'Close-up', duration: 2 },
        ],
      }),
    ),
  )

  assert.equal(input.multi_shots, true)
  assert.equal(input.duration, '5')
  assert.deepEqual(input.image_urls, ['https://cdn/first.png'])
  assert.deepEqual(input.multi_prompt, [
    { prompt: 'Sequence brief: A slow camera move\nShot 1/2: Wide establishing shot', duration: 3 },
    { prompt: 'Continue the same sequence with consistent subjects, world and visual continuity. Shot 2/2: Close-up', duration: 2 },
  ])
  assert.equal('prompt' in input, false)
})

test('Kling 3 Extend multi-shot keeps the timeline shot-end as its only boundary frame', () => {
  const elementId = 'extend-subject'
  const elementTag = klingElementProviderTag(elementId)
  const hostedKlingElements: KlingHostedElement[] = [{
    id: elementId,
    name: 'Courier',
    description: 'The same courier continuing from the captured timeline shot',
    providerName: klingElementProviderName(elementId),
    mediaKind: 'images',
    inputUrls: ['https://cdn/courier-front.jpg', 'https://cdn/courier-side.png'],
  }]

  const input = jobInput(buildVideoRequest('Kling 3', videoCtx({
    prompt: 'Continue directly from the captured timeline shot end.',
    firstFrameUrl: 'https://cdn/timeline-shot-end.png',
    hostedKlingElements,
    multiShot: true,
    shots: [
      { prompt: 'The courier accelerates through the doorway.', duration: 3, referenceTags: [elementTag] },
      { prompt: 'The camera overtakes the courier and reveals the street.', duration: 4, referenceTags: [elementTag] },
    ],
  })))

  assert.equal(input.multi_shots, true)
  assert.deepEqual(input.image_urls, ['https://cdn/timeline-shot-end.png'])
  assert.equal(input.duration, '7')
  assert.equal('prompt' in input, false)
  assert.deepEqual(input.kling_elements, [{
    name: klingElementProviderName(elementId),
    description: 'The same courier continuing from the captured timeline shot',
    element_input_urls: ['https://cdn/courier-front.jpg', 'https://cdn/courier-side.png'],
  }])
  assert.equal((input.multi_prompt as Array<{ prompt: string }>).every((shot) => shot.prompt.endsWith(elementTag)), true)
})

test('Kling 3 Extend multi-shot rejects an optional last frame instead of silently dropping it', () => {
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({
      prompt: 'Continue from the timeline shot end.',
      firstFrameUrl: 'https://cdn/timeline-shot-end.png',
      lastFrameUrl: 'https://cdn/unsupported-last-frame.png',
      multiShot: true,
      shots: [
        { prompt: 'Continue the movement.', duration: 2 },
        { prompt: 'Resolve into a wider composition.', duration: 3 },
      ],
    })),
    /multi-shot supports a first frame only/i,
  )
})

test('non-Kling video adapters fail closed when stale UI state requests multi-shot', () => {
  assert.throws(
    () => buildVideoRequest('Seedance 2', videoCtx({
      firstFrameUrl: 'https://cdn/start.png',
      multiShot: true,
      shots: [
        { prompt: 'First connected beat.', duration: 2 },
        { prompt: 'Second connected beat.', duration: 3 },
      ],
    })),
    /supported only by Kling 3/i,
  )
})

test('Kling 3 rejects legacy flat reference buckets instead of inventing unnamed Elements', () => {
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({
      firstFrameUrl: 'https://cdn/start.png',
      imageUrls: ['https://cdn/hero-front.png', 'https://cdn/hero-side.png'],
    })),
    /must be defined as named Elements/,
  )
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({
      firstFrameUrl: 'https://cdn/start.png',
      videoUrls: ['https://cdn/ref.mov'],
      audioUrls: ['https://cdn/ref.wav'],
    })),
    /must be defined as named Elements/,
  )
})

test('Kling 3 sends a named shared image element with its complete 2–4 image group', () => {
  const providerName = klingElementProviderName('hero-stable-id')
  const hostedKlingElements: KlingHostedElement[] = [{
    id: 'hero-stable-id',
    name: 'Hero',
    description: 'The same courier in a charcoal coat and red scarf',
    providerName,
    mediaKind: 'images',
    inputUrls: [
      'https://cdn/hero-front.jpg',
      'https://cdn/hero-profile.png',
      'https://cdn/hero-full.jpg',
      'https://cdn/hero-action.png',
    ],
  }]

  const input = jobInput(buildVideoRequest('Kling 3', videoCtx({ firstFrameUrl: 'https://cdn/start.png', hostedKlingElements })))

  assert.deepEqual(input.kling_elements, [{
    name: providerName,
    description: 'The same courier in a charcoal coat and red scarf',
    element_input_urls: [
      'https://cdn/hero-front.jpg',
      'https://cdn/hero-profile.png',
      'https://cdn/hero-full.jpg',
      'https://cdn/hero-action.png',
    ],
  }])
  assert.match(String(input.prompt), new RegExp(`${klingElementProviderTag('hero-stable-id')}$`))
})

test('Kling 3 sends one trimmed shared video with its optional paired voice reference', () => {
  const providerName = klingElementProviderName('vehicle-stable-id')
  const hostedKlingElements: KlingHostedElement[] = [{
    id: 'vehicle-stable-id',
    name: 'Courier bike',
    description: 'A red electric motorcycle with a scratched left fairing',
    providerName,
    mediaKind: 'video',
    inputUrls: ['https://cdn/bike-reference.mov'],
    audioUrl: 'https://cdn/bike-engine.wav',
    startTimeMs: 1_250,
    endTimeMs: 7_250,
  }]

  const input = jobInput(buildVideoRequest('Kling 3', videoCtx({ firstFrameUrl: 'https://cdn/start.png', hostedKlingElements })))

  assert.deepEqual(input.kling_elements, [{
    name: providerName,
    description: 'A red electric motorcycle with a scratched left fairing',
    element_input_urls: ['https://cdn/bike-reference.mov'],
    element_input_audio_urls: ['https://cdn/bike-engine.wav'],
    start_time: 1_250,
    end_time: 7_250,
  }])
  assert.match(String(input.prompt), new RegExp(`${klingElementProviderTag('vehicle-stable-id')}$`))
})

test('Kling 3 multi-shot includes only the selected shared element tags in each shot', () => {
  const heroId = 'shared-hero'
  const vehicleId = 'shared-vehicle'
  const heroTag = klingElementProviderTag(heroId)
  const vehicleTag = klingElementProviderTag(vehicleId)
  const hostedKlingElements: KlingHostedElement[] = [
    {
      id: heroId,
      name: 'Hero',
      description: 'Courier in a charcoal coat',
      providerName: klingElementProviderName(heroId),
      mediaKind: 'images',
      inputUrls: ['https://cdn/hero-front.jpg', 'https://cdn/hero-side.png'],
    },
    {
      id: vehicleId,
      name: 'Bike',
      description: 'Red electric motorcycle',
      providerName: klingElementProviderName(vehicleId),
      mediaKind: 'video',
      inputUrls: ['https://cdn/bike.mov'],
      startTimeMs: 0,
      endTimeMs: 5_000,
    },
  ]

  const input = jobInput(buildVideoRequest('Kling 3', videoCtx({
    prompt: 'Follow one courier through a continuous rainy-night escape.',
    multiShot: true,
    firstFrameUrl: 'https://cdn/start.png',
    hostedKlingElements,
    shots: [
      { prompt: 'The courier checks the station clock.', duration: 3, referenceTags: [heroTag] },
      { prompt: 'The motorcycle launches into the street.', duration: 4, referenceTags: [heroTag, vehicleTag] },
    ],
  })))
  const prompts = input.multi_prompt as Array<{ prompt: string }>
  assert.match(prompts[0].prompt, new RegExp(`${heroTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  assert.equal(prompts[0].prompt.includes(vehicleTag), false)
  assert.match(prompts[1].prompt, new RegExp(`${heroTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${vehicleTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
})

test('Kling 3 rejects audio without the image/video element required by the endpoint', () => {
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({ audioUrls: ['https://cdn/ref.wav'] })),
    /must be defined as named Elements/,
  )
})

test('Kling 3 rejects a lone reference image instead of treating it as a frame', () => {
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({ imageUrls: ['https://cdn/ref.png'] })),
    /must be defined as named Elements/,
  )
})

test('Kling 3 requires a first frame whenever a named Element tag is used', () => {
  const id = 'hero-needs-frame'
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({
      hostedKlingElements: [{
        id,
        name: 'Hero',
        description: 'Courier in a red coat',
        providerName: klingElementProviderName(id),
        mediaKind: 'images',
        inputUrls: ['https://cdn/hero-front.jpg', 'https://cdn/hero-side.png'],
      }],
    })),
    /requires a first frame/,
  )
})

test('Kling 3 standard enforces the documented prompt ceiling after automatic Element tags', () => {
  assert.doesNotThrow(() => buildVideoRequest('Kling 3', videoCtx({ prompt: '🎬'.repeat(2500) })))
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({ prompt: '🎬'.repeat(2501) })),
    /2,500 .*characters/,
  )

  const id = 'weighted-reference'
  const hostedKlingElements: KlingHostedElement[] = [{
    id,
    name: 'Hero',
    description: 'A stable hero reference',
    providerName: klingElementProviderName(id),
    mediaKind: 'images',
    inputUrls: ['https://cdn/hero-1.jpg', 'https://cdn/hero-2.jpg'],
  }]
  assert.doesNotThrow(() => buildVideoRequest('Kling 3', videoCtx({
    prompt: 'a'.repeat(2462),
    firstFrameUrl: 'https://cdn/start.png',
    hostedKlingElements,
  })))
  assert.throws(
    () => buildVideoRequest('Kling 3', videoCtx({
      prompt: 'a'.repeat(2463),
      firstFrameUrl: 'https://cdn/start.png',
      hostedKlingElements,
    })),
    /every Element tag uses 37/,
  )
})

test('Kling 3 Turbo uses only the documented text and single-image endpoint fields', () => {
  const text = jobInput(buildVideoRequest('Kling 3 Turbo', videoCtx({
    duration: '9',
    resolution: '1080p',
    aspect: '9:16',
  })))
  assert.deepEqual(text, {
    prompt: 'A slow camera move',
    duration: '9',
    aspect_ratio: '9:16',
    resolution: '1080p',
  })

  const image = jobInput(buildVideoRequest('Kling 3 Turbo', videoCtx({
    firstFrameUrl: 'https://cdn/start.png',
    duration: '7',
    resolution: '720p',
    aspect: '1:1',
  })))
  assert.deepEqual(image, {
    prompt: 'A slow camera move',
    image_urls: ['https://cdn/start.png'],
    duration: '7',
    resolution: '720p',
  })
  assert.equal('aspect_ratio' in image, false)
})

test('Kling 3 Turbo fails closed for unsupported endpoint and reference media', () => {
  assert.throws(
    () => buildVideoRequest('Kling 3 Turbo', videoCtx({
      firstFrameUrl: 'https://cdn/start.png',
      lastFrameUrl: 'https://cdn/end.png',
    })),
    /one starting image only/,
  )
  assert.throws(
    () => buildVideoRequest('Kling 3 Turbo', videoCtx({ videoUrls: ['https://cdn/reference.mov'] })),
    /one starting image only/,
  )
  assert.doesNotThrow(() => buildVideoRequest('Kling 3 Turbo', videoCtx({ prompt: '🎬'.repeat(2500) })))
  assert.throws(
    () => buildVideoRequest('Kling 3 Turbo', videoCtx({ prompt: '🎬'.repeat(2501) })),
    /2,500 characters/,
  )
})

test('Kling 3 Motion Control sends the documented required media and option values', () => {
  const input = jobInput(buildVideoRequest('Kling 3 Motion Control', videoCtx({
    resolution: '1080p',
    imageUrls: ['https://cdn/character.png'],
    videoUrls: ['https://cdn/driver.mov'],
    extras: { characterOrientation: 'Image', backgroundSource: 'Image' },
  })))
  assert.deepEqual(input, {
    prompt: 'A slow camera move',
    input_urls: ['https://cdn/character.png'],
    video_urls: ['https://cdn/driver.mov'],
    mode: '1080p',
    character_orientation: 'image',
    background_source: 'input_image',
  })
})

test('Kling 3 Motion Control rejects missing or unrelated media before a paid request', () => {
  assert.throws(
    () => buildVideoRequest('Kling 3 Motion Control', videoCtx({
      imageUrls: ['https://cdn/character.png'],
    })),
    /exactly one character image and one driver video/,
  )
  assert.throws(
    () => buildVideoRequest('Kling 3 Motion Control', videoCtx({
      imageUrls: ['https://cdn/character.png'],
      videoUrls: ['https://cdn/driver.mov'],
      audioUrls: ['https://cdn/audio.wav'],
    })),
    /one character image and one driver video only/,
  )
  assert.throws(
    () => buildVideoRequest('Kling 3 Motion Control', videoCtx({
      prompt: '🎬'.repeat(2501),
      imageUrls: ['https://cdn/character.png'],
      videoUrls: ['https://cdn/driver.mov'],
    })),
    /2,500 characters/,
  )
})

test('Gemini Omni uses only persisted character/audio IDs and enforces quota', () => {
  const input = jobInput(
    buildVideoRequest(
      'Gemini Omni Video',
      videoCtx({ characterIds: ['character-1'], audioIds: ['audio-1'] }),
    ),
  )
  assert.deepEqual(input.character_ids, ['character-1'])
  assert.deepEqual(input.audio_ids, ['audio-1'])

  assert.throws(
    () =>
      buildVideoRequest(
        'Gemini Omni Video',
        videoCtx({
          imageUrls: Array.from({ length: 6 }, (_, i) => `https://cdn/image-${i}.png`),
          videoUrls: ['https://cdn/ref.mov'],
        }),
      ),
    /exceed its 7-unit quota/,
  )
})

test('Edit Video exposes raw reference audio only for the documented Seedance adapters', () => {
  const models = Object.entries(VIDEO_EDIT_CONFIG)
    .filter(([, config]) => config.refAudios > 0)
    .map(([model]) => model)
  assert.deepEqual(models, ['Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini'])
  assert.equal(VIDEO_EDIT_CONFIG['Seedance 2'].refAudios, 3)
  assert.equal(VIDEO_EDIT_CONFIG['Seedance 2 Fast'].refAudios, 3)
  assert.equal(VIDEO_EDIT_CONFIG['Seedance 2 Mini'].refAudios, 3)
  assert.equal(VIDEO_EDIT_CONFIG['Gemini Omni Video'].refAudios, 0)
})

test('Seedance Edit Video maps hosted reference audio URLs for every verified adapter', () => {
  for (const model of ['Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini']) {
    const input = jobInput(
      buildVideoEditRequest(model, {
        prompt: 'Cut the scene to the reference rhythm',
        sourceUrl: 'https://cdn/source.mp4',
        refImageUrls: [],
        refVideoUrls: [],
        refAudioUrls: ['https://cdn/beat.wav', 'https://cdn/voice.mp3'],
        params: { resolution: '720p', aspect: '16:9', duration: '5s', audio: 'On' },
        factor: '2×',
      }),
    )
    assert.deepEqual(input.reference_video_urls, ['https://cdn/source.mp4'])
    assert.deepEqual(input.reference_audio_urls, ['https://cdn/beat.wav', 'https://cdn/voice.mp3'])
  }
})

test('Edit Image keeps the primary source in the provider edit slot and supporting refs after it', () => {
  const arrayField: Record<string, string> = {
    'GPT Image 2': 'input_urls',
    'Seedream 5 Pro': 'image_urls',
    'Seedream 5 Lite': 'image_urls',
    'Seedream 4.5': 'image_urls',
    'Nano Banana Pro': 'image_input',
    'Nano Banana 2': 'image_input',
    'Nano Banana 2 Lite': 'image_urls',
    'Flux 2': 'input_urls',
    'Wan 2.7 Image': 'input_urls',
  }
  const primary = 'https://cdn/primary.png'
  const supporting = 'https://cdn/supporting.png'

  for (const model of IMAGE_MODELS) {
    const allowsSupporting = IMAGE_MODEL_CONFIG[model].maxReferenceImages > 1
    const request = buildImageEditRequest(model, {
      prompt: 'Change the jacket to blue',
      primarySourceUrl: primary,
      referenceUrls: allowsSupporting ? [supporting] : [],
      aspect: IMAGE_MODEL_CONFIG[model].aspectRatios[0] ?? '1:1',
      resolution: IMAGE_MODEL_CONFIG[model].resolutions[0] ?? '',
      extras: Object.fromEntries(IMAGE_MODEL_CONFIG[model].extraOptions.map((option) => [option.key, option.values[0]])),
    })
    assert.equal(request.family, 'jobs', model)
    if (request.family !== 'jobs') throw new Error(`Expected a Market job for ${model}`)
    if (model === 'Qwen2 Image') {
      assert.equal(request.input.image_url, primary, model)
    } else {
      assert.deepEqual(request.input[arrayField[model]], allowsSupporting ? [primary, supporting] : [primary], model)
      if (allowsSupporting) {
        assert.match(String(request.input.prompt), /Edit image 1 only/, model)
        assert.match(String(request.input.prompt), /supporting visual references only/, model)
      }
    }
  }
})

test('Edit Image fails closed for unknown adapters and rejects references beyond the model contract', () => {
  const context = {
    prompt: 'Edit the source',
    primarySourceUrl: 'https://cdn/primary.png',
    referenceUrls: [],
    aspect: '1:1',
    resolution: '1K',
    extras: {},
  }
  assert.throws(() => buildImageEditRequest('Unknown image model', context), /not a verified EasyField image-edit model/)
  assert.throws(
    () => buildImageEditRequest('Qwen2 Image', { ...context, referenceUrls: ['https://cdn/supporting.png'] }),
    /at most 0 supporting reference images/,
  )
})

test('Ideogram Inpaint sends the primary image and binary mask through dedicated fields', () => {
  const request = buildImageInpaintRequest('Ideogram V3 Edit', {
    prompt: 'Replace the selected cup with a glass',
    primarySourceUrl: 'https://cdn/primary.png',
    maskUrl: 'https://cdn/mask.png',
  })
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(request.model, 'ideogram/v3-edit')
  assert.deepEqual(request.input, {
    prompt: 'Replace the selected cup with a glass',
    image_url: 'https://cdn/primary.png',
    mask_url: 'https://cdn/mask.png',
    rendering_speed: 'BALANCED',
    expand_prompt: true,
  })
  assert.throws(
    () => buildImageInpaintRequest('Flux Fill Pro', { prompt: 'Fill', primarySourceUrl: 'https://cdn/a.png', maskUrl: 'https://cdn/m.png' }),
    /not a verified EasyField inpaint model/,
  )
})

test('Edit Video menu contains only verified video-input adapters and serializes the source deterministically', () => {
  assert.deepEqual(CUSTOM_VIDEO_MODELS, [
    'Seedance 2',
    'Seedance 2 Fast',
    'Seedance 2 Mini',
    'Runway Aleph',
    'Wan 2.7 Video Edit',
    'Gemini Omni Video',
    'HappyHorse Video Edit',
  ])
  assert.equal(CUSTOM_VIDEO_MODELS.includes('Kling 3.0 Motion Control'), false)
  assert.equal(Object.hasOwn(VIDEO_EDIT_CONFIG, 'Kling 3.0 Motion Control'), false)
  const source = 'https://cdn/primary-source.mp4'
  for (const model of CUSTOM_VIDEO_MODELS) {
    const request = buildVideoEditRequest(model, {
      prompt: 'Restyle the primary clip',
      sourceUrl: source,
      refImageUrls: [],
      refVideoUrls: VIDEO_EDIT_CONFIG[model].refVideos > 0 ? ['https://cdn/support.mp4'] : [],
      refAudioUrls: [],
      params: Object.fromEntries(VIDEO_EDIT_CONFIG[model].params.map((param) => [param.key, param.default])),
      factor: '2×',
    })
    if (request.family === 'aleph') {
      assert.equal(request.body.videoUrl, source, model)
      assert.equal('aspectRatio' in request.body, false, model)
      assert.equal('referenceImage' in request.body, false, model)
      continue
    }
    assert.equal(request.family, 'jobs', model)
    if (request.family !== 'jobs') throw new Error(`Expected a Market job for ${model}`)
    const serialized = request.input.video_url
      ?? (Array.isArray(request.input.reference_video_urls) ? request.input.reference_video_urls[0] : undefined)
      ?? (Array.isArray(request.input.video_list) ? (request.input.video_list[0] as { url?: string })?.url : undefined)
    assert.equal(serialized, source, model)
  }
  assert.throws(
    () => buildVideoEditRequest('Unknown video model', {
      prompt: 'Edit', sourceUrl: source, refImageUrls: [], refVideoUrls: [], refAudioUrls: [], params: {}, factor: '2×',
    }),
    /not a verified EasyField video-reference model/,
  )
})

test('Edit Video rejects reference audio for unverified models and above Seedance quota', () => {
  const context = {
    prompt: 'Restyle the clip',
    sourceUrl: 'https://cdn/source.mp4',
    refImageUrls: [],
    refVideoUrls: [],
    refAudioUrls: ['https://cdn/beat.wav'],
    params: {},
    factor: '2×',
  }
  assert.throws(() => buildVideoEditRequest('Runway Aleph', context), /does not accept uploaded reference audio/)
  assert.throws(
    () =>
      buildVideoEditRequest('Seedance 2', {
        ...context,
        refAudioUrls: Array.from({ length: 4 }, (_, index) => `https://cdn/audio-${index}.wav`),
      }),
    /at most 3 reference audio files/,
  )
})

test('Qwen2 Image uses distinct text and edit endpoints without an undocumented tier', () => {
  assert.equal(IMAGE_MODEL_CONFIG['Qwen2 Image'].extraOptions.some((option) => option.key === 'tier'), false)
  const request = buildImageRequest('Qwen2 Image', {
    prompt: 'Restyle the image',
    aspect: '16:9',
    resolution: '',
    extras: { format: 'PNG', tier: 'Pro' },
    imageUrls: ['https://cdn/source.png'],
  })
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(request.model, 'qwen2/image-edit')
  assert.equal('tier' in request.input, false)

  const textRequest = buildImageRequest('Qwen2 Image', {
    prompt: 'Create a multilingual poster',
    aspect: '16:9',
    resolution: '',
    extras: { format: 'PNG' },
    imageUrls: [],
  })
  assert.equal(textRequest.family, 'jobs')
  if (textRequest.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(textRequest.model, 'qwen2/text-to-image')
  assert.equal('image_url' in textRequest.input, false)
})

test('Seedream 5 Pro maps every documented generation setting and reference limit', () => {
  const text = buildImageRequest('Seedream 5 Pro', {
    prompt: 'A precise multilingual product poster',
    aspect: '3:2',
    resolution: '2K',
    extras: { format: 'JPEG' },
    imageUrls: [],
  })
  assert.equal(text.family, 'jobs')
  if (text.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(text.model, 'seedream/5-pro-text-to-image')
  assert.deepEqual(text.input, {
    prompt: 'A precise multilingual product poster',
    aspect_ratio: '3:2',
    quality: 'high',
    output_format: 'jpeg',
    nsfw_checker: true,
  })

  const edit = buildImageRequest('Seedream 5 Pro', {
    prompt: 'Preserve the subject and change the material',
    aspect: '1:1',
    resolution: '1K',
    extras: { format: 'PNG' },
    imageUrls: ['https://cdn/source.png', 'https://cdn/style.webp'],
  })
  assert.equal(edit.family, 'jobs')
  if (edit.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(edit.model, 'seedream/5-pro-image-to-image')
  assert.deepEqual(edit.input.image_urls, ['https://cdn/source.png', 'https://cdn/style.webp'])
  assert.equal(edit.input.quality, 'basic')
  assert.equal(edit.input.output_format, 'png')
  assert.equal(IMAGE_MODEL_CONFIG['Seedream 5 Pro'].maxReferenceImages, 10)
  assert.throws(() => buildImageRequest('Seedream 5 Pro', {
    prompt: 'Valid prompt', aspect: '1:1', resolution: '1K', extras: {},
    imageUrls: Array.from({ length: 11 }, (_, index) => `https://cdn/${index}.png`),
  }), /at most 10 reference images/)
})

test('original Grok Imagine keeps its separate 6–30 second contract', () => {
  const request = buildVideoRequest(
    'Grok Imagine Video',
    videoCtx({ aspect: '16:9', resolution: '480p', duration: '30', extras: { mode: 'Normal' } }),
  )
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(request.model, 'grok-imagine/text-to-video')
  const input = request.input
  assert.equal(input.duration, '30')
  assert.equal(typeof input.duration, 'string')
  assert.equal(input.resolution, '480p')
  assert.equal(input.mode, 'normal')
  assert.equal(input.nsfw_checker, true)
  assert.deepEqual(VIDEO_MODEL_CONFIG['Grok Imagine Video'].durations, Array.from({ length: 25 }, (_, index) => String(index + 6)))
  assert.throws(() => buildVideoRequest('Grok Imagine Video', videoCtx({ duration: '31', resolution: '480p' })), /6–30 seconds/)
})

test('Grok Imagine 1.5 Preview stays distinct from generic Grok and uses its documented schema', () => {
  const request = buildVideoRequest('Grok Imagine 1.5 Preview', videoCtx({
    aspect: 'Auto',
    resolution: '720p',
    duration: '8',
    imageUrls: ['https://cdn/reference.png'],
  }))
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(request.model, 'grok-imagine-video-1-5-preview')
  assert.deepEqual(request.input, {
    prompt: 'A slow camera move',
    image_urls: ['https://cdn/reference.png'],
    aspect_ratio: 'auto',
    resolution: '720p',
    duration: 8,
    nsfw_checker: true,
  })
  assert.equal('mode' in request.input, false)
  assert.deepEqual(VIDEO_MODEL_CONFIG['Grok Imagine 1.5 Preview'].durations, Array.from({ length: 15 }, (_, index) => String(index + 1)))
  assert.throws(() => buildVideoRequest('Grok Imagine 1.5 Preview', videoCtx({ duration: '16', resolution: '480p' })), /1–15 seconds/)
})

test('original Grok references enforce the documented source and mode rules', () => {
  assert.throws(() => buildVideoRequest('Grok Imagine Video', videoCtx({
    duration: '12',
    resolution: '720p',
    extras: { mode: 'Spicy' },
    imageUrls: ['https://cdn/reference.png'],
  })), /Spicy mode is unavailable/)
  assert.throws(() => buildVideoRequest('Grok Imagine Video', videoCtx({
    duration: '12',
    resolution: '720p',
    imageUrls: Array.from({ length: 8 }, (_, index) => `https://cdn/${index}.png`),
  })), /at most 7 reference images/)
})

test('Hailuo 2.3 Standard exposes the value tier without changing the Pro endpoint', () => {
  const request = buildVideoRequest('Hailuo 2.3 Standard', videoCtx({
    firstFrameUrl: 'https://cdn/first.png', resolution: '768P', duration: '10',
  }))
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(request.model, 'hailuo/2-3-image-to-video-standard')
  assert.equal(request.input.image_url, 'https://cdn/first.png')
  assert.equal(request.input.duration, '10')
  assert.equal(request.input.nsfw_checker, true)
})

test('Wan 2.7 continuation accepts a video clip with or without a separate start frame', () => {
  const clipOnly = buildVideoRequest('Wan 2.7 Video', videoCtx({
    firstFrameUrl: undefined,
    videoUrls: ['https://cdn/edited-shot.mp4'],
  }))
  assert.equal(clipOnly.family, 'jobs')
  if (clipOnly.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(clipOnly.model, 'wan/2-7-image-to-video')
  assert.equal(clipOnly.input.first_clip_url, 'https://cdn/edited-shot.mp4')
  assert.equal('first_frame_url' in clipOnly.input, false)

  const frameAndClip = buildVideoRequest('Wan 2.7 Video', videoCtx({
    firstFrameUrl: 'https://cdn/timeline-end.png',
    videoUrls: ['https://cdn/edited-shot.mp4'],
  }))
  assert.equal(frameAndClip.family, 'jobs')
  if (frameAndClip.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(frameAndClip.input.first_frame_url, 'https://cdn/timeline-end.png')
  assert.equal(frameAndClip.input.first_clip_url, 'https://cdn/edited-shot.mp4')
})

test('every model visible in Extend serializes the captured shot end as its start frame', () => {
  const startFrameUrl = 'https://cdn/timeline-shot-end.png'
  for (const model of EXTEND_VIDEO_MODELS) {
    const hailuo = model.startsWith('Hailuo')
    const request = buildVideoRequest(model, videoCtx({
      firstFrameUrl: startFrameUrl,
      duration: hailuo ? '6' : '5',
      resolution: hailuo ? '768P' : '1080p',
    }))
    if (request.family === 'veo') {
      assert.equal(request.body.generationType, 'FIRST_AND_LAST_FRAMES_2_VIDEO', model)
      assert.deepEqual(request.body.imageUrls, [startFrameUrl], model)
    } else if (request.family === 'runway') {
      assert.equal(request.body.imageUrl, startFrameUrl, model)
    } else {
      const input = request.input
      const serialized = input.first_frame_url
        ?? input.image_url
        ?? (Array.isArray(input.image_urls) ? input.image_urls[0] : undefined)
      assert.equal(serialized, startFrameUrl, model)
    }
  }
})

test('minimal live-smoke image and TTS builders match their Market routes', () => {
  const image = buildImageRequest('Nano Banana 2 Lite', {
    prompt: 'A blue cube',
    aspect: '1:1',
    resolution: '1K',
    extras: { format: 'PNG' },
    imageUrls: [],
  })
  assert.equal(image.family, 'jobs')
  if (image.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(image.model, 'nano-banana-2-lite')
  assert.deepEqual(image.input, {
    prompt: 'A blue cube',
    aspect_ratio: '1:1',
  })

  const tts = buildTtsRequest('turbo-2-5', 'voice-id', 'EasyField test complete.', {
    stability: 0.5,
    similarity: 0.75,
    style: 0,
    speed: 1,
    timestamps: true,
    previousText: 'Previous sentence.',
    nextText: 'Next sentence.',
    languageCode: 'he',
  })
  assert.equal(tts.family, 'jobs')
  if (tts.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(tts.model, 'elevenlabs/text-to-speech-turbo-2-5')
  assert.equal(tts.input.voice, 'voice-id')
  assert.equal(tts.input.similarity_boost, 0.75)
  assert.equal(tts.input.timestamps, true)
  assert.equal(tts.input.previous_text, 'Previous sentence.')
  assert.equal(tts.input.next_text, 'Next sentence.')
  assert.equal(tts.input.language_code, 'he')
})

test('ElevenLabs narration builders follow per-model endpoint controls and limits', () => {
  assert.deepEqual(TTS_SLIDERS.map((slider) => slider.step), [0.01, 0.01, 0.01, 0.01])
  assert.equal(TURBO_LANGUAGES.every((language) => !language.code || /^[a-z]{2}$/.test(language.code)), true)
  const base = {
    stability: 0.51,
    similarity: 0.76,
    style: 0.01,
    speed: 1.01,
    timestamps: false,
    previousText: 'Before',
    nextText: 'After',
    languageCode: 'he',
  }
  const multilingual = buildTtsRequest('multilingual-v2', 'voice-id', 'שלום', base)
  assert.equal(multilingual.family, 'jobs')
  if (multilingual.family !== 'jobs') throw new Error('Expected a Market job')
  assert.deepEqual(multilingual.input, {
    text: 'שלום',
    voice: 'voice-id',
    stability: 0.51,
    similarity_boost: 0.76,
    style: 0.01,
    speed: 1.01,
    timestamps: false,
    previous_text: 'Before',
    next_text: 'After',
  })
  assert.equal('language_code' in multilingual.input, false, 'Multilingual v2 must never receive language_code')

  assert.throws(
    () => buildTtsRequest('turbo-2-5', 'voice-id', 'Text', { ...base, languageCode: 'fil' }),
    /ISO 639-1/,
  )
  assert.throws(
    () => buildTtsRequest('turbo-2-5', 'voice-id', 'x'.repeat(5001), base),
    /5,000 characters or fewer/,
  )
  assert.throws(
    () => buildTtsRequest('turbo-2-5', 'voice-id', 'Text', { ...base, previousText: 'x'.repeat(5001) }),
    /Previous context/,
  )
  assert.throws(
    () => buildTtsRequest('turbo-2-5', 'voice-id', 'Text', { ...base, speed: 1.21 }),
    /Speed must be between 0.7 and 1.2/,
  )
})

test('Eleven v3 dialogue sends supported language and exact stability', () => {
  assert.deepEqual(DIALOGUE_STABILITY_VALUES, [0, 0.5, 1])
  assert.equal(ELEVEN_LANGUAGES.some((language) => language.code === 'he'), true)
  const request = buildDialogueRequest(
    [
      { voice: 'voice-a', text: 'שלום' },
      { voice: 'voice-b', text: 'מה נשמע?' },
    ],
    { stability: 0.5, languageCode: 'he' },
  )
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(request.model, 'elevenlabs/text-to-dialogue-v3')
  assert.equal(request.input.stability, 0.5)
  assert.equal(request.input.language_code, 'he')
  assert.deepEqual(request.input.dialogue, [
    { voice: 'voice-a', text: 'שלום' },
    { voice: 'voice-b', text: 'מה נשמע?' },
  ])

  assert.throws(
    () => buildDialogueRequest([{ voice: 'voice-a', text: 'Text' }], { stability: 0.25 as 0.5, languageCode: '' }),
    /exactly 0, 0.5, or 1/,
  )
  assert.throws(
    () => buildDialogueRequest([{ voice: 'voice-a', text: 'x'.repeat(5001) }], { stability: 1, languageCode: 'en' }),
    /total 5,000 characters or fewer/,
  )
  assert.throws(
    () => buildDialogueRequest([{ voice: 'voice-a', text: 'Text' }], { stability: 0, languageCode: 'xx' }),
    /supported by Eleven v3/,
  )
})

test('minimal Suno smoke request uses the dedicated simple-mode contract', () => {
  const request = buildMusicRequest({
    version: 'V5',
    mode: 'Simple',
    instrumental: true,
    prompt: 'Minimal ambient cue',
    style: '',
    title: '',
    negativeTags: '',
    vocalGender: 'Any',
    sliders: { styleWeight: 0.65, weirdness: 0.5, audioWeight: 0.65 },
  })
  assert.equal(request.family, 'suno')
  if (request.family !== 'suno') throw new Error('Expected a Suno request')
  assert.equal(request.body.model, 'V5')
  assert.equal(request.body.customMode, false)
  assert.equal(request.body.instrumental, true)
  assert.equal('style' in request.body, false)
  assert.equal('title' in request.body, false)
})

test('Suno Sounds maps only the documented controls and omits Any key', () => {
  const request = buildSoundEffectRequest({
    model: 'V5_5',
    prompt: 'A tight cinematic impact',
    loop: false,
    bpm: 120,
    key: 'Any',
    grabLyrics: false,
  })
  assert.equal(request.family, 'sounds')
  if (request.family !== 'sounds') throw new Error('Expected a Suno Sounds request')
  assert.deepEqual(request.body, {
    prompt: 'A tight cinematic impact',
    model: 'V5_5',
    soundLoop: false,
    soundTempo: 120,
    grabLyrics: false,
  })
  assert.equal('soundKey' in request.body, false)
  assert.equal('duration' in request.body, false)
  assert.equal('callBackUrl' in request.body, false)
})

test('Suno Sounds accepts v5 and validates prompt, BPM and provider key enums', () => {
  const request = buildSoundEffectRequest({
    model: 'V5',
    prompt: 'Seamless synth pulse',
    loop: true,
    bpm: 166,
    key: 'D#m',
    grabLyrics: true,
  })
  assert.equal(request.family, 'sounds')
  if (request.family !== 'sounds') throw new Error('Expected a Suno Sounds request')
  assert.equal(request.body.soundKey, 'D#m')
  assert.equal(request.body.soundLoop, true)
  assert.equal(request.body.grabLyrics, true)

  assert.throws(() => buildSoundEffectRequest({ model: 'V5', prompt: 'x'.repeat(501), loop: false, bpm: 120, key: 'Any', grabLyrics: false }), /500 characters or fewer/)
  assert.throws(() => buildSoundEffectRequest({ model: 'V5', prompt: 'Impact', loop: false, bpm: 0, key: 'Any', grabLyrics: false }), /1 to 300/)
  assert.throws(() => buildSoundEffectRequest({ model: 'V5', prompt: 'Impact', loop: false, bpm: 301, key: 'Any', grabLyrics: false }), /1 to 300/)
})

test('market labels stay specific to the adapter that actually runs', () => {
  assert.equal(IMAGE_MODELS.includes('Wan 2.7 Image'), true)
  assert.equal(VIDEO_MODELS.includes('Wan 2.7 Video'), true)
  assert.equal(VIDEO_MODELS.includes('Runway AI Video'), true)
  assert.equal(VIDEO_MODELS.includes('Runway Gen-4 Turbo'), false)
  assert.equal(VIDEO_MODELS.includes('Grok Imagine 1.5 Preview'), true)

  const still = buildImageRequest('Wan 2.7 Image', {
    prompt: 'Editorial portrait',
    aspect: '4:3',
    resolution: '2K',
    extras: {},
    imageUrls: [],
  })
  assert.equal(still.family, 'jobs')
  if (still.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(still.model, 'wan/2-7-image')

  const video = buildVideoRequest('Wan 2.7 Video', videoCtx())
  assert.equal(video.family, 'jobs')
  if (video.family !== 'jobs') throw new Error('Expected a Market job')
  assert.equal(video.model, 'wan/2-7-text-to-video')

  const runway = buildVideoRequest('Runway AI Video', videoCtx())
  assert.equal(runway.family, 'runway')
})
