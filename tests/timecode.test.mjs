import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  framesToTimecode,
  timecodeToFrames,
  timelineFrameToTimecode,
  timelinePlayheadToSourceFrame,
} = require('../plugin/timecode.cjs')

test('timeline frame conversion preserves common non-drop frame rates and custom starts', () => {
  for (const fps of [23.976, 24, 25, 30, 50, 60]) {
    const start = fps === 25 || fps === 50 ? '10:00:00:00' : '01:00:00:00'
    const startFrames = timecodeToFrames(start, fps)
    assert.notEqual(startFrames, null)
    const target = timelineFrameToTimecode({
      captureFrame: 1_000 + Math.round(fps) * 65 + 7,
      timelineStartFrame: 1_000,
      timelineStartTimecode: start,
      fps,
      dropFrame: false,
    })
    assert.equal(timecodeToFrames(target, fps), Number(startFrames) + Math.round(fps) * 65 + 7)
  }
})

test('29.97 and 59.94 drop-frame conversion skips invalid minute labels without drift', () => {
  const cases = [
    { fps: 29.97, oneMinute: '00:01:00;02', tenMinutes: '00:10:00;00' },
    { fps: 59.94, oneMinute: '00:01:00;04', tenMinutes: '00:10:00;00' },
  ]
  for (const { fps, oneMinute, tenMinutes } of cases) {
    const oneMinuteFrames = timecodeToFrames(oneMinute, fps)
    const tenMinuteFrames = timecodeToFrames(tenMinutes, fps)
    assert.equal(framesToTimecode(oneMinuteFrames, fps, true), oneMinute)
    assert.equal(framesToTimecode(tenMinuteFrames, fps, true), tenMinutes)
    const custom = timelineFrameToTimecode({
      captureFrame: 10_000 + Number(tenMinuteFrames),
      timelineStartFrame: 10_000,
      timelineStartTimecode: '01:00:00;00',
      fps,
      dropFrame: true,
    })
    assert.equal(custom, '01:10:00;00')
  }
})

test('invalid timecodes are rejected rather than mapped to the wrong frame', () => {
  assert.equal(timecodeToFrames('not-timecode', 24), null)
  assert.equal(timecodeToFrames('00:61:00:00', 24), null)
  assert.equal(timecodeToFrames('00:00:00:24', 24), null)
  assert.equal(timecodeToFrames('00:01:00;00', 29.97), null)
  assert.equal(timecodeToFrames('00:01:00;01', 29.97), null)
  assert.equal(timecodeToFrames('00:01:00;00', 59.94), null)
  assert.equal(timecodeToFrames('00:01:00;03', 59.94), null)
  assert.notEqual(timecodeToFrames('00:10:00;00', 29.97), null)
  assert.notEqual(timecodeToFrames('00:10:00;00', 59.94), null)
})

test('drop-frame conversion wraps cleanly at 24 hours', () => {
  for (const fps of [29.97, 59.94]) {
    const oneDay = Math.round(fps * 60 * 60 * 24)
    assert.equal(framesToTimecode(oneDay, fps, true), '00:00:00;00')
  }
})

test('timeline playhead mapping uses timeline FPS before converting to source FPS', () => {
  assert.equal(timelinePlayheadToSourceFrame({
    playheadFrame: 124,
    itemStartFrame: 100,
    sourceStartFrame: 48,
    timelineFps: 24,
    sourceFps: 60,
  }), 108)
  assert.equal(timelinePlayheadToSourceFrame({
    playheadFrame: 112,
    itemStartFrame: 100,
    sourceStartFrame: 10,
    timelineFps: 24,
    sourceFps: 30,
  }), 25)
  assert.equal(timelinePlayheadToSourceFrame({
    playheadFrame: 90,
    itemStartFrame: 100,
    sourceStartFrame: 10,
    timelineFps: 24,
    sourceFps: 30,
  }), 10)
  assert.equal(timelinePlayheadToSourceFrame({
    playheadFrame: 100,
    itemStartFrame: 100,
    sourceStartFrame: 0,
    timelineFps: 0,
    sourceFps: 30,
  }), null)
})
