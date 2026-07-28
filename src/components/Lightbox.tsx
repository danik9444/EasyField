import { useEffect, useRef, useState } from 'react'

// Full-panel viewer for enlarging a result. Click the backdrop, the ✕, or press
// Escape to close.
export function Lightbox({ url, kind = 'image', onClose }: { url: string; kind?: 'image' | 'video'; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const [retryKey, setRetryKey] = useState(0)
  const [loadResult, setLoadResult] = useState<{ key: string; status: 'ready' | 'error' } | null>(null)
  const mediaKey = `${kind}:${url}:${retryKey}`
  const loadStatus = loadResult?.key === mediaKey ? loadResult.status : 'loading'

  const retry = () => {
    setRetryKey((key) => key + 1)
    requestAnimationFrame(() => closeRef.current?.focus())
  }

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFrame = requestAnimationFrame(() => closeRef.current?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true')
      if (!focusable.length) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKey)
      previousFocus?.focus()
    }
  }, [])

  return (
    <div
      ref={dialogRef}
      className="ef-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${kind === 'video' ? 'Video' : 'Image'} preview`}
      aria-busy={loadStatus === 'loading'}
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button ref={closeRef} type="button" className="ef-lightbox-close" onClick={onClose} aria-label="Close preview">✕</button>
      {loadStatus === 'loading' && <div className="ef-lightbox-status" role="status">Loading preview…</div>}
      {loadStatus === 'error' && (
        <div className="ef-lightbox-status is-error" role="alert">
          <strong>Preview unavailable</strong>
          <span>This media could not be loaded.</span>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}
      {kind === 'video' ? (
        <video
          key={mediaKey}
          className={'ef-lightbox-media' + (loadStatus === 'ready' ? '' : ' is-pending')}
          src={url}
          controls={loadStatus === 'ready'}
          autoPlay
          playsInline
          preload="metadata"
          aria-label="Video preview"
          onLoadedData={() => setLoadResult({ key: mediaKey, status: 'ready' })}
          onError={() => setLoadResult({ key: mediaKey, status: 'error' })}
        />
      ) : (
        <img
          key={mediaKey}
          className={'ef-lightbox-media' + (loadStatus === 'ready' ? '' : ' is-pending')}
          src={url}
          alt="Image preview"
          onLoad={() => setLoadResult({ key: mediaKey, status: 'ready' })}
          onError={() => setLoadResult({ key: mediaKey, status: 'error' })}
        />
      )}
    </div>
  )
}
