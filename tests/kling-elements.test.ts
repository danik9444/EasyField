import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KLING_ELEMENT_AUDIO_MAX_DURATION_MS,
  KLING_ELEMENT_AUDIO_MIN_DURATION_MS,
  KLING_ELEMENT_IMAGE_MAX,
  KLING_ELEMENT_IMAGE_MAX_ASPECT_RATIO,
  KLING_ELEMENT_IMAGE_MAX_BYTES,
  KLING_ELEMENT_IMAGE_MIN,
  KLING_ELEMENT_IMAGE_MIN_ASPECT_RATIO,
  KLING_ELEMENT_IMAGE_MIN_HEIGHT,
  KLING_ELEMENT_IMAGE_MIN_WIDTH,
  KLING_ELEMENT_MAX,
  KLING_ELEMENT_VIDEO_MIN_DURATION_MS,
  KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS,
  KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS,
  isKlingElementProviderName,
  klingElementProviderName,
  klingElementProviderTag,
  klingElementReferenceManifest,
  klingElementReferenceOptions,
  stripOrphanKlingSceneReferenceTags,
  toKlingProviderElement,
  validateKlingElementDraft,
  validateKlingElementDrafts,
  type KlingElementDraft,
  type KlingElementFileLike,
} from '../src/data/klingElements.ts'

const MB = 1024 * 1024

const file = (name: string, type: string, size = 1 * MB): KlingElementFileLike => ({ name, type, size })
const jpg = (index: number, size = 1 * MB): KlingElementFileLike => ({
  ...file(`portrait-${index}.jpg`, 'image/jpeg', size),
  width: 300,
  height: 300,
})
const png = (index: number, size = 1 * MB): KlingElementFileLike => ({
  ...file(`portrait-${index}.png`, 'image/png', size),
  width: 300,
  height: 300,
})

const imageElement = (id = 'hero', count = 2): KlingElementDraft => ({
  id,
  name: 'Hero',
  description: 'The lead courier in a charcoal coat',
  media: { kind: 'images', files: Array.from({ length: count }, (_, index) => index % 2 ? png(index) : jpg(index)) },
})

const videoElement = (overrides: Partial<KlingElementDraft> = {}): KlingElementDraft => ({
  id: 'vehicle',
  name: 'Vehicle',
  description: 'A red electric motorcycle',
  media: {
    kind: 'video',
    file: file('motorcycle.mov', 'video/quicktime', 40 * MB),
    durationMs: 12_000,
    startTimeMs: 2_000,
    endTimeMs: 8_000,
  },
  ...overrides,
})

const codes = (element: KlingElementDraft) => validateKlingElementDraft(element).issues.map((entry) => entry.code)

test('Kling contract constants mirror the documented provider boundaries', () => {
  assert.equal(KLING_ELEMENT_MAX, 3)
  assert.equal(KLING_ELEMENT_IMAGE_MIN, 2)
  assert.equal(KLING_ELEMENT_IMAGE_MAX, 4)
  assert.equal(KLING_ELEMENT_IMAGE_MAX_BYTES, 10 * MB)
  assert.equal(KLING_ELEMENT_IMAGE_MIN_WIDTH, 300)
  assert.equal(KLING_ELEMENT_IMAGE_MIN_HEIGHT, 300)
  assert.equal(KLING_ELEMENT_IMAGE_MIN_ASPECT_RATIO, 0.4)
  assert.equal(KLING_ELEMENT_IMAGE_MAX_ASPECT_RATIO, 2.5)
  assert.equal(KLING_ELEMENT_VIDEO_MIN_DURATION_MS, 3_000)
  assert.equal(KLING_ELEMENT_VIDEO_SEGMENT_MIN_MS, 3_000)
  assert.equal(KLING_ELEMENT_VIDEO_SEGMENT_MAX_MS, 8_000)
  assert.equal(KLING_ELEMENT_AUDIO_MIN_DURATION_MS, 5_000)
  assert.equal(KLING_ELEMENT_AUDIO_MAX_DURATION_MS, 30_000)
})

test('provider names and tags are safe, deterministic, stable across display-name edits and collision resistant', () => {
  const name = klingElementProviderName('Hero / Front')
  assert(isKlingElementProviderName(name))
  assert.equal(klingElementProviderName('Hero / Front'), name)
  assert.equal(klingElementProviderTag('Hero / Front'), `@${name}`)
  assert.notEqual(klingElementProviderName('Hero Front'), name, 'IDs that slugify alike retain distinct hash suffixes')
  assert.equal(klingElementProviderName('דמות ראשית').startsWith('element_reference_'), true)

  const draft = imageElement('stable-id')
  const before = klingElementProviderTag(draft.id)
  const renamed = { ...draft, name: 'A completely different display name' }
  assert.equal(klingElementProviderTag(renamed.id), before)
})

test('required identity, name, description and media are reported together', () => {
  const result = validateKlingElementDraft({ id: ' ', name: '', description: '\n', media: null })
  assert.equal(result.valid, false)
  assert.deepEqual(result.issues.map((entry) => entry.code), [
    'missing-id',
    'missing-name',
    'missing-description',
    'missing-media',
  ])
})

test('image elements accept 2–4 JPG/PNG files and the inclusive 10 MB boundary', () => {
  const minimum = imageElement('min', 2)
  const maximum = imageElement('max', 4)
  maximum.media = { kind: 'images', files: [jpg(1), png(2), jpg(3, KLING_ELEMENT_IMAGE_MAX_BYTES), png(4)] }

  assert.equal(validateKlingElementDraft(minimum).valid, true)
  assert.equal(validateKlingElementDraft(maximum).valid, true)
  assert(codes(imageElement('too-few', 1)).includes('image-count'))
  assert(codes(imageElement('too-many', 5)).includes('image-count'))

  const tooLarge = imageElement('large')
  tooLarge.media = { kind: 'images', files: [jpg(1), png(2, KLING_ELEMENT_IMAGE_MAX_BYTES + 1)] }
  assert(codes(tooLarge).includes('image-size'))

  const wrongType = imageElement('gif')
  wrongType.media = { kind: 'images', files: [jpg(1), file('animated.gif', 'image/gif')] }
  assert(codes(wrongType).includes('image-type'))
})

test('image element dimensions and aspect ratio use inclusive Kie boundaries', () => {
  for (const [width, height] of [
    [300, 300],
    [300, 750],
    [750, 300],
  ]) {
    const draft = imageElement(`valid-${width}-${height}`)
    draft.media = {
      kind: 'images',
      files: [
        { ...jpg(1), width, height },
        { ...png(2), width, height },
      ],
    }
    assert.equal(validateKlingElementDraft(draft).valid, true, `${width}×${height} should be accepted`)
  }

  for (const [width, height] of [
    [299, 300],
    [300, 299],
  ]) {
    const draft = imageElement(`too-small-${width}-${height}`)
    draft.media = { kind: 'images', files: [{ ...jpg(1), width, height }, { ...png(2), width: 300, height: 300 }] }
    assert(codes(draft).includes('image-dimensions'), `${width}×${height} should fail minimum dimensions`)
  }

  for (const [width, height] of [
    [300, 751],
    [751, 300],
  ]) {
    const draft = imageElement(`bad-ratio-${width}-${height}`)
    draft.media = { kind: 'images', files: [{ ...jpg(1), width, height }, { ...png(2), width: 300, height: 300 }] }
    assert(codes(draft).includes('image-aspect-ratio'), `${width}×${height} should fail aspect ratio`)
  }
})

test('missing or incomplete image metadata blocks safely instead of bypassing provider preflight', () => {
  const partial = imageElement('partial-dimensions')
  partial.media = { kind: 'images', files: [{ ...jpg(1), width: 600 }, png(2)] }
  delete partial.media.files[0].height
  assert(codes(partial).includes('image-dimensions'))

  const missing = imageElement('missing-dimensions')
  missing.media = { kind: 'images', files: [file('one.jpg', 'image/jpeg'), png(2)] }
  assert(codes(missing).includes('image-dimensions'))
})

test('file checks stay browser-File compatible while working with plain Node objects', () => {
  const extensionOnly = imageElement('extension-only')
  extensionOnly.media = { kind: 'images', files: [{ ...file('one.JPG', ''), width: 300, height: 300 }, { ...file('two.png', ''), width: 300, height: 300 }] }
  assert.equal(validateKlingElementDraft(extensionOnly).valid, true)

  const mimeOnly = imageElement('mime-only')
  mimeOnly.media = { kind: 'images', files: [{ ...file('one', 'image/jpeg'), width: 300, height: 300 }, { ...file('two', 'image/png'), width: 300, height: 300 }] }
  assert.equal(validateKlingElementDraft(mimeOnly).valid, true)

  const contradictory = imageElement('contradictory')
  contradictory.media = { kind: 'images', files: [{ ...file('one.exe', 'image/jpeg'), width: 300, height: 300 }, png(2)] }
  assert(codes(contradictory).includes('image-type'))

  const persistedReferenceShape = imageElement('reference-image-shape')
  persistedReferenceShape.media = {
    kind: 'images',
    files: [
      { id: 'one', name: 'one.jpg', mimeType: 'image/jpeg', byteSize: KLING_ELEMENT_IMAGE_MAX_BYTES, width: 300, height: 300 },
      { id: 'two', name: 'two.png', mimeType: 'image/png', byteSize: 500_000, width: 300, height: 300 },
    ],
  }
  assert.equal(validateKlingElementDraft(persistedReferenceShape).valid, true)
})

test('video elements accept one MP4/MOV and inclusive 3–8 second effective segments', () => {
  const lower = videoElement()
  lower.media = { kind: 'video', file: file('clip.mp4', 'video/mp4'), durationMs: 3_000, startTimeMs: 0, endTimeMs: 3_000 }
  const upper = videoElement()
  upper.media = { kind: 'video', file: file('clip.mov', 'video/quicktime'), durationMs: 10_000, startTimeMs: 2_000, endTimeMs: 10_000 }
  assert.equal(validateKlingElementDraft(lower).valid, true)
  assert.equal(validateKlingElementDraft(upper).valid, true)

  const tooShortSource = videoElement()
  tooShortSource.media = { kind: 'video', file: file('clip.mp4', 'video/mp4'), durationMs: 2_999, startTimeMs: 0, endTimeMs: 2_999 }
  assert(codes(tooShortSource).includes('video-duration'))

  const shortSegment = videoElement()
  shortSegment.media = { kind: 'video', file: file('clip.mp4', 'video/mp4'), durationMs: 9_000, startTimeMs: 0, endTimeMs: 2_999 }
  assert(codes(shortSegment).includes('video-segment-duration'))
  const longSegment = videoElement()
  longSegment.media = { kind: 'video', file: file('clip.mov', 'video/quicktime'), durationMs: 9_000, startTimeMs: 0, endTimeMs: 8_001 }
  assert(codes(longSegment).includes('video-segment-duration'))
})

test('video trim must be whole milliseconds, ordered and inside source duration', () => {
  for (const media of [
    { durationMs: 9_000, startTimeMs: -1, endTimeMs: 4_000 },
    { durationMs: 9_000, startTimeMs: 4_000, endTimeMs: 4_000 },
    { durationMs: 9_000, startTimeMs: 2_000, endTimeMs: 9_001 },
    { durationMs: 9_000, startTimeMs: 0.5, endTimeMs: 4_000 },
  ]) {
    const draft = videoElement()
    draft.media = { kind: 'video', file: file('clip.mp4', 'video/mp4'), ...media }
    assert(codes(draft).includes('video-trim'))
  }

  const wrongType = videoElement()
  wrongType.media = { kind: 'video', file: file('clip.webm', 'video/webm'), durationMs: 9_000, startTimeMs: 0, endTimeMs: 4_000 }
  assert(codes(wrongType).includes('video-type'))
})

test('optional audio accepts the inclusive 5–30 second duration range', () => {
  for (const durationMs of [KLING_ELEMENT_AUDIO_MIN_DURATION_MS, KLING_ELEMENT_AUDIO_MAX_DURATION_MS]) {
    const draft = imageElement(`audio-${durationMs}`)
    draft.audio = { file: file('voice.wav', 'audio/wav'), durationMs }
    assert.equal(validateKlingElementDraft(draft).valid, true)
  }
  for (const durationMs of [KLING_ELEMENT_AUDIO_MIN_DURATION_MS - 1, KLING_ELEMENT_AUDIO_MAX_DURATION_MS + 1, 5_000.5]) {
    const draft = imageElement(`bad-audio-${durationMs}`)
    draft.audio = { file: file('voice.wav', 'audio/wav'), durationMs }
    assert(codes(draft).includes('audio-duration'))
  }
})

test('collection validation enforces at most three elements and unique stable provider tags', () => {
  const valid = [imageElement('one'), imageElement('two'), videoElement({ id: 'three' })]
  assert.equal(validateKlingElementDrafts(valid).valid, true)

  const tooMany = [...valid, imageElement('four')]
  assert(validateKlingElementDrafts(tooMany).issues.some((entry) => entry.code === 'too-many-elements'))

  const duplicate = [imageElement('same'), imageElement('same')]
  assert(validateKlingElementDrafts(duplicate).issues.some((entry) => entry.code === 'duplicate-provider-tag'))
})

test('reference options and context manifest preserve element order without exposing media URLs', () => {
  const withAudio = imageElement('hero')
  withAudio.audio = { file: file('voice.wav', 'audio/wav'), durationMs: 6_000 }
  const elements = [withAudio, videoElement()]
  const untouched = structuredClone(elements)

  const options = klingElementReferenceOptions(elements)
  assert.deepEqual(options.map((entry) => entry.elementId), ['hero', 'vehicle'])
  assert.deepEqual(options.map((entry) => entry.mediaKind), ['images', 'video'])
  assert(options[0].tag.startsWith('@element_hero_'))

  const manifest = klingElementReferenceManifest(elements)
  assert.match(manifest[0], /Hero .* 2 images .* audio 6\.0s/)
  assert.match(manifest[1], /Vehicle .* video 2\.0–8\.0s/)
  assert.equal(manifest.some((entry) => /https?:\/\//.test(entry)), false)
  assert.deepEqual(elements, untouched)
})

test('orphan tags are stripped without mutating scenes or elements', () => {
  const elements = [imageElement('hero'), imageElement('case')]
  const heroTag = klingElementProviderTag('hero')
  const caseTag = klingElementProviderTag('case')
  const scenes = [
    { id: 'one', prompt: 'Opening', referenceTags: [heroTag, '@element_deleted_deadbeef', heroTag] },
    { id: 'two', prompt: 'Middle', referenceTags: [caseTag] },
    { id: 'three', prompt: 'Ending' },
    { id: 'four', prompt: 'No references', referenceTags: [] },
  ]
  const sceneSnapshot = structuredClone(scenes)
  const elementSnapshot = structuredClone(elements)

  const stripped = stripOrphanKlingSceneReferenceTags(scenes, [elements[0]])
  assert.deepEqual(stripped[0].referenceTags, [heroTag])
  assert.deepEqual(stripped[1].referenceTags, [])
  assert.equal(stripped[2].referenceTags, undefined, 'undefined keeps the existing “all current elements” semantic')
  assert.deepEqual(stripped[3].referenceTags, [])
  assert.notEqual(stripped[0], scenes[0])
  assert.deepEqual(scenes, sceneSnapshot)
  assert.deepEqual(elements, elementSnapshot)
})

test('hosted elements convert to provider payloads with copied arrays and video trim metadata', () => {
  const inputUrls = ['https://media.example/clip.mov']
  const providerName = klingElementProviderName('vehicle')
  const provider = toKlingProviderElement({
    id: 'vehicle',
    name: 'Vehicle',
    description: 'Red motorcycle',
    providerName,
    mediaKind: 'video',
    inputUrls,
    audioUrl: 'https://media.example/engine.wav',
    startTimeMs: 1_000,
    endTimeMs: 7_000,
  })
  assert.deepEqual(provider, {
    name: providerName,
    description: 'Red motorcycle',
    element_input_urls: ['https://media.example/clip.mov'],
    element_input_audio_urls: ['https://media.example/engine.wav'],
    start_time: 1_000,
    end_time: 7_000,
  })
  provider.element_input_urls.push('https://media.example/other.mov')
  assert.deepEqual(inputUrls, ['https://media.example/clip.mov'])
  assert.throws(() => toKlingProviderElement({
    id: 'bad',
    name: 'Bad',
    description: 'Bad name',
    providerName: 'not safe!',
    mediaKind: 'images',
    inputUrls: ['https://media.example/one.png', 'https://media.example/two.png'],
  }), /Invalid Kling provider element name/)
  assert.throws(() => toKlingProviderElement({
    id: 'missing-display-name',
    name: ' ',
    description: 'Reference identity',
    providerName: klingElementProviderName('missing-display-name'),
    mediaKind: 'images',
    inputUrls: ['https://media.example/one.png', 'https://media.example/two.png'],
  }), /require a display name/)
  assert.throws(() => toKlingProviderElement({
    id: 'stable-id',
    name: 'Hero',
    description: 'Reference identity',
    providerName: klingElementProviderName('different-id'),
    mediaKind: 'images',
    inputUrls: ['https://media.example/one.png', 'https://media.example/two.png'],
  }), /stable element identity/)
})
