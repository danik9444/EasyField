// Send generated results to the DaVinci Resolve timeline via the bridge adapter.
// Every screen's "Send to timeline" button routes through here so the outcome is
// reported honestly: when the bridge is down (browser dev, or Resolve closed) we
// say so instead of faking success; when it's up we place each item and count the
// real successes. placeToTimeline never throws, so no try/catch is needed here.

import { resolve, type ResolvePlacementAnchor } from './resolve'
import { loadSettings } from '../settings'
import { foleyRecordFrame } from '../data/soundEffects'
import type { BeatMarker, BeatMarkerColor } from '../data/beatWorkflow'

export interface TimelineItem {
  url: string
  name: string
}

export interface TimelinePlacementContext {
  recordFrame: number
  projectId?: string
  timelineId?: string
  anchorItemId?: string
  anchorItemStartFrame?: number
  anchorItemEndFrame?: number
  anchorItemSourceStartFrame?: number
  anchorItemSourceEndFrame?: number
  anchorMediaPoolItemId?: string
  anchorTrackIndex?: number
  validationAnchors?: ResolvePlacementAnchor[]
}

export interface TimelinePlacementAnchor {
  fps: number
  itemId: string
  itemStartFrame: number
  itemEndFrame: number
  projectId?: string
  timelineId?: string
}

export interface TimedTimelineItem extends TimelineItem {
  offsetSeconds: number
}

export async function importAudioWithBeatMarkers(input: {
  url: string
  name: string
  target: 'timeline' | 'media-pool'
  analysisId: string
  color: BeatMarkerColor
  markers: BeatMarker[]
}, toast: (msg: string) => void): Promise<boolean> {
  if (!resolve.isBridgeConnected()) {
    toast('DaVinci not connected — open EasyField inside Resolve')
    return false
  }
  if (!input.markers.length) {
    toast('No reviewed beat markers to import')
    return false
  }
  const placement = await resolve.placeToTimeline({
    url: input.url,
    name: input.name,
    kind: 'audio',
    placement: input.target === 'media-pool' ? 'media-pool' : 'playhead',
  })
  if (!placement.ok || !placement.path) {
    toast(placement.error ? `Audio import failed — ${placement.error}` : 'Audio import failed')
    return false
  }
  const markerResult = await resolve.applyBeatMarkers({
    path: placement.path,
    target: input.target,
    analysisId: input.analysisId,
    color: input.color,
    markers: input.markers,
  })
  if (!markerResult.ok) {
    toast(`Audio imported, but markers failed — ${markerResult.error || 'review the imported clip'}`)
    return false
  }
  toast(`${markerResult.applied ?? input.markers.length} markers added ${input.target === 'media-pool' ? 'in Media Pool' : 'to the timeline clip'}`)
  return true
}

export function recordFrameForOffset(anchor: TimelinePlacementAnchor, offsetSeconds: number): number | null {
  return foleyRecordFrame(anchor.itemStartFrame, anchor.itemEndFrame, anchor.fps, offsetSeconds)
}

export async function sendTimedAudioToTimeline(
  items: TimedTimelineItem[],
  anchor: TimelinePlacementAnchor,
  toast: (msg: string) => void,
): Promise<void> {
  if (!resolve.isBridgeConnected()) {
    toast('DaVinci not connected — open EasyField inside Resolve')
    return
  }
  if (!items.length) {
    toast('Nothing to place')
    return
  }
  let ok = 0
  let firstError: string | undefined
  for (const item of items) {
    const recordFrame = recordFrameForOffset(anchor, item.offsetSeconds)
    if (recordFrame == null) {
      firstError ??= 'A Foley event falls outside the captured source clip'
      continue
    }
    const result = await resolve.placeToTimeline({
      url: item.url,
      name: item.name,
      kind: 'audio',
      placement: 'playhead',
      recordFrame,
      projectId: anchor.projectId,
      timelineId: anchor.timelineId,
      anchorItemId: anchor.itemId,
      anchorItemStartFrame: anchor.itemStartFrame,
      anchorItemEndFrame: anchor.itemEndFrame,
    })
    if (result.ok) ok += 1
    else firstError ??= result.error
  }
  if (ok === items.length) toast(`${ok} Foley event${ok === 1 ? '' : 's'} placed at captured timing`)
  else if (ok === 0) toast(firstError ? `Foley placement failed — ${firstError}` : 'Foley placement failed')
  else toast(`${ok}/${items.length} Foley events placed · ${firstError || 'review the remaining events'}`)
}

// Place `items` on the timeline sequentially (sequential — not Promise.all — so
// AppendToTimeline keeps the caller's ordering) and toast the outcome.
export async function sendToTimeline(
  items: TimelineItem[],
  kind: 'image' | 'video' | 'audio',
  toast: (msg: string) => void,
  capturedContext?: TimelinePlacementContext,
): Promise<void> {
  if (!resolve.isBridgeConnected()) {
    toast('DaVinci not connected — open EasyField inside Resolve')
    return
  }
  if (!items.length) {
    toast('Nothing to send')
    return
  }

  let ok = 0
  let firstError: string | undefined
  // A generated transition belongs to the frozen incoming-shot boundary. Force
  // safe managed-track placement at that exact frame; ordinary sends continue
  // to respect the user's global placement preference.
  const placement = capturedContext ? 'playhead' : loadSettings().placementMode
  // Defense in depth for legacy/in-memory settings: destructive replacement
  // must never execute until the timeline preview + confirmation adapter ships.
  if (placement === 'replace') {
    toast('Replace selection is unavailable until Timeline Preview is installed')
    return
  }
  for (const item of items) {
    const res = await resolve.placeToTimeline({
      url: item.url,
      name: item.name,
      kind,
      placement,
      recordFrame: capturedContext?.recordFrame,
      projectId: capturedContext?.projectId,
      timelineId: capturedContext?.timelineId,
      anchorItemId: capturedContext?.anchorItemId,
      anchorItemStartFrame: capturedContext?.anchorItemStartFrame,
      anchorItemEndFrame: capturedContext?.anchorItemEndFrame,
      anchorItemSourceStartFrame: capturedContext?.anchorItemSourceStartFrame,
      anchorItemSourceEndFrame: capturedContext?.anchorItemSourceEndFrame,
      anchorMediaPoolItemId: capturedContext?.anchorMediaPoolItemId,
      anchorTrackIndex: capturedContext?.anchorTrackIndex,
      validationAnchors: capturedContext?.validationAnchors,
    })
    if (res.ok) ok += 1
    else if (!firstError) firstError = res.error
  }

  const total = items.length
  const fail = total - ok
  if (fail === 0) {
    toast(`${ok} sent to timeline`)
  } else if (ok === 0) {
    toast(firstError ? `Timeline send failed — ${firstError}` : 'Timeline send failed')
  } else {
    toast(`${ok}/${total} sent — ${fail} failed`)
  }
}
