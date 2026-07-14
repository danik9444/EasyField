import { useEffect, useRef, useState } from 'react'

// Renders a full-size (e.g. 1920×1080) HTML composition in an iframe and scales
// it down to fit the panel width, preserving aspect ratio. Used for the live
// HyperFrames preview (the iframe runs the real GSAP timeline).
export function ScaledFrame({ html, width, height }: { html: string; width: number; height: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.18)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setScale(el.clientWidth / width)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [width])

  return (
    <div ref={wrapRef} className="ef-anim-frame" style={{ aspectRatio: `${width} / ${height}` }}>
      <iframe
        title="HyperFrames preview"
        srcDoc={html}
        sandbox="allow-scripts"
        style={{ width, height, border: 0, position: 'absolute', top: 0, left: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }}
      />
    </div>
  )
}
