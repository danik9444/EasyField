import { useEffect, useRef, useState } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { AnimationComposition, type AnimProps } from '../remotion/AnimationComposition'

interface RenderJobBase {
  engine: 'HyperFrames' | 'Remotion'
  width: number
  height: number
  fps: number
  durationSec: number
  frameCount: number
}

interface HyperFramesJob extends RenderJobBase {
  engine: 'HyperFrames'
  html: string
}

interface RemotionJob extends RenderJobBase {
  engine: 'Remotion'
  props: AnimProps
}

type RenderJob = HyperFramesJob | RemotionJob

interface HostBridge {
  ready: boolean
  error?: string
  seek?: (frame: number) => Promise<{ frame: number }>
}

declare global {
  interface Window {
    __easyfieldRenderHost?: HostBridge
  }
}

window.__easyfieldRenderHost = { ready: false }

const nextPaint = (target: Window = window) =>
  new Promise<void>((resolve) => target.requestAnimationFrame(() => target.requestAnimationFrame(() => resolve())))

async function preloadImages(urls: string[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve()
          image.onerror = () => reject(new Error('An animation asset could not be decoded'))
          image.src = url
          if (image.complete && image.naturalWidth > 0) resolve()
        }),
    ),
  )
}

function setHostError(error: unknown) {
  window.__easyfieldRenderHost = {
    ready: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

function RemotionHost({ job }: { job: RemotionJob }) {
  const player = useRef<PlayerRef>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    let cancelled = false
    const expose = async () => {
      await preloadImages(job.props.assetUrls)
      if (cancelled || !player.current) return
      window.__easyfieldRenderHost = {
        ready: true,
        seek: async (frame) => {
          if (!player.current) throw new Error('Remotion player is unavailable')
          player.current.seekTo(frame)
          await nextPaint()
          return { frame: player.current.getCurrentFrame() }
        },
      }
    }
    if (mounted) void expose().catch(setHostError)
    return () => {
      cancelled = true
    }
  }, [job, mounted])

  return (
    <Player
      acknowledgeRemotionLicense
      ref={(next) => {
        player.current = next
        if (next) setMounted(true)
      }}
      component={AnimationComposition}
      inputProps={job.props}
      durationInFrames={job.frameCount}
      fps={job.fps}
      compositionWidth={job.width}
      compositionHeight={job.height}
      controls={false}
      autoPlay={false}
      loop={false}
      style={{ width: job.width, height: job.height }}
    />
  )
}

function HyperFramesHost({ job }: { job: HyperFramesJob }) {
  const iframe = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let cancelled = false
    let ready = false
    let sequence = 0
    const pending = new Map<number, { resolve: (value: { frame: number }) => void; reject: (error: Error) => void; timer: number }>()
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return
      const message = event.data as { channel?: string; type?: string; requestId?: number; frame?: number } | null
      if (!message || message.channel !== 'easyfield-hyperframes-v1') return
      if (message.type === 'ready') {
        ready = true
        window.__easyfieldRenderHost = {
          ready: true,
          seek: (frame) => new Promise((resolve, reject) => {
            if (!ready || !iframe.current?.contentWindow) return reject(new Error('HyperFrames renderer is unavailable'))
            const requestId = ++sequence
            const timer = window.setTimeout(() => {
              pending.delete(requestId)
              reject(new Error('HyperFrames seek timed out'))
            }, 5000)
            pending.set(requestId, { resolve, reject, timer })
            iframe.current.contentWindow.postMessage({ channel: 'easyfield-hyperframes-v1', type: 'seek', requestId, frame, seconds: frame / job.fps }, '*')
          }),
        }
      } else if (message.type === 'seeked' && typeof message.requestId === 'number') {
        const request = pending.get(message.requestId)
        if (!request) return
        window.clearTimeout(request.timer)
        pending.delete(message.requestId)
        request.resolve({ frame: typeof message.frame === 'number' ? message.frame : 0 })
      }
    }
    window.addEventListener('message', onMessage)
    const readyTimer = window.setTimeout(() => {
      if (!ready && !cancelled) setHostError(new Error('HyperFrames runtime did not become ready'))
    }, 12_000)
    return () => {
      cancelled = true
      ready = false
      window.clearTimeout(readyTimer)
      window.removeEventListener('message', onMessage)
      pending.forEach((request) => {
        window.clearTimeout(request.timer)
        request.reject(new Error('HyperFrames renderer was disposed'))
      })
      pending.clear()
    }
  }, [job])

  return (
    <iframe
      ref={iframe}
      title="HyperFrames renderer"
      srcDoc={job.html}
      sandbox="allow-scripts"
      style={{ display: 'block', width: job.width, height: job.height, border: 0 }}
    />
  )
}

export function AnimationRenderHost({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<RenderJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const response = await fetch(`/api/render/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Render job could not be loaded (${response.status})`)
      const value = (await response.json()) as RenderJob
      if (!cancelled) setJob(value)
    }
    void load().catch((reason) => {
      if (cancelled) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      setHostError(message)
    })
    return () => {
      cancelled = true
    }
  }, [jobId])

  useEffect(() => {
    if (!job) return
    document.documentElement.style.width = `${job.width}px`
    document.documentElement.style.height = `${job.height}px`
    document.body.style.width = `${job.width}px`
    document.body.style.height = `${job.height}px`
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
    const root = document.getElementById('root')
    if (root) {
      root.style.width = `${job.width}px`
      root.style.height = `${job.height}px`
      root.style.minHeight = '0'
      root.style.display = 'block'
    }
  }, [job])

  if (error) {
    return <div style={{ color: '#fff', background: '#101015', padding: 24, fontFamily: 'system-ui' }}>{error}</div>
  }
  if (!job) return null
  return job.engine === 'Remotion' ? <RemotionHost job={job} /> : <HyperFramesHost job={job} />
}
