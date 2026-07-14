import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { buildImageUpscaleRequest, buildVideoUpscaleRequest } from '../src/data/kieModels.ts'
import { applyLivePrices, upscaleBatchEstimate, upscaleRunEstimate } from '../src/data/pricing.ts'
import {
  TOPAZ_IMAGE_MAX_BYTES,
  TOPAZ_VIDEO_MAX_BYTES,
  inferTopazSourceKind,
  topazFactorsForSource,
  topazImageOutputTier,
  topazModelForKind,
  validateTopazSource,
} from '../src/data/upscale.ts'
import type { KieLivePriceRow } from '../src/services/kie.ts'

function liveRow(modelDescription: string, credits: number, unit: string): KieLivePriceRow {
  return { modelDescription, credits, unit, usd: credits * 0.005, interfaceType: '', provider: 'Topaz', anchor: '' }
}

afterEach(() => applyLivePrices([]))

test('source type selects the matching Topaz model and documented factors', () => {
  assert.equal(inferTopazSourceKind({ name: 'portrait.webp', type: '' }), 'image')
  assert.equal(inferTopazSourceKind({ name: 'shot.mov', type: 'video/quicktime' }), 'video')
  assert.equal(inferTopazSourceKind({ name: 'notes.txt', type: 'text/plain' }), null)
  assert.equal(topazModelForKind('image'), 'Topaz Image Upscale')
  assert.equal(topazModelForKind('video'), 'Topaz Video Upscale')
  assert.deepEqual(topazFactorsForSource('video'), ['1×', '2×', '4×'])
  assert.deepEqual(topazFactorsForSource('image', 4_096, 2_160), ['1×', '2×', '4×'])
  assert.deepEqual(topazFactorsForSource('image', 10_000, 5_000), ['1×', '2×'])
})

test('Topaz input validation enforces the official formats and byte caps', () => {
  assert.deepEqual(validateTopazSource({ name: 'still.png', type: 'image/png', size: TOPAZ_IMAGE_MAX_BYTES }), {
    kind: 'image', mimeType: 'image/png', byteSize: TOPAZ_IMAGE_MAX_BYTES,
  })
  assert.deepEqual(validateTopazSource({ name: 'clip.mkv', type: 'video/x-matroska', size: TOPAZ_VIDEO_MAX_BYTES }), {
    kind: 'video', mimeType: 'video/x-matroska', byteSize: TOPAZ_VIDEO_MAX_BYTES,
  })
  assert.throws(() => validateTopazSource({ name: 'still.gif', type: 'image/gif', size: 100 }), /JPG, PNG or WEBP/)
  assert.throws(() => validateTopazSource({ name: 'clip.webm', type: 'video/webm', size: 100 }), /MP4, MOV or MKV/)
  assert.throws(() => validateTopazSource({ name: 'still.jpg', type: 'image/jpeg', size: TOPAZ_IMAGE_MAX_BYTES + 1 }), /10 MB/)
  assert.throws(() => validateTopazSource({ name: 'clip.mp4', type: 'video/mp4', size: TOPAZ_VIDEO_MAX_BYTES + 1 }), /50 MB/)
})

test('Topaz builders serialize only verified provider fields and reject invalid factors', () => {
  const image = buildImageUpscaleRequest('Topaz Image Upscale', 'https://cdn/source.png', '8×')
  const video = buildVideoUpscaleRequest('https://cdn/source.mp4', '4×')
  assert.deepEqual(image, {
    family: 'jobs',
    model: 'topaz/image-upscale',
    input: { image_url: 'https://cdn/source.png', upscale_factor: '8', nsfw_checker: true },
  })
  assert.deepEqual(video, {
    family: 'jobs',
    model: 'topaz/video-upscale',
    input: { video_url: 'https://cdn/source.mp4', upscale_factor: '4', nsfw_checker: true },
  })
  assert.throws(() => buildImageUpscaleRequest('Topaz Image Upscale', 'https://cdn/source.png', '16×'), /must be 1, 2, 4, 8/)
  assert.throws(() => buildVideoUpscaleRequest('https://cdn/source.mp4', '8×'), /must be 1, 2, 4/)
})

test('Topaz image tiers and live video duration pricing use source metadata', () => {
  applyLivePrices([
    liveRow('Topaz image upscaler, 4K', 20, 'per image'),
    liveRow('Topaz video upscaler, 1x/2x', 8, 'per second'),
    liveRow('Topaz video upscaler, 4x', 14, 'per second'),
  ])
  assert.equal(topazImageOutputTier(1_000, 800, '4×'), '4K')
  const image = upscaleRunEstimate('image', '4×', { width: 1_000, height: 800 })
  assert.equal(image.credits, 20)
  assert.equal(image.source, 'live')
  assert.equal(image.perSecond, false)

  const exactVideo = upscaleRunEstimate('video', '2×', { durationSeconds: 5.25 })
  assert.equal(exactVideo.credits, 42)
  assert.equal(exactVideo.perSecond, false)
  assert.equal(exactVideo.source, 'live')

  const unknownDuration = upscaleRunEstimate('video', '4×')
  assert.equal(unknownDuration.credits, 14)
  assert.equal(unknownDuration.perSecond, true)

  const abovePublishedImageTier = upscaleRunEstimate('image', '2×', { width: 5_000, height: 3_000 })
  assert.equal(abovePublishedImageTier.credits, null)
  assert.equal(abovePublishedImageTier.source, 'unavailable')
})

test('mixed Topaz batch pricing sums only exact per-source estimates', () => {
  applyLivePrices([
    liveRow('Topaz image upscaler, 4K', 20, 'per image'),
    liveRow('Topaz video upscaler, 1x/2x', 8, 'per second'),
  ])
  const exact = upscaleBatchEstimate([
    { kind: 'image', factor: '2×', width: 1_500, height: 1_000 },
    { kind: 'video', factor: '2×', durationSeconds: 3.5 },
  ])
  assert.equal(exact.credits, 48)
  assert.equal(exact.source, 'live')
  assert.equal(exact.perSecond, false)
  assert.equal(exact.count, 2)
  assert.equal(exact.unit, undefined)

  const unknown = upscaleBatchEstimate([
    { kind: 'image', factor: '2×', width: 1_500, height: 1_000 },
    { kind: 'video', factor: '2×' },
  ])
  assert.equal(unknown.credits, null)
  assert.equal(unknown.source, 'unavailable')
  assert.equal(unknown.perSecond, false)
})
