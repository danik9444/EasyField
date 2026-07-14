import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import captureModule from '../plugin/edit-image-capture.cjs'

const { classifyEditImageSource, createEditImageCapture } = captureModule

class TestError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function frameFromTimecode(value) {
  const parts = String(value || '').split(':').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null
  return (((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 24) + parts[3]
}

function createHarness({
  filePath = '',
  type = 'Video',
  clipType = '',
  frames = '120',
  timecodes = ['01:00:00:12'],
  exportBytes = Buffer.from('rendered timeline pixels'),
  item = true,
} = {}) {
  let contextReads = 0
  let exports = 0
  let locks = 0
  const sent = []
  const mediaPoolItem = {
    async GetClipProperty(key) {
      if (key === 'File Path') return filePath
      if (key === 'Type') return type
      if (key === 'Clip Type') return clipType
      if (key === 'Frames') return frames
      return ''
    },
  }
  const timelineItem = item ? {
    async GetMediaPoolItem() { return mediaPoolItem },
    async GetName() { return 'Shot A' },
    async GetUniqueId() { return 'item-1' },
  } : null
  const timeline = {
    async GetCurrentVideoItem() { return timelineItem },
    async GetCurrentTimecode() {
      const value = timecodes[Math.min(contextReads, timecodes.length - 1)]
      contextReads += 1
      return value
    },
    async GetName() { return 'Main edit' },
    async GetUniqueId() { return 'timeline-1' },
    async GetSetting(key) { return key === 'timelineFrameRate' ? '24' : '' },
  }
  const project = {
    async GetUniqueId() { return 'project-1' },
    async ExportCurrentFrameAsStill(outputPath) {
      exports += 1
      fs.writeFileSync(outputPath, exportBytes)
      return true
    },
  }
  const capture = createEditImageCapture({
    async getContext() { return { project, timeline } },
    async withTimelineOperationLock(operation) {
      locks += 1
      return await operation()
    },
    async sleep() {},
    sendFile(_res, outputPath, contentType, headers) {
      sent.push({ outputPath, contentType, headers, bytes: fs.readFileSync(outputPath) })
    },
    async runFfmpeg(args) {
      const outputPath = args.at(-1)
      fs.writeFileSync(outputPath, Buffer.from('normalized source still'))
    },
    EFError: TestError,
    timecodeToFrames: frameFromTimecode,
    enc: encodeURIComponent,
    cleanupDelayMs: 0,
  })
  return {
    capture,
    sent,
    get exports() { return exports },
    get locks() { return locks },
  }
}

test('Edit Image source classification keeps stills separate from video and image sequences', () => {
  assert.equal(classifyEditImageSource({ filePath: '/media/photo.png', type: ' Still ', frames: '1' }), 'still-image')
  assert.equal(classifyEditImageSource({ filePath: '/media/photo.tif', type: 'IMAGE', frames: '1' }), 'still-image')
  assert.equal(classifyEditImageSource({ filePath: '/media/frozen.mp4', type: 'Video', frames: '1' }), 'video')
  assert.equal(classifyEditImageSource({ filePath: '/media/shot.0001.dpx', type: 'Image Sequence', frames: '240' }), 'video')
  assert.equal(classifyEditImageSource({ filePath: '/media/unknown.png', type: '', frames: '' }), 'video')
  assert.equal(classifyEditImageSource({ filePath: '', type: 'Fusion Composition', frames: '' }), 'generated')
  assert.equal(classifyEditImageSource({ filePath: '', type: '', frames: '' }), 'unknown')
})

test('a still under the playhead returns the original source file instead of a timeline render', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-image-still-test-'))
  const sourcePath = path.join(dir, 'original-source.png')
  const sourceBytes = Buffer.from('exact original still bytes')
  fs.writeFileSync(sourcePath, sourceBytes)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, type: 'Still', frames: '1' })
  await harness.capture.grabEditImageSource({ destroyed: false }, { destroyed: false, headersSent: false, writableEnded: false })

  assert.equal(harness.locks, 1)
  assert.equal(harness.exports, 0)
  assert.equal(harness.sent.length, 1)
  assert.deepEqual(harness.sent[0].bytes, sourceBytes)
  assert.equal(harness.sent[0].contentType, 'image/png')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Capture-Kind']), 'source')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-Kind']), 'still-image')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Name']), 'original-source.png')
})

test('a video under the playhead returns the rendered current timeline frame without moving the playhead', async () => {
  const rendered = Buffer.from('graded fusion timeline frame')
  const harness = createHarness({ filePath: '/media/shot.mov', type: 'Video + Audio', frames: '240', exportBytes: rendered })
  await harness.capture.grabEditImageSource({ destroyed: false }, { destroyed: false, headersSent: false, writableEnded: false })

  assert.equal(harness.exports, 1)
  assert.equal(harness.sent.length, 1)
  assert.deepEqual(harness.sent[0].bytes, rendered)
  assert.equal(harness.sent[0].contentType, 'image/png')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Capture-Kind']), 'timeline-output')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-Kind']), 'video')
})

test('browser-unsupported still formats are normalized from the source rather than rendered from the timeline', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-image-tiff-test-'))
  const sourcePath = path.join(dir, 'scan.tiff')
  fs.writeFileSync(sourcePath, Buffer.from('tiff source'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const harness = createHarness({ filePath: sourcePath, type: 'Image', frames: '1' })
  await harness.capture.grabEditImageSource({ destroyed: false }, { destroyed: false, headersSent: false, writableEnded: false })

  assert.equal(harness.exports, 0)
  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0].bytes.toString(), 'normalized source still')
  assert.equal(decodeURIComponent(harness.sent[0].headers['X-EF-Source-Normalized']), 'true')
})

test('Edit Image capture fails closed when the playhead moves or a source still is offline', async () => {
  const moved = createHarness({ filePath: '/media/shot.mov', type: 'Video', timecodes: ['01:00:00:12', '01:00:00:13'] })
  await assert.rejects(
    moved.capture.grabEditImageSource({ destroyed: false }, { destroyed: false, headersSent: false, writableEnded: false }),
    (error) => error instanceof TestError && error.code === 'PLAYHEAD_CHANGED',
  )
  assert.equal(moved.exports, 0)
  assert.equal(moved.sent.length, 0)

  const offline = createHarness({ filePath: '/missing/source.png', type: 'Still', frames: '1' })
  await assert.rejects(
    offline.capture.grabEditImageSource({ destroyed: false }, { destroyed: false, headersSent: false, writableEnded: false }),
    (error) => error instanceof TestError && error.code === 'SOURCE_OFFLINE',
  )
  assert.equal(offline.exports, 0)
  assert.equal(offline.sent.length, 0)
})

test('Edit Image capture reports an honest no-item result', async () => {
  const harness = createHarness({ item: false })
  await assert.rejects(
    harness.capture.grabEditImageSource({ destroyed: false }, { destroyed: false, headersSent: false, writableEnded: false }),
    (error) => error instanceof TestError && error.code === 'NO_ITEM',
  )
  assert.equal(harness.sent.length, 0)
})
