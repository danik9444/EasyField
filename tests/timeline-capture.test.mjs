import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTimelineBoundaryCapture } = require('../plugin/timeline-capture.cjs')
const { timecodeToFrames, timelineFrameToTimecode } = require('../plugin/timecode.cjs')

class TestEFError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function harness({ itemStart = 100, itemEnd = 200, sourceStart = 24, sourceEnd = 123, afterMove } = {}) {
  let currentTimecode = '01:00:02:00'
  let activeProjectId = 'project-1'
  let activeTimelineId = 'timeline-1'
  let currentItemStart = itemStart
  let currentItemEnd = itemEnd
  let currentSourceStart = sourceStart
  let currentSourceEnd = sourceEnd
  let mediaPoolItemId = 'media-1'
  const setCalls = []
  const exports = []
  const responses = []

  const item = {
    GetUniqueId: async () => 'item-1',
    GetName: async () => 'Shot A',
    GetStart: async () => currentItemStart,
    GetEnd: async () => currentItemEnd,
    GetSourceStartFrame: async () => currentSourceStart,
    GetSourceEndFrame: async () => currentSourceEnd,
    GetMediaPoolItem: async () => ({ GetUniqueId: async () => mediaPoolItemId }),
    GetTrackTypeAndIndex: async () => ['video', 2],
  }
  const timeline = {
    GetCurrentVideoItem: async () => item,
    GetCurrentTimecode: async () => currentTimecode,
    SetCurrentTimecode: async (value) => {
      currentTimecode = value
      setCalls.push(value)
      return true
    },
    GetUniqueId: async () => activeTimelineId,
    GetName: async () => 'Main edit',
    GetStartFrame: async () => 0,
    GetStartTimecode: async () => '01:00:00:00',
    GetSetting: async () => '24',
  }
  const project = {
    GetUniqueId: async () => activeProjectId,
    ExportCurrentFrameAsStill: async (filePath) => {
      exports.push(currentTimecode)
      writeFileSync(filePath, Buffer.from('rendered timeline frame'))
      return true
    },
  }
  const getContext = async () => ({ project, timeline })
  const capture = createTimelineBoundaryCapture({
    getContext,
    withTimelineOperationLock: async (operation) => operation(),
    sleep: async () => { if (afterMove) await afterMove({
      get currentTimecode() { return currentTimecode },
      set currentTimecode(value) { currentTimecode = value },
      set activeProjectId(value) { activeProjectId = value },
      set activeTimelineId(value) { activeTimelineId = value },
      set itemStart(value) { currentItemStart = value },
      set itemEnd(value) { currentItemEnd = value },
      set sourceStart(value) { currentSourceStart = value },
      set sourceEnd(value) { currentSourceEnd = value },
      set mediaPoolItemId(value) { mediaPoolItemId = value },
    }) },
    sendFile: (res, filePath, contentType, headers) => {
      responses.push({ contentType, headers, bytes: readFileSync(filePath).toString() })
    },
    EFError: TestEFError,
    timelineFrameToTimecode,
    timecodeToFrames,
    enc: encodeURIComponent,
    cleanupDelayMs: 0,
  })

  return { capture, setCalls, exports, responses }
}

test('rendered boundary capture maps shot start and end to ordered timeline frames and restores the playhead', async () => {
  const start = harness()
  await start.capture.grabShotStartFrame({}, {})
  assert.deepEqual(start.setCalls, ['01:00:04:04', '01:00:02:00'])
  assert.deepEqual(start.exports, ['01:00:04:04'])
  assert.equal(decodeURIComponent(start.responses[0].headers['X-EF-Capture-Edge']), 'start')
  assert.equal(Number(decodeURIComponent(start.responses[0].headers['X-EF-Capture-Frame'])), 100)
  assert.equal(decodeURIComponent(start.responses[0].headers['X-EF-Project-Id']), 'project-1')
  assert.equal(Number(decodeURIComponent(start.responses[0].headers['X-EF-Source-Start-Frame'])), 24)
  assert.equal(decodeURIComponent(start.responses[0].headers['X-EF-Media-Pool-Item-Id']), 'media-1')
  assert.equal(Number(decodeURIComponent(start.responses[0].headers['X-EF-Timeline-Fps'])), 24)
  assert.equal(start.responses[0].bytes, 'rendered timeline frame')

  const end = harness()
  await end.capture.grabShotEndFrame({}, {})
  assert.deepEqual(end.setCalls, ['01:00:08:07', '01:00:02:00'])
  assert.deepEqual(end.exports, ['01:00:08:07'])
  assert.equal(decodeURIComponent(end.responses[0].headers['X-EF-Capture-Edge']), 'end')
  assert.equal(Number(decodeURIComponent(end.responses[0].headers['X-EF-Capture-Frame'])), 199)
})

test('one-frame shots have the same valid rendered start and end boundary', async () => {
  const start = harness({ itemStart: 100, itemEnd: 101 })
  const end = harness({ itemStart: 100, itemEnd: 101 })
  await start.capture.grabShotStartFrame({}, {})
  await end.capture.grabShotEndFrame({}, {})
  assert.equal(start.responses[0].headers['X-EF-Capture-Frame'], end.responses[0].headers['X-EF-Capture-Frame'])
})

test('capture refuses to export or restore over a user playhead move', async () => {
  const changed = harness({ afterMove: async (state) => { state.currentTimecode = '01:00:12:00' } })
  await assert.rejects(
    changed.capture.grabShotStartFrame({}, {}),
    (error) => error instanceof TestEFError && error.code === 'PLAYHEAD_CHANGED',
  )
  assert.deepEqual(changed.exports, [])
  assert.deepEqual(changed.setCalls, ['01:00:04:04'])
})

test('capture refuses to export or restore after the active project changes', async () => {
  const changed = harness({ afterMove: async (state) => { state.activeProjectId = 'project-2' } })
  await assert.rejects(
    changed.capture.grabShotEndFrame({}, {}),
    (error) => error instanceof TestEFError && error.code === 'TIMELINE_CHANGED',
  )
  assert.deepEqual(changed.exports, [])
  assert.deepEqual(changed.setCalls, ['01:00:08:07'])
})

test('capture refuses a shot that is trimmed or relinked while the boundary is being prepared', async () => {
  const trimmed = harness({ afterMove: async (state) => { state.sourceEnd = 122 } })
  await assert.rejects(
    trimmed.capture.grabShotEndFrame({}, {}),
    (error) => error instanceof TestEFError && error.code === 'TIMELINE_CHANGED',
  )
  assert.deepEqual(trimmed.exports, [])

  const relinked = harness({ afterMove: async (state) => { state.mediaPoolItemId = 'media-2' } })
  await assert.rejects(
    relinked.capture.grabShotStartFrame({}, {}),
    (error) => error instanceof TestEFError && error.code === 'TIMELINE_CHANGED',
  )
  assert.deepEqual(relinked.exports, [])
})
