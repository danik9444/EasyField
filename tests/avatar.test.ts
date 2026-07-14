import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AVATAR_MODEL_CONFIG,
  AVATAR_MODELS,
  avatarModelsForWorkflow,
  avatarOptionsForRequest,
  defaultAvatarOptionsFor,
  validateAvatarDraft,
  type AvatarDraft,
} from '../src/data/avatar.ts'
import {
  buildAvatarRequest,
  buildAvatarSubjectDetectionRequest,
  type AvatarCtx,
} from '../src/data/kieModels.ts'

const MB = 1024 * 1024

function jobPayload(request: ReturnType<typeof buildAvatarRequest>): {
  model: string
  input: Record<string, unknown>
} {
  assert.equal(request.family, 'jobs')
  if (request.family !== 'jobs') throw new Error('Expected a Kie Market job')
  return { model: request.model, input: request.input }
}

function portraitContext(overrides: Partial<AvatarCtx> = {}): AvatarCtx {
  return {
    prompt: 'Natural speech with subtle, friendly expressions.',
    imageUrl: 'https://cdn.example/portrait.png',
    audioUrl: 'https://cdn.example/voice.wav',
    subjectLayout: 'single',
    ...overrides,
  }
}

function validPortraitDraft(overrides: Partial<AvatarDraft> = {}): AvatarDraft {
  return {
    model: 'Kling Avatar Pro',
    rightsConfirmed: true,
    prompt: '',
    subjectLayout: 'single',
    subjectSourceId: 'portrait-source',
    maskSourceIds: [],
    image: {
      id: 'portrait-source',
      name: 'portrait.png',
      mimeType: 'image/png',
      byteSize: 2 * MB,
    },
    audio: {
      name: 'voice.wav',
      mimeType: 'audio/wav',
      byteSize: 3 * MB,
      durationSeconds: 45,
    },
    ...overrides,
  }
}

test('Avatar exposes exactly the six dedicated Kie contracts in workflow-safe order', () => {
  assert.deepEqual(AVATAR_MODELS, [
    'Kling Avatar Pro',
    'Kling Avatar Standard',
    'OmniHuman 1.5',
    'InfiniteTalk',
    'Wan 2.2 A14B Speech-to-Video Turbo',
    'Volcengine Lip Sync',
  ])
  assert.deepEqual(avatarModelsForWorkflow('portrait'), AVATAR_MODELS.slice(0, 5))
  assert.deepEqual(avatarModelsForWorkflow('video-lipsync'), ['Volcengine Lip Sync'])
  assert.deepEqual(
    AVATAR_MODELS.map((model) => AVATAR_MODEL_CONFIG[model].route),
    [
      'kling/ai-avatar-pro',
      'kling/ai-avatar-standard',
      'omnihuman-1-5',
      'infinitalk/from-audio',
      'wan/2-2-a14b-speech-to-video-turbo',
      'volcengine/video-to-video-lip-sync',
    ],
  )
  assert.deepEqual(
    AVATAR_MODELS.map((model) => AVATAR_MODEL_CONFIG[model].speakerTargeting),
    [
      'single-subject-only',
      'single-subject-only',
      'subject-mask',
      'single-subject-only',
      'single-subject-only',
      'single-subject-only',
    ],
  )
})

test('Kling Pro and Standard serialize their current non-v1 routes and preserve the required empty prompt field', () => {
  for (const [model, route] of [
    ['Kling Avatar Pro', 'kling/ai-avatar-pro'],
    ['Kling Avatar Standard', 'kling/ai-avatar-standard'],
  ] as const) {
    assert.deepEqual(jobPayload(buildAvatarRequest(model, portraitContext({ prompt: '' }))), {
      model: route,
      input: {
        image_url: 'https://cdn.example/portrait.png',
        audio_url: 'https://cdn.example/voice.wav',
        prompt: '',
      },
    })
  }
})

test('OmniHuman serializes one selected speaker mask and only its documented portrait controls', () => {
  assert.equal(AVATAR_MODEL_CONFIG['OmniHuman 1.5'].promptMax, 300)
  assert.doesNotThrow(() => buildAvatarRequest('OmniHuman 1.5', portraitContext({ prompt: 'x'.repeat(300) })))
  assert.throws(
    () => buildAvatarRequest('OmniHuman 1.5', portraitContext({ prompt: 'x'.repeat(301) })),
    /300 characters or fewer/i,
  )

  assert.deepEqual(jobPayload(buildAvatarRequest('OmniHuman 1.5', portraitContext({
    subjectLayout: 'multiple',
    maskUrls: ['https://cdn.example/person-a.png'],
    options: { outputResolution: '720', fastMode: true, seed: 72 },
  }))), {
    model: 'omnihuman-1-5',
    input: {
      image_url: 'https://cdn.example/portrait.png',
      audio_url: 'https://cdn.example/voice.wav',
      mask_url: ['https://cdn.example/person-a.png'],
      prompt: 'Natural speech with subtle, friendly expressions.',
      output_resolution: '720',
      pe_fast_mode: true,
      seed: 72,
    },
  })

  const withoutPrompt = jobPayload(buildAvatarRequest('OmniHuman 1.5', portraitContext({ prompt: '' })))
  assert.equal(Object.hasOwn(withoutPrompt.input, 'prompt'), false)
})

test('InfiniteTalk serializes its exact resolution and optional seed contract', () => {
  assert.deepEqual(jobPayload(buildAvatarRequest('InfiniteTalk', portraitContext({
    options: { resolution: '720p', seed: 24_000 },
  }))), {
    model: 'infinitalk/from-audio',
    input: {
      image_url: 'https://cdn.example/portrait.png',
      audio_url: 'https://cdn.example/voice.wav',
      prompt: 'Natural speech with subtle, friendly expressions.',
      resolution: '720p',
      seed: 24_000,
    },
  })
})

test('Wan Speech-to-Video serializes frames and FPS rather than inventing a duration field', () => {
  const payload = jobPayload(buildAvatarRequest('Wan 2.2 A14B Speech-to-Video Turbo', portraitContext({
    options: {
      numFrames: 120,
      framesPerSecond: 24,
      resolution: '580p',
      negativePrompt: 'flicker, distorted mouth',
      seed: 91,
      numInferenceSteps: 32,
      guidanceScale: 4.2,
      shift: 6.5,
      nsfwChecker: true,
    },
  })))

  assert.deepEqual(payload, {
    model: 'wan/2-2-a14b-speech-to-video-turbo',
    input: {
      prompt: 'Natural speech with subtle, friendly expressions.',
      image_url: 'https://cdn.example/portrait.png',
      audio_url: 'https://cdn.example/voice.wav',
      num_frames: 120,
      frames_per_second: 24,
      resolution: '580p',
      negative_prompt: 'flicker, distorted mouth',
      seed: 91,
      num_inference_steps: 32,
      guidance_scale: 4.2,
      shift: 6.5,
      nsfw_checker: true,
    },
  })
  assert.equal(Object.hasOwn(payload.input, 'duration'), false)
})

test('Volcengine keeps Lite-only and Basic-only controls out of each other payloads', () => {
  const common = {
    prompt: '',
    videoUrl: 'https://cdn.example/performance.mov',
    audioUrl: 'https://cdn.example/dub.m4a',
  }
  assert.deepEqual(jobPayload(buildAvatarRequest('Volcengine Lip Sync', {
    ...common,
    options: {
      lipSyncMode: 'lite',
      separateVocal: true,
      alignAudio: true,
      alignAudioReverse: true,
      templateStartSeconds: 1.5,
    },
  })), {
    model: 'volcengine/video-to-video-lip-sync',
    input: {
      mode: 'lite',
      video_url: 'https://cdn.example/performance.mov',
      audio_url: 'https://cdn.example/dub.m4a',
      separate_vocal: true,
      align_audio: true,
      align_audio_reverse: true,
      templ_start_seconds: 1.5,
    },
  })

  assert.deepEqual(jobPayload(buildAvatarRequest('Volcengine Lip Sync', {
    ...common,
    options: { lipSyncMode: 'basic', separateVocal: false, openSceneDetection: true },
  })), {
    model: 'volcengine/video-to-video-lip-sync',
    input: {
      mode: 'basic',
      video_url: 'https://cdn.example/performance.mov',
      audio_url: 'https://cdn.example/dub.m4a',
      separate_vocal: false,
      open_scenedet: true,
    },
  })
})

test('consent, source type and prompt failures are reported by pure preflight', () => {
  const valid = validateAvatarDraft(validPortraitDraft())
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.issues, [])
  assert.deepEqual(valid.deferredChecks, [])

  const invalid = validateAvatarDraft(validPortraitDraft({
    rightsConfirmed: false,
    prompt: '🎬'.repeat(5_001),
    image: null,
    video: { name: 'wrong.mp4', mimeType: 'video/mp4', byteSize: MB },
    audio: null,
  }))
  assert.equal(invalid.valid, false)
  assert.deepEqual(new Set(invalid.issues.map((issue) => issue.code)), new Set([
    'rights-required',
    'prompt-too-long',
    'image-required',
    'video-unsupported',
    'audio-required',
  ]))
})

test('media boundaries and model-specific option dependencies fail before request serialization', () => {
  const omniAtLimit = validateAvatarDraft(validPortraitDraft({
    model: 'OmniHuman 1.5',
    prompt: '',
    subjectLayout: 'multiple',
    maskSourceIds: Array.from({ length: 6 }, () => 'portrait-source'),
    audio: {
      name: 'voice.wav',
      mimeType: 'audio/wav',
      byteSize: MB,
      durationSeconds: 60,
    },
    masks: Array.from({ length: 6 }, (_, index) => ({
      name: `mask-${index}.png`,
      mimeType: 'image/png',
      byteSize: 100,
    })),
  }))
  assert.equal(omniAtLimit.valid, false)
  assert.equal(omniAtLimit.issues.some((issue) => issue.code === 'invalid-duration'), true)
  assert.equal(omniAtLimit.issues.some((issue) => issue.code === 'speaker-target-count'), true)

  assert.throws(
    () => avatarOptionsForRequest('InfiniteTalk', { seed: 9_999 }),
    /invalid value for seed/i,
  )
  assert.throws(
    () => avatarOptionsForRequest('Wan 2.2 A14B Speech-to-Video Turbo', { numFrames: 42 }),
    /invalid value for number of frames/i,
  )
  assert.throws(
    () => avatarOptionsForRequest('Volcengine Lip Sync', { lipSyncMode: 'lite', alignAudio: false, alignAudioReverse: true }),
    /requires audio alignment/i,
  )
  assert.throws(
    () => avatarOptionsForRequest('Kling Avatar Pro', { resolution: '720p' }),
    /does not support the resolution option/i,
  )
})

test('unknown models, unhosted media and cross-workflow sources fail closed without fallback routing', () => {
  assert.throws(
    () => buildAvatarRequest('Imaginary Avatar', portraitContext()),
    /not a verified EasyField Avatar model/i,
  )
  assert.throws(
    () => buildAvatarRequest('Kling Avatar Pro', portraitContext({ imageUrl: 'blob:local-image' })),
    /must be uploaded before Avatar generation/i,
  )
  assert.throws(
    () => buildAvatarRequest('Kling Avatar Pro', portraitContext({ videoUrl: 'https://cdn.example/wrong.mp4' })),
    /portrait image, not a source video/i,
  )
  assert.throws(
    () => buildAvatarRequest('Volcengine Lip Sync', {
      prompt: '',
      imageUrl: 'https://cdn.example/wrong.png',
      videoUrl: 'https://cdn.example/source.mp4',
      audioUrl: 'https://cdn.example/audio.wav',
    }),
    /source video, not a portrait image/i,
  )
})

test('unresolved local media facts remain explicit deferred preflight checks', () => {
  const result = validateAvatarDraft(validPortraitDraft({
    image: { id: 'portrait-source', name: 'portrait.png' },
    audio: { name: 'voice.wav' },
  }))
  assert.equal(result.valid, true, 'unknown metadata is not itself proof that media is invalid')
  assert.deepEqual(new Set(result.deferredChecks.map((check) => `${check.field}:${check.code}`)), new Set([
    'image:size-unknown',
    'audio:size-unknown',
    'audio:duration-unknown',
  ]))
})

test('portrait subject review is mandatory, source-bound and rejects images without a person', () => {
  const unreviewed = validateAvatarDraft(validPortraitDraft({
    subjectLayout: undefined,
    subjectSourceId: undefined,
  }))
  assert.equal(unreviewed.valid, false)
  assert.equal(unreviewed.issues.some((issue) => issue.code === 'subject-review-required'), true)

  const stale = validateAvatarDraft(validPortraitDraft({ subjectSourceId: 'previous-portrait' }))
  assert.equal(stale.valid, false)
  assert.equal(stale.issues.some((issue) => issue.code === 'subject-review-stale'), true)

  const noSubject = validateAvatarDraft(validPortraitDraft({ subjectLayout: 'none' }))
  assert.equal(noSubject.valid, false)
  assert.equal(noSubject.issues.some((issue) => issue.code === 'no-subject-detected'), true)
})

test('multi-person portraits cannot use models without a structured speaker target', () => {
  for (const model of [
    'Kling Avatar Pro',
    'Kling Avatar Standard',
    'InfiniteTalk',
    'Wan 2.2 A14B Speech-to-Video Turbo',
  ] as const) {
    const result = validateAvatarDraft(validPortraitDraft({
      model,
      prompt: 'Make the person on the left speak.',
      subjectLayout: 'multiple',
    }))
    assert.equal(result.valid, false, model)
    assert.equal(result.issues.some((issue) => issue.code === 'multi-person-unsupported'), true, model)

    assert.throws(
      () => buildAvatarRequest(model, portraitContext({
        prompt: 'Make the person on the left speak.',
        subjectLayout: 'multiple',
      })),
      /cannot choose a speaker in a multi-person portrait/i,
      model,
    )
  }
})

test('OmniHuman multi-person portraits require exactly one speaker mask bound to the current source', () => {
  const common = {
    model: 'OmniHuman 1.5',
    prompt: '',
    subjectLayout: 'multiple' as const,
  }
  const mask = {
    name: 'person-1.png',
    mimeType: 'image/png',
    byteSize: 120_000,
  }

  const missing = validateAvatarDraft(validPortraitDraft(common))
  assert.equal(missing.valid, false)
  assert.equal(missing.issues.some((issue) => issue.code === 'speaker-target-required'), true)

  const stale = validateAvatarDraft(validPortraitDraft({
    ...common,
    masks: [mask],
    maskSourceIds: ['previous-portrait'],
  }))
  assert.equal(stale.valid, false)
  assert.equal(stale.issues.some((issue) => issue.code === 'speaker-target-stale'), true)

  const valid = validateAvatarDraft(validPortraitDraft({
    ...common,
    masks: [mask],
    maskSourceIds: ['portrait-source'],
  }))
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.issues, [])

  const tooMany = validateAvatarDraft(validPortraitDraft({
    ...common,
    masks: [mask, { ...mask, name: 'person-2.png' }],
    maskSourceIds: ['portrait-source', 'portrait-source'],
  }))
  assert.equal(tooMany.valid, false)
  assert.equal(tooMany.issues.some((issue) => issue.code === 'speaker-target-count'), true)

  const singleWithMask = validateAvatarDraft(validPortraitDraft({
    model: 'OmniHuman 1.5',
    prompt: '',
    subjectLayout: 'single',
    masks: [mask],
    maskSourceIds: ['portrait-source'],
  }))
  assert.equal(singleWithMask.valid, false)
  assert.equal(singleWithMask.issues.some((issue) => issue.code === 'speaker-target-unexpected'), true)
})

test('Avatar request adapters independently fail closed on missing or ambiguous subject review', () => {
  assert.throws(
    () => buildAvatarRequest('Kling Avatar Pro', portraitContext({ subjectLayout: undefined })),
    /review whether the portrait contains one person or multiple people/i,
  )
  assert.throws(
    () => buildAvatarRequest('Kling Avatar Pro', portraitContext({ subjectLayout: 'none' })),
    /no person was identified/i,
  )
  assert.throws(
    () => buildAvatarRequest('OmniHuman 1.5', portraitContext({ subjectLayout: 'multiple', maskUrls: [] })),
    /choose exactly one detected person/i,
  )
  assert.throws(
    () => buildAvatarRequest('OmniHuman 1.5', portraitContext({
      subjectLayout: 'multiple',
      maskUrls: ['https://cdn.example/person-a.png', 'https://cdn.example/person-b.png'],
    })),
    /choose exactly one detected person/i,
  )

  assert.deepEqual(jobPayload(buildAvatarRequest('OmniHuman 1.5', portraitContext({
    subjectLayout: 'multiple',
    maskUrls: ['https://cdn.example/person-a.png'],
  }))).input.mask_url, ['https://cdn.example/person-a.png'])
})

test('OmniHuman subject detection uses its dedicated exact Kie Market request', () => {
  assert.deepEqual(jobPayload(buildAvatarSubjectDetectionRequest('https://cdn.example/group.png')), {
    model: 'omnihuman-1-5/subject-detection',
    input: { image_url: 'https://cdn.example/group.png' },
  })
  assert.throws(
    () => buildAvatarSubjectDetectionRequest('blob:local-group'),
    /must be uploaded before avatar generation/i,
  )
})

test('model defaults are derived from the same registry used by request serialization', () => {
  assert.deepEqual(defaultAvatarOptionsFor('OmniHuman 1.5'), {
    outputResolution: '1080',
    fastMode: false,
    seed: -1,
  })
  assert.deepEqual(defaultAvatarOptionsFor('Wan 2.2 A14B Speech-to-Video Turbo'), {
    numFrames: 80,
    framesPerSecond: 16,
    resolution: '480p',
    numInferenceSteps: 27,
    guidanceScale: 3.5,
    shift: 5,
    nsfwChecker: true,
  })
})
