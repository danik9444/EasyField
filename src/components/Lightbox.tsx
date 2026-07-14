import { useEffect, useRef } from 'react'

// Full-panel viewer for enlarging a result. Click the backdrop, the ✕, or press
// Escape to close.
export function Lightbox({ url, kind = 'image', onClose }: { url: string; kind?: 'image' | 'video'; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)

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
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button ref={closeRef} type="button" className="ef-lightbox-close" onClick={onClose} aria-label="Close preview">✕</button>
      {kind === 'video' ? (
        <video className="ef-lightbox-media" src={url} controls autoPlay playsInline aria-label="Video preview" />
      ) : (
        <img className="ef-lightbox-media" src={url} alt="Image preview" />
      )}
    </div>
  )
}
