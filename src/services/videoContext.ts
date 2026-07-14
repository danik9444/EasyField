const VIDEO_LOAD_TIMEOUT_MS = 12_000

function abortError(): Error {
  const error = new Error('Video analysis cancelled')
  error.name = 'AbortError'
  return error
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
  signal?: AbortSignal,
  timeoutMs = VIDEO_LOAD_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeEventListener(eventName, onReady)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onReady = () => finish()
    const onError = () => finish(new Error('The selected video could not be decoded.'))
    const onAbort = () => finish(abortError())
    const timer = window.setTimeout(() => finish(new Error('Video analysis timed out.')), timeoutMs)
    video.addEventListener(eventName, onReady, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function makeVideo(url: string): HTMLVideoElement {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  if (/^https?:/i.test(url)) video.crossOrigin = 'anonymous'
  video.src = url
  return video
}

function releaseVideo(video: HTMLVideoElement): void {
  try { video.pause() } catch { /* best effort */ }
  video.removeAttribute('src')
  try { video.load() } catch { /* best effort */ }
}

export async function readVideoDuration(url: string, signal?: AbortSignal): Promise<number> {
  const video = makeVideo(url)
  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      video.load()
      await waitForVideoEvent(video, 'loadedmetadata', signal)
    }
    const duration = Number(video.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('The selected video has no readable duration.')
    return duration
  } finally {
    releaseVideo(video)
  }
}

export function orderedVideoSampleTimes(durationSeconds: number, maximumFrames = 8): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || maximumFrames <= 0) return []
  const frameLimit = Math.max(1, Math.min(12, Math.floor(maximumFrames)))
  const count = Math.min(frameLimit, Math.max(3, Math.ceil(durationSeconds / 1.5)))
  const safeEnd = Math.max(0, durationSeconds - Math.min(0.04, durationSeconds / 10))
  return Array.from({ length: count }, (_, index) => {
    const time = durationSeconds * ((index + 0.5) / count)
    return Math.round(Math.min(safeEnd, Math.max(0, time)) * 1000) / 1000
  })
}

export interface SampledVideoFrame {
  timeSeconds: number
  mediaType: 'image/jpeg'
  dataB64: string
}

export async function sampleVideoFrames(
  url: string,
  opts: { durationSeconds?: number; maximumFrames?: number; maxDimension?: number; signal?: AbortSignal } = {},
): Promise<SampledVideoFrame[]> {
  const video = makeVideo(url)
  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      video.load()
      await waitForVideoEvent(video, 'loadedmetadata', opts.signal)
    }
    const duration = Number.isFinite(opts.durationSeconds) && Number(opts.durationSeconds) > 0
      ? Number(opts.durationSeconds)
      : Number(video.duration)
    if (!Number.isFinite(duration) || duration <= 0) return []
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoEvent(video, 'loadeddata', opts.signal)
    }
    const times = orderedVideoSampleTimes(duration, opts.maximumFrames ?? 8)
    const maxDimension = Math.max(320, Math.min(1280, Math.round(opts.maxDimension ?? 768)))
    const frames: SampledVideoFrame[] = []
    for (const timeSeconds of times) {
      if (opts.signal?.aborted) throw abortError()
      if (Math.abs(video.currentTime - timeSeconds) > 0.01) {
        video.currentTime = timeSeconds
        await waitForVideoEvent(video, 'seeked', opts.signal)
      }
      const sourceWidth = video.videoWidth
      const sourceHeight = video.videoHeight
      if (!sourceWidth || !sourceHeight) continue
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(sourceWidth * scale))
      canvas.height = Math.max(1, Math.round(sourceHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) continue
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
      const comma = dataUrl.indexOf(',')
      if (comma < 0) continue
      frames.push({ timeSeconds, mediaType: 'image/jpeg', dataB64: dataUrl.slice(comma + 1) })
    }
    return frames
  } catch (error) {
    if (opts.signal?.aborted) throw abortError()
    // Remote media without CORS may not be drawable. The caller can still use
    // the reference manifest instead of pretending visual frames were attached.
    if (error instanceof DOMException && error.name === 'SecurityError') return []
    throw error
  } finally {
    releaseVideo(video)
  }
}
