import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import captureModule from '../plugin/edit-video-capture.cjs'

const { createEditVideoCapture } = captureModule

class TestError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function createHarness({
  filePath,
  sourceStart = 48,
  sourceEnd = 167,
  timelineStart = 100,
  timelineEnd = 220,
  sourceFps = 24,
  timelineFps = 24,
  outputDuration = 5,
  failEncode = false,
  item = true,
} = {}) {
  const ffmpegCalls = []
  const sent = []
  let locks = 0
  let sourceStartReads = 0
  let sourceEndReads = 0
  let timelineStartReads = 0
  let timelineEndReads = 0
  const values = (value, read) => Array.isArray(value) ? value[Math.min(read, value.length - 1)] : value
  const mediaPoolItem = {
    async GetClipProperty(key) {
      if (key === 'File Path') return filePath
      if (key === 'FPS') return String(sourceFps)
      return ''
    },
  }
  const timelineItem = item ? {
    async GetMediaPoolItem() { return mediaPoolItem },
    async GetSourceStartFrame() {
      const value = values(sourceStart, sourceStartReads)
      sourceStartReads += 1
      return value
    },
    async GetSourceEndFrame() {
      const value = values(sourceEnd, sourceEndReads)
      sourceEndReads += 1
      return value
    },
    async GetStart() {
      const value = values(timelineStart, timelineStartReads)
      timelineStartReads += 1
      return value
    },
    async GetEnd() {
      const value = values(timelineEnd, timelineEndReads)
      timelineEndReads += 1
      return value
    },
    async GetName() { return 'Interview closeup' },
    async GetUniqueId() { return 'item-7' },
  } : null
  const timeline = {
    async GetCurrentVideoItem() { return timelineItem },
    async GetCurrentTimecode() { return '01:00:04:04' },
    async GetName() { return 'Main edit' },
    async GetUniqueId() { return 'timeline-1' },
    async GetSetting(key) { return key === 'timelineFrameRate' ? String(timelineFps) : '' },
  }
  const project = {
    async GetUniqueId() { return 'project-1' },
  }
  const capture = createEditVideoCapture({
    async getContext() { return { project, timeline } },
    async withTimelineOperationLock(operation) {
      locks += 1
      return await operation()
    },
    sendFile(_res, outputPath, contentType, headers) {
      sent.push({ outputPath, contentType, headers, bytes: fs.readFileSync(outputPath) })
    },
    async runFfmpeg(args) {
      ffmpegCalls.push(args)
      if (failEncode) throw new Error('encode failed')
      fs.writeFileSync(args.at(-1), Buffer.from('exact trimmed mp4'))
    },
    async probeDuration() { return outputDuration },
    async clipFps() { return sourceFps },
    EFError: TestError,
    enc: encodeURIComponent,
    cleanupDelayMs: 0,
  })
  return {
    capture,
    ffmpegCalls,
    sent,
    get locks() { return locks },
  }
}

function responseStub() {
  return { destroyed: false, headersSent: false, writableEnded: false }
}

test('Edit Video Grab transcodes only the exact Resolve Source In/Out range', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-video-test-'))
  const sourcePath = path.join(dir, 'interview.mov')
  fs.writeFileSync(sourcePath, Buffer.from('source movie'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath })
  await harness.capture.grabEditVideoSource({ destroyed: false }, responseStub())

  assert.equal(harness.locks, 1)
  assert.equal(harness.ffmpegCalls.length, 1)
  const args = harness.ffmpegCalls[0]
  assert.equal(args.includes('copy'), false)
  assert.equal(args[args.indexOf('-ss') + 1], '2')
  assert.equal(args[args.indexOf('-t') + 1], '5')
  assert.equal(args[args.indexOf('-map') + 1], '0:v:0')
  assert.equal(args.includes('0:a:0?'), true)
  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0].bytes.toString(), 'exact trimmed mp4')
  assert.equal(harness.sent[0].contentType, 'video/mp4')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Trimmed']), 'true')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-Start-Frame']), '48')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-End-Frame']), '167')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Duration-Seconds']), '5')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Timeline-Fps']), '24')
})

test('Edit Video Grab rejects retimed clips instead of returning the wrong duration', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-video-retime-test-'))
  const sourcePath = path.join(dir, 'retimed.mov')
  fs.writeFileSync(sourcePath, Buffer.from('retimed movie'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, timelineEnd: 340 })
  await assert.rejects(
    harness.capture.grabEditVideoSource({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'UNSUPPORTED_TIMELINE_EDIT',
  )
  assert.equal(harness.ffmpegCalls.length, 0)
  assert.equal(harness.sent.length, 0)
})

test('Edit Video Grab never falls back to the full source when exact trim export fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-video-fail-test-'))
  const sourcePath = path.join(dir, 'long-gop.mp4')
  const fullSource = Buffer.from('full source must never be returned')
  fs.writeFileSync(sourcePath, fullSource)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, failEncode: true })
  await assert.rejects(
    harness.capture.grabEditVideoSource({ destroyed: false }, responseStub()),
    /encode failed/,
  )
  assert.equal(harness.ffmpegCalls.length, 1)
  assert.equal(harness.sent.length, 0)
})

test('Edit Video Grab validates the encoded duration before returning media', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-video-duration-test-'))
  const sourcePath = path.join(dir, 'short.mov')
  fs.writeFileSync(sourcePath, Buffer.from('source movie'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, outputDuration: 4.1 })
  await assert.rejects(
    harness.capture.grabEditVideoSource({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'FFMPEG_FAILED',
  )
  assert.equal(harness.sent.length, 0)
})

test('Edit Video Grab fails safely for offline, non-file-backed, or missing clips', async () => {
  const offline = createHarness({ filePath: '/missing/timeline-source.mov' })
  await assert.rejects(
    offline.capture.grabEditVideoSource({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'SOURCE_OFFLINE',
  )
  assert.equal(offline.sent.length, 0)

  const missing = createHarness({ filePath: '', item: false })
  await assert.rejects(
    missing.capture.grabEditVideoSource({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'NO_ITEM',
  )
  assert.equal(missing.sent.length, 0)
})

test('Edit Video Grab discards output if the timeline item is trimmed during capture', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-video-change-test-'))
  const sourcePath = path.join(dir, 'changing.mov')
  fs.writeFileSync(sourcePath, Buffer.from('source movie'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, sourceEnd: [167, 166] })
  await assert.rejects(
    harness.capture.grabEditVideoSource({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'TIMELINE_CHANGED',
  )
  assert.equal(harness.sent.length, 0)
})
