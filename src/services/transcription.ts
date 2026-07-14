import type {
  TranscriptLanguageChoice,
  TranscriptTask,
  WhisperModelId,
  WhisperRawResult,
} from '../data/transcript'

export interface WhisperRuntimeModelStatus {
  id: WhisperModelId
  downloaded: boolean
  approximateBytes: number
}

export interface WhisperRuntimeStatus {
  ok: boolean
  available: boolean
  engine: 'openai-whisper'
  implementation: 'whisper.cpp'
  engineVersion?: string
  code?: string
  error?: string
  setupGuide?: string
  runtimeInstallSupported?: boolean
  models: WhisperRuntimeModelStatus[]
}

interface WhisperServiceStatus {
  ok?: boolean
  engine?: string
  runtime?: {
    state?: string
    available?: boolean
    installable?: boolean
    engineVersion?: string
    code?: string
    error?: string
  }
  models?: Record<string, { state?: string; bytes?: number }>
}

interface TranscriptionErrorPayload {
  ok?: false
  code?: string
  error?: string
  setupGuide?: string
}

export interface LocalTranscriptionOptions {
  model: WhisperModelId
  language: TranscriptLanguageChoice
  task: TranscriptTask
  wordTimestamps: boolean
  initialPrompt: string
  conditionOnPreviousText: boolean
  temperature: number
  beamSize: number
}

export class LocalTranscriptionError extends Error {
  code: string
  setupGuide?: string

  constructor(message: string, code = 'TRANSCRIPTION_FAILED', setupGuide?: string) {
    super(message)
    this.name = 'LocalTranscriptionError'
    this.code = code
    this.setupGuide = setupGuide
  }
}

async function responseError(response: Response, fallback: string): Promise<LocalTranscriptionError> {
  const payload = (await response.json().catch(() => null)) as TranscriptionErrorPayload | null
  return new LocalTranscriptionError(payload?.error || fallback, payload?.code || 'TRANSCRIPTION_FAILED', payload?.setupGuide)
}

function publicModelId(value: string): WhisperModelId | null {
  if (value === 'large') return 'large-v3'
  return ['tiny', 'base', 'small', 'medium', 'turbo'].includes(value) ? value as WhisperModelId : null
}

function serviceModelId(value: WhisperModelId): string {
  return value === 'large-v3' ? 'large' : value
}

function normalizedStatus(value: WhisperServiceStatus | Partial<WhisperRuntimeStatus> | null): WhisperRuntimeStatus {
  const service = value as WhisperServiceStatus | null
  const legacy = value as Partial<WhisperRuntimeStatus> | null
  const serviceModels = service?.models && !Array.isArray(service.models)
    ? Object.entries(service.models).flatMap(([id, item]) => {
        const normalizedId = publicModelId(id)
        return normalizedId ? [{ id: normalizedId, downloaded: item.state === 'ready', approximateBytes: Number(item.bytes) || 0 }] : []
      })
    : []
  return {
    ok: value?.ok === true,
    available: service?.runtime ? service.runtime.available === true : legacy?.available === true,
    engine: 'openai-whisper',
    implementation: 'whisper.cpp',
    engineVersion: service?.runtime?.engineVersion ?? legacy?.engineVersion,
    code: service?.runtime?.code ?? legacy?.code,
    error: service?.runtime?.error ?? legacy?.error,
    setupGuide: legacy?.setupGuide,
    runtimeInstallSupported: service?.runtime ? service.runtime.installable === true : legacy?.runtimeInstallSupported === true,
    models: serviceModels.length ? serviceModels : Array.isArray(legacy?.models) ? legacy!.models!.filter((item) => item && typeof item.id === 'string') : [],
  }
}

export async function getWhisperRuntimeStatus(signal?: AbortSignal): Promise<WhisperRuntimeStatus> {
  try {
    const response = await fetch('/api/transcribe/status', { signal })
    if (!response.ok) throw await responseError(response, 'Could not check the local Whisper runtime.')
    return normalizedStatus(await response.json() as WhisperServiceStatus)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return normalizedStatus({
      ok: false,
      available: false,
      code: error instanceof LocalTranscriptionError ? error.code : 'TRANSCRIPTION_SERVICE_UNAVAILABLE',
      error: error instanceof Error ? error.message : 'The local transcription service is unavailable.',
      models: [],
    })
  }
}

export async function installWhisperRuntime(signal?: AbortSignal): Promise<WhisperRuntimeStatus> {
  const response = await fetch('/api/transcribe/runtime/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  })
  if (!response.ok) throw await responseError(response, 'The local Whisper runtime could not be installed.')
  return normalizedStatus(await response.json() as WhisperServiceStatus)
}

export async function downloadWhisperModel(model: WhisperModelId, signal?: AbortSignal): Promise<WhisperRuntimeStatus> {
  const response = await fetch('/api/transcribe/model/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: serviceModelId(model) }),
    signal,
  })
  if (!response.ok) throw await responseError(response, 'The selected Whisper model could not be downloaded.')
  return getWhisperRuntimeStatus(signal)
}

export async function transcribeLocally(
  media: Blob,
  fileName: string,
  options: LocalTranscriptionOptions,
  signal?: AbortSignal,
): Promise<WhisperRawResult> {
  const headers = new Headers({
    'Content-Type': media.type || 'application/octet-stream',
    'X-EF-File-Name': encodeURIComponent(fileName.slice(0, 240)),
    'X-EF-Whisper-Model': serviceModelId(options.model),
    'X-EF-Whisper-Language': options.language,
    'X-EF-Whisper-Task': options.task,
    'X-EF-Whisper-Word-Timestamps': options.wordTimestamps ? 'true' : 'false',
    'X-EF-Whisper-Initial-Vocabulary': encodeURIComponent(options.initialPrompt.slice(0, 1_200)),
    'X-EF-Whisper-Condition-On-Previous-Text': options.conditionOnPreviousText ? 'true' : 'false',
    'X-EF-Whisper-Temperature': String(Math.min(1, Math.max(0, options.temperature))),
    'X-EF-Whisper-Beam-Size': String(Math.min(10, Math.max(1, Math.round(options.beamSize)))),
  })
  const response = await fetch('/api/transcribe', { method: 'POST', headers, body: media, signal })
  if (!response.ok) throw await responseError(response, `Local transcription failed (${response.status}).`)
  const result = await response.json() as WhisperRawResult | TranscriptionErrorPayload
  if (result.ok !== true) throw new LocalTranscriptionError(result.error || 'Local transcription failed.', result.code)
  return {
    ...result,
    implementation: 'whisper.cpp',
    model: (String(result.model) === 'large' ? 'large-v3' : result.model) as WhisperModelId,
  }
}
