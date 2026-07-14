import assert from 'node:assert/strict'
import test from 'node:test'
import { wavDurationSeconds } from '../src/data/audioMetadata.ts'

function pcmWav(seconds: number, sampleRate = 48_000, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const dataSize = Math.round(seconds * byteRate)
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const put = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  put(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, channels * (bitsPerSample / 8), true)
  view.setUint16(34, bitsPerSample, true)
  put(36, 'data')
  view.setUint32(40, dataSize, true)
  return buffer
}

test('reads the duration of a standard PCM WAV', () => {
  assert.equal(wavDurationSeconds(pcmWav(3)), 3)
})

test('rejects non-WAV and malformed chunk data', () => {
  assert.equal(wavDurationSeconds(new ArrayBuffer(12)), null)
  const malformed = pcmWav(1)
  new DataView(malformed).setUint32(40, 0xffff_ffff, true)
  assert.equal(wavDurationSeconds(malformed), null)
})
