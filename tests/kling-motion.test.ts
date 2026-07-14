import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KLING_MOTION_IMAGE_MAX_BYTES,
  KLING_MOTION_IMAGE_ORIENTATION_MAX_DURATION_MS,
  KLING_MOTION_PROMPT_MAX,
  KLING_MOTION_VIDEO_MAX_BYTES,
  KLING_MOTION_VIDEO_MAX_DURATION_MS,
  KLING_MOTION_VIDEO_MIN_DURATION_MS,
  validateKlingMotionDraft,
  type KlingMotionDraft,
  type KlingMotionFileLike,
} from '../src/data/klingMotion.ts'
import { VIDEO_MODEL_CONFIG } from '../src/data/videoModelConfig.ts'

const MB = 1024 * 1024

const image = (overrides: Partial<KlingMotionFileLike> = {}): KlingMotionFileLike => ({
  name: 'character.png',
  type: 'image/png',
  size: 2 * MB,
  width: 1080,
  height: 1350,
  ...overrides,
})

const video = (overrides: Partial<KlingMotionFileLike> = {}): KlingMotionFileLike => ({
  name: 'driver.mov',
  type: 'video/quicktime',
  size: 30 * MB,
  width: 1080,
  height: 1920,
  durationMs: 8_000,
  ...overrides,
})

const draft = (overrides: Partial<KlingMotionDraft> = {}): KlingMotionDraft => ({
  prompt: 'The character follows the driver naturally.',
  images: [image()],
  videos: [video()],
  orientation: 'image',
  ...overrides,
})

const codes = (value: KlingMotionDraft) => validateKlingMotionDraft(value).issues.map((issue) => issue.code)

test('Kling Motion and Turbo expose the documented prompt ceiling without treating Elements as an Extend source', () => {
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3'].promptMax, KLING_MOTION_PROMPT_MAX)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3'].referenceImages, false)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3'].maxReferenceImages, 0)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3'].video, undefined)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3'].audio, undefined)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3 Turbo'].promptMax, KLING_MOTION_PROMPT_MAX)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3 Motion Control'].promptMax, KLING_MOTION_PROMPT_MAX)
  assert.equal(VIDEO_MODEL_CONFIG['Kling 3'].extendVideoReference, undefined)
})

test('validates exactly one character image and one driver video', () => {
  assert.equal(validateKlingMotionDraft(draft()).valid, true)
  assert(codes(draft({ images: [] })).includes('image-count'))
  assert(codes(draft({ images: [image(), image()] })).includes('image-count'))
  assert(codes(draft({ videos: [] })).includes('video-count'))
  assert(codes(draft({ videos: [video(), video()] })).includes('video-count'))
})

test('prompt length uses Unicode characters and enforces the inclusive 2500-character boundary', () => {
  assert.equal(validateKlingMotionDraft(draft({ prompt: '🎬'.repeat(KLING_MOTION_PROMPT_MAX) })).valid, true)
  assert(codes(draft({ prompt: '🎬'.repeat(KLING_MOTION_PROMPT_MAX + 1) })).includes('prompt-too-long'))
  assert(codes(draft({ orientation: 'subject' })).includes('invalid-orientation'))
})

test('accepts JPG/PNG images through the inclusive 10MB boundary and rejects incompatible or contradictory types', () => {
  assert.equal(validateKlingMotionDraft(draft({ images: [image({ name: 'character.jpg', type: 'image/jpeg', size: KLING_MOTION_IMAGE_MAX_BYTES })] })).valid, true)
  assert(codes(draft({ images: [image({ name: 'character.webp', type: 'image/webp' })] })).includes('image-type'))
  assert(codes(draft({ images: [image({ name: 'character.exe', type: 'image/jpeg' })] })).includes('image-type'))
  assert(codes(draft({ images: [image({ size: KLING_MOTION_IMAGE_MAX_BYTES + 1 })] })).includes('image-size'))
})

test('enforces image and video dimensions greater than 340px and the inclusive 2:5–5:2 aspect range', () => {
  assert.equal(validateKlingMotionDraft(draft({ images: [image({ width: 400, height: 1000 })] })).valid, true)
  assert.equal(validateKlingMotionDraft(draft({ images: [image({ width: 1000, height: 400 })] })).valid, true)
  assert(codes(draft({ images: [image({ width: 340, height: 1000 })] })).includes('image-dimensions'))
  assert(codes(draft({ images: [image({ width: 399, height: 1000 })] })).includes('image-aspect-ratio'))
  assert(codes(draft({ videos: [video({ width: 1000, height: 399 })] })).includes('video-aspect-ratio'))
  assert(codes(draft({ videos: [video({ width: 1920, height: 340 })] })).includes('video-dimensions'))
})

test('accepts MP4/MOV videos up to 100MB and durations from 3–30 seconds', () => {
  assert.equal(validateKlingMotionDraft(draft({ orientation: 'video', videos: [video({ name: 'driver.mp4', type: 'video/mp4', size: KLING_MOTION_VIDEO_MAX_BYTES, durationMs: KLING_MOTION_VIDEO_MIN_DURATION_MS })] })).valid, true)
  assert.equal(validateKlingMotionDraft(draft({ orientation: 'video', videos: [video({ durationMs: KLING_MOTION_VIDEO_MAX_DURATION_MS })] })).valid, true)
  assert(codes(draft({ videos: [video({ name: 'driver.webm', type: 'video/webm' })] })).includes('video-type'))
  assert(codes(draft({ videos: [video({ size: KLING_MOTION_VIDEO_MAX_BYTES + 1 })] })).includes('video-size'))
  assert(codes(draft({ videos: [video({ durationMs: KLING_MOTION_VIDEO_MIN_DURATION_MS - 1 })] })).includes('video-duration'))
  assert(codes(draft({ orientation: 'video', videos: [video({ durationMs: KLING_MOTION_VIDEO_MAX_DURATION_MS + 1 })] })).includes('video-duration'))
})

test('image character orientation limits the driver to 10 seconds', () => {
  assert.equal(validateKlingMotionDraft(draft({ videos: [video({ durationMs: KLING_MOTION_IMAGE_ORIENTATION_MAX_DURATION_MS })] })).valid, true)
  assert(codes(draft({ videos: [video({ durationMs: KLING_MOTION_IMAGE_ORIENTATION_MAX_DURATION_MS + 1 })] })).includes('image-orientation-video-duration'))
  assert.equal(validateKlingMotionDraft(draft({ orientation: 'video', videos: [video({ durationMs: KLING_MOTION_IMAGE_ORIENTATION_MAX_DURATION_MS + 1 })] })).valid, true)
})

test('unknown hosted or Resolve-grab metadata is deferred rather than blocking existing sources', () => {
  const value = draft({
    images: [{ id: 'grab-image', url: 'resolve://timeline/frame' }],
    videos: [{ id: 'grab-video', url: 'https://media.example/driver' }],
  })
  const before = structuredClone(value)
  const result = validateKlingMotionDraft(value)
  assert.equal(result.valid, true)
  assert.deepEqual(result.deferredChecks.map((check) => check.code), [
    'image-type-unknown',
    'image-size-unknown',
    'image-dimensions-unknown',
    'video-type-unknown',
    'video-size-unknown',
    'video-dimensions-unknown',
    'video-duration-unknown',
  ])
  assert.deepEqual(value, before)
})

test('persisted metadata aliases and durationSeconds are accepted structurally', () => {
  const result = validateKlingMotionDraft(draft({
    orientation: 'video',
    images: [{ name: 'character', mimeType: 'image/png', byteSize: 1 * MB, width: 800, height: 800 }],
    videos: [{ name: 'driver', mimeType: 'video/mp4', byteSize: 5 * MB, width: 720, height: 1280, durationSeconds: 30 }],
  }))
  assert.equal(result.valid, true)
  assert.deepEqual(result.deferredChecks, [])
})
