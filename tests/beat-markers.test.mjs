import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import markerModule from '../plugin/beat-markers.cjs'

const { createBeatMarkerService } = markerModule

class TestError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function harness(t, { failAt = -1 } = {}) {
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-beat-markers-'))
  const mediaPath = path.join(mediaRoot, 'track.wav')
  fs.writeFileSync(mediaPath, Buffer.from('audio'))
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }))
  const addedPool = []
  const addedTimeline = []
  const rolledBack = []
  const makeTarget = (added) => ({
    async AddMarker(frame, color, name, note, duration, customData) {
      if (added.length === failAt) return false
      added.push({ frame, color, name, note, duration, customData })
      return true
    },
    async DeleteMarkerByCustomData(customData) {
      rolledBack.push(customData)
      return true
    },
  })
  const poolTarget = makeTarget(addedPool)
  poolTarget.GetClipProperty = async (key) => key === 'File Path' ? mediaPath : ''
  const timelineTarget = makeTarget(addedTimeline)
  timelineTarget.GetMediaPoolItem = async () => poolTarget
  const root = {
    async GetClipList() { return [poolTarget] },
    async GetSubFolderList() { return [] },
  }
  const mediaPool = { async GetRootFolder() { return root } }
  const timeline = {
    async GetSetting(key) { return key === 'timelineFrameRate' ? '24' : '' },
    async GetTrackCount(kind) { return kind === 'audio' ? 1 : 0 },
    async GetItemListInTrack() { return [timelineTarget] },
  }
  const project = {
    async GetMediaPool() { return mediaPool },
    async GetSetting() { return '24' },
  }
  const service = createBeatMarkerService({
    async getContext() { return { project, timeline } },
    async withTimelineOperationLock(operation) { return await operation() },
    mediaRoot,
    EFError: TestError,
  })
  const payload = {
    path: mediaPath,
    analysisId: 'beat-analysis-1',
    color: 'Cyan',
    markers: [
      { time: 1, confidence: 0.9, name: 'Beat 001' },
      { time: 2.5, confidence: 0.8, name: 'Beat 002' },
    ],
  }
  return { service, payload, mediaRoot, addedPool, addedTimeline, rolledBack }
}

test('reviewed beats are added as relative clip markers in Media Pool or Timeline', async (t) => {
  const h = harness(t)
  const pool = await h.service.applyMarkers({ ...h.payload, target: 'media-pool' })
  const timeline = await h.service.applyMarkers({ ...h.payload, target: 'timeline' })

  assert.equal(pool.ok, true)
  assert.equal(timeline.ok, true)
  assert.deepEqual(h.addedPool.map((marker) => marker.frame), [24, 60])
  assert.deepEqual(h.addedTimeline.map((marker) => marker.frame), [24, 60])
  assert.equal(h.addedTimeline.every((marker) => marker.duration === 1), true)
  assert.equal(h.addedTimeline.every((marker) => marker.customData.startsWith('easyfield-beat-')), true)
  assert.equal(timeline.undoToken.customData.length, 2)
})

test('marker application rolls back only EasyField-owned markers after a partial failure', async (t) => {
  const h = harness(t, { failAt: 1 })
  await assert.rejects(
    h.service.applyMarkers({ ...h.payload, target: 'timeline' }),
    (error) => error instanceof TestError && error.code === 'MARKER_APPLY_FAILED',
  )
  assert.equal(h.addedTimeline.length, 1)
  assert.deepEqual(h.rolledBack, [h.addedTimeline[0].customData])
})

test('marker application rejects paths outside the EasyField media root', async (t) => {
  const h = harness(t)
  await assert.rejects(
    h.service.applyMarkers({ ...h.payload, path: '/etc/hosts', target: 'media-pool' }),
    (error) => error instanceof TestError && error.code === 'UNSAFE_PATH',
  )
})
