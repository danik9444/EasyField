/**
 * Read a PCM/IEEE-float WAV duration without relying on an HTMLAudioElement.
 * Browser metadata events can be delayed or omitted for a freshly selected
 * File; the RIFF byte-rate and data-chunk size are deterministic instead.
 */
export function wavDurationSeconds(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 20) return null
  const view = new DataView(buffer)
  const fourCC = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    )

  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') return null

  let byteRate = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const chunkId = fourCC(offset)
    const declaredSize = view.getUint32(offset + 4, true)
    const payloadOffset = offset + 8
    if (declaredSize > view.byteLength - payloadOffset) return null
    const availableSize = declaredSize

    if (chunkId === 'fmt ' && availableSize >= 12) {
      byteRate = view.getUint32(payloadOffset + 8, true)
    } else if (chunkId === 'data') {
      dataBytes = availableSize
    }

    if (byteRate > 0 && dataBytes > 0) {
      const duration = dataBytes / byteRate
      return Number.isFinite(duration) && duration > 0 ? duration : null
    }

    // RIFF chunks are word-aligned. Stop on a malformed size rather than
    // wrapping or walking beyond the selected file.
    const next = payloadOffset + declaredSize + (declaredSize % 2)
    if (next <= offset || next > view.byteLength) break
    offset = next
  }

  return null
}
