// kie.ai account + generation API.
//  - Credits:   GET  /api/v1/chat/credit            (docs.kie.ai/common-api/get-account-credits)
//  - Prices:    POST /client/v1/model-pricing/page (public kie.ai/pricing feed)
//  - Generate:  POST /api/v1/jobs/createTask         (Market unified API)
//  - Poll:      GET  /api/v1/jobs/recordInfo?taskId= (Market unified API)
//  - Upload:    POST https://kieai.redpandaai.co/api/file-base64-upload (File Upload API)
// All authenticated with `Authorization: Bearer <key>`.
//
// We always call kie.ai through relative proxy paths (`/kie` -> api.kie.ai,
// `/kie-upload` -> kieai.redpandaai.co), never the hosts directly. The origin
// that serves this UI always provides those proxies: the Vite dev server in
// development, and the plugin's embedded server inside DaVinci Resolve in
// production. (A standalone static web build would have to supply its own.)
const ROOT = '/kie'
const BASE = `${ROOT}/api/v1`
const UPLOAD_BASE = '/kie-upload'

export interface CreditsResult {
  ok: boolean
  credits?: number
  error?: string
}

export interface KieLivePriceRow {
  modelDescription: string
  interfaceType: string
  provider: string
  credits: number
  unit: string
  usd: number | null
  anchor: string
}

interface PricingPage {
  code?: number
  data?: {
    records?: Array<{
      modelDescription?: string
      interfaceType?: string
      provider?: string
      creditPrice?: string | number
      creditUnit?: string
      usdPrice?: string | number
      anchor?: string
    }>
    pages?: number
  }
}

function parsePricingPage(json: PricingPage): KieLivePriceRow[] {
  if (json.code !== 200 || !Array.isArray(json.data?.records)) return []
  const rows: KieLivePriceRow[] = []
  for (const row of json.data.records) {
    const credits = Number(row.creditPrice)
    if (!row.modelDescription || !Number.isFinite(credits)) continue
    // Some live rows use a decimal comma. Normalise it without guessing when
    // the provider omits a USD value; credits remain the billing source of truth.
    const usdRaw = String(row.usdPrice ?? '').replace(',', '.').trim()
    const usd = usdRaw ? Number(usdRaw) : Number.NaN
    rows.push({
      modelDescription: row.modelDescription.trim(),
      interfaceType: row.interfaceType?.trim() ?? '',
      provider: row.provider?.trim() ?? '',
      credits,
      unit: row.creditUnit?.trim() ?? '',
      usd: Number.isFinite(usd) ? usd : null,
      anchor: row.anchor?.trim() ?? '',
    })
  }
  return rows
}

async function fetchPricingPage(pageNum: number): Promise<PricingPage | null> {
  try {
    const res = await fetch(`${ROOT}/client/v1/model-pricing/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageNum, pageSize: 100, modelDescription: '', interfaceType: '' }),
    })
    if (!res.ok) return null
    return (await res.json()) as PricingPage
  } catch {
    return null
  }
}

// The exact data source used by kie.ai/pricing. It is public and requires no
// credential, and unlike the playground group's single headline value it
// includes variant, resolution, input-mode and per-second rows. Fetch every
// page so all model families can be priced from the same live source of truth.
export async function fetchModelPrices(): Promise<KieLivePriceRow[]> {
  const first = await fetchPricingPage(1)
  if (!first || first.code !== 200) return []
  const pages = Math.min(Math.max(1, Number(first.data?.pages) || 1), 20)
  const rest = pages > 1
    ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => fetchPricingPage(index + 2)))
    : []
  const rows = [first, ...rest.filter((page): page is PricingPage => page?.code === 200)].flatMap(parsePricingPage)
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.modelDescription.toLowerCase()}|${row.unit.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// Generation transport (createTask / recordInfo / file upload)
// ---------------------------------------------------------------------------

export type KieErrorKind =
  | 'cancelled'
  | 'provider-terminal'
  | 'tracking-recoverable'
  | 'submission-uncertain'
  | 'request-rejected'
  | 'unknown'

export class KieError extends Error {
  readonly code?: number
  readonly kind: KieErrorKind

  constructor(message: string, code?: number, kind: KieErrorKind = 'unknown') {
    super(message)
    this.code = code
    this.kind = kind
    this.name = 'KieError'
  }
}

export function isProviderTerminalKieError(error: unknown): boolean {
  return error instanceof KieError && error.kind === 'provider-terminal'
}

export function isRecoverableKieTrackingError(error: unknown): boolean {
  return error instanceof KieError && error.kind === 'tracking-recoverable'
}

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' }
}

// Response codes that mean the request was REJECTED (so no task was created and
// retrying a createTask is safe and won't double-charge): rate limit / sub-key
// limit / maintenance / gateway. 500/408/network are ambiguous (the task may
// have been created), so createTask does NOT retry on those.
const CREATE_RETRYABLE = new Set([429, 433, 455, 502, 503, 504])
// Fatal — never retry (bad key, no credits, bad params, hard generation failure).
const FATAL_CODES = new Set([401, 402, 403, 404, 422, 501, 505])
// A record read is idempotent, but retrying a permanent provider response only
// hides the real error behind "Lost connection" and delays recovery. Limit
// retries to explicit transient HTTP/provider codes; raw fetch failures are
// still retried because they have no response code at all.
const POLL_RETRYABLE = new Set([408, 425, 429, 433, 455, 500, 502, 503, 504])

const isCancel = (e: unknown) => e instanceof KieError && e.kind === 'cancelled'
const asTrackingError = (e: unknown) => e instanceof KieError
  ? new KieError(e.message, e.code, 'tracking-recoverable')
  : new KieError(e instanceof Error ? e.message : String(e), undefined, 'tracking-recoverable')
const isRetryablePollError = (e: unknown) =>
  !(e instanceof KieError) || (e.code != null ? POLL_RETRYABLE.has(e.code) : e.message === 'Network error')

// Abortable delay — rejects immediately if the signal fires.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new KieError('Cancelled', undefined, 'cancelled'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new KieError('Cancelled', undefined, 'cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface RetryOpts {
  retries?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, err: unknown) => void
  isRetryable?: (err: unknown) => boolean
}

// Retry with exponential backoff. By default retries anything non-fatal (used
// for reads/uploads); pass `isRetryable` to narrow it (used for createTask).
async function withRetry<T>(fn: () => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const retries = o.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
    try {
      return await fn()
    } catch (e) {
      const retryable = o.isRetryable ? o.isRetryable(e) : !(e instanceof KieError && e.code != null && FATAL_CODES.has(e.code))
      if (isCancel(e) || attempt >= retries || !retryable) throw e
      o.onRetry?.(attempt + 1, e)
      await sleep(Math.min(1500 * 2 ** attempt, 8000), o.signal)
    }
  }
}

// Turn any browser URL the app holds (blob:, data:, http:) into a base64 data
// URL suitable for the base64 upload endpoint.
export async function urlToDataUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
  if (url.startsWith('data:')) return url
  const blob = await (await fetch(url, { signal })).blob()
  if (signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(blob)
  })
}

// Upload a data URL to kie.ai and return a public https file URL (valid ~24h),
// which is what every generation model expects for image/video/audio inputs.
// Uploads are free and idempotent, so we retry transient failures.
const DATA_URL_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
}

function uploadFileName(dataUrl: string, requestedName?: string): string | undefined {
  const mimeType = /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase()
  const extension = mimeType ? DATA_URL_EXTENSIONS[mimeType] : undefined
  const cleanName = requestedName
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f\x7f]/g, '')
    .trim()

  // Resolve labels grabs as "Timeline/clip · timecode", so their otherwise
  // valid PNG/MP4/WAV bytes arrive without a terminal extension. Kie's upload
  // accepts the bytes, but downstream models infer the media type from the
  // hosted URL and reject that extensionless reference. Keep normal upload
  // names intact and add the authoritative Data URL extension only when absent.
  if (cleanName && /\.[a-z0-9]{1,10}$/i.test(cleanName)) return cleanName.slice(0, 240)
  if (extension) {
    const stem = (cleanName || 'easyfield-upload').replace(/[. ]+$/g, '') || 'easyfield-upload'
    return `${stem.slice(0, 240 - extension.length)}${extension}`
  }

  // With no trustworthy extension, omit the optional filename and let Kie's
  // MIME-aware upload service generate one instead of forcing a misleading,
  // extensionless URL.
  return undefined
}

export async function uploadDataUrl(apiKey: string, dataUrl: string, fileName?: string, signal?: AbortSignal): Promise<string> {
  const normalizedFileName = uploadFileName(dataUrl, fileName)
  return withRetry(
    async () => {
      let res: Response
      try {
        res = await fetch(`${UPLOAD_BASE}/api/file-base64-upload`, {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify({ base64Data: dataUrl, uploadPath: 'images', fileName: normalizedFileName }),
          signal,
        })
      } catch {
        if (signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
        throw new KieError('Network error while uploading')
      }
      const json = (await res.json().catch(() => null)) as
        | { code?: number; success?: boolean; msg?: string; data?: { fileUrl?: string; downloadUrl?: string } }
        | null
      // The live API returns `downloadUrl` (a hosted https URL); `fileUrl` in the
      // docs is idealized. Prefer whichever is present.
      const fileUrl = json?.data?.downloadUrl || json?.data?.fileUrl
      if (!res.ok || !fileUrl) throw new KieError(json?.msg || `Upload failed (${res.status})`, json?.code ?? res.status)
      return fileUrl
    },
    { retries: 3, signal },
  )
}

// Convenience: upload any app URL (blob/data/http) → hosted file URL.
export async function uploadUrl(apiKey: string, url: string, fileName?: string, signal?: AbortSignal): Promise<string> {
  return uploadDataUrl(apiKey, await urlToDataUrl(url, signal), fileName, signal)
}

export interface JobResult {
  urls: string[]
  creditsConsumed: number | null
  raw: unknown
}

export type KieFamily = 'jobs' | 'veo' | 'runway' | 'aleph' | 'suno' | 'sounds'

// Create a Market job. Returns the taskId. Retries ONLY on codes that mean the
// request was rejected (so no task exists yet) — never on ambiguous 500/network,
// which could double-charge.
export async function createTask(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  opts: PollOptions = {},
): Promise<string> {
  return withRetry(
    async () => {
      await opts.onSubmissionStarted?.()
      if (opts.signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
      let res: Response
      try {
        res = await fetch(`${BASE}/jobs/createTask`, {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify({ model, input }),
          signal: opts.signal,
        })
      } catch {
        if (opts.signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
        throw new KieError(
          'The provider submission outcome is unknown because the connection closed before a task ID was returned.',
          undefined,
          'submission-uncertain',
        ) // no code → never retried
      }
      const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: { taskId?: string } } | null
      const taskId = json?.data?.taskId
      if (json?.code === 200 && taskId) return taskId
      throw new KieError(json?.msg || `Create task failed (${res.status})`, json?.code ?? res.status, 'request-rejected')
    },
    { retries: 4, signal: opts.signal, onRetry: opts.onRetry, isRetryable: (e) => e instanceof KieError && e.code != null && CREATE_RETRYABLE.has(e.code) },
  )
}

// Pull the media URLs out of a Market recordInfo resultJson.
function extractUrls(resultJson: string | undefined): string[] {
  if (!resultJson) return []
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown; resultObject?: { mask_urls?: unknown } }
    const urls = parsed.resultUrls ?? parsed.resultObject?.mask_urls
    if (Array.isArray(urls)) return urls.filter((u): u is string => typeof u === 'string')
    if (typeof urls === 'string') return [urls]
  } catch {
    /* not JSON */
  }
  return []
}

export interface PollOptions {
  signal?: AbortSignal
  intervalMs?: number
  timeoutMs?: number
  /** Awaited immediately before a paid create request is sent. */
  onSubmissionStarted?: () => void | Promise<void>
  /** Fired after the durable EasyField activity record exists. */
  onJobCreated?: (jobId: string) => void
  onState?: (state: string) => void
  onTaskId?: (taskId: string, family: KieFamily) => void | Promise<void> // awaited once accepted so durable recovery metadata is flushed
  /** Removes completed or explicitly failed children from the recovery ledger. */
  onTaskSettled?: (taskId: string, family: KieFamily, outcome: 'succeeded' | 'failed') => void | Promise<void>
  onRetry?: (attempt: number, err: unknown) => void // fired when a transient call is retried
}
// A single failed poll is a blip, not a failure — give up only after this many
// consecutive read errors so we don't abandon a job that's actually running.
const MAX_POLL_ERRORS = 6

// Poll a Market job until it reaches success/fail (or times out). Tolerant of
// transient read errors, with a gentle backoff so long video jobs don't hammer
// the API. A hard `fail` state is a real failure and is NOT retried.
export async function pollTask(apiKey: string, taskId: string, opts: PollOptions = {}): Promise<JobResult> {
  const { signal, intervalMs = 2500, timeoutMs = 12 * 60 * 1000, onState, onRetry } = opts
  const started = Date.now()
  let delay = intervalMs
  let errors = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
    try {
      const res = await fetch(`${BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal,
      })
      const json = (await res.json().catch(() => null)) as
        | { code?: number; msg?: string; data?: { state?: string; resultJson?: string; failMsg?: string; creditsConsumed?: number } }
        | null
      const data = json?.data
      if (!res.ok || !data) throw new KieError(json?.msg || `Poll failed (${res.status})`, json?.code ?? res.status)
      errors = 0
      if (data.state) onState?.(data.state)
      if (data.state === 'success') return { urls: extractUrls(data.resultJson), creditsConsumed: data.creditsConsumed ?? null, raw: data }
      if (data.state === 'fail') throw new KieError(data.failMsg || 'Generation failed', undefined, 'provider-terminal')
    } catch (e) {
      if (isCancel(e)) throw e
      if (isProviderTerminalKieError(e)) throw e
      // Hard generation/provider failures surface immediately; only transient
      // response codes and raw network blips are retried.
      if (!isRetryablePollError(e)) throw asTrackingError(e)
      if (++errors > MAX_POLL_ERRORS) throw new KieError('Lost connection to kie.ai while waiting for the result', undefined, 'tracking-recoverable')
      onRetry?.(errors, e)
    }
    if (Date.now() - started > timeoutMs) throw new KieError('Timed out waiting for the result', undefined, 'tracking-recoverable')
    await sleep(delay, signal)
    delay = Math.min(Math.round(delay * 1.25), 10000)
  }
}

// One-shot: create a Market job and wait for its media URLs.
export async function runTask(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  opts: PollOptions = {},
): Promise<JobResult> {
  const taskId = await createTask(apiKey, model, input, opts)
  await opts.onTaskId?.(taskId, 'jobs')
  try {
    const result = await pollTask(apiKey, taskId, opts)
    await opts.onTaskSettled?.(taskId, 'jobs', 'succeeded')
    return result
  } catch (error) {
    if (isProviderTerminalKieError(error)) await opts.onTaskSettled?.(taskId, 'jobs', 'failed')
    throw error
  }
}

// ---- Dedicated families (Veo / Runway / Aleph / Suno) --------------------
// These predate the unified Market API: a flat request body and a bespoke
// record endpoint with their own success flag + result shape.

// Turn any value that might be an array or a JSON-encoded array of URLs into
// a plain string[]. kie.ai is inconsistent across endpoints, so we're tolerant.
function coerceUrls(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((u): u is string => typeof u === 'string')
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('[')) {
      try {
        const p = JSON.parse(s)
        if (Array.isArray(p)) return p.filter((u): u is string => typeof u === 'string')
      } catch {
        /* fall through */
      }
    }
    if (s.startsWith('http')) return [s]
  }
  return []
}

type DedicatedExtract = (data: Record<string, unknown>) => {
  done: boolean
  failed: boolean
  urls: string[]
  failMsg?: string
}

async function createDedicated(apiKey: string, path: string, body: Record<string, unknown>, opts: PollOptions = {}): Promise<string> {
  return withRetry(
    async () => {
      await opts.onSubmissionStarted?.()
      if (opts.signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
      let res: Response
      try {
        res = await fetch(`${ROOT}${path}`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body), signal: opts.signal })
      } catch {
        if (opts.signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
        throw new KieError(
          'The provider submission outcome is unknown because the connection closed before a task ID was returned.',
          undefined,
          'submission-uncertain',
        )
      }
      const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: { taskId?: string } } | null
      const taskId = json?.data?.taskId
      if (json?.code === 200 && taskId) return taskId
      throw new KieError(json?.msg || `Create task failed (${res.status})`, json?.code ?? res.status, 'request-rejected')
    },
    { retries: 4, signal: opts.signal, onRetry: opts.onRetry, isRetryable: (e) => e instanceof KieError && e.code != null && CREATE_RETRYABLE.has(e.code) },
  )
}

async function pollDedicated(
  apiKey: string,
  recordPath: string,
  taskId: string,
  extract: DedicatedExtract,
  opts: PollOptions = {},
): Promise<JobResult> {
  const { signal, intervalMs = 3000, timeoutMs = 12 * 60 * 1000, onState, onRetry } = opts
  const started = Date.now()
  let delay = intervalMs
  let errors = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new KieError('Cancelled', undefined, 'cancelled')
    try {
      const res = await fetch(`${ROOT}${recordPath}?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal,
      })
      const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: Record<string, unknown> } | null
      const data = json?.data
      if (!res.ok || !data) throw new KieError(json?.msg || `Poll failed (${res.status})`, json?.code ?? res.status)
      errors = 0
      const { done, failed, urls, failMsg } = extract(data)
      if (failed) throw new KieError(failMsg || 'Generation failed', undefined, 'provider-terminal')
      if (done) {
        onState?.('success')
        return { urls, creditsConsumed: typeof data.creditsConsumed === 'number' ? (data.creditsConsumed as number) : null, raw: data }
      }
      onState?.('generating')
    } catch (e) {
      if (isCancel(e)) throw e
      if (isProviderTerminalKieError(e)) throw e
      if (!isRetryablePollError(e)) throw asTrackingError(e)
      if (++errors > MAX_POLL_ERRORS) throw new KieError('Lost connection to kie.ai while waiting for the result', undefined, 'tracking-recoverable')
      onRetry?.(errors, e)
    }
    if (Date.now() - started > timeoutMs) throw new KieError('Timed out waiting for the result', undefined, 'tracking-recoverable')
    await sleep(delay, signal)
    delay = Math.min(Math.round(delay * 1.25), 10000)
  }
}

// A model request, resolved by the registry, ready to send.
export type KieRequest =
  | { family: 'jobs'; model: string; input: Record<string, unknown> }
  | { family: 'veo'; body: Record<string, unknown> }
  | { family: 'runway'; body: Record<string, unknown> }
  | { family: 'aleph'; body: Record<string, unknown> }
  | { family: 'suno'; body: Record<string, unknown> }
  | { family: 'sounds'; body: Record<string, unknown> }

const sunoAudioExtract: DedicatedExtract = (d) => {
  const status = String(d.status ?? '')
  const resp = (d.response ?? {}) as { sunoData?: Array<{ audioUrl?: string; streamAudioUrl?: string }> }
  const urls = (resp.sunoData ?? []).map((track) => track.audioUrl || track.streamAudioUrl).filter((url): url is string => !!url)
  const failed = /FAILED|ERROR|EXCEPTION/.test(status)
  return {
    done: status === 'SUCCESS' && urls.length > 0,
    failed,
    urls,
    failMsg: failed
      ? (typeof d.errorMessage === 'string' && d.errorMessage ? d.errorMessage : status)
      : undefined,
  }
}

const EXTRACTORS: Record<'veo' | 'runway' | 'aleph' | 'suno' | 'sounds', { create: string; record: string; extract: DedicatedExtract }> = {
  // docs.kie.ai/veo3-api — successFlag: 0 generating, 1 success, 2/3 failed.
  veo: {
    create: '/api/v1/veo/generate',
    record: '/api/v1/veo/record-info',
    extract: (d) => {
      const flag = d.successFlag
      const resp = (d.response ?? {}) as Record<string, unknown>
      return {
        done: flag === 1,
        failed: flag === 2 || flag === 3,
        urls: coerceUrls(resp.resultUrls ?? d.resultUrls),
        failMsg: typeof d.errorMessage === 'string' ? (d.errorMessage as string) : undefined,
      }
    },
  },
  // docs.kie.ai/runway-api — state: wait|queueing|generating|success|fail.
  runway: {
    create: '/api/v1/runway/generate',
    record: '/api/v1/runway/record-detail',
    extract: (d) => {
      const info = (d.videoInfo ?? {}) as Record<string, unknown>
      return {
        done: d.state === 'success',
        failed: d.state === 'fail',
        urls: coerceUrls(info.videoUrl),
        failMsg: typeof d.failMsg === 'string' ? (d.failMsg as string) : undefined,
      }
    },
  },
  // docs.kie.ai/runway-api/generate-aleph-video — successFlag like Veo.
  aleph: {
    create: '/api/v1/aleph/generate',
    record: '/api/v1/aleph/record-info',
    extract: (d) => {
      const flag = d.successFlag
      const resp = (d.response ?? {}) as Record<string, unknown>
      return {
        done: flag === 1,
        failed: flag === 2 || flag === 3,
        urls: coerceUrls(resp.resultVideoUrl ?? resp.resultUrls),
        failMsg: typeof d.errorMessage === 'string' ? (d.errorMessage as string) : undefined,
      }
    },
  },
  // docs.kie.ai/suno-api — status SUCCESS (with FIRST/TEXT_SUCCESS partials).
  suno: {
    create: '/api/v1/generate',
    record: '/api/v1/generate/record-info',
    extract: sunoAudioExtract,
  },
  // docs.kie.ai/suno-api/generate-sounds — sound jobs use their own creation
  // route but share Suno's durable record endpoint and result shape.
  sounds: {
    create: '/api/v1/generate/sounds',
    record: '/api/v1/generate/record-info',
    extract: sunoAudioExtract,
  },
}

// Resume an accepted provider task without re-submitting paid work. Persist the
// family next to the task ID: dedicated Veo/Runway/Aleph/Suno/Sounds tasks do not use
// the Market recordInfo endpoint.
export async function resumeKieModel(
  apiKey: string,
  family: KieFamily,
  taskId: string,
  opts: PollOptions = {},
): Promise<JobResult> {
  if (family === 'jobs') return pollTask(apiKey, taskId, opts)
  const cfg = EXTRACTORS[family]
  return pollDedicated(apiKey, cfg.record, taskId, cfg.extract, opts)
}

// Run any model (jobs or dedicated) and wait for its media URLs.
export async function runKieModel(apiKey: string, req: KieRequest, opts: PollOptions = {}): Promise<JobResult> {
  if (req.family === 'jobs') return runTask(apiKey, req.model, req.input, opts)
  const cfg = EXTRACTORS[req.family]
  const taskId = await createDedicated(apiKey, cfg.create, req.body, opts)
  await opts.onTaskId?.(taskId, req.family)
  try {
    const result = await resumeKieModel(apiKey, req.family, taskId, opts)
    await opts.onTaskSettled?.(taskId, req.family, 'succeeded')
    return result
  } catch (error) {
    if (isProviderTerminalKieError(error)) await opts.onTaskSettled?.(taskId, req.family, 'failed')
    throw error
  }
}

export async function fetchCredits(apiKey: string): Promise<CreditsResult> {
  const key = apiKey.trim()
  if (!key) return { ok: false, error: 'No API key' }
  try {
    const res = await fetch(`${BASE}/chat/credit`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    // kie.ai returns HTTP 200 with the real status in the body `code`.
    const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null
    if (res.status === 401 || res.status === 403 || json?.code === 401 || json?.code === 403) {
      return { ok: false, error: 'Invalid API key' }
    }
    if (!res.ok || !json) return { ok: false, error: `Request failed (${res.status})` }
    if (json.code !== 200 || typeof json.data !== 'number') {
      return { ok: false, error: json.msg || 'Unexpected response' }
    }
    return { ok: true, credits: json.data }
  } catch {
    return { ok: false, error: 'Network error — is the key/connection right?' }
  }
}
