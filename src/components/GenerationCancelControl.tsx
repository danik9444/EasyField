import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  canBackgroundJob,
  canCancelJob,
  cancelJob,
  continueJobInBackground,
  getJobs,
  useJobs,
  type JobRecord,
} from '../services/jobCenter'

export type GenerationExitOutcome = 'cancelled' | 'backgrounded'

export interface GenerationJobControl {
  job: JobRecord | null
  begin: () => AbortController
  attachJob: (jobId: string) => void
  finish: (controller: AbortController) => void
  exit: () => GenerationExitOutcome | null
}

export interface GenerationBatchJobControl {
  jobs: JobRecord[]
  begin: () => AbortController
  attachJob: (jobId: string) => void
  finish: (controller: AbortController) => void
  exit: () => GenerationExitOutcome | null
}

function exitCurrentJob(jobId: string | null, controller: AbortController | null): GenerationExitOutcome | null {
  const job = jobId ? getJobs().find((item) => item.id === jobId) : undefined
  let outcome: GenerationExitOutcome = 'cancelled'

  if (job) {
    if (canCancelJob(job)) {
      const result = cancelJob(job.id)
      if (result === 'already-submitted') {
        continueJobInBackground(job.id)
        outcome = 'backgrounded'
      }
    } else if (canBackgroundJob(job)) {
      continueJobInBackground(job.id)
      outcome = 'backgrounded'
    } else {
      return null
    }
  }

  // This caller signal only unwinds the screen. withTrackedJob keeps its own
  // signal alive once submission starts, so accepted work still reaches Library.
  controller?.abort()
  return outcome
}

/** Owns the foreground side of one generation while Job Center owns durability. */
export function useGenerationJobControl(): GenerationJobControl {
  const jobs = useJobs()
  const controllerRef = useRef<AbortController | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const exitRequestedRef = useRef(false)
  const mountedRef = useRef(true)
  const [jobId, setJobId] = useState<string | null>(null)

  const begin = useCallback(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    jobIdRef.current = null
    exitRequestedRef.current = false
    if (mountedRef.current) setJobId(null)
    return controller
  }, [])

  const attachJob = useCallback((nextJobId: string) => {
    jobIdRef.current = nextJobId
    if (mountedRef.current) setJobId(nextJobId)
    if (!exitRequestedRef.current) return
    exitCurrentJob(nextJobId, controllerRef.current)
    jobIdRef.current = null
    if (mountedRef.current) setJobId(null)
  }, [])

  const finish = useCallback((controller: AbortController) => {
    if (controllerRef.current !== controller) return
    controllerRef.current = null
    jobIdRef.current = null
    exitRequestedRef.current = false
    if (mountedRef.current) setJobId(null)
  }, [])

  const exit = useCallback(() => {
    exitRequestedRef.current = true
    const outcome = exitCurrentJob(jobIdRef.current, controllerRef.current)
    if (outcome) {
      controllerRef.current = null
      jobIdRef.current = null
      if (mountedRef.current) setJobId(null)
    }
    return outcome
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      exitRequestedRef.current = true
      exitCurrentJob(jobIdRef.current, controllerRef.current)
      controllerRef.current = null
      jobIdRef.current = null
    }
  }, [])

  const job = useMemo(() => jobId ? jobs.find((item) => item.id === jobId) ?? null : null, [jobId, jobs])
  return { job, begin, attachJob, finish, exit }
}

function isTerminal(job: JobRecord): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
}

function exitCurrentJobs(jobIds: readonly string[], controller: AbortController | null): GenerationExitOutcome | null {
  let backgrounded = false
  let acted = false
  let finishing = false

  for (const jobId of jobIds) {
    const job = getJobs().find((item) => item.id === jobId)
    if (!job || isTerminal(job)) continue
    if (canCancelJob(job)) {
      const result = cancelJob(job.id)
      acted = true
      if (result === 'already-submitted') {
        continueJobInBackground(job.id)
        backgrounded = true
      }
      continue
    }
    if (canBackgroundJob(job)) {
      continueJobInBackground(job.id)
      backgrounded = true
      acted = true
      continue
    }
    finishing = true
  }

  if (finishing && !acted) return null
  controller?.abort()
  return backgrounded ? 'backgrounded' : 'cancelled'
}

/**
 * Foreground control for a fan-out batch whose children remain separate durable
 * jobs. Accepted cloud tasks continue safely; children that have not submitted
 * are cancelled together with the local upload/preflight work.
 */
export function useGenerationBatchJobControl(): GenerationBatchJobControl {
  const allJobs = useJobs()
  const controllerRef = useRef<AbortController | null>(null)
  const jobIdsRef = useRef<string[]>([])
  const exitRequestedRef = useRef(false)
  const mountedRef = useRef(true)
  const [jobIds, setJobIds] = useState<string[]>([])

  const begin = useCallback(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    jobIdsRef.current = []
    exitRequestedRef.current = false
    if (mountedRef.current) setJobIds([])
    return controller
  }, [])

  const attachJob = useCallback((nextJobId: string) => {
    if (!jobIdsRef.current.includes(nextJobId)) {
      jobIdsRef.current = [...jobIdsRef.current, nextJobId]
      if (mountedRef.current) setJobIds(jobIdsRef.current)
    }
    if (exitRequestedRef.current) exitCurrentJob(nextJobId, controllerRef.current)
  }, [])

  const finish = useCallback((controller: AbortController) => {
    if (controllerRef.current !== controller) return
    controllerRef.current = null
    jobIdsRef.current = []
    exitRequestedRef.current = false
    if (mountedRef.current) setJobIds([])
  }, [])

  const exit = useCallback(() => {
    exitRequestedRef.current = true
    const outcome = exitCurrentJobs(jobIdsRef.current, controllerRef.current)
    if (outcome) {
      controllerRef.current = null
      jobIdsRef.current = []
      if (mountedRef.current) setJobIds([])
    }
    return outcome
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      exitRequestedRef.current = true
      exitCurrentJobs(jobIdsRef.current, controllerRef.current)
      controllerRef.current = null
      jobIdsRef.current = []
    }
  }, [])

  const jobs = useMemo(
    () => jobIds.map((id) => allJobs.find((job) => job.id === id)).filter((job): job is JobRecord => !!job),
    [allJobs, jobIds],
  )
  return { jobs, begin, attachJob, finish, exit }
}

interface GenerationCancelControlProps {
  job: JobRecord | null
  onExit: () => void
  noun?: string
  local?: boolean
}

export function GenerationCancelControl({ job, onExit, noun = 'generation', local = false }: GenerationCancelControlProps) {
  const submitted = !!job && canBackgroundJob(job)
  const unavailable = !!job && !submitted && !canCancelJob(job)
  const descriptionId = job ? `generation-exit-${job.id}` : undefined

  return (
    <div className={'ef-generation-exit' + (submitted ? ' is-background' : '')}>
      <button
        type="button"
        className="ef-generation-exit-action"
        disabled={unavailable}
        aria-describedby={descriptionId}
        onClick={onExit}
      >
        {submitted ? 'Continue in background' : unavailable ? 'Finishing…' : `Cancel ${noun}`}
      </button>
      <small id={descriptionId}>
        {submitted
          ? 'The provider has started. EasyField will save the finished result to Library.'
          : unavailable
            ? 'The result is being secured in Library.'
            : local ? 'Stops the local process without creating a result.' : 'Stops safely before a provider task is submitted.'}
      </small>
    </div>
  )
}

interface GenerationBatchCancelControlProps {
  jobs: readonly JobRecord[]
  onExit: () => void
  noun?: string
}

export function GenerationBatchCancelControl({ jobs, onExit, noun = 'batch' }: GenerationBatchCancelControlProps) {
  const submitted = jobs.some(canBackgroundJob)
  const cancellable = !jobs.length || jobs.some(canCancelJob)
  const unavailable = !!jobs.length && !submitted && !cancellable
  const descriptionId = jobs[0] ? `generation-batch-exit-${jobs[0].id}` : 'generation-batch-exit-pending'

  return (
    <div className={'ef-generation-exit' + (submitted ? ' is-background' : '')}>
      <button
        type="button"
        className="ef-generation-exit-action"
        disabled={unavailable}
        aria-describedby={descriptionId}
        onClick={onExit}
      >
        {submitted ? 'Continue batch in background' : unavailable ? 'Finishing…' : `Cancel ${noun}`}
      </button>
      <small id={descriptionId}>
        {submitted
          ? 'Accepted Topaz tasks will finish and save to Library; work not yet submitted will stop.'
          : unavailable
            ? 'The completed results are being secured in Library.'
            : 'Stops every batch item safely before its provider task is submitted.'}
      </small>
    </div>
  )
}
