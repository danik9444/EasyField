import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  applyLivePrices,
  avatarRunEstimate,
  formatEstimate,
  imageRunEstimate,
  musicRunEstimate,
  soundEffectsRunEstimate,
  ttsRunEstimate,
  videoEditRunEstimate,
  videoRunEstimate,
} from '../src/data/pricing.ts'
import type { KieLivePriceRow } from '../src/services/kie.ts'

function row(modelDescription: string, credits: number, unit = 'per image'): KieLivePriceRow {
  return { modelDescription, credits, unit, usd: credits * 0.005, interfaceType: '', provider: 'Kie', anchor: '' }
}

afterEach(() => applyLivePrices([]))

test('live image rows replace dated fallback values and are visibly labelled', () => {
  applyLivePrices([row('Google nano banana 2, 2K', 13)])
  const estimate = imageRunEstimate('Nano Banana 2', '2K', {}, 2)
  assert.equal(estimate.credits, 26)
  assert.equal(estimate.source, 'live')
  assert.match(formatEstimate(estimate), /^LIVE ·/)
})

test('offline estimates remain current dated fallbacks instead of becoming blockers', () => {
  const estimate = imageRunEstimate('Qwen2 Image', '', {}, 1)
  assert.equal(estimate.credits, 5.6)
  assert.equal(estimate.source, 'fallback')
  assert.match(formatEstimate(estimate), /^UPDATED 7\/11 ·/)
})

test('Seedream 5 Pro uses live output tiers and bills only references after the first', () => {
  applyLivePrices([
    row('seedream 5 Pro, image-to-image, 2K', 14),
    row('seedream 5 Pro, input image, First image free', 0.5),
  ])
  const estimate = imageRunEstimate('Seedream 5 Pro', '2K', { format: 'PNG' }, 2, { referenceCount: 3 })
  assert.equal(estimate.credits, 30)
  assert.equal(estimate.source, 'live')
})

test('video pricing distinguishes source-video billing and fixed per-video tiers', () => {
  applyLivePrices([
    row('bytedance/seedance-2, 720p no video input', 41, 'per second'),
    row('bytedance/seedance-2, 720p with video input', 25, 'per second'),
    row('Google veo 3.1, text-to-video, Fast-720p', 60, 'per video'),
  ])
  assert.equal(videoRunEstimate('Seedance 2', '720p', '5', {}, 1).credits, 205)
  assert.equal(videoRunEstimate('Seedance 2', '720p', '5', {}, 1, { hasVideoInput: true }).credits, 125)
  assert.equal(videoRunEstimate('Veo 3.1 Fast', '720p', '4', {}, 1).credits, 60)
  assert.equal(videoRunEstimate('Veo 3.1 Fast', '720p', '8', {}, 1).credits, 60)
})

test('latest Grok Preview and Hailuo Standard select their own live rows', () => {
  applyLivePrices([
    row('grok-imagine-video-1-5-preview, image-to-video, 720p', 3, 'per second'),
    row('hailuo 2.3, image-to-video, Standard-6.0s-1080p', 50, 'per video'),
  ])
  assert.equal(videoRunEstimate('Grok Imagine 1.5 Preview', '720p', '8', {}, 1).credits, 24)
  assert.equal(videoRunEstimate('Hailuo 2.3 Standard', '1080P', '6', {}, 1).credits, 50)
})

test('Kling 3 Motion Control prices the complete probed driver clip instead of a one-second placeholder', () => {
  applyLivePrices([
    row('kling 3.0 motion control, 720p', 20, 'per second'),
    row('kling 3.0 motion control, 1080p', 27, 'per second'),
  ])
  const exact = videoRunEstimate('Kling 3 Motion Control', '1080p', '', {}, 2, {
    hasVideoInput: true,
    inputDurationSeconds: 7.5,
  })
  assert.equal(exact.credits, 405)
  assert.equal(exact.perSecond, false)

  const unknown = videoRunEstimate('Kling 3 Motion Control', '720p', '', {}, 1, { hasVideoInput: true })
  assert.equal(unknown.credits, 20)
  assert.equal(unknown.perSecond, true)
})

test('current audio and edit fallbacks cover previously unknown prices', () => {
  assert.equal(musicRunEstimate('V5').credits, 12)
  assert.equal(soundEffectsRunEstimate().credits, 2.5)
  assert.equal(ttsRunEstimate('turbo-2-5', 1000).credits, 6)
  assert.equal(ttsRunEstimate('text-to-dialogue-v3', 1000).credits, 14)
  assert.equal(videoEditRunEstimate('custom', 'Runway Aleph', {}, '').credits, 110)
})

test('Suno Sounds uses the exact live per-request row without duration multiplication', () => {
  applyLivePrices([row('Suno, Generate sounds', 3.25, 'per request')])
  const estimate = soundEffectsRunEstimate()
  assert.equal(estimate.credits, 3.25)
  assert.equal(estimate.perSecond, false)
  assert.equal(estimate.source, 'live')
})

test('Avatar pricing uses live Kie rows and the actual voice or frame duration', () => {
  applyLivePrices([
    row('Kling AI Avtar Pro', 16, 'per second'),
    row('InfiniteTalk, From Audio, 720p', 12, 'per second'),
    row('Wan 2.2 Speech to Video Turbo, 720p', 24, 'per second'),
    row('Volcengine, Video Lip Sync', 8, 'per second'),
  ])

  const kling = avatarRunEstimate('Kling Avatar Pro', 2, { audioDurationSeconds: 4 })
  assert.equal(kling.credits, 128)
  assert.equal(kling.perSecond, false)
  assert.equal(kling.source, 'live')

  const unknownDuration = avatarRunEstimate('InfiniteTalk', 1, { resolution: '720p' })
  assert.equal(unknownDuration.credits, 12)
  assert.equal(unknownDuration.perSecond, true)

  const wan = avatarRunEstimate('Wan 2.2 A14B Speech-to-Video Turbo', 1, {
    resolution: '720p',
    numFrames: 80,
    framesPerSecond: 16,
  })
  assert.equal(wan.credits, 120)
  assert.equal(wan.perSecond, false)

  const lipSync = avatarRunEstimate('Volcengine Lip Sync', 1, { audioDurationSeconds: 3.5 })
  assert.equal(lipSync.credits, 28)
})
