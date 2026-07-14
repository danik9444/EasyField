import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  MAX_AUDIO_BYTES,
  RenderError,
  buildEncoderArgs,
  createAnimationRenderService,
  validateRenderPayload,
} = require('../plugin/animation-render.cjs')
const {
  MAX_ANIMATION_AUDIO_BYTES,
  buildAnimationAudioMuxArgs,
  validateAnimationAudioDataUrl,
} = await import('../vite-plugin-render.ts')

const metadata = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 5,
}

const props = {
  mode: 'presets',
  text: 'EasyField',
  preset: 'Fade In',
  accent: '#E26BD2',
  bg: '#101015',
  assetUrls: [],
}

function assertRenderError(fn, code) {
  assert.throws(fn, (error) => error instanceof RenderError && error.code === code)
}

test('normalizes validated Remotion metadata into the composition props', () => {
  const job = validateRenderPayload({
    engine: 'Remotion',
    ...metadata,
    props: { ...props, recipe: 'product-video', width: 9999, fps: 999 },
  })
  assert.equal(job.frameCount, 150)
  assert.equal(job.props.recipe, 'product-video')
  assert.equal(job.props.width, 1920)
  assert.equal(job.props.height, 1080)
  assert.equal(job.props.fps, 30)
  assert.equal(job.props.durationSec, 5)
})

test('defaults legacy Remotion jobs without a recipe to Custom', () => {
  const job = validateRenderPayload({ engine: 'Remotion', ...metadata, props })
  assert.equal(job.props.recipe, 'custom')
})

test('rejects unsupported Animation recipes at the render boundary', () => {
  assertRenderError(
    () => validateRenderPayload({
      engine: 'Remotion',
      ...metadata,
      props: { ...props, recipe: 'unsafe-custom-code' },
    }),
    'BAD_RENDER_REQUEST',
  )
  assertRenderError(
    () => validateRenderPayload({
      engine: 'Remotion',
      ...metadata,
      props: { ...props, recipe: 'template-video' },
    }),
    'BAD_RENDER_REQUEST',
  )
})

test('accepts generated HyperFrames HTML with explicit render metadata', () => {
  const job = validateRenderPayload({ engine: 'HyperFrames', ...metadata, html: '<!doctype html><div id="root"></div>' })
  assert.equal(job.engine, 'HyperFrames')
  assert.equal(job.frameCount, 150)
})

test('accepts a bounded top-level embedded audio file for either animation engine', () => {
  const audioDataUrl = `data:audio/wav;base64,${Buffer.from('RIFF-safe-audio').toString('base64')}`
  const remotion = validateRenderPayload({ engine: 'Remotion', ...metadata, props, audioDataUrl })
  assert.equal(remotion.audioDataUrl, audioDataUrl)
  assert.equal(remotion.audioMimeType, 'audio/wav')
  assert.equal(remotion.audioFormat, 'wav')
  assert.equal(remotion.audioExtension, 'wav')
  assert.equal(remotion.audioByteLength, Buffer.byteLength('RIFF-safe-audio'))

  const hyperFrames = validateRenderPayload({
    engine: 'HyperFrames',
    ...metadata,
    html: '<!doctype html><div></div>',
    audioDataUrl,
  })
  assert.equal(hyperFrames.audioDataUrl, audioDataUrl)
})

test('rejects remote, non-audio and malformed embedded animation audio', () => {
  const request = (audioDataUrl) => ({ engine: 'Remotion', ...metadata, props, audioDataUrl })
  for (const value of [
    'https://attacker.invalid/audio.mp3',
    'data:text/plain;base64,UklGRg==',
    'data:audio/wav,UklGRg==',
    'data:audio/wav;base64,UklG Rg==',
    'data:audio/x-unknown;base64,UklGRg==',
    'data:audio/wav;base64,',
  ]) {
    assertRenderError(() => validateRenderPayload(request(value)), 'BAD_RENDER_REQUEST')
  }
})

test('rejects embedded animation audio above the 24 MB raw-byte cap', () => {
  assert.equal(MAX_AUDIO_BYTES, 24 * 1024 * 1024)
  const oversizedBase64 = 'AAAA'.repeat((MAX_AUDIO_BYTES / 3) + 1)
  assertRenderError(
    () => validateRenderPayload({
      engine: 'Remotion',
      ...metadata,
      props,
      audioDataUrl: `data:audio/wav;base64,${oversizedBase64}`,
    }),
    'PAYLOAD_TOO_LARGE',
  )
})

test('keeps the silent ffmpeg command unchanged and AAC-muxes optional audio to the video duration', () => {
  const silent = buildEncoderArgs(metadata, '/tmp/silent.mp4')
  assert.deepEqual(silent, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'rawvideo',
    '-pixel_format', 'bgra',
    '-video_size', '1920x1080',
    '-framerate', '30',
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '/tmp/silent.mp4',
  ])

  const withAudio = buildEncoderArgs(metadata, '/tmp/with-audio.mp4', { path: '/tmp/input.wav', format: 'wav' })
  assert.equal(withAudio.includes('-an'), false)
  assert.deepEqual(withAudio.slice(withAudio.indexOf('-i', withAudio.indexOf('-i') + 1) - 2, withAudio.indexOf('-map')), [
    '-f', 'wav', '-i', '/tmp/input.wav',
  ])
  assert.deepEqual(withAudio.slice(withAudio.indexOf('-map'), withAudio.indexOf('-c:v')), [
    '-map', '0:v:0', '-map', '1:a:0',
  ])
  assert.deepEqual(withAudio.slice(withAudio.indexOf('-c:a'), withAudio.indexOf('-movflags')), [
    '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-t', '5',
  ])
})

test('dev render audio uses the same 24 MB data-URL contract and exact AAC mux policy', () => {
  assert.equal(MAX_ANIMATION_AUDIO_BYTES, MAX_AUDIO_BYTES)
  const audio = validateAnimationAudioDataUrl(`data:audio/mpeg;base64,${Buffer.from('ID3-audio').toString('base64')}`)
  assert(audio)
  assert.equal(audio.extension, 'mp3')
  assert.equal(audio.format, 'mp3')
  assert.throws(
    () => validateAnimationAudioDataUrl('data:video/mp4;base64,AAAA'),
    /supported data:audio base64 URL/,
  )
  assert.deepEqual(
    buildAnimationAudioMuxArgs('/tmp/silent.mp4', '/tmp/input.mp3', 'mp3', 5, '/tmp/out.mp4'),
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', '/tmp/silent.mp4',
      '-f', 'mp3',
      '-i', '/tmp/input.mp3',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-af', 'apad',
      '-t', '5',
      '-movflags', '+faststart',
      '/tmp/out.mp4',
    ],
  )
})

test('rejects render metadata that could allocate an unexpected job', () => {
  assertRenderError(() => validateRenderPayload({ engine: 'Unknown', ...metadata }), 'BAD_RENDER_REQUEST')
  assertRenderError(() => validateRenderPayload({ engine: 'HyperFrames', ...metadata, width: 8192, html: '<html></html>' }), 'BAD_RENDER_REQUEST')
  assertRenderError(() => validateRenderPayload({ engine: 'HyperFrames', ...metadata, fps: 120, html: '<html></html>' }), 'BAD_RENDER_REQUEST')
  assertRenderError(() => validateRenderPayload({ engine: 'HyperFrames', ...metadata, durationSec: 60, html: '<html></html>' }), 'BAD_RENDER_REQUEST')
})

test('rejects non-embedded Remotion assets', () => {
  assertRenderError(
    () => validateRenderPayload({
      engine: 'Remotion',
      ...metadata,
      props: { ...props, assetUrls: ['https://attacker.invalid/image.png'] },
    }),
    'BAD_RENDER_REQUEST',
  )
})

test('HTTP boundary rejects non-JSON and oversized render requests before opening a window', async (t) => {
  let windowsOpened = 0
  class UnexpectedWindow {
    constructor() {
      windowsOpened += 1
      throw new Error('renderer should not open for an invalid request')
    }
  }
  const service = createAnimationRenderService({
    BrowserWindow: UnexpectedWindow,
    origin: 'http://127.0.0.1:1',
    ffmpegPath: 'ffmpeg',
    maxBodyBytes: 64,
    authorizeRequest: () => true,
    logger: { error() {} },
  })
  t.after(() => service.dispose())

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    if (!service.handleRequest(req, res, pathname)) res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const wrongType = await fetch(`${baseUrl}/api/render`, { method: 'POST', body: 'hello' })
  assert.equal(wrongType.status, 415)
  assert.equal((await wrongType.json()).code, 'UNSUPPORTED_MEDIA')

  const oversized = await fetch(`${baseUrl}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(128) }),
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).code, 'PAYLOAD_TOO_LARGE')
  assert.equal(windowsOpened, 0)
})

test('a render-wide deadline aborts and destroys a hung hidden window', async (t) => {
  const tempBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('ef-animation-')))
  let windowDestroyed = false
  class HangingWindow {
    webContents = {}
    setMenu() {}
    isDestroyed() { return windowDestroyed }
    destroy() { windowDestroyed = true }
    loadURL() { return new Promise(() => {}) }
  }
  const service = createAnimationRenderService({
    BrowserWindow: HangingWindow,
    origin: 'http://127.0.0.1:1',
    ffmpegPath: 'ffmpeg',
    renderTimeoutMs: 50,
    authorizeRequest: () => true,
    logger: { error() {}, warn() {} },
  })
  t.after(() => service.dispose())

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    if (!service.handleRequest(req, res, pathname)) res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'Remotion', ...metadata, props }),
  })
  assert.equal(response.status, 504)
  assert.equal((await response.json()).code, 'RENDER_TIMEOUT')
  assert.equal(windowDestroyed, true)
  const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith('ef-animation-') && !tempBefore.has(name))
  assert.deepEqual(leftovers, [])
})
