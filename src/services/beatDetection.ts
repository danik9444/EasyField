export interface BeatPoint {
  time: number
  confidence: number
}

export interface BeatDetectionResult {
  ok: true
  engine: 'librosa'
  engineVersion: string
  bpm: number
  confidence: number
  durationSeconds: number
  sampleRate: number
  beats: BeatPoint[]
}

export interface BeatRuntimeStatus {
  ok: boolean
  available: boolean
  engine: 'librosa'
  engineVersion?: string
  code?: string
  error?: string
  setupGuide?: string
}

interface BeatErrorPayload {
  ok?: false
  code?: string
  error?: string
  setupGuide?: string
}

export class BeatDetectionError extends Error {
  code: string
  setupGuide?: string

  constructor(message: string, code = 'BEAT_ANALYSIS_FAILED', setupGuide?: string) {
    super(message)
    this.name = 'BeatDetectionError'
    this.code = code
    this.setupGuide = setupGuide
  }
}

function localHeaders(): Headers {
  return new Headers()
}

async function payloadError(response: Response, fallback: string): Promise<BeatDetectionError> {
  const payload = (await response.json().catch(() => null)) as BeatErrorPayload | null
  return new BeatDetectionError(
    payload?.error || fallback,
    payload?.code || 'BEAT_ANALYSIS_FAILED',
    payload?.setupGuide,
  )
}

export async function getBeatRuntimeStatus(signal?: AbortSignal): Promise<BeatRuntimeStatus> {
  try {
    const response = await fetch('/api/beat-detect/status', { headers: localHeaders(), signal })
    if (!response.ok) throw await payloadError(response, 'Could not check the local beat runtime.')
    return await response.json() as BeatRuntimeStatus
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      ok: false,
      available: false,
      engine: 'librosa',
      code: error instanceof BeatDetectionError ? error.code : 'BEAT_SERVICE_UNAVAILABLE',
      error: error instanceof Error ? error.message : 'The local beat service is unavailable.',
    }
  }
}

export async function detectBeats(
  media: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<BeatDetectionResult> {
  const headers = localHeaders()
  headers.set('Content-Type', media.type || 'application/octet-stream')
  headers.set('X-EF-File-Name', encodeURIComponent(fileName.slice(0, 240)))
  const response = await fetch('/api/beat-detect', {
    method: 'POST',
    headers,
    body: media,
    signal,
  })
  if (!response.ok) throw await payloadError(response, `Beat analysis failed (${response.status}).`)
  const result = await response.json() as BeatDetectionResult | BeatErrorPayload
  if (result.ok !== true) {
    throw new BeatDetectionError(result.error || 'Beat analysis failed.', result.code)
  }
  return result
}
