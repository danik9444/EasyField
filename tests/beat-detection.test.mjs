import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createBeatDetectionService,
  normalizeBeatResult,
  probeBeatRuntime,
} = require('../plugin/beat-detection.cjs')

test('beat result normalization keeps finite ordered review data', () => {
  const result = normalizeBeatResult({
    ok: true,
    engineVersion: '0.11.0',
    bpm: 122.456,
    confidence: 1.7,
    durationSeconds: 10,
    sampleRate: 44100,
    beats: [
      { time: -1, confidence: 1 },
      { time: 0.5, confidence: -2 },
      { time: 2.5, confidence: 0.8 },
      { time: 2, confidence: 0.9 },
      { time: 99, confidence: 0.9 },
    ],
  })
  assert.equal(result.bpm, 122.46)
  assert.equal(result.confidence, 1)
  assert.deepEqual(result.beats, [
    { time: 0.5, confidence: 0 },
    { time: 2.5, confidence: 0.8 },
  ])
})

test('local beat service probes librosa and analyzes uploaded bytes without an apply operation', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'easyfield-beat-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fakeAnalyzer = path.join(dir, 'fake-analyzer.cjs')
  await writeFile(fakeAnalyzer, `
if (process.argv.includes('--probe')) {
  process.stdout.write(JSON.stringify({ ok: true, available: true, engine: 'librosa', engineVersion: 'test' }))
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    engine: 'librosa',
    engineVersion: 'test',
    bpm: 96,
    confidence: 0.75,
    durationSeconds: 8,
    sampleRate: 44100,
    beats: [{ time: 0.5, confidence: 0.7 }, { time: 1.125, confidence: 0.8 }]
  }))
}
`)

  const service = createBeatDetectionService({
    scriptPath: fakeAnalyzer,
    pythonCandidates: [process.execPath],
    maxBytes: 1024,
  })
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (!service.handleRequest(request, response, pathname)) {
      response.writeHead(404)
      response.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`

  const runtimeResponse = await fetch(`${origin}/api/beat-detect/status`)
  assert.equal(runtimeResponse.status, 200)
  const runtime = await runtimeResponse.json()
  assert.equal(runtime.available, true)
  assert.equal(runtime.engine, 'librosa')

  const analysisResponse = await fetch(`${origin}/api/beat-detect`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', 'X-EF-File-Name': 'song.wav' },
    body: Buffer.from('synthetic-audio-fixture'),
  })
  assert.equal(analysisResponse.status, 200)
  assert.deepEqual(await analysisResponse.json(), {
    ok: true,
    engine: 'librosa',
    engineVersion: 'test',
    bpm: 96,
    confidence: 0.75,
    durationSeconds: 8,
    sampleRate: 44100,
    beats: [{ time: 0.5, confidence: 0.7 }, { time: 1.125, confidence: 0.8 }],
  })

  const applyResponse = await fetch(`${origin}/api/beat-detect/apply`, { method: 'POST' })
  assert.equal(applyResponse.status, 404)
})

test('missing managed Python/librosa runtime returns a safe diagnostic', async () => {
  const status = await probeBeatRuntime({
    scriptPath: '/definitely/missing/easyfield-beat.py',
    pythonCandidates: ['/definitely/missing/easyfield-python'],
  })
  assert.equal(status.available, false)
  assert.equal(status.code, 'BEAT_RUNTIME_MISSING')
  assert.equal(status.setupGuide, 'plugin/python/README.md')
})
