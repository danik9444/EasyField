// Posts a composition to the local render middleware (POST /api/render) and
// returns an object-URL for the resulting MP4. HyperFrames renders from the
// generated HTML; Remotion renders from props. Asset images are passed as data
// URLs so they're self-contained for both the browser preview and Node render.
import type { AnimSettings } from '../data/animationConfig'
import { dimsFor } from '../data/animationConfig'
import { buildHyperframesHtml } from '../animation/hyperframes'
import { prepareJobLedger, startJob } from './jobCenter'

export async function renderAnimation(
  s: AnimSettings,
  assetUrls: string[],
  opts: { audioDataUrl?: string; onJobCreated?: (jobId: string) => void } = {},
): Promise<string> {
  await prepareJobLedger()
  const controller = new AbortController()
  const job = startJob({
    title: 'Render animation',
    subtitle: `${s.engine} · ${s.durationSec}s`,
    kind: 'animation',
    onCancel: () => controller.abort(),
  })
  opts.onJobCreated?.(job.id)
  const { width, height } = dimsFor(s.aspect)
  const metadata = {
    engine: s.engine,
    width,
    height,
    fps: s.fps,
    durationSec: s.durationSec,
    ...(opts.audioDataUrl ? { audioDataUrl: opts.audioDataUrl } : {}),
  }
  const payload =
    s.engine === 'HyperFrames'
      ? { ...metadata, html: buildHyperframesHtml(s, assetUrls, { preview: false }) }
      : {
          ...metadata,
          props: { mode: s.mode, recipe: s.recipe, text: s.text, preset: s.preset, accent: s.accent, bg: s.bg, assetUrls, fps: s.fps, durationSec: s.durationSec, width, height },
        }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    await job.persisted
    job.update({ status: 'running', detail: 'Rendering locally' })
    const res = await fetch('/api/render', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      let msg = `Render failed (${res.status})`
      try {
        const j = await res.json()
        if (j.error) msg = j.error
      } catch {
        /* non-JSON error body */
      }
      throw new Error(msg)
    }
    const blob = await res.blob()
    if (!blob.size || !blob.type.toLowerCase().startsWith('video/mp4')) {
      throw new Error('Render server returned an invalid MP4')
    }
    const url = URL.createObjectURL(blob)
    job.succeed(1)
    return url
  } catch (error) {
    job.fail(controller.signal.aborted ? new Error('Cancelled') : error)
    throw controller.signal.aborted ? new Error('Cancelled') : error
  }
}
