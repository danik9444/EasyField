import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import captureModule from '../plugin/audio-capture.cjs'

const { createAudioCapture } = captureModule

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
  trackItems,
} = {}) {
  const ffmpegCalls = []
  const sent = []
  let locks = 0
  const mediaPoolItem = {
    async GetClipProperty(key) {
      if (key === 'File Path') return filePath
      if (key === 'FPS') return String(sourceFps)
      return ''
    },
  }
  const makeItem = (name = 'Dialogue A1', id = 'audio-1') => ({
    async GetMediaPoolItem() { return mediaPoolItem },
    async GetSourceStartFrame() { return sourceStart },
    async GetSourceEndFrame() { return sourceEnd },
    async GetStart() { return timelineStart },
    async GetEnd() { return timelineEnd },
    async GetName() { return name },
    async GetUniqueId() { return id },
  })
  const defaultItem = makeItem()
  const items = trackItems ?? [[defaultItem]]
  const timeline = {
    async GetTrackCount(kind) { return kind === 'audio' ? items.length : 0 },
    async GetItemListInTrack(_kind, index) { return items[index - 1] ?? [] },
    async GetCurrentVideoItem() { return null },
    async GetCurrentTimecode() { return '01:00:04:14' },
    async GetName() { return 'Main edit' },
    async GetUniqueId() { return 'timeline-1' },
    async GetSetting(key) { return key === 'timelineFrameRate' ? String(timelineFps) : '' },
  }
  const project = { async GetUniqueId() { return 'project-1' } }
  const capture = createAudioCapture({
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
      fs.writeFileSync(args.at(-1), Buffer.from('trimmed wav bytes'))
    },
    async probeDuration() { return outputDuration },
    async clipFps() { return sourceFps },
    timecodeToFrames() { return 110 },
    EFError: TestError,
    enc: encodeURIComponent,
    cleanupDelayMs: 0,
  })
  return { capture, ffmpegCalls, sent, makeItem, get locks() { return locks } }
}

const responseStub = () => ({ destroyed: false, headersSent: false, writableEnded: false })

test('timeline audio Grab exports the exact visible cut as provider-compatible WAV', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-audio-capture-test-'))
  const sourcePath = path.join(dir, 'dialogue.mov')
  fs.writeFileSync(sourcePath, Buffer.from('source media'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath })
  await harness.capture.grabAudio({ destroyed: false }, responseStub())

  assert.equal(harness.locks, 1)
  assert.equal(harness.ffmpegCalls.length, 1)
  const args = harness.ffmpegCalls[0]
  assert.equal(args[args.indexOf('-ss') + 1], '2')
  assert.equal(args[args.indexOf('-t') + 1], '5')
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0')
  assert.equal(args[args.indexOf('-ar') + 1], '48000')
  assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le')
  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0].contentType, 'audio/wav')
  assert.equal(harness.sent[0].bytes.toString(), 'trimmed wav bytes')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Duration-Seconds']), '5')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Trimmed']), 'true')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Track-Type']), 'audio')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Track-Index']), '1')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-Start-Frame']), '48')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-End-Frame']), '167')
})

test('timeline audio Grab rejects a retimed clip instead of returning the wrong sound', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-audio-retime-test-'))
  const sourcePath = path.join(dir, 'retimed.mov')
  fs.writeFileSync(sourcePath, Buffer.from('source media'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, timelineEnd: 340 })
  await assert.rejects(
    harness.capture.grabAudio({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'UNSUPPORTED_TIMELINE_EDIT',
  )
  assert.equal(harness.ffmpegCalls.length, 0)
  assert.equal(harness.sent.length, 0)
})

test('timeline audio Grab fails honestly when the playhead has no audio', async () => {
  const harness = createHarness({ filePath: '', trackItems: [] })
  await assert.rejects(
    harness.capture.grabAudio({ destroyed: false }, responseStub()),
    (error) => error instanceof TestError && error.code === 'NO_ITEM',
  )
  assert.equal(harness.sent.length, 0)
})
