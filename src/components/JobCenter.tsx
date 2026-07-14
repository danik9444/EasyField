import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { canCancelJob, cancelJob, clearFinishedJobs, hasAcceptedProviderWork, removeJob, retryJobRecovery, useJobs, type JobRecord } from '../services/jobCenter'
import { host } from '../services/host'

interface JobCenterProps {
  onOpenLibrary: () => void
}

const ACTIVE = new Set<JobRecord['status']>(['preparing', 'queued', 'running'])
const ACTIVITY_DOCK_KEY = 'activity-dock'
const DOCK_MARGIN = 8
const DOCK_DRAG_THRESHOLD = 4

interface ActivityDockPosition {
  left: number
  top: number
}

function clampDockPosition(position: ActivityDockPosition, width = 160, height = 42): ActivityDockPosition {
  return {
    left: Math.min(Math.max(DOCK_MARGIN, position.left), Math.max(DOCK_MARGIN, window.innerWidth - width - DOCK_MARGIN)),
    top: Math.min(Math.max(DOCK_MARGIN, position.top), Math.max(DOCK_MARGIN, window.innerHeight - height - DOCK_MARGIN)),
  }
}

function elapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function statusLabel(status: JobRecord['status']): string {
  if (status === 'preparing') return 'Preparing'
  if (status === 'queued') return 'Queued'
  if (status === 'running') return 'Generating'
  if (status === 'succeeded') return 'Complete'
  if (status === 'failed') return 'Failed'
  return 'Cancelled'
}

function phaseIndex(status: JobRecord['status']): number {
  if (status === 'preparing') return 0
  if (status === 'queued') return 1
  if (status === 'running') return 2
  if (status === 'succeeded') return 3
  return -1
}

export function JobCenter({ onOpenLibrary }: JobCenterProps) {
  const jobs = useJobs()
  const [open, setOpen] = useState(false)
  const [triggerHidden, setTriggerHidden] = useState(false)
  const [dockPosition, setDockPosition] = useState<ActivityDockPosition | null>(null)
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const centerRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const cancelConfirmRef = useRef<HTMLButtonElement>(null)
  const previousLatestRef = useRef<{ id: string; status: JobRecord['status'] } | null>(null)
  const dragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
    startX: number
    startY: number
    width: number
    height: number
    moved: boolean
  } | null>(null)
  const activeCount = useMemo(() => jobs.filter((job) => ACTIVE.has(job.status)).length, [jobs])
  const cancellableCount = useMemo(() => jobs.filter(canCancelJob).length, [jobs])
  const finishedCount = jobs.length - activeCount
  const latest = jobs[0]

  useEffect(() => {
    let active = true
    void host.getState<ActivityDockPosition>('settings', ACTIVITY_DOCK_KEY).then((saved) => {
      if (!active || !saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return
      setDockPosition(clampDockPosition(saved))
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const keepDockInView = () => {
      setDockPosition((current) => {
        if (!current) return current
        const rect = centerRef.current?.getBoundingClientRect()
        return clampDockPosition(current, rect?.width, rect?.height)
      })
    }
    window.addEventListener('resize', keepDockInView)
    return () => window.removeEventListener('resize', keepDockInView)
  }, [])

  // Surface a new generation once when it starts and surface the same job again
  // when its artifact is ready. Closing the panel in between is respected.
  useEffect(() => {
    const previous = previousLatestRef.current
    if (!latest) {
      previousLatestRef.current = null
      return
    }
    const isNewJob = !previous || previous.id !== latest.id
    const becameReady = previous?.id === latest.id && previous.status !== latest.status && (latest.status === 'succeeded' || latest.status === 'failed')
    const restoredActiveJob = !previous && ACTIVE.has(latest.status)
    if (latest.autoOpen !== false && ((isNewJob && ACTIVE.has(latest.status)) || becameReady || restoredActiveJob)) {
      setTriggerHidden(false)
      setOpen(true)
    }
    previousLatestRef.current = { id: latest.id, status: latest.status }
  }, [latest?.id, latest?.status])

  useEffect(() => {
    if (!activeCount) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeCount])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => panelRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!cancelConfirmId) return
    const job = jobs.find((item) => item.id === cancelConfirmId)
    if (!job || !canCancelJob(job)) {
      setCancelConfirmId(null)
      return
    }
    const frame = requestAnimationFrame(() => cancelConfirmRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [cancelConfirmId, jobs])

  const closePanel = (restoreFocus = true) => {
    setCancelConfirmId(null)
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const startDockDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = centerRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      moved: false,
    }
  }

  const moveDock = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (distance < DOCK_DRAG_THRESHOLD) return
      drag.moved = true
    }
    setDockPosition(clampDockPosition({ left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY }, drag.width, drag.height))
  }

  const finishDockDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!drag.moved) return
    setDockPosition((current) => {
      if (current) void host.setState<ActivityDockPosition>('settings', ACTIVITY_DOCK_KEY, current)
      return current
    })
  }

  const moveDockWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Home') {
      event.preventDefault()
      setDockPosition(null)
      void host.deleteState('settings', ACTIVITY_DOCK_KEY)
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    const rect = centerRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    const step = event.shiftKey ? 40 : 12
    const base = dockPosition ?? { left: rect.left, top: rect.top }
    const next = clampDockPosition({
      left: base.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      top: base.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
    }, rect.width, rect.height)
    setDockPosition(next)
    void host.setState<ActivityDockPosition>('settings', ACTIVITY_DOCK_KEY, next)
  }

  const dockStyle: CSSProperties | undefined = dockPosition
    ? { left: dockPosition.left, top: dockPosition.top, right: 'auto', bottom: 'auto' }
    : undefined

  return (
    <aside ref={centerRef} style={dockStyle} className={'ef-job-center' + (open ? ' is-open' : '')} aria-label="Activity center">
      <span className="ef-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {latest ? `${latest.title}: ${statusLabel(latest.status)}. ${latest.detail ?? ''}` : ''}
      </span>

      {!triggerHidden && !open && (
        <div className="ef-job-dock">
          <button
            type="button"
            className="ef-job-drag"
            aria-label="Move activity control. Use arrow keys to move; Home resets its position"
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
            title="Drag or use arrow keys to move · Home resets"
            onPointerDown={startDockDrag}
            onPointerMove={moveDock}
            onPointerUp={finishDockDrag}
            onPointerCancel={finishDockDrag}
            onKeyDown={moveDockWithKeyboard}
          >
            ⋮⋮
          </button>
          <button
            ref={triggerRef}
            type="button"
            className="ef-job-trigger"
            aria-expanded={open}
            aria-controls="ef-job-panel"
            aria-label={open ? 'Close activity' : activeCount ? `Open activity. ${activeCount} active jobs${cancellableCount ? `, ${cancellableCount} can be cancelled` : ''}` : finishedCount ? `Open activity. ${finishedCount} finished jobs` : 'Open activity. No recent jobs'}
            onClick={() => (open ? closePanel(false) : setOpen(true))}
          >
            <span className={'ef-job-trigger-dot' + (activeCount ? ' is-active' : finishedCount ? ' is-finished' : '')} aria-hidden="true" />
            <span>{activeCount ? `${activeCount} generating` : finishedCount ? `${finishedCount} finished` : 'Activity'}</span>
            <span className="ef-job-trigger-caret" aria-hidden="true">{open ? '↓' : '↑'}</span>
          </button>
          <button
            type="button"
            className="ef-job-dock-close"
            aria-label="Hide activity control until the next job update"
            title="Hide until the next job"
            onClick={() => { setOpen(false); setTriggerHidden(true) }}
          >×</button>
        </div>
      )}

      {open && (
        <>
          <div className="ef-job-backdrop" aria-hidden="true" onMouseDown={() => closePanel()} />
          <section
            ref={panelRef}
            id="ef-job-panel"
            className="ef-job-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ef-job-panel-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closePanel()
                return
              }
              if (event.key !== 'Tab') return
              const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
              if (!focusable.length) {
                event.preventDefault()
                return
              }
              const first = focusable[0]
              const last = focusable[focusable.length - 1]
              if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }}
          >
            <header className="ef-job-head">
              <div>
                <small>DURABLE ACTIVITY</small>
                <strong id="ef-job-panel-title">Activity</strong>
                <span>{activeCount ? `${activeCount} active · ${finishedCount} finished` : finishedCount ? `${finishedCount} finished job${finishedCount === 1 ? '' : 's'}` : 'Ready for your first job'}</span>
              </div>
              <div className="ef-job-head-actions">
                {!!finishedCount && (
                  <button type="button" className="ef-job-clear" onClick={clearFinishedJobs}>
                    Clear finished
                  </button>
                )}
                <button type="button" className="ef-icon-btn" onClick={() => closePanel()} aria-label="Close activity panel">
                  ×
                </button>
              </div>
            </header>

            {!jobs.length ? (
              <div className="ef-job-empty">
                <span aria-hidden="true"><i /><i /><i /></span>
                <strong>No activity yet</strong>
                <p>Generation, analysis and local render jobs will stay visible here—even after a restart.</p>
              </div>
            ) : (
              <div className="ef-job-list">
                {jobs.map((job) => {
                  const active = ACTIVE.has(job.status)
                  return (
                    <article className={`ef-job ef-job-${job.status}`} key={job.id}>
                      <span className="ef-job-state-mark" aria-hidden="true">
                        {job.status === 'succeeded' ? '✓' : job.status === 'failed' ? '!' : job.status === 'cancelled' ? '×' : ''}
                      </span>
                      <div className="ef-job-copy">
                        <div className="ef-job-title-row">
                          <strong>{job.title}</strong>
                          <time>{elapsed(job.startedAt, active ? now : job.updatedAt)}</time>
                        </div>
                        <span>{job.subtitle || job.detail}</span>
                        <small>
                          {statusLabel(job.status)}
                          {job.subtitle && job.detail ? ` · ${job.detail}` : ''}
                          {job.resultCount && job.resultCount > 1 ? ` · ${job.resultCount} results` : ''}
                          {active && hasAcceptedProviderWork(job) ? ' · Provider accepted · tracking continues' : job.submissionState === 'submitting' ? ' · Submission locked · tracking continues' : ''}
                        </small>
                        {job.status === 'failed' || job.status === 'cancelled' ? (
                          <span className={`ef-job-terminal ef-job-terminal--${job.status}`}>{job.status === 'failed' ? 'Needs attention · review the details before retrying' : 'Cancelled before completion'}</span>
                        ) : (
                          <div className="ef-job-progress">
                            <span className="ef-job-phase" aria-label={`${statusLabel(job.status)} phase`}>
                              {['Prepare', 'Queue', 'Generate', 'Saved'].map((phase, index) => <i key={phase} className={index <= phaseIndex(job.status) ? 'is-done' : ''} title={phase} />)}
                            </span>
                            <span className="ef-job-phase-labels" aria-hidden="true"><i>Prepare</i><i>Queue</i><i>Generate</i><i>Saved</i></span>
                          </div>
                        )}
                        {job.error && <p role="alert">{job.error}</p>}
                      </div>
                      <div className="ef-job-actions">
                        {job.status === 'queued' && job.error && (job.taskId || job.providerTasks?.length) && (
                          <button type="button" onClick={() => void retryJobRecovery(job.id)}>
                            Retry
                          </button>
                        )}
                        {active && canCancelJob(job) && (cancelConfirmId === job.id ? (
                          <>
                            <button
                              ref={cancelConfirmRef}
                              type="button"
                              className="ef-job-confirm-cancel"
                              aria-label={`Confirm cancellation of ${job.title}`}
                              onClick={() => {
                                cancelJob(job.id)
                                setCancelConfirmId(null)
                                requestAnimationFrame(() => panelRef.current?.focus())
                              }}
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              aria-label={`Keep ${job.title} running`}
                              onClick={() => {
                                setCancelConfirmId(null)
                                requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>(`[data-cancel-job-id="${job.id}"]`)?.focus())
                              }}
                            >
                              Keep
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            data-cancel-job-id={job.id}
                            aria-label={`Cancel ${job.title}`}
                            onClick={() => setCancelConfirmId(job.id)}
                          >
                            Cancel
                          </button>
                        ))}
                        {job.status === 'succeeded' && (job.resultCount ?? 1) > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenLibrary()
                              setOpen(false)
                            }}
                          >
                            View
                          </button>
                        )}
                        {!active && (
                          <button type="button" className="ef-job-dismiss" onClick={() => removeJob(job.id)} aria-label={`Dismiss ${job.title}`} title="Dismiss job">
                            ×
                          </button>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
    </aside>
  )
}
