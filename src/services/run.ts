// High-level generation entry points used by the screens. Each takes the raw
// panel state, uploads any local media to EasyField Cloud, builds the model's exact
// request via the registry, runs it, and returns the resulting media URL(s)
// plus the real credits charged.
//
// Media reality: `upload`-kind items carry real bytes (a blob URL) and are
// uploaded. Legacy `playhead` items have no pixels and are skipped; new capture
// failures never create them. A run with no usable required source throws a
// NeedsSourceError for the screen to show.
import { currentApiKey, loadSettings } from '../settings'
import {
  imageEditRunEstimate,
  imageRunEstimate,
  musicRunEstimate,
  soundEffectsRunEstimate,
  ttsRunEstimate,
  upscaleBatchEstimate,
  upscaleRunEstimate,
  videoEditRunEstimate,
  videoRunEstimate,
  avatarRunEstimate,
} from '../data/pricing'
import { assertSpendApproved } from './spendGuard'
import { isRecoverableProviderTrackingError, runProviderModel, uploadUrl, type PollOptions } from './providerGateway'
import { generationStartLimit, jobLimit, uploadLimit, mapLimit } from './taskQueue'
import { createUploadReuseCache } from './uploadReuse'
import { getJobs, hasAcceptedProviderWork, prepareJobLedger, startJob, type JobKind, type ProviderTaskRef } from './jobCenter'
import type { ReferenceImage, MediaFile } from '../data/referenceImage'
import {
  TOPAZ_IMAGE_MAX_OUTPUT_SIDE,
  TOPAZ_IMAGE_MODEL,
  TOPAZ_VIDEO_MODEL,
  factorNumber,
  topazFactorsForSource,
  validateTopazSource,
  type UpscaleMediaKind,
} from '../data/upscale.ts'
import {
  KLING_ELEMENT_MAX,
  klingElementProviderName,
  validateKlingElementDrafts,
  type KlingElementDraft,
  type KlingElementFileLike,
  type KlingHostedElement,
} from '../data/klingElements'
import { validateKlingMotionDraft } from '../data/klingMotion'
import { ANGLES_MODELS, MAX_RANDOM_ANGLES, type AngleRequestEntry } from '../data/angles'
import { IDEOGRAM_V3_EDIT_PROMPT_MAX, IMAGE_MODEL_CONFIG } from '../data/imageModelConfig.ts'
import { VIDEO_MODEL_CONFIG } from '../data/videoModelConfig.ts'
import { VIDEO_EDIT_CONFIG } from '../data/videoEditConfig.ts'
import {
  validateAvatarDraft,
  type AvatarOptions,
  type AvatarSubjectLayout,
  type AvatarWorkflow,
} from '../data/avatar.ts'
import {
  assertPromptCharacterLimit,
  happyHorsePromptMax,
  promptCharacterCount,
} from '../data/promptLimits.ts'
import {
  DEFAULT_MULTI_SHOT_RULES,
  validateMultiShotDraft,
} from '../data/videoMultiShot.ts'
import type { DialogueSettings, TtsSettings } from '../data/elevenLabsConfig'
import {
  buildImageRequest,
  buildImageEditRequest,
  buildImageInpaintRequest,
  buildVideoRequest,
  buildAvatarRequest,
  buildAvatarSubjectDetectionRequest,
  buildVideoEditRequest,
  buildVideoUpscaleRequest,
  buildImageUpscaleRequest,
  buildRemoveBgRequest,
  buildTtsRequest,
  buildDialogueRequest,
  buildMusicRequest,
  buildSoundEffectRequest,
  type ImageCtx,
  type VideoCtx,
  type MusicCtx,
  type SoundEffectCtx,
} from '../data/providerModels'

export class NotConnectedError extends Error {
  constructor() {
    super('Connect your EasyField Cloud API key first (tap the credits badge on Home).')
    this.name = 'NotConnectedError'
  }
}
export class NeedsSourceError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'NeedsSourceError'
  }
}
export class UnsupportedInputError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'UnsupportedInputError'
  }
}

export class GenerationContinuesInBackgroundError extends Error {
  constructor() {
    super('Generation continues in Activity and will be saved to Library.')
    this.name = 'GenerationContinuesInBackgroundError'
  }
}

export function isGenerationExit(error: unknown): boolean {
  return error instanceof GenerationContinuesInBackgroundError
    || (error instanceof Error && /cancelled|canceled|aborted/i.test(error.message))
}

export interface RunResult {
  urls: string[]
  credits: number | null
  droppedPlayheads: number // timeline placeholders that couldn't be sent (no DaVinci yet)
  failedJobs: number // fan-out requests that failed while sibling results were recovered
  pendingJobs: number // accepted siblings whose provider tracking can be retried from Activity
}

export function isConnected(): boolean {
  // Credentials are intentionally omitted from persisted settings, so reading
  // localStorage here made every generation screen look disconnected after the
  // secure-storage migration. The session-only runtime value is authoritative.
  return !!currentApiKey()
}

const EXPLICIT_URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const NETWORK_PATH_REFERENCE = /^[\\/]{2}/

export function validatedDownloadUrl(rawUrl: string, baseUrl: string): string {
  const candidate = rawUrl.trim()
  if (!candidate) {
    throw new Error('Unsafe download URL: only blob:, https:, and same-origin relative URLs are allowed.')
  }

  let parsed: URL
  try {
    parsed = new URL(candidate, baseUrl)
  } catch {
    throw new Error('Unsafe download URL: only blob:, https:, and same-origin relative URLs are allowed.')
  }

  if (parsed.protocol === 'blob:' || parsed.protocol === 'https:') return parsed.href

  // Managed Library artifacts use a relative /artifacts/... URL served by the
  // authenticated loopback origin. Permit only genuinely relative references
  // that stay on that origin; absolute http:, protocol-relative, file:, data:
  // and javascript: inputs must never reach the anchor URL sink.
  if (!EXPLICIT_URL_SCHEME.test(candidate) && !NETWORK_PATH_REFERENCE.test(candidate)) {
    let base: URL
    try {
      base = new URL(baseUrl)
    } catch {
      throw new Error('Unsafe download URL: only blob:, https:, and same-origin relative URLs are allowed.')
    }
    if (
      (base.protocol === 'http:' || base.protocol === 'https:')
      && parsed.protocol === base.protocol
      && parsed.origin === base.origin
    ) {
      return parsed.href
    }
  }

  throw new Error('Unsafe download URL: only blob:, https:, and same-origin relative URLs are allowed.')
}

// Save a result to disk. Localized (blob) results download directly; remote video
// URLs can't be force-saved cross-origin, so we open them for the user to save.
export function saveUrl(url: string, filename: string): void {
  const safeUrl = validatedDownloadUrl(url, document.baseURI)
  const a = document.createElement('a')
  a.href = safeUrl
  a.download = filename
  a.rel = 'noreferrer'
  if (!safeUrl.startsWith('blob:')) a.target = '_blank'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function requireKey(): string {
  const k = currentApiKey()
  if (!k) throw new NotConnectedError()
  return k
}

type AnyMedia = ReferenceImage | MediaFile
const isUpload = (m: AnyMedia): m is Extract<AnyMedia, { kind: 'upload' }> => m.kind === 'upload'
// An already-hosted https URL (for example, a prior cloud result reused from the Library)
// is passed straight to the model — the provider fetches it server-side, with no re-upload and
// no browser CORS. Only local blob:/data: URLs need uploading.
const isHosted = (u: string) => /^https?:\/\//i.test(u)

const SEEDANCE_MODELS = new Set(['Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini'])

// These two functions intentionally mirror the exact provider prompt wrappers
// in `data/providerModels.ts`. They run on local draft metadata before any source or
// reference is uploaded, so a wrapper that pushes the final prompt over the provider's
// ceiling cannot create a paid job first and fail only afterwards.
function imageEditProviderPrompt(prompt: string, hasSupportingReferences: boolean): string {
  return hasSupportingReferences
    ? [
        'Edit image 1 only; it is the primary image being edited.',
        'Images 2 and later are supporting visual references only. Do not replace image 1 or transfer their composition unless the edit instruction explicitly asks for it.',
        '',
        `Edit instruction: ${prompt}`,
      ].join('\n')
    : prompt
}

function videoEditProviderPrompt(prompt: string, hasSupportingReferences: boolean): string {
  return hasSupportingReferences
    ? [
        'Transform the primary video source. It is the edit target.',
        'All other attached images, videos, and audio are supporting references only; do not replace the primary source unless the edit instruction explicitly asks for it.',
        '',
        `Edit instruction: ${prompt}`,
      ].join('\n')
    : prompt
}

function hasHostedCandidate(items: readonly AnyMedia[]): boolean {
  return items.some(isUpload)
}

// A Storyboard batch runs several `runImage` calls in parallel with the same
// Library-owned blob references. Re-uploading every blob for every scene wastes
// time and provider bandwidth. Blob URLs are immutable identities while alive,
// so coalesce their uploads and briefly reuse the resulting public URL.
//
// The cache never stores the cloud key. While an upload is pending, the key exists
// only inside that request's closure; a success replaces the closure with the
// hosted URL. A sliding 30-minute TTL covers long boards while keeping public
// media URLs short-lived in renderer memory, and the LRU cap bounds retention.
const blobUploadReuse = createUploadReuseCache({
  ttlMs: 30 * 60 * 1000,
  maxReadyEntries: 128,
})

function hostUpload(key: string, item: Extract<AnyMedia, { kind: 'upload' }>, signal?: AbortSignal): Promise<string> {
  if (isHosted(item.url)) return Promise.resolve(item.url)
  const upload = (sharedSignal: AbortSignal) => uploadLimit(() => uploadUrl(key, item.url, item.name, sharedSignal))
  // A data URL can be megabytes long, so never retain it as a Map key. Current
  // Storyboard and Library references use blob URLs and take the reusable path.
  if (!item.url.startsWith('blob:')) return uploadLimit(() => uploadUrl(key, item.url, item.name, signal))
  return blobUploadReuse.getOrUpload(item.url, signal, upload)
}

// Resolve one item → hosted URL, or null if it's a playhead placeholder.
async function hostOne(key: string, item: AnyMedia | null, signal?: AbortSignal): Promise<string | null> {
  if (!item || !isUpload(item)) return null
  return hostUpload(key, item, signal)
}
// Resolve all upload-kind items (bounded concurrency); returns hosted URLs +
// count of skipped playheads.
async function hostAll(key: string, items: AnyMedia[], signal?: AbortSignal): Promise<{ urls: string[]; dropped: number }> {
  const uploads = items.filter(isUpload)
  const urls = await mapLimit(uploads, 4, (item) => hostUpload(key, item, signal))
  return { urls, dropped: items.length - uploads.length }
}

function klingFileSourceUrl(file: KlingElementFileLike): string | null {
  return typeof file.url === 'string' && /^(blob:|data:|https?:)/i.test(file.url) ? file.url : null
}

async function hostKlingFile(
  key: string,
  file: KlingElementFileLike,
  signal?: AbortSignal,
): Promise<string> {
  const sourceUrl = klingFileSourceUrl(file)
  if (sourceUrl) {
    return hostUpload(key, {
      id: file.id ?? `kling-element:${file.name}`,
      kind: 'upload',
      name: file.name,
      url: sourceUrl,
    }, signal)
  }

  // ElementEditor keeps browser Files directly so their bytes survive every
  // re-render without creating long-lived object URLs. Materialize a URL only
  // for the bounded upload and revoke it immediately afterwards.
  if (typeof Blob !== 'undefined' && file instanceof Blob && typeof URL !== 'undefined') {
    const objectUrl = URL.createObjectURL(file)
    try {
      return await uploadLimit(() => uploadUrl(key, objectUrl, file.name, signal))
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
  throw new UnsupportedInputError(`${file.name || 'Kling element media'} is no longer readable. Choose it again before generating.`)
}

/** Host each shared element file once, regardless of how many shots invoke it. */
async function hostKlingElements(
  key: string,
  elements: readonly KlingElementDraft[],
  signal?: AbortSignal,
): Promise<KlingHostedElement[]> {
  const hostedFiles = new Map<KlingElementFileLike, Promise<string>>()
  const hostOnce = (file: KlingElementFileLike): Promise<string> => {
    const current = hostedFiles.get(file)
    if (current) return current
    const pending = hostKlingFile(key, file, signal)
    hostedFiles.set(file, pending)
    return pending
  }

  return mapLimit([...elements], 3, async (element) => {
    if (!element.media) throw new UnsupportedInputError(`${element.name || 'Kling element'} has no visual reference.`)
    const inputUrls = element.media.kind === 'images'
      ? await mapLimit([...element.media.files], 4, hostOnce)
      : [await hostOnce(element.media.file)]
    const audioUrl = element.audio ? await hostOnce(element.audio.file) : undefined
    return {
      id: element.id,
      name: element.name,
      description: element.description,
      providerName: klingElementProviderName(element.id),
      mediaKind: element.media.kind,
      inputUrls,
      ...(audioUrl ? { audioUrl } : {}),
      ...(element.media.kind === 'video'
        ? { startTimeMs: element.media.startTimeMs, endTimeMs: element.media.endTimeMs }
        : {}),
    }
  })
}

// Run a request N times through the global job limiter (image/clip fan-out).
async function fanOut(key: string, req: Parameters<typeof runProviderModel>[1], n: number, opts: PollOptions) {
  const settled = await Promise.allSettled(
    Array.from({ length: Math.max(1, n) }, () => runOne(key, req, opts)),
  )
  if (opts.signal?.aborted) throw new Error('Cancelled')
  const results = settled
    .filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof runProviderModel>>> => item.status === 'fulfilled')
    .map((item) => item.value)
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
  const pending = rejected.filter((item) => isRecoverableProviderTrackingError(item.reason)).length
  const failures = rejected.length - pending
  if (!results.length) {
    const firstFailure = rejected.find((item) => isRecoverableProviderTrackingError(item.reason)) ?? rejected[0]
    throw firstFailure?.reason ?? new Error('Generation failed')
  }
  return { results, failures, pending }
}

// Single job through the global limiter.
const runOne = (key: string, req: Parameters<typeof runProviderModel>[1], opts: PollOptions) => jobLimit(
  () => generationStartLimit(() => runProviderModel(key, req, opts), opts.signal),
  opts.signal,
)

function sumCredits(list: Array<{ creditsConsumed: number | null }>): number | null {
  const nums = list.map((r) => r.creditsConsumed).filter((n): n is number => typeof n === 'number')
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null
}

interface TrackedRun {
  title: string
  subtitle?: string
  kind: JobKind
  autoOpen?: boolean
}

function stateDetail(state: string): { status: 'queued' | 'running'; detail: string } {
  const normalized = state.toLowerCase()
  if (normalized.includes('queue') || normalized.includes('wait')) return { status: 'queued', detail: 'Waiting for a generation slot' }
  if (normalized.includes('success')) return { status: 'running', detail: 'Saving results' }
  return { status: 'running', detail: 'Generating' }
}

// Mirror every long-running cloud request into the persistent, app-level activity
// surface. Screen-level callbacks still receive the exact same events.
async function withTrackedJob<T extends RunResult>(
  meta: TrackedRun,
  opts: PollOptions,
  work: (trackedOpts: PollOptions) => Promise<T>,
): Promise<T> {
  // The preparing record must reach Main/SQLite before a paid provider request
  // is allowed to leave the app.
  await prepareJobLedger()
  const controller = new AbortController()
  let submissionStarted = false
  let submissionPromise: Promise<void> | null = null
  let durabilityFailure = false
  const completedProviderTasks: ProviderTaskRef[] = []
  let detached = false
  let detachForeground!: (error: GenerationContinuesInBackgroundError) => void
  const foregroundExit = new Promise<never>((_resolve, reject) => {
    detachForeground = reject
  })
  const continueInBackground = () => {
    if (detached) return
    detached = true
    detachForeground(new GenerationContinuesInBackgroundError())
  }
  const abortFromCaller = () => {
    // Once the paid POST begins, a browser abort cannot revoke provider work.
    // Detach the screen while the internal signal keeps polling and saving.
    if (submissionStarted) continueInBackground()
    else controller.abort()
  }
  if (opts.signal?.aborted) controller.abort()
  else opts.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const job = startJob({
    ...meta,
    onCancel: () => controller.abort(),
    onBackground: continueInBackground,
  })
  opts.onJobCreated?.(job.id)
  const trackedOpts: PollOptions = {
    ...opts,
    signal: controller.signal,
    onSubmissionStarted: () => {
      submissionStarted = true
      submissionPromise ??= (async () => {
        await job.beginSubmission()
        await opts.onSubmissionStarted?.()
      })()
      return submissionPromise
    },
    onTaskId: async (taskId, family) => {
      await job.acceptTask(taskId, family)
      await opts.onTaskId?.(taskId, family)
    },
    onTaskSettled: async (taskId, family, outcome) => {
      if (outcome === 'failed') {
        await job.settleTask(taskId, family)
      } else if (!completedProviderTasks.some((task) => task.taskId === taskId && task.family === family)) {
        // A successful provider task remains in the durable recovery ledger
        // until its output has been downloaded, checksummed and committed to
        // Library. A crash between provider success and local materialization
        // can therefore resume the already-paid task instead of losing it.
        completedProviderTasks.push({ taskId, family })
      }
      await opts.onTaskSettled?.(taskId, family, outcome)
    },
    onState: (state) => {
      job.update(stateDetail(state))
      opts.onState?.(state)
    },
    onRetry: (attempt, error) => {
      job.update({ status: 'queued', detail: `Connection retry ${attempt}` })
      opts.onRetry?.(attempt, error)
    },
  }

  const finalizeResult = async (result: T, background: boolean): Promise<T> => {
    try {
      const { addCreationsDurably } = await import('../data/creations.ts')
      const current = getJobs().find((item) => item.id === job.id)
      const creations = await addCreationsDurably(result.urls.map((url) => ({
        kind: meta.kind === 'animation' ? 'video' : meta.kind,
        url,
        model: meta.subtitle ?? meta.title,
        prompt: meta.title,
        meta: background ? 'Completed in background · review before timeline placement' : undefined,
        durability: 'link-only',
      })), {
        onSecured: async (securedItems) => {
          const securedUrls = securedItems.map((item) => item.url)
          const securedCount = (getJobs().find((item) => item.id === job.id)?.resultCount ?? 0) + securedUrls.length
          await job.secureResults(securedUrls, securedCount, 'Results secured locally · adding to Library')
        },
      })
      if (creations.length !== result.urls.length) {
        throw new Error('Not every generated result could be committed to Library.')
      }
      const securedUrls = creations.map((creation) => creation.url)
      const securedByProviderUrl = new Map(result.urls.map((url, index) => [url, securedUrls[index]]))
      const secured = { ...result, urls: securedUrls } as T
      const batchItems = (secured as T & { items?: Array<{ urls: string[] }> }).items
      if (Array.isArray(batchItems)) {
        ;(secured as T & { items: Array<{ urls: string[] }> }).items = batchItems.map((item) => ({
          ...item,
          urls: item.urls.map((url) => securedByProviderUrl.get(url) ?? url),
        }))
      }
      const resultCount = (current?.resultCount ?? 0) + secured.urls.length
      if (secured.pendingJobs) {
        await job.savePartialResults(
          secured.urls,
          completedProviderTasks,
          resultCount,
          background
            ? `Saved ${secured.urls.length} result${secured.urls.length === 1 ? '' : 's'} in background · ${secured.pendingJobs} still pending`
            : `Saved ${secured.urls.length} result${secured.urls.length === 1 ? '' : 's'} · ${secured.pendingJobs} still pending`,
        )
      } else {
        await job.commitResults(
          secured.urls,
          resultCount,
          background
            ? secured.failedJobs
              ? `Saved in background · ${secured.failedJobs} request${secured.failedJobs === 1 ? '' : 's'} failed`
              : 'Completed in background · saved to Library'
            : secured.failedJobs
              ? `Completed with ${secured.failedJobs} failed request${secured.failedJobs === 1 ? '' : 's'}`
              : undefined,
        )
      }
      return secured
    } catch (error) {
      durabilityFailure = true
      throw error
    }
  }

  let workPromise: Promise<T> | null = null
  try {
    await job.persisted
    workPromise = work(trackedOpts)
    const result = await Promise.race([workPromise, foregroundExit])
    if (controller.signal.aborted) throw new Error('Cancelled')
    return await finalizeResult(result, false)
  } catch (error) {
    if (error instanceof GenerationContinuesInBackgroundError && workPromise) {
      const backgroundWork = workPromise
      void backgroundWork.then((result) => finalizeResult(result, true)).catch((backgroundError) => {
        const record = getJobs().find((item) => item.id === job.id)
        if ((isRecoverableProviderTrackingError(backgroundError) || durabilityFailure) && record && hasAcceptedProviderWork(record)) {
          job.pause(backgroundError, durabilityFailure ? 'Saving results paused · retry from Activity' : undefined)
        } else {
          controller.abort()
          job.fail(backgroundError)
        }
      })
      throw error
    }
    const record = getJobs().find((item) => item.id === job.id)
    if ((isRecoverableProviderTrackingError(error) || durabilityFailure) && record && hasAcceptedProviderWork(record)) {
      job.pause(error, durabilityFailure ? 'Saving results paused · retry from Activity' : undefined)
    } else {
      controller.abort()
      job.fail(error)
    }
    throw error
  } finally {
    opts.signal?.removeEventListener('abort', abortFromCaller)
  }
}

// Package provider URLs into a RunResult. `withTrackedJob` owns the durability
// boundary and commits every URL through Electron Main before it can mark the
// paid job successful. Keeping the original URL until that point is important:
// browser blob localization would make video CORS behavior decide whether a
// paid result survives a restart.
async function finish(
  urls: string[],
  credits: number | null,
  droppedPlayheads: number,
  signal?: AbortSignal,
  failedJobs = 0,
  pendingJobs = 0,
): Promise<RunResult> {
  if (signal?.aborted) throw new Error('Cancelled')
  return { urls: urls.slice(), credits, droppedPlayheads, failedJobs, pendingJobs }
}

// ---- Create Image ----------------------------------------------------------
export interface ImageRun {
  jobTitle?: string
  model: string
  prompt: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  refs: ReferenceImage[]
  count: number
}

/** Pure prompt-only validation; safe to call before credentials, jobs or uploads. */
export function preflightImagePrompt(r: Pick<ImageRun, 'model' | 'prompt'>): void {
  const config = IMAGE_MODEL_CONFIG[r.model]
  if (!config) return
  const minimum = r.model === 'Seedream 5 Pro' || r.model === 'Seedream 5 Lite' || r.model === 'Flux 2' ? 3 : 0
  assertPromptCharacterLimit(r.prompt, config.promptMax, `${r.model} prompt`, minimum)
}

export async function runImage(r: ImageRun, opts: PollOptions = {}): Promise<RunResult> {
  preflightImagePrompt(r)
  assertSpendApproved(imageRunEstimate(r.model, r.resolution, r.extras, r.count, { referenceCount: r.refs.length }), 'Image generation', loadSettings().spendLimit)
  return withTrackedJob({ title: r.jobTitle ?? 'Create image', subtitle: r.model, kind: 'image' }, opts, async (trackedOpts) => {
    const key = requireKey()
    const { urls: imageUrls, dropped } = await hostAll(key, r.refs, trackedOpts.signal)
    const ctx: ImageCtx = { prompt: r.prompt, aspect: r.aspect, resolution: r.resolution, extras: r.extras, imageUrls }
    const req = buildImageRequest(r.model, ctx)
    const { results, failures, pending } = await fanOut(key, req, r.count, trackedOpts)
    return finish(results.flatMap((x) => x.urls), sumCredits(results), dropped, trackedOpts.signal, failures, pending)
  })
}

// ---- Create Video ----------------------------------------------------------
export interface VideoRun {
  jobTitle?: string
  workflow?: 'create' | 'extend' | 'transition'
  model: string
  prompt: string
  negativePrompt: string
  aspect: string
  resolution: string
  duration: string
  extras: Record<string, string>
  webSearch: boolean
  firstFrame: ReferenceImage | null
  lastFrame: ReferenceImage | null
  refImages: ReferenceImage[]
  refVideos: MediaFile[]
  refAudios: MediaFile[]
  /** Shared Kling reference elements; each can be invoked by multiple shots. */
  klingElements?: KlingElementDraft[]
  multiShot: boolean
  shots: Array<{ prompt: string; duration: number; referenceTags?: string[] }>
  characterRefs: MediaFile[]
  voices: string[]
  characterIds?: string[]
  audioIds?: string[]
  grokTaskId?: string
  grokIndex?: string
  count: number
}

/** Pure prompt-only validation; final provider prompt budgets are checked pre-upload. */
export function preflightVideoPrompt(r: Pick<VideoRun, 'model' | 'prompt' | 'negativePrompt' | 'multiShot' | 'shots' | 'klingElements'>): void {
  const config = VIDEO_MODEL_CONFIG[r.model]

  if (r.model === 'Kling 3' && config) {
    const elementTags = (r.klingElements ?? []).map((element) => `@${klingElementProviderName(element.id)}`)
    if (r.multiShot) {
      const rules = config.multiShot ?? DEFAULT_MULTI_SHOT_RULES
      const issue = validateMultiShotDraft({
        brief: r.prompt,
        scenes: r.shots.map((shot, index) => ({
          id: `provider-shot-${index + 1}`,
          prompt: shot.prompt,
          duration: String(shot.duration),
          referenceTags: shot.referenceTags,
        })),
        elementTags,
        rules,
      })
      if (issue) throw new Error(issue)
    } else {
      const trimmed = r.prompt.trim()
      const missingTags = elementTags.filter((tag) => !trimmed.includes(tag))
      const finalPrompt = [trimmed, ...missingTags].filter(Boolean).join(' ')
      let weightedLength = promptCharacterCount(finalPrompt)
      elementTags.forEach((tag) => {
        if (finalPrompt.includes(tag)) weightedLength += 37 - promptCharacterCount(tag)
      })
      if (weightedLength > config.promptMax) {
        throw new Error(`Kling 3 prompts are limited to ${config.promptMax.toLocaleString()} weighted characters; every Element tag uses 37.`)
      }
    }
  } else if (config) {
    const maximum = r.model === 'Happy Horse 1.1' ? happyHorsePromptMax(r.prompt) : config.promptMax
    const minimum = SEEDANCE_MODELS.has(r.model) ? 3 : 0
    assertPromptCharacterLimit(r.prompt, maximum, `${r.model} prompt`, minimum)
  }

  if (r.model === 'Wan 2.7 Video') {
    assertPromptCharacterLimit(r.negativePrompt, 500, 'Wan 2.7 negative prompt')
  }
}

export async function runVideo(r: VideoRun, opts: PollOptions = {}): Promise<RunResult> {
  const groupedKlingElements = r.klingElements ?? []
  // Fail before uploads or spend preflight if stale UI state tries to route a
  // shot plan through an adapter that has no multi-shot contract. Extend
  // sequences are frame-led: the rendered end of the Resolve shot is the
  // single provider start frame, and Kling does not accept a last frame in
  // multi-shot mode.
  if (r.multiShot) {
    if (r.model !== 'Kling 3') {
      throw new UnsupportedInputError('Multi-shot generation is currently supported only by Kling 3.')
    }
    if (r.lastFrame) {
      throw new UnsupportedInputError('Kling 3 multi-shot accepts one starting frame only; remove the last frame.')
    }
    if (r.workflow === 'extend' && !r.firstFrame) {
      throw new UnsupportedInputError('Kling 3 Extend multi-shot requires the rendered end frame of the source shot.')
    }
  }
  if (groupedKlingElements.length && r.model !== 'Kling 3') {
    throw new UnsupportedInputError('Shared Kling elements can only be sent to Kling 3.')
  }
  const elementValidation = validateKlingElementDrafts(groupedKlingElements)
  if (!elementValidation.valid) {
    throw new UnsupportedInputError(elementValidation.issues[0]?.message ?? 'Kling element references are invalid.')
  }
  if (r.model === 'Kling 3') {
    if (r.refImages.length || r.refVideos.length || r.refAudios.length) {
      throw new UnsupportedInputError('Kling 3 references must be added as named Elements; remove legacy flat reference media.')
    }
    if (groupedKlingElements.length > KLING_ELEMENT_MAX) {
      throw new UnsupportedInputError(`Kling 3 supports at most ${KLING_ELEMENT_MAX} named Elements.`)
    }
    if (groupedKlingElements.length && !r.firstFrame) {
      throw new UnsupportedInputError('Kling 3 requires a first frame when named Elements are used.')
    }
  }
  if (r.model === 'Kling 3 Motion Control') {
    const motionValidation = validateKlingMotionDraft({
      prompt: r.prompt,
      images: r.refImages,
      videos: r.refVideos,
      orientation: r.extras.characterOrientation === 'Image' ? 'image' : 'video',
    })
    if (!motionValidation.valid) {
      throw new UnsupportedInputError(motionValidation.issues[0]?.message ?? 'Kling 3 Motion Control inputs are invalid.')
    }
  }
  if (r.workflow === 'transition') {
    if (!r.firstFrame || !r.lastFrame) {
      throw new UnsupportedInputError('Transition generation requires both the outgoing end frame and incoming start frame.')
    }
    if (r.refImages.length || r.refVideos.length || r.refAudios.length || groupedKlingElements.length || r.multiShot || r.characterRefs.length || r.voices.length) {
      throw new UnsupportedInputError('Transition generation accepts two ordered endpoint frames only; remove other reference media.')
    }
  }
  preflightVideoPrompt(r)
  assertSpendApproved(
    videoRunEstimate(r.model, r.resolution, r.duration, r.extras, r.count, {
      hasVideoInput: r.refVideos.length > 0 || groupedKlingElements.some((element) => element.media?.kind === 'video'),
      hasImageInput: !!r.firstFrame || !!r.lastFrame || r.refImages.length > 0 || groupedKlingElements.some((element) => element.media?.kind === 'images'),
      referenceMode: (r.refImages.length > 0 || groupedKlingElements.length > 0) && !r.firstFrame && !r.lastFrame,
      inputDurationSeconds: r.model === 'Kling 3 Motion Control' && r.refVideos[0]?.kind === 'upload'
        ? r.refVideos[0].durationSeconds
        : undefined,
    }),
    'Video generation',
    loadSettings().spendLimit,
  )
  return withTrackedJob({ title: r.jobTitle ?? 'Create video', subtitle: r.model, kind: 'video' }, opts, async (trackedOpts) => {
    // Omni video accepts IDs produced by separate cloud character/audio creation
    // endpoints. Treating uploaded images or preset labels as those IDs would make
    // a paid request with silently ignored inputs, so reject that legacy UI shape.
    if (r.model === 'Gemini Omni Video' && (r.characterRefs.length || r.voices.length)) {
      throw new UnsupportedInputError(
        'Google Omni character and voice inputs require saved cloud character/audio IDs; raw references and preset names cannot be sent yet.',
      )
    }
    const key = requireKey()
    const [firstFrameUrl, lastFrameUrl, imgs, vids, auds, hostedKlingElements] = await Promise.all([
      hostOne(key, r.firstFrame, trackedOpts.signal),
      hostOne(key, r.lastFrame, trackedOpts.signal),
      hostAll(key, r.refImages, trackedOpts.signal),
      hostAll(key, r.refVideos, trackedOpts.signal),
      hostAll(key, r.refAudios, trackedOpts.signal),
      hostKlingElements(key, groupedKlingElements, trackedOpts.signal),
    ])
    const dropped =
      imgs.dropped + vids.dropped + auds.dropped + (r.firstFrame && !firstFrameUrl ? 1 : 0) + (r.lastFrame && !lastFrameUrl ? 1 : 0)
    const ctx: VideoCtx = {
      prompt: r.prompt,
      negativePrompt: r.negativePrompt,
      aspect: r.aspect,
      resolution: r.resolution,
      duration: r.duration,
      extras: r.extras,
      firstFrameUrl: firstFrameUrl ?? undefined,
      lastFrameUrl: lastFrameUrl ?? undefined,
      imageUrls: imgs.urls,
      videoUrls: vids.urls,
      audioUrls: auds.urls,
      hostedKlingElements,
      webSearch: r.webSearch,
      multiShot: r.multiShot,
      shots: r.shots,
      characterIds: r.characterIds,
      audioIds: r.audioIds,
      grokTaskId: r.grokTaskId,
      grokIndex: r.grokIndex,
    }
    const req = buildVideoRequest(r.model, ctx)
    const { results, failures, pending } = await fanOut(key, req, r.count, trackedOpts)
    return finish(results.flatMap((x) => x.urls), sumCredits(results), dropped, trackedOpts.signal, failures, pending)
  })
}

// ---- Avatar / deterministic lip sync --------------------------------------
export interface AvatarRun {
  model: string
  workflow: AvatarWorkflow
  prompt: string
  image: ReferenceImage | null
  video: MediaFile | null
  audio: MediaFile | null
  subjectLayout: AvatarSubjectLayout | null
  subjectSourceId?: string
  masks: ReferenceImage[]
  maskSourceIds: string[]
  rightsConfirmed: boolean
  options: Partial<AvatarOptions>
  count: number
}

function requireAvatarUpload(
  item: ReferenceImage | MediaFile | null,
  label: string,
): Extract<ReferenceImage | MediaFile, { kind: 'upload' }> {
  if (!item || item.kind !== 'upload' || !item.url) {
    throw new NeedsSourceError(`${label} must come from Files, Library, or a successful Resolve Grab.`)
  }
  return item
}

/**
 * Detect every selectable speaker in one portrait before Avatar generation.
 * The caller-provided source identity is checked before credentials, durable
 * job creation, upload, or a provider request so a stale selection can never
 * run against a newly replaced portrait.
 */
export async function detectAvatarSubjects(
  image: ReferenceImage,
  sourceId: string,
  opts: PollOptions = {},
): Promise<RunResult> {
  const source = requireAvatarUpload(image, 'Portrait image')
  const expectedSourceId = sourceId.trim()
  if (!expectedSourceId || source.id !== expectedSourceId) {
    throw new UnsupportedInputError('Speaker detection source no longer matches the selected portrait. Detect people again.')
  }
  const key = requireKey()

  return withTrackedJob(
    { title: 'Detect avatar subjects', subtitle: 'OmniHuman 1.5', kind: 'image', autoOpen: false },
    opts,
    async (trackedOpts) => {
      const imageUrl = await hostOne(key, source, trackedOpts.signal)
      if (!imageUrl) throw new NeedsSourceError('Portrait image could not be uploaded for speaker detection.')
      const result = await runOne(key, buildAvatarSubjectDetectionRequest(imageUrl), trackedOpts)
      if (!result.urls.length) throw new UnsupportedInputError('OmniHuman did not detect a selectable subject in this portrait.')
      return finish(result.urls, result.creditsConsumed, 0, trackedOpts.signal)
    },
  )
}

/** Pure preflight: invalid work is rejected before keys, uploads or jobs. */
export function preflightAvatar(r: AvatarRun): void {
  if (!Number.isInteger(r.count) || r.count < 1) {
    throw new UnsupportedInputError('Avatar variations must be a positive whole number.')
  }
  const portrait = r.workflow === 'portrait' ? requireAvatarUpload(r.image, 'Portrait image') : null
  const sourceVideo = r.workflow === 'video-lipsync' ? requireAvatarUpload(r.video, 'Source video') : null
  const voice = requireAvatarUpload(r.audio, 'Voice audio')
  const masks = r.masks.map((mask, index) => requireAvatarUpload(mask, `Subject mask ${index + 1}`))
  const validation = validateAvatarDraft({
    model: r.model,
    rightsConfirmed: r.rightsConfirmed,
    prompt: r.prompt,
    image: portrait,
    video: sourceVideo,
    audio: voice,
    subjectLayout: r.subjectLayout ?? undefined,
    subjectSourceId: r.subjectSourceId,
    masks,
    maskSourceIds: r.maskSourceIds,
    options: r.options,
  })
  if (!validation.valid) {
    throw new UnsupportedInputError(validation.issues[0]?.message ?? 'Avatar inputs are invalid.')
  }
}

export async function runAvatar(r: AvatarRun, opts: PollOptions = {}): Promise<RunResult> {
  preflightAvatar(r)
  const durationSeconds = r.audio?.kind === 'upload' ? r.audio.durationSeconds : undefined
  assertSpendApproved(
    avatarRunEstimate(r.model, r.count, {
      audioDurationSeconds: durationSeconds,
      numFrames: r.options.numFrames,
      framesPerSecond: r.options.framesPerSecond,
      resolution: r.options.resolution ?? r.options.outputResolution,
    }),
    'Avatar generation',
    loadSettings().spendLimit,
  )

  return withTrackedJob(
    { title: r.workflow === 'portrait' ? 'Create avatar' : 'Video lip sync', subtitle: r.model, kind: 'video' },
    opts,
    async (trackedOpts) => {
      const key = requireKey()
      const [imageUrl, videoUrl, audioUrl, hostedMasks] = await Promise.all([
        hostOne(key, r.workflow === 'portrait' ? r.image : null, trackedOpts.signal),
        hostOne(key, r.workflow === 'video-lipsync' ? r.video : null, trackedOpts.signal),
        hostOne(key, r.audio, trackedOpts.signal),
        hostAll(key, r.masks, trackedOpts.signal),
      ])
      if (!audioUrl) throw new NeedsSourceError('Voice audio could not be uploaded.')
      const request = buildAvatarRequest(r.model, {
        prompt: r.workflow === 'video-lipsync' ? '' : r.prompt,
        imageUrl: imageUrl ?? undefined,
        videoUrl: videoUrl ?? undefined,
        audioUrl,
        maskUrls: hostedMasks.urls,
        ...(r.workflow === 'portrait' ? { subjectLayout: r.subjectLayout ?? undefined } : {}),
        options: r.options,
      })
      const { results, failures, pending } = await fanOut(key, request, r.count, trackedOpts)
      return finish(
        results.flatMap((result) => result.urls),
        sumCredits(results),
        hostedMasks.dropped,
        trackedOpts.signal,
        failures,
        pending,
      )
    },
  )
}

// ---- Edit Image ------------------------------------------------------------
export interface ImageEditRun {
  operation: 'custom' | 'inpaint' | 'upscale' | 'removebg'
  source: ReferenceImage | null
  // custom
  model?: string
  prompt?: string
  aspect?: string
  resolution?: string
  extras?: Record<string, string>
  refs?: ReferenceImage[]
  // inpaint
  mask?: ReferenceImage | null
  // upscale
  upscaleModel?: string
  factor?: string
}

/** Validate only prompt-bearing edit operations; utility operations stay untouched. */
export function preflightImageEditPrompt(
  r: Pick<ImageEditRun, 'operation' | 'model' | 'prompt' | 'refs'>,
): void {
  if (r.operation === 'inpaint') {
    assertPromptCharacterLimit(r.prompt ?? '', IDEOGRAM_V3_EDIT_PROMPT_MAX, 'Ideogram V3 Edit prompt', 1)
    return
  }
  if (r.operation !== 'custom') return

  const model = r.model || 'Nano Banana 2'
  const config = IMAGE_MODEL_CONFIG[model]
  if (!config) return
  const finalPrompt = imageEditProviderPrompt(
    r.prompt ?? '',
    hasHostedCandidate(r.refs ?? []),
  )
  const minimum = model === 'Seedream 5 Pro' || model === 'Seedream 5 Lite' || model === 'Flux 2' ? 3 : 0
  assertPromptCharacterLimit(finalPrompt, config.promptMax, `${model} prompt`, minimum)
}

export async function runImageEdit(r: ImageEditRun, opts: PollOptions = {}): Promise<RunResult> {
  preflightImageEditPrompt(r)
  const subtitle = r.operation === 'custom' || r.operation === 'inpaint'
    ? r.model || 'Image edit'
    : r.operation === 'upscale'
      ? r.upscaleModel || 'Upscale'
      : 'Remove background'
  assertSpendApproved(
    imageEditRunEstimate(r.operation, r.model || 'Nano Banana 2', r.resolution || '', r.extras || {}, r.upscaleModel, r.operation === 'custom' ? 1 + (r.refs?.length ?? 0) : 0),
    'Image edit',
    loadSettings().spendLimit,
  )
  return withTrackedJob({ title: 'Edit image', subtitle, kind: 'image' }, opts, async (trackedOpts) => {
    const key = requireKey()
    const sourceUrl = await hostOne(key, r.source, trackedOpts.signal)
    if (!sourceUrl) throw new NeedsSourceError('Upload a source image to edit (timeline capture needs DaVinci).')
    if (r.operation === 'upscale') {
      const res = await runOne(key, buildImageUpscaleRequest(r.upscaleModel || 'Topaz Image Upscale', sourceUrl, r.factor || '2×'), trackedOpts)
      return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
    }
    if (r.operation === 'removebg') {
      const res = await runOne(key, buildRemoveBgRequest(sourceUrl), trackedOpts)
      return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
    }
    if (r.operation === 'inpaint') {
      const maskUrl = await hostOne(key, r.mask ?? null, trackedOpts.signal)
      if (!maskUrl) throw new NeedsSourceError('Paint an inpaint mask before running this edit.')
      const req = buildImageInpaintRequest(r.model || 'Ideogram V3 Edit', {
        prompt: r.prompt || '',
        primarySourceUrl: sourceUrl,
        maskUrl,
      })
      const res = await runOne(key, req, trackedOpts)
      return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
    }
    // custom prompt edit — source + extra refs feed the model's edit variant.
    const refHost = await hostAll(key, r.refs ?? [], trackedOpts.signal)
    const req = buildImageEditRequest(r.model || 'Nano Banana 2', {
      prompt: r.prompt || '',
      primarySourceUrl: sourceUrl,
      referenceUrls: refHost.urls,
      aspect: r.aspect || '',
      resolution: r.resolution || '',
      extras: r.extras || {},
    })
    const res = await runOne(key, req, trackedOpts)
    return finish(res.urls, res.creditsConsumed, refHost.dropped, trackedOpts.signal)
  })
}

// ---- Camera Angles --------------------------------------------------------
export interface AnglesBatchRun {
  source: ReferenceImage | null
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
  entries: AngleRequestEntry[]
}

export interface AnglesBatchItemResult {
  id: string
  label: string
  prompt: string
  urls: string[]
  credits: number | null
  error?: string
  pending?: boolean
}

export interface AnglesBatchResult extends RunResult {
  items: AnglesBatchItemResult[]
}

/**
 * Generate a frozen set of camera viewpoints under one durable Activity job.
 * The primary source is uploaded once and every paid task uses the strict image
 * edit adapter, which keeps that source in provider input slot one.
 */
export async function runAnglesBatch(r: AnglesBatchRun, opts: PollOptions = {}): Promise<AnglesBatchResult> {
  const entries = r.entries.map((entry) => ({ ...entry, prompt: entry.prompt.trim(), label: entry.label.trim() }))
  if (!r.source) throw new NeedsSourceError('Upload or grab a primary source image before generating angles.')
  if (!(ANGLES_MODELS as readonly string[]).includes(r.model)) throw new UnsupportedInputError(`${r.model} is not a verified EasyField Angles model.`)
  if (!entries.length) throw new UnsupportedInputError('Choose at least one camera angle to generate.')
  if (entries.length > MAX_RANDOM_ANGLES) throw new UnsupportedInputError(`Generate up to ${MAX_RANDOM_ANGLES} angles in one reviewed batch.`)
  if (entries.some((entry) => !entry.id || !entry.label || !entry.prompt)) throw new UnsupportedInputError('Every angle needs a label and camera direction.')
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new UnsupportedInputError('Camera angles must be unique within a batch.')

  // Each entry already contains the complete camera-preservation scaffold.
  // Validate all of them before opening the batch job or uploading its shared
  // source, just like the single-image generation path.
  entries.forEach((entry) => preflightImagePrompt({ model: r.model, prompt: entry.prompt }))

  assertSpendApproved(
    imageRunEstimate(r.model, r.resolution, r.extras, entries.length, { referenceCount: 1 }),
    'Camera-angle generation',
    loadSettings().spendLimit,
  )

  return withTrackedJob<AnglesBatchResult>({
    title: 'Generate camera angles',
    subtitle: `${entries.length} angle${entries.length === 1 ? '' : 's'} · ${r.model}`,
    kind: 'image',
  }, opts, async (trackedOpts) => {
    const key = requireKey()
    const sourceUrl = await hostOne(key, r.source, trackedOpts.signal)
    if (!sourceUrl) throw new NeedsSourceError('The primary source image could not be uploaded.')
    const requests = entries.map((entry) => buildImageEditRequest(r.model, {
      prompt: entry.prompt,
      primarySourceUrl: sourceUrl,
      referenceUrls: [],
      aspect: r.aspect,
      resolution: r.resolution,
      extras: r.extras,
    }))
    const settled = await Promise.allSettled(requests.map((request) => runOne(key, request, trackedOpts)))
    if (trackedOpts.signal?.aborted) throw new Error('Cancelled')
    const pendingJobs = settled.filter((item) => item.status === 'rejected' && isRecoverableProviderTrackingError(item.reason)).length
    const failedJobs = settled.filter((item) => item.status === 'rejected' && !isRecoverableProviderTrackingError(item.reason)).length
    const successful = settled.flatMap((item, index) => item.status === 'fulfilled' ? [{ entry: entries[index], result: item.value }] : [])
    if (!successful.length) {
      const firstRejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
      throw firstRejected?.reason ?? new Error('Camera-angle generation failed.')
    }

    const localizedUrls = successful.flatMap(({ result }) => result.urls)
    let offset = 0
    const completedById = new Map<string, AnglesBatchItemResult>()
    successful.forEach(({ entry, result }) => {
      const urls = localizedUrls.slice(offset, offset + result.urls.length)
      offset += result.urls.length
      completedById.set(entry.id, { ...entry, urls, credits: result.creditsConsumed })
    })
    const items = entries.map((entry, index): AnglesBatchItemResult => {
      const completed = completedById.get(entry.id)
      if (completed) return completed
      const rejected = settled[index] as PromiseRejectedResult
      return {
        ...entry,
        urls: [],
        credits: null,
        error: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason ?? 'Generation failed'),
        pending: isRecoverableProviderTrackingError(rejected.reason),
      }
    })
    return {
      items,
      urls: localizedUrls,
      credits: sumCredits(successful.map(({ result }) => result)),
      droppedPlayheads: 0,
      failedJobs,
      pendingJobs,
    }
  })
}

// ---- Edit Video ------------------------------------------------------------
export interface VideoEditRun {
  operation: 'custom' | 'upscale'
  model: string // active model (or upscale model)
  source: MediaFile | null
  prompt: string
  params: Record<string, string>
  refImages: ReferenceImage[]
  refVideos: MediaFile[]
  refAudios: MediaFile[]
  factor: string
}

/** Pure validation of the exact prompt envelope sent by video-edit adapters. */
export function preflightVideoEditPrompt(
  r: Pick<VideoEditRun, 'operation' | 'model' | 'prompt' | 'refImages' | 'refVideos' | 'refAudios'>,
): void {
  if (r.operation !== 'custom') return
  const config = VIDEO_EDIT_CONFIG[r.model]
  if (!config) return
  const hasSupportingReferences = hasHostedCandidate([
    ...r.refImages,
    ...r.refVideos,
    ...r.refAudios,
  ])
  const finalPrompt = videoEditProviderPrompt(r.prompt, hasSupportingReferences)
  const maximum = r.model === 'HappyHorse Video Edit'
    ? happyHorsePromptMax(finalPrompt)
    : config.promptMax
  const minimum = SEEDANCE_MODELS.has(r.model) ? 3 : 0
  assertPromptCharacterLimit(finalPrompt, maximum, `${r.model} prompt`, minimum)
}

function validateVideoEditAudio(model: string, refs: MediaFile[]): void {
  if (!refs.length) return
  if (model !== 'Seedance 2' && model !== 'Seedance 2 Fast' && model !== 'Seedance 2 Mini') {
    throw new UnsupportedInputError(`${model} does not accept uploaded reference audio through EasyField Cloud.`)
  }
  if (refs.length > 3) throw new UnsupportedInputError('Seedance accepts at most 3 reference audio files.')
  let totalDuration = 0
  refs.forEach((ref) => {
    if (ref.kind !== 'upload') throw new UnsupportedInputError('Upload Seedance reference audio as a WAV or MP3 file.')
    if (!/\.(wav|mp3)$/i.test(ref.name)) throw new UnsupportedInputError('Seedance reference audio must be WAV or MP3.')
    if (typeof ref.byteSize === 'number' && ref.byteSize > 15 * 1024 * 1024) {
      throw new UnsupportedInputError('Each Seedance reference audio file must be 15 MB or smaller.')
    }
    if (typeof ref.durationSeconds !== 'number' || !Number.isFinite(ref.durationSeconds)) {
      throw new UnsupportedInputError('Re-add reference audio so EasyField can verify its duration before generation.')
    }
    if (ref.durationSeconds < 2 || ref.durationSeconds > 15) {
      throw new UnsupportedInputError('Each Seedance reference audio file must be between 2 and 15 seconds.')
    }
    totalDuration += ref.durationSeconds
  })
  if (totalDuration > 15) throw new UnsupportedInputError('Seedance reference audio can be at most 15 seconds in total.')
}

export async function runVideoEdit(r: VideoEditRun, opts: PollOptions = {}): Promise<RunResult> {
  preflightVideoEditPrompt(r)
  assertSpendApproved(videoEditRunEstimate(r.operation, r.model, r.params, r.factor), 'Video edit', loadSettings().spendLimit)
  validateVideoEditAudio(r.model, r.refAudios)
  return withTrackedJob({ title: 'Edit video', subtitle: r.model, kind: 'video' }, opts, async (trackedOpts) => {
    const key = requireKey()
    const sourceUrl = await hostOne(key, r.source, trackedOpts.signal)
    if (!sourceUrl) throw new NeedsSourceError('Upload a source clip to edit (timeline capture needs DaVinci).')
    if (r.operation === 'upscale') {
      const res = await runOne(key, buildVideoUpscaleRequest(sourceUrl, r.factor || '2×'), trackedOpts)
      return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
    }
    const [imgs, vids, audios] = await Promise.all([
      hostAll(key, r.refImages, trackedOpts.signal),
      hostAll(key, r.refVideos, trackedOpts.signal),
      hostAll(key, r.refAudios, trackedOpts.signal),
    ])
    const req = buildVideoEditRequest(r.model, {
      prompt: r.prompt,
      sourceUrl,
      refImageUrls: imgs.urls,
      refVideoUrls: vids.urls,
      refAudioUrls: audios.urls,
      params: r.params,
      factor: r.factor,
    })
    const res = await runOne(key, req, trackedOpts)
    return finish(res.urls, res.creditsConsumed, imgs.dropped + vids.dropped + audios.dropped, trackedOpts.signal)
  })
}

// ---- Upscale ---------------------------------------------------------------
export interface UpscaleRun {
  kind: UpscaleMediaKind
  source: ReferenceImage | MediaFile | null
  factor: string
  width?: number
  height?: number
  durationSeconds?: number
}

type UpscaleUploadSource = Extract<ReferenceImage | MediaFile, { kind: 'upload' }>

function validateUpscaleRun(r: UpscaleRun): UpscaleUploadSource {
  const source = r.source?.kind === 'upload' ? r.source : null
  if (!source) throw new NeedsSourceError(`Add a source ${r.kind} before running Topaz.`)
  if (typeof source.byteSize === 'number') {
    validateTopazSource({ name: source.name, type: source.mimeType, size: source.byteSize }, r.kind)
  }
  const allowedFactors = topazFactorsForSource(r.kind, r.width, r.height)
  if (!allowedFactors.includes(r.factor)) {
    throw new UnsupportedInputError(`${r.factor || 'The selected factor'} is not available for this Topaz ${r.kind} source.`)
  }
  if (r.kind === 'image') {
    const longest = Math.max(Number(r.width) || 0, Number(r.height) || 0)
    if (longest && longest * factorNumber(r.factor) > TOPAZ_IMAGE_MAX_OUTPUT_SIDE) {
      throw new UnsupportedInputError('The selected factor would exceed Topaz’s 20,000 px output-side limit.')
    }
  }
  return source
}

export async function runUpscale(r: UpscaleRun, opts: PollOptions = {}): Promise<RunResult> {
  const model = r.kind === 'image' ? TOPAZ_IMAGE_MODEL : TOPAZ_VIDEO_MODEL
  const source = validateUpscaleRun(r)

  assertSpendApproved(
    upscaleRunEstimate(r.kind, r.factor, { width: r.width, height: r.height, durationSeconds: r.durationSeconds }),
    'Upscale',
    loadSettings().spendLimit,
  )
  return withTrackedJob({ title: `Upscale ${r.kind}`, subtitle: `${source.name} · ${model}`, kind: r.kind }, opts, async (trackedOpts) => {
    const key = requireKey()
    const sourceUrl = await hostOne(key, source, trackedOpts.signal)
    if (!sourceUrl) throw new NeedsSourceError(`Upload a source ${r.kind} before running Topaz.`)
    const result = r.kind === 'image'
      ? await runOne(key, buildImageUpscaleRequest(TOPAZ_IMAGE_MODEL, sourceUrl, r.factor), trackedOpts)
      : await runOne(key, buildVideoUpscaleRequest(sourceUrl, r.factor), trackedOpts)
    return finish(result.urls, result.creditsConsumed, 0, trackedOpts.signal)
  })
}

export interface UpscaleBatchEntry extends UpscaleRun {
  id: string
  sourceName: string
}

export interface UpscaleBatchItemResult {
  id: string
  kind: UpscaleMediaKind
  sourceName: string
  factor: string
  model: string
  urls: string[]
  credits: number | null
  error?: string
  pending?: boolean
}

export interface UpscaleBatchResult extends RunResult {
  items: UpscaleBatchItemResult[]
}

export interface UpscaleBatchOptions extends PollOptions {
  onItemCompleted?: (item: UpscaleBatchItemResult) => void | Promise<void>
  onItemJobCreated?: (itemId: string, jobId: string) => void
}

/**
 * EasyField batch fan-out for Topaz. The provider accepts one scalar source URL per
 * task, so every entry remains its own durable job and paid provider request.
 * This preserves the correct media kind during restart recovery and lets the
 * UI cancel unsubmitted siblings while accepted tasks continue in Activity.
 */
export async function runUpscaleBatch(
  entriesInput: readonly UpscaleBatchEntry[],
  opts: UpscaleBatchOptions = {},
): Promise<UpscaleBatchResult> {
  const entries = entriesInput.map((entry) => ({ ...entry }))
  if (!entries.length) throw new NeedsSourceError('Add at least one image or video to the Upscale batch.')
  if (entries.some((entry) => !entry.id || !entry.sourceName.trim())) {
    throw new UnsupportedInputError('Every Upscale batch item needs a stable source identity.')
  }
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new UnsupportedInputError('Upscale batch item identities must be unique.')
  }

  // Freeze and validate the entire reviewed batch before the first paid task.
  entries.forEach(validateUpscaleRun)
  assertSpendApproved(
    upscaleBatchEstimate(entries.map((entry) => ({
      kind: entry.kind,
      factor: entry.factor,
      width: entry.width,
      height: entry.height,
      durationSeconds: entry.durationSeconds,
    }))),
    'Upscale batch',
    loadSettings().spendLimit,
  )

  const { onItemCompleted, onItemJobCreated, ...pollOpts } = opts
  const settled = await Promise.allSettled(entries.map(async (entry): Promise<UpscaleBatchItemResult> => {
    const result = await runUpscale(entry, {
      ...pollOpts,
      onJobCreated: (jobId) => {
        pollOpts.onJobCreated?.(jobId)
        onItemJobCreated?.(entry.id, jobId)
      },
    })
    const item: UpscaleBatchItemResult = {
      id: entry.id,
      kind: entry.kind,
      sourceName: entry.sourceName,
      factor: entry.factor,
      model: entry.kind === 'image' ? TOPAZ_IMAGE_MODEL : TOPAZ_VIDEO_MODEL,
      urls: result.urls,
      credits: result.credits,
    }
    try {
      await onItemCompleted?.(item)
    } catch {
      // A renderer notification failure must never reclassify paid provider
      // work that has already completed and is durable in Job Center.
    }
    return item
  }))

  const successful = settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : [])
  const rejected = settled.flatMap((item, index) => item.status === 'rejected' ? [{ entry: entries[index], reason: item.reason }] : [])
  const completedById = new Map(successful.map((item) => [item.id, item]))
  const rejectedById = new Map(rejected.map((item) => [item.entry.id, item.reason]))
  const items = entries.map((entry): UpscaleBatchItemResult => {
    const completed = completedById.get(entry.id)
    if (completed) return completed
    const reason = rejectedById.get(entry.id)
    return {
      id: entry.id,
      kind: entry.kind,
      sourceName: entry.sourceName,
      factor: entry.factor,
      model: entry.kind === 'image' ? TOPAZ_IMAGE_MODEL : TOPAZ_VIDEO_MODEL,
      urls: [],
      credits: null,
      error: reason instanceof Error ? reason.message : String(reason ?? 'Upscale failed'),
      pending: isRecoverableProviderTrackingError(reason),
    }
  })
  const countedFailures = rejected.filter((item) => !isRecoverableProviderTrackingError(item.reason) && !isGenerationExit(item.reason)).length
  const pendingJobs = rejected.filter((item) => isRecoverableProviderTrackingError(item.reason)).length
  return {
    items,
    urls: successful.flatMap((item) => item.urls),
    credits: sumCredits(successful.map((item) => ({ creditsConsumed: item.credits }))),
    droppedPlayheads: 0,
    failedJobs: countedFailures,
    pendingJobs,
  }
}

// ---- Voice Over ------------------------------------------------------------
export async function runTts(
  modelId: string,
  voice: string,
  text: string,
  settings: TtsSettings,
  opts: PollOptions & { autoOpenJob?: boolean } = {},
): Promise<RunResult> {
  assertSpendApproved(ttsRunEstimate(modelId, text.length), 'Voice generation', loadSettings().spendLimit)
  return withTrackedJob({ title: 'Create voice-over', subtitle: voice, kind: 'audio', autoOpen: opts.autoOpenJob !== false }, opts, async (trackedOpts) => {
    const key = requireKey()
    const res = await runOne(key, buildTtsRequest(modelId, voice, text, settings), trackedOpts)
    return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
  })
}

export async function runDialogue(
  lines: Array<{ voice: string; text: string }>,
  settings: DialogueSettings,
  opts: PollOptions = {},
): Promise<RunResult> {
  assertSpendApproved(
    ttsRunEstimate('text-to-dialogue-v3', lines.reduce((sum, line) => sum + line.text.length, 0)),
    'Dialogue generation',
    loadSettings().spendLimit,
  )
  return withTrackedJob({ title: 'Create dialogue', subtitle: `${lines.length} lines`, kind: 'audio' }, opts, async (trackedOpts) => {
    const key = requireKey()
    const res = await runOne(key, buildDialogueRequest(lines, settings), trackedOpts)
    return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
  })
}

// ---- Create Music ----------------------------------------------------------
export async function runMusic(m: MusicCtx, opts: PollOptions = {}): Promise<RunResult> {
  assertSpendApproved(musicRunEstimate(m.version || ''), 'Music generation', loadSettings().spendLimit)
  return withTrackedJob({ title: 'Create music', subtitle: m.mode || 'Music', kind: 'audio' }, opts, async (trackedOpts) => {
    const key = requireKey()
    const res = await runOne(key, buildMusicRequest(m), trackedOpts)
    return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
  })
}

// ---- Sound Effects --------------------------------------------------------
export async function runSoundEffect(sound: SoundEffectCtx, opts: PollOptions = {}): Promise<RunResult> {
  assertSpendApproved(soundEffectsRunEstimate(), 'Sound-effect generation', loadSettings().spendLimit)
  return withTrackedJob({ title: 'Create sound effect', subtitle: `Suno ${sound.model === 'V5_5' ? 'v5.5' : 'v5'}`, kind: 'audio' }, opts, async (trackedOpts) => {
    const key = requireKey()
    const res = await runOne(key, buildSoundEffectRequest(sound), trackedOpts)
    return finish(res.urls, res.creditsConsumed, 0, trackedOpts.signal)
  })
}

export interface SoundEffectBatchEntry {
  id: string
  title: string
  sound: SoundEffectCtx
}

export interface SoundEffectBatchItemResult {
  id: string
  title: string
  urls: string[]
  credits: number | null
  error?: string
  pending?: boolean
}

export interface SoundEffectBatchResult extends RunResult {
  items: SoundEffectBatchItemResult[]
}

/**
 * Auto Foley fan-out under one durable Activity record. Every provider task ID
 * is attached to the same job ledger, while results retain their event ID so a
 * partial success can be reviewed and placed without resubmitting paid work.
 */
export async function runSoundEffectBatch(entries: SoundEffectBatchEntry[], opts: PollOptions = {}): Promise<SoundEffectBatchResult> {
  if (!entries.length) throw new Error('Approve at least one Foley event before generating.')
  assertSpendApproved(soundEffectsRunEstimate(entries.length), 'Auto Foley generation', loadSettings().spendLimit)
  return withTrackedJob<SoundEffectBatchResult>({
    title: 'Generate Auto Foley',
    subtitle: `${entries.length} approved event${entries.length === 1 ? '' : 's'}`,
    kind: 'audio',
  }, opts, async (trackedOpts) => {
    const key = requireKey()
    const settled = await Promise.allSettled(entries.map((entry) => runOne(key, buildSoundEffectRequest(entry.sound), trackedOpts)))
    if (trackedOpts.signal?.aborted) throw new Error('Cancelled')
    const pendingJobs = settled.filter((item) => item.status === 'rejected' && isRecoverableProviderTrackingError(item.reason)).length
    const failedJobs = settled.filter((item) => item.status === 'rejected' && !isRecoverableProviderTrackingError(item.reason)).length
    const successful = settled.flatMap((item, index) => item.status === 'fulfilled' ? [{ entry: entries[index], result: item.value }] : [])
    if (!successful.length) {
      const firstRejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
      throw firstRejected?.reason ?? new Error('Auto Foley generation failed.')
    }

    const flatLocalUrls = successful.flatMap(({ result }) => result.urls)
    let urlOffset = 0
    const successfulById = new Map<string, SoundEffectBatchItemResult>()
    successful.forEach(({ entry, result }) => {
      const urls = flatLocalUrls.slice(urlOffset, urlOffset + result.urls.length)
      urlOffset += result.urls.length
      successfulById.set(entry.id, { id: entry.id, title: entry.title, urls, credits: result.creditsConsumed })
    })
    const items = entries.map((entry, index): SoundEffectBatchItemResult => {
      const completed = successfulById.get(entry.id)
      if (completed) return completed
      const rejected = settled[index] as PromiseRejectedResult
      return {
        id: entry.id,
        title: entry.title,
        urls: [],
        credits: null,
        error: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason ?? 'Generation failed'),
        pending: isRecoverableProviderTrackingError(rejected.reason),
      }
    })
    return {
      items,
      urls: flatLocalUrls,
      credits: sumCredits(successful.map(({ result }) => result)),
      droppedPlayheads: 0,
      failedJobs,
      pendingJobs,
    }
  })
}
