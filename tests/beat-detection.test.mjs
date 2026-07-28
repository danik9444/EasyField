import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
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

function writeRuntimeCandidate(root, componentId, executableName, contents) {
  const architecture = process.arch
  const relativeRoot = `runtime-packs/${componentId}/${architecture}`
  const relativePath = `bin/${executableName}`
  const candidate = path.join(root, relativeRoot, relativePath)
  const bytes = Buffer.from(contents)
  fs.mkdirSync(path.dirname(candidate), { recursive: true })
  fs.writeFileSync(candidate, bytes, { mode: 0o700 })
  fs.chmodSync(candidate, 0o700)
  fs.writeFileSync(path.join(root, 'runtime-packs.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin',
    architectures: ['arm64', 'x64'],
    releaseReady: true,
    components: [{
      id: componentId,
      targets: {
        [architecture]: {
          root: relativeRoot,
          executables: { [executableName]: relativePath },
          files: [{
            path: relativePath,
            size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            kind: 'mach-o',
            executable: true,
          }],
        },
      },
    }],
  }))
  return candidate
}

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
  const python = writeRuntimeCandidate(
    dir,
    'librosa-python',
    'python3',
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  )

  const service = createBeatDetectionService({
    scriptPath: fakeAnalyzer,
    pythonCandidates: [python],
    runtimePackRoot: dir,
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

test('beat analysis probes a checksum-pinned runtime candidate', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'easyfield-beat-authenticated-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const analyzer = path.join(dir, 'probe.cjs')
  await writeFile(analyzer, 'process.stdout.write(JSON.stringify({ok:true,engineVersion:"verified-test"}))')
  const python = writeRuntimeCandidate(
    dir,
    'librosa-python',
    'python3',
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  )
  const status = await probeBeatRuntime({
    scriptPath: analyzer,
    pythonCandidates: [python],
    runtimePackRoot: dir,
  })
  assert.equal(status.available, true)
  assert.equal(status.engineVersion, 'verified-test')
})

test('beat analysis refuses unauthenticated environment interpreter overrides', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'easyfield-beat-env-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const analyzer = path.join(dir, 'probe.cjs')
  await writeFile(analyzer, 'process.stdout.write(JSON.stringify({ok:true,engineVersion:"env-test"}))')
  const executed = path.join(dir, 'executed')
  const untrustedPython = path.join(dir, 'untrusted-python')
  await writeFile(untrustedPython, `#!/bin/sh\ntouch ${JSON.stringify(executed)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
  fs.chmodSync(untrustedPython, 0o700)
  const previous = process.env.EF_BEAT_PYTHON
  process.env.EF_BEAT_PYTHON = untrustedPython
  try {
    const packaged = await probeBeatRuntime({ scriptPath: analyzer, allowEnvironmentOverrides: false })
    const development = await probeBeatRuntime({ scriptPath: analyzer, allowEnvironmentOverrides: true })
    assert.equal(packaged.available, false)
    assert.equal(development.available, false)
    assert.equal(fs.existsSync(executed), false)
  } finally {
    if (previous === undefined) delete process.env.EF_BEAT_PYTHON
    else process.env.EF_BEAT_PYTHON = previous
  }
})
