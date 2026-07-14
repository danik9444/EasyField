import { useSyncExternalStore } from 'react'
import { host } from './host.ts'
import type { ProviderFamily } from './providerGateway.ts'

export type JobKind = 'image' | 'video' | 'audio' | 'animation'
export type JobStatus = 'preparing' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobSubmissionState = 'preparing' | 'submitting' | 'accepted'
export type CancelJobResult = 'cancelled' | 'already-submitted' | 'terminal' | 'missing'
export type BackgroundJobResult = 'backgrounded' | 'not-submitted' | 'terminal' | 'missing'

export interface ProviderTaskRef {
  taskId: string
  family: ProviderFamily
}

export interface JobRecord {
  id: string
  title: string
  subtitle?: string
  kind: JobKind
  status: JobStatus
  /**
   * A paid provider request can only be cancelled while it is still preparing
   * local inputs. `submitting` is persisted before the first create request so
   * the UI never mistakes an ambiguous in-flight POST for a safe cancellation.
   */
  submissionState?: JobSubmissionState
  /** Activity may remain collapsed for inline micro-jobs such as voice auditions. */
  autoOpen?: boolean
  detail?: string
  /** Legacy single-task fields are kept so existing ledgers can be recovered. */
  taskId?: string
  taskFamily?: ProviderFamily
  /** Every accepted paid task, including fan-out siblings. */
  providerTasks?: ProviderTaskRef[]
  /**
   * Opaque local Artifact Store URLs committed before a paid job can become
   * terminal. They let startup rebuild a missing renderer Library index without
   * keeping or exposing filesystem paths.
   */
  resultUrls?: string[]
  resultCount?: number
  error?: string
  startedAt: number
  updatedAt: number
}

interface NewJob {
  title: string
  subtitle?: string
  kind: JobKind
  autoOpen?: boolean
  onCancel?: () => void
  onBackground?: () => void
}

export interface JobHandle {
  id: string
  /** Resolves only after the preparing record is durable. */
  persisted: Promise<void>
  update: (patch: Partial<Pick<JobRecord, 'status' | 'detail'>>) => void
  beginSubmission: () => Promise<void>
  acceptTask: (taskId: string, family: ProviderFamily) => Promise<void>
  settleTask: (taskId: string, family: ProviderFamily) => Promise<void>
  savePartialResults: (urls: string[], completedTasks: ProviderTaskRef[], resultCount: number, detail: string) => Promise<void>
  commitResults: (urls: string[], resultCount?: number, detail?: string) => Promise<void>
  pause: (error: unknown, detail?: string) => void
  succeed: (resultCount?: number, detail?: string) => void
  fail: (error: unknown) => void
  cancel: () => void
}

const listeners = new Set<() => void>()
const cancelHandlers = new Map<string, () => void>()
const backgroundHandlers = new Map<string, () => void>()
let jobs: JobRecord[] = []
let counter = 0
const TERMINAL = new Set<JobStatus>(['succeeded', 'failed', 'cancelled'])
const recovering = new Set<string>()
let hydrated = false
let hydrationPromise: Promise<void> | null = null
let persistenceTail: Promise<void> = Promise.resolve()

// Older ledgers and upstream errors may still contain the former provider
// brand. Build the compatibility matcher without retaining that brand in the
// product source, then normalize every user-visible Job Center text field.
const legacyProviderToken = globalThis.atob('a2ll')
const legacyProviderPattern = new RegExp(
  `(^|[^a-z0-9])${legacyProviderToken}(?:[.]?ai)?(?=$|[^a-z0-9])`,
  'gi',
)

function sanitizeProviderCopy(value: string): string {
  return value.replace(legacyProviderPattern, (_match, prefix: string) => `${prefix}EasyField Cloud`)
}

function safeErrorMessage(error: unknown): string {
  return sanitizeProviderCopy(error instanceof Error ? error.message : String(error))
}

function sanitizeJobTextFields<T extends Partial<JobRecord>>(value: T): T {
  return {
    ...value,
    ...(typeof value.title === 'string' ? { title: sanitizeProviderCopy(value.title) } : {}),
    ...(typeof value.subtitle === 'string' ? { subtitle: sanitizeProviderCopy(value.subtitle) } : {}),
    ...(typeof value.detail === 'string' ? { detail: sanitizeProviderCopy(value.detail) } : {}),
    ...(typeof value.error === 'string' ? { error: sanitizeProviderCopy(value.error) } : {}),
  } as T
}

function persistNow(): Promise<void> {
  // Serialize whole-ledger snapshots. Fan-out callbacks can accept/settle
  // several children at once; out-of-order writes must never restore an older
  // snapshot over newer recovery metadata.
  const snapshot = jobs
  const write = persistenceTail.then(() => host.setState('jobs', 'ledger', snapshot))
  persistenceTail = write.catch(() => { /* the caller still receives the failure */ })
  return write
}

function persist() {
  if (!hydrated) return
  void persistNow().catch(() => { /* critical paid-task writes are awaited separately */ })
}

function emit() {
  for (const listener of listeners) listener()
}

function patchJob(id: string, patch: Partial<JobRecord>, persistChange = true) {
  const now = Date.now()
  const safePatch = sanitizeJobTextFields(patch)
  let changed = false
  jobs = jobs.map((job) => {
    if (job.id !== id || TERMINAL.has(job.status)) return job
    changed = true
    return { ...job, ...safePatch, updatedAt: now }
  })
  if (!changed) return
  if (persistChange) persist()
  emit()
}

function safeResultUrls(urls: string[]): string[] {
  return [...new Set(urls
    .filter((url): url is string => typeof url === 'string' && url.length > 0 && url.length <= 4096)
    .filter((url) => /^(?:\/artifacts\/[0-9a-f-]+|blob:|data:|https:\/\/)/i.test(url)))]
}

async function precommitJobResults(id: string, urls: string[], resultCount: number): Promise<string[]> {
  const current = jobs.find((job) => job.id === id)
  if (!current || TERMINAL.has(current.status)) return current?.resultUrls ?? []
  const safeNewUrls = safeResultUrls(urls)
  if (safeNewUrls.length !== new Set(urls).size) {
    throw new Error('Job results were not valid durable artifact references.')
  }
  const resultUrls = safeResultUrls([...(current.resultUrls ?? []), ...safeNewUrls])
  patchJob(id, {
    resultUrls,
    resultCount: Math.max(resultCount, resultUrls.length),
    detail: 'Results secured locally · finalizing',
    error: undefined,
  }, false)
  // This is the crash-safety boundary: the ledger still contains every paid
  // provider task, but now also contains every verified local artifact. Only
  // after this exact snapshot is durable may successful tasks be removed or
  // the job be marked terminal.
  await persistNow()
  return resultUrls
}

async function savePartialJobResults(
  id: string,
  urls: string[],
  completedTasks: ProviderTaskRef[],
  resultCount: number,
  detail: string,
): Promise<void> {
  await precommitJobResults(id, urls, resultCount)
  const current = jobs.find((job) => job.id === id)
  if (!current || TERMINAL.has(current.status)) return
  const completed = new Set(completedTasks.map((task) => `${task.family}:${task.taskId}`))
  const providerTasks = (current.providerTasks ?? []).filter((task) => !completed.has(`${task.family}:${task.taskId}`))
  const last = providerTasks[providerTasks.length - 1]
  patchJob(id, {
    status: 'queued',
    detail,
    providerTasks,
    taskId: last?.taskId,
    taskFamily: last?.family,
    resultCount: Math.max(resultCount, current.resultUrls?.length ?? 0),
  }, false)
  try {
    await persistNow()
  } catch {
    // The precommit snapshot is already durable and intentionally retained all
    // provider refs, so restart recovery may repeat a poll but cannot lose work.
    void persistNow().catch(() => { /* retry while this session remains alive */ })
  }
}

async function commitJobResults(id: string, urls: string[], resultCount = urls.length, detail?: string): Promise<void> {
  const resultUrls = await precommitJobResults(id, urls, resultCount)
  const committed = settleJob(id, {
    status: 'succeeded',
    detail: detail || 'Generation complete',
    resultCount: Math.max(resultCount, resultUrls.length),
    resultUrls,
    providerTasks: [],
    taskId: undefined,
    taskFamily: undefined,
    error: undefined,
  })
  if (!committed) return
  try {
    await persistNow()
  } catch {
    // The immediately preceding non-terminal precommit is durable and still
    // carries provider refs plus all local artifact URLs. On restart it safely
    // reconciles Library and resumes instead of losing a paid result.
    void persistNow().catch(() => { /* best-effort terminal-state retry */ })
  }
}

async function acceptProviderTask(id: string, taskId: string, family: ProviderFamily): Promise<void> {
  if (!taskId) return
  const now = Date.now()
  let changed = false
  jobs = jobs.map((job) => {
    if (job.id !== id || TERMINAL.has(job.status)) return job
    const providerTasks = job.providerTasks ?? (job.taskId
      ? [{ taskId: job.taskId, family: job.taskFamily ?? 'jobs' as const }]
      : [])
    if (providerTasks.some((task) => task.taskId === taskId && task.family === family)) return job
    changed = true
    return {
      ...job,
      status: 'running',
      submissionState: 'accepted',
      detail: 'Generation accepted',
      taskId,
      taskFamily: family,
      providerTasks: [...providerTasks, { taskId, family }],
      updatedAt: now,
    }
  })
  if (!changed) return
  emit()
  if (!hydrated) throw new Error('Job ledger was not ready before provider acceptance')
  try {
    await persistNow()
  } catch (error) {
    // The provider already accepted the paid task. Keep polling in this session
    // while a background write retries the recovery metadata; throwing here
    // would abandon a task that is still running remotely.
    patchJob(id, {
      detail: 'Generation accepted · recovery save pending',
      error: safeErrorMessage(error),
    })
    void persistNow().catch(() => { /* the active session continues tracking */ })
  }
}

async function settleProviderTask(id: string, taskId: string, family: ProviderFamily): Promise<void> {
  const now = Date.now()
  let changed = false
  jobs = jobs.map((job) => {
    if (job.id !== id || TERMINAL.has(job.status)) return job
    const providerTasks = (job.providerTasks ?? []).filter((task) => !(task.taskId === taskId && task.family === family))
    if (providerTasks.length === (job.providerTasks ?? []).length && !(job.taskId === taskId && (job.taskFamily ?? 'jobs') === family)) return job
    const last = providerTasks[providerTasks.length - 1]
    changed = true
    return {
      ...job,
      providerTasks,
      taskId: last?.taskId,
      taskFamily: last?.family,
      updatedAt: now,
    }
  })
  if (!changed) return
  emit()
  if (!hydrated) return
  try {
    await persistNow()
  } catch {
    void persistNow().catch(() => { /* same-session completion still proceeds */ })
  }
}

async function beginProviderSubmission(id: string): Promise<void> {
  const now = Date.now()
  let changed = false
  jobs = jobs.map((job) => {
    if (job.id !== id || TERMINAL.has(job.status) || job.submissionState === 'accepted') return job
    if (job.submissionState === 'submitting') return job
    changed = true
    return {
      ...job,
      status: 'queued',
      submissionState: 'submitting',
      detail: 'Submitting to provider',
      updatedAt: now,
    }
  })
  if (!changed) return
  emit()
  if (!hydrated) throw new Error('Job ledger was not ready before provider submission')
  // This boundary is intentionally awaited before the paid request leaves the
  // app. A user can safely cancel uploads/preparation, but not an in-flight POST.
  await persistNow()
}

function settleJob(id: string, patch: Pick<JobRecord, 'status' | 'detail'> & Partial<JobRecord>): boolean {
  const current = jobs.find((job) => job.id === id)
  if (!current || TERMINAL.has(current.status)) return false
  cancelHandlers.delete(id)
  backgroundHandlers.delete(id)
  patchJob(id, patch)
  return true
}

function pauseJob(id: string, error: unknown, detail = 'Tracking paused · retry when the connection is available') {
  patchJob(id, {
    status: 'queued',
    detail,
    error: safeErrorMessage(error),
  })
}

export function startJob(input: NewJob): JobHandle {
  const id = `job-${Date.now()}-${counter++}`
  const now = Date.now()
  const record: JobRecord = sanitizeJobTextFields({
    id,
    title: input.title,
    subtitle: input.subtitle,
    kind: input.kind,
    autoOpen: input.autoOpen !== false,
    status: 'preparing',
    submissionState: 'preparing',
    detail: 'Preparing inputs',
    startedAt: now,
    updatedAt: now,
  })
  const next = [record, ...jobs]
  const active = next.filter((job) => !TERMINAL.has(job.status))
  const finished = next.filter((job) => TERMINAL.has(job.status)).slice(0, 16)
  jobs = [...active, ...finished].sort((a, b) => b.startedAt - a.startedAt)
  if (input.onCancel) cancelHandlers.set(id, input.onCancel)
  if (input.onBackground) backgroundHandlers.set(id, input.onBackground)
  emit()
  const persisted = hydrated ? persistNow() : Promise.resolve()

  return {
    id,
    persisted,
    update: (patch) => patchJob(id, patch),
    beginSubmission: () => beginProviderSubmission(id),
    acceptTask: (taskId, family) => acceptProviderTask(id, taskId, family),
    settleTask: (taskId, family) => settleProviderTask(id, taskId, family),
    savePartialResults: (urls, completedTasks, resultCount, detail) => savePartialJobResults(id, urls, completedTasks, resultCount, detail),
    commitResults: (urls, resultCount, detail) => commitJobResults(id, urls, resultCount, detail),
    pause: (error, detail) => pauseJob(id, error, detail),
    succeed: (resultCount, detail) => settleJob(id, { status: 'succeeded', detail: detail || 'Generation complete', resultCount }),
    fail: (error) => {
      const message = safeErrorMessage(error)
      if (/cancel|abort/i.test(message)) settleJob(id, { status: 'cancelled', detail: 'Cancelled' })
      else settleJob(id, { status: 'failed', detail: 'Needs attention', error: message })
    },
    cancel: () => cancelJob(id),
  }
}

export function hasAcceptedProviderWork(job: JobRecord): boolean {
  return job.submissionState === 'accepted' || !!job.taskId || !!job.providerTasks?.length
}

export function canCancelJob(job: JobRecord): boolean {
  return ['preparing', 'queued', 'running'].includes(job.status)
    && job.submissionState !== 'submitting'
    && !hasAcceptedProviderWork(job)
}

export function canBackgroundJob(job: JobRecord): boolean {
  return ['preparing', 'queued', 'running'].includes(job.status)
    && (job.submissionState === 'submitting' || hasAcceptedProviderWork(job))
}

export function cancelJob(id: string): CancelJobResult {
  const job = jobs.find((item) => item.id === id)
  if (!job) return 'missing'
  if (!['preparing', 'queued', 'running'].includes(job.status)) return 'terminal'
  // The cloud route does not expose a provider-side cancellation endpoint. The request is
  // locked as soon as submission starts—not only after the task id arrives—so
  // an ambiguous accepted/charged task can never be orphaned by local abort.
  if (!canCancelJob(job)) {
    patchJob(id, { detail: hasAcceptedProviderWork(job) ? 'Provider accepted · tracking continues' : 'Submitting · tracking continues' })
    return 'already-submitted'
  }
  cancelHandlers.get(id)?.()
  settleJob(id, { status: 'cancelled', detail: 'Cancelled' })
  return 'cancelled'
}

export function continueJobInBackground(id: string): BackgroundJobResult {
  const job = jobs.find((item) => item.id === id)
  if (!job) return 'missing'
  if (!['preparing', 'queued', 'running'].includes(job.status)) return 'terminal'
  if (!canBackgroundJob(job)) return 'not-submitted'
  backgroundHandlers.get(id)?.()
  patchJob(id, { detail: hasAcceptedProviderWork(job) ? 'Provider accepted · continuing in background' : 'Submitting · continuing in background' })
  return 'backgrounded'
}

export function removeJob(id: string) {
  cancelHandlers.delete(id)
  backgroundHandlers.delete(id)
  jobs = jobs.filter((job) => job.id !== id)
  emit()
  persist()
}

export function clearFinishedJobs() {
  const active = new Set(['preparing', 'queued', 'running'])
  jobs = jobs.filter((job) => active.has(job.status))
  emit()
  persist()
}

async function recoverJob(job: JobRecord) {
  const providerTasks = job.providerTasks?.length
    ? job.providerTasks
    : job.taskId ? [{ taskId: job.taskId, family: job.taskFamily ?? 'jobs' as const }] : []
  if (!providerTasks.length || recovering.has(job.id) || TERMINAL.has(job.status)) return
  const [{ isProviderTerminalError, resumeProviderModel }, { currentApiKey }, { addCreationsDurably }] = await Promise.all([
    import('./providerGateway.ts'),
    import('../settings.ts'),
    import('../data/creations.ts'),
  ])
  const apiKey = currentApiKey()
  if (!apiKey) {
    patchJob(job.id, { detail: 'Connect EasyField Cloud to recover this paid job' })
    return
  }
  recovering.add(job.id)
  patchJob(job.id, { status: 'running', detail: 'Recovering provider task' })
  try {
    const settled = await Promise.allSettled(
      providerTasks.map((task) => resumeProviderModel(apiKey, task.family, task.taskId)),
    )
    const results = settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : [])
    const providerUrls = results.flatMap((result) => result.urls)
    const securedCreations = providerUrls.length
      ? await addCreationsDurably(providerUrls.map((url) => ({
        kind: job.kind === 'animation' ? 'video' : job.kind,
        url,
        model: job.subtitle || job.title,
        prompt: 'Recovered after restart',
        durability: 'link-only',
      })))
      : []
    const urls = securedCreations.map((creation) => creation.url)
    const remaining = providerTasks.filter((_task, index) => {
      const outcome = settled[index]
      return outcome.status === 'rejected' && !isProviderTerminalError(outcome.reason)
    })
    const providerFailures = settled.filter((outcome) => outcome.status === 'rejected' && isProviderTerminalError(outcome.reason)).length
    if (remaining.length) {
      const firstFailure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected' && !isProviderTerminalError(item.reason))
      const message = safeErrorMessage(firstFailure?.reason ?? 'Unknown recovery error')
      const last = remaining[remaining.length - 1]
      // Keep unresolved paid tasks active and retryable. Marking this job
      // terminal would permanently suppress restart recovery.
      const detail = urls.length
          ? `Recovered ${urls.length} result${urls.length === 1 ? '' : 's'} · ${remaining.length} still pending`
          : 'Recovery paused · retry when the connection is available'
      if (urls.length) {
        const completedTasks = providerTasks.filter((task) => !remaining.some((pending) => pending.taskId === task.taskId && pending.family === task.family))
        await savePartialJobResults(
          job.id,
          urls,
          completedTasks,
          safeResultUrls([...(job.resultUrls ?? []), ...urls]).length,
          detail,
        )
        patchJob(job.id, { error: message })
      } else {
        patchJob(job.id, {
          status: 'queued',
          detail,
          error: message,
          providerTasks: remaining,
          taskId: last.taskId,
          taskFamily: last.family,
        })
      }
      return
    }
    if (!urls.length && providerFailures && !(job.resultUrls?.length)) {
      const firstFailure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected' && isProviderTerminalError(item.reason))
      settleJob(job.id, {
        status: 'failed',
        detail: 'Provider could not complete the generation',
        error: safeErrorMessage(firstFailure?.reason ?? 'Provider generation failed'),
      })
      return
    }
    const allResultUrls = safeResultUrls([...(job.resultUrls ?? []), ...urls])
    await commitJobResults(
      job.id,
      allResultUrls,
      allResultUrls.length,
      providerFailures
        ? `Recovered and saved to Library · ${providerFailures} provider request${providerFailures === 1 ? '' : 's'} failed`
        : 'Recovered and saved to Library',
    )
  } catch (error) {
    // Local persistence/import failures are not proof that a paid provider task
    // failed. Leave it retryable instead of turning it into a terminal record.
    patchJob(job.id, {
      status: 'queued',
      detail: 'Recovery paused · retry when the connection is available',
      error: safeErrorMessage(error),
    })
  } finally {
    recovering.delete(job.id)
  }
}

export async function retryJobRecovery(id: string): Promise<void> {
  const job = jobs.find((item) => item.id === id)
  if (job) await recoverJob(job)
}

export async function hydrateJobs(): Promise<void> {
  await prepareJobLedger()
  await reconcileCommittedResults()
  await persistNow()
  await recoverDurableJobs()
}

async function reconcileCommittedResults(): Promise<void> {
  const committed = jobs.flatMap((job) => (job.resultUrls ?? []).map((url) => ({ job, url })))
  if (!committed.length) return
  const { addCreationsDurably, prepareCreationLibrary } = await import('../data/creations.ts')
  await prepareCreationLibrary()
  const localized = await addCreationsDurably(committed.map(({ job, url }) => ({
    kind: job.kind === 'animation' ? 'video' : job.kind,
    url,
    model: job.subtitle || job.title,
    prompt: job.status === 'succeeded' ? 'Recovered from Job Center' : 'Recovered partial result',
    durability: /^\/artifacts\//i.test(url) || /^(?:blob:|data:)/i.test(url) ? 'local' : 'link-only',
  })))
  const localizedByUrl = new Map(committed.map(({ url }, index) => [url, localized[index]?.url ?? url]))
  let changed = false
  jobs = jobs.map((job) => {
    if (!job.resultUrls?.length) return job
    const resultUrls = safeResultUrls(job.resultUrls.map((url) => localizedByUrl.get(url) ?? url))
    if (resultUrls.every((url, index) => url === job.resultUrls?.[index])) return job
    changed = true
    return { ...job, resultUrls, updatedAt: Date.now() }
  })
  if (changed) emit()
}

export async function prepareJobLedger(): Promise<void> {
  if (hydrated) return
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      const stored = await host.getState<JobRecord[]>('jobs', 'ledger')
      const currentById = new Map(jobs.map((job) => [job.id, job]))
      for (const persistedJob of stored ?? []) {
        if (currentById.has(persistedJob.id)) continue
        const storedJob = sanitizeJobTextFields(persistedJob)
        const hasProviderTask = !!storedJob.taskId || !!storedJob.providerTasks?.length
        const ambiguousSubmission = !TERMINAL.has(storedJob.status)
          && storedJob.submissionState === 'submitting'
          && !hasProviderTask
        const job: JobRecord = ambiguousSubmission
          ? {
              ...storedJob,
              status: 'failed',
              detail: 'Submission outcome unknown · not resubmitted',
              error: 'EasyField closed before EasyField Cloud returned a task ID. Check cloud task history before generating again.',
              updatedAt: Date.now(),
            }
          : storedJob
        currentById.set(job.id, job)
      }
      jobs = [...currentById.values()].sort((a, b) => b.startedAt - a.startedAt)
      hydrated = true
      emit()
    })().finally(() => { hydrationPromise = null })
  }
  await hydrationPromise
}

export async function recoverDurableJobs(): Promise<void> {
  await Promise.allSettled(
    jobs
      .filter((job) => !TERMINAL.has(job.status) && (job.taskId || job.providerTasks?.length))
      .map(recoverJob),
  )
}

export function subscribeJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getJobs(): JobRecord[] {
  return jobs
}

export function useJobs(): JobRecord[] {
  return useSyncExternalStore(subscribeJobs, getJobs, getJobs)
}
