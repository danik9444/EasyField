import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_BEAT_MARKER_SETTINGS,
  buildBeatMarkers,
  createBeatAnalysisCompanion,
  normalizeBeatMarkerSettings,
  parseBeatAnalysisCompanion,
} from '../src/data/beatWorkflow.ts'
import type { BeatDetectionResult } from '../src/services/beatDetection.ts'

const result: BeatDetectionResult = {
  ok: true,
  engine: 'librosa',
  engineVersion: '0.11.0',
  bpm: 120,
  confidence: 0.82,
  durationSeconds: 8,
  sampleRate: 48000,
  beats: [
    { time: 0.5, confidence: 0.9 },
    { time: 1, confidence: 0.4 },
    { time: 1.5, confidence: 0.8 },
    { time: 2, confidence: 0.7 },
    { time: 2.5, confidence: 0.3 },
    { time: 3, confidence: 0.95 },
  ],
}

test('Beat marker styles produce deterministic editorial densities', () => {
  const every = buildBeatMarkers(result, { ...DEFAULT_BEAT_MARKER_SETTINGS, styleId: 'every-beat' })
  const strong = buildBeatMarkers(result, { ...DEFAULT_BEAT_MARKER_SETTINGS, styleId: 'strong-beats' })
  const everyTwo = buildBeatMarkers(result, { ...DEFAULT_BEAT_MARKER_SETTINGS, styleId: 'every-2' })
  const everyFour = buildBeatMarkers(result, { ...DEFAULT_BEAT_MARKER_SETTINGS, styleId: 'every-4' })

  assert.deepEqual(every.map((marker) => marker.time), [0.5, 1, 1.5, 2, 2.5, 3])
  assert.deepEqual(strong.map((marker) => marker.time), [0.5, 1.5, 2, 3])
  assert.deepEqual(everyTwo.map((marker) => marker.time), [0.5, 1.5, 2.5])
  assert.deepEqual(everyFour.map((marker) => marker.time), [0.5, 2.5])
})

test('Custom Beat filtering honors confidence, range, Nth selection, spacing and offset', () => {
  const settings = normalizeBeatMarkerSettings({
    styleId: 'custom',
    everyNth: 2,
    minimumConfidence: 0.5,
    minimumGapSeconds: 0.8,
    offsetSeconds: 0.1,
    rangeStartSeconds: 1,
    rangeEndSeconds: 3,
    markerColor: 'Purple',
    markerPrefix: 'Cut',
  })
  const markers = buildBeatMarkers(result, settings)
  assert.deepEqual(markers.map((marker) => marker.time), [1.6, 3])
  assert.deepEqual(markers.map((marker) => marker.name), ['Cut 001', 'Cut 002'])
})

test('Beat analysis sidecars preserve the complete result and reviewed marker selection', () => {
  const markers = buildBeatMarkers(result, { ...DEFAULT_BEAT_MARKER_SETTINGS, styleId: 'every-2' })
  const companion = createBeatAnalysisCompanion({
    sourceName: 'Track.wav',
    sourceKind: 'audio',
    libraryCreationId: 'cr-audio',
    result,
    settings: { ...DEFAULT_BEAT_MARKER_SETTINGS, styleId: 'every-2' },
    markers,
    now: 1234,
    analysisId: 'beat-test-1234',
  })
  const parsed = parseBeatAnalysisCompanion(companion)
  assert.ok(parsed)
  assert.equal(companion.fileName, 'Track.easyfield-beats.json')
  assert.equal(companion.summary.markerCount, 3)
  assert.equal(parsed.analysis.bpm, 120)
  assert.deepEqual(parsed.markers, markers)
  assert.equal(parsed.source.libraryCreationId, 'cr-audio')
})
