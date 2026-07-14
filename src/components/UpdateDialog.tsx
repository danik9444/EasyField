import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

export interface UpdateDialogStatus {
  currentVersion: string
  latestVersion: string
  releaseNotes?: string
}

export interface UpdateDialogProps {
  status: UpdateDialogStatus
  installing: boolean
  installed: boolean
  error?: string | null
  onInstall: () => void | Promise<void>
  onDismiss: () => void
}

type DialogMode = 'available' | 'installing' | 'installed' | 'error'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function UpdateDialog({ status, installing, installed, error, onInstall, onDismiss }: UpdateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const onDismissRef = useRef(onDismiss)
  const titleId = useId()
  const descriptionId = useId()
  const mode: DialogMode = installed ? 'installed' : installing ? 'installing' : error ? 'error' : 'available'

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

    return () => {
      previousFocus?.focus()
    }
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (firstActionRef.current && !firstActionRef.current.disabled) firstActionRef.current.focus()
      else dialogRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [mode])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (installing) return
      onDismissRef.current()
      return
    }

    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.getAttribute('aria-hidden') !== 'true')

    if (!focusable.length) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const title = mode === 'installed'
    ? 'Update installed'
    : mode === 'installing'
      ? 'Installing EasyField update'
      : mode === 'error'
        ? 'Update could not be installed'
        : `EasyField ${status.latestVersion} is available`

  const description = mode === 'installed'
    ? `Restart DaVinci Resolve to finish loading EasyField ${status.latestVersion}.`
    : mode === 'installing'
      ? 'EasyField is installing the update. Keep this window open while the files are prepared.'
      : mode === 'error'
        ? error || 'EasyField could not install the update. Try again.'
        : 'This updates the DaVinci Resolve integration. Your settings and Library stay on this Mac.'

  return (
    <div
      className={`ef-update-backdrop ef-update-backdrop--${mode}`}
      onMouseDown={(event) => {
        if (!installing && event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={dialogRef}
        className={`ef-update-dialog ef-update-dialog--${mode}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={installing}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="ef-update-header">
          <span className="ef-update-kicker">EASYFIELD UPDATE</span>
          {!installing && (
            <button type="button" className="ef-update-close" onClick={onDismiss} aria-label="Close update dialog">
              ×
            </button>
          )}
        </header>

        <div className="ef-update-content">
          <span className="ef-update-mark" aria-hidden="true">
            {mode === 'installed' ? '✓' : mode === 'error' ? '!' : '↑'}
          </span>
          <h2 id={titleId} className="ef-update-title">{title}</h2>
          <p id={descriptionId} className="ef-update-description" role={mode === 'error' ? 'alert' : 'status'} aria-live="polite">
            {description}
          </p>

          {mode === 'available' && (
            <div className="ef-update-version" aria-label={`Installed version ${status.currentVersion}; available version ${status.latestVersion}`}>
              <span><small>INSTALLED</small>{status.currentVersion}</span>
              <i aria-hidden="true">→</i>
              <span><small>AVAILABLE</small>{status.latestVersion}</span>
            </div>
          )}

          {mode === 'available' && status.releaseNotes && (
            <p className="ef-update-notes">{status.releaseNotes}</p>
          )}

          {mode === 'installing' && (
            <div className="ef-update-progress" role="progressbar" aria-label="Installing EasyField update">
              <span />
            </div>
          )}
        </div>

        <footer className="ef-update-actions">
          {mode === 'available' && (
            <>
              <button ref={firstActionRef} type="button" className="ef-update-primary" onClick={() => void onInstall()}>
                Update now
              </button>
              <button type="button" className="ef-update-secondary" onClick={onDismiss}>
                Later
              </button>
            </>
          )}

          {mode === 'error' && (
            <>
              <button ref={firstActionRef} type="button" className="ef-update-primary" onClick={() => void onInstall()}>
                Try again
              </button>
              <button type="button" className="ef-update-secondary" onClick={onDismiss}>
                Later
              </button>
            </>
          )}

          {mode === 'installed' && (
            <button ref={firstActionRef} type="button" className="ef-update-primary" onClick={onDismiss}>
              Got it
            </button>
          )}

          {mode === 'installing' && <span className="ef-update-wait">Installing…</span>}
        </footer>
      </div>
    </div>
  )
}
