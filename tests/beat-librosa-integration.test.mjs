import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import beatModule from '../plugin/beat-detection.cjs'

const { analyzeBeatFile, probeBeatRuntime } = beatModule

function clickTrackWav(durationSeconds = 8, bpm = 120, sampleRate = 44100) {
  const sampleCount = Math.round(durationSeconds * sampleRate)
  const pcm = Buffer.alloc(sampleCount * 2)
  const interval = 60 / bpm
  for (let beat = 1, time = 0.5; time < durationSeconds - 0.2; beat += 1, time += interval) {
    const start = Math.round(time * sampleRate)
    const clickSamples = Math.round(0.035 * sampleRate)
    const amplitude = beat % 4 === 1 ? 0.95 : 0.72
    for (let offset = 0; offset < clickSamples && start + offset < sampleCount; offset += 1) {
      const envelope = Math.exp(-offset / (sampleRate * 0.007))
      const sample = Math.sin(2 * Math.PI * 1700 * offset / sampleRate) * envelope * amplitude
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), (start + offset) * 2)
    }
  }
  const out = Buffer.alloc(44 + pcm.length)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + pcm.length, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(pcm.length, 40)
  pcm.copy(out, 44)
  return out
}

test('the managed librosa runtime detects a deterministic 120 BPM click track', async (t) => {
  const scriptPath = path.resolve('plugin/python/beat_detect.py')
  const runtime = await probeBeatRuntime({ scriptPath })
  if (!runtime.available) {
    t.skip('managed librosa runtime is unavailable on this machine')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-librosa-click-'))
  const input = path.join(dir, 'click-track.wav')
  fs.writeFileSync(input, clickTrackWav())
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const result = await analyzeBeatFile(input, { scriptPath, pythonCandidates: [runtime.python], timeoutMs: 30000 })
  assert.equal(result.ok, true)
  assert.equal(result.engine, 'librosa')
  assert.ok(result.bpm >= 115 && result.bpm <= 125, `expected ~120 BPM, received ${result.bpm}`)
  assert.ok(result.beats.length >= 12, `expected a stable beat sequence, received ${result.beats.length}`)
  assert.equal(result.beats.every((beat, index) => index === 0 || beat.time >= result.beats[index - 1].time), true)
})
