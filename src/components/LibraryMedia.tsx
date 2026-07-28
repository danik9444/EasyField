import { useEffect, useRef, useState } from 'react'

function useViewportPresence<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? false)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, visible] as const
}

interface LibraryImageProps {
  src: string
  className: string
}

export function LibraryImage({ src, className }: LibraryImageProps) {
  const [ref, visible] = useViewportPresence<HTMLSpanElement>()
  return (
    <span ref={ref} className={className} aria-hidden="true">
      {visible && <img src={src} alt="" loading="lazy" decoding="async" />}
    </span>
  )
}

interface LibraryVideoProps {
  src: string
  className: string
  hoverPlayback?: boolean
}

export function LibraryVideo({ src, className, hoverPlayback = false }: LibraryVideoProps) {
  const [ref, visible] = useViewportPresence<HTMLSpanElement>()
  return (
    <span ref={ref} className={className} aria-hidden="true">
      {visible && (
        <video
          src={src}
          muted
          loop={hoverPlayback}
          playsInline
          preload="metadata"
          onMouseEnter={hoverPlayback ? (event) => event.currentTarget.play().catch(() => {}) : undefined}
          onMouseLeave={hoverPlayback ? (event) => {
            event.currentTarget.pause()
            event.currentTarget.currentTime = 0
          } : undefined}
        />
      )}
    </span>
  )
}

interface LibraryAudioProps {
  src: string
  ariaLabel: string
  className: string
  audioClassName?: string
}

export function LibraryAudio({ src, ariaLabel, className, audioClassName }: LibraryAudioProps) {
  const [ref, visible] = useViewportPresence<HTMLDivElement>()
  const [playRequested, setPlayRequested] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const showPlayer = visible || playRequested

  useEffect(() => {
    if (!playRequested) return
    void audioRef.current?.play().catch(() => {})
  }, [playRequested])

  return (
    <div ref={ref} className={className}>
      {showPlayer ? (
        <audio
          ref={audioRef}
          className={audioClassName}
          src={src}
          controls
          preload="metadata"
          aria-label={ariaLabel}
          onPlay={() => setPlayRequested(true)}
        />
      ) : (
        <button type="button" className="ef-library-audio-load" onClick={() => setPlayRequested(true)} aria-label={ariaLabel}>
          ▶ Play audio
        </button>
      )}
    </div>
  )
}
