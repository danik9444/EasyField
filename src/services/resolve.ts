// Adapter boundary for the DaVinci Resolve host. Everything the panel needs
// from Resolve goes through the `/bridge/*` HTTP endpoints served by the plugin's
// embedded server (127.0.0.1:18832) — reached relatively here: the Vite dev
// server proxies `/bridge` there in development, and in production the panel is
// served by that same embedded server inside DaVinci Resolve. When the bridge
// is unreachable (browser dev with no plugin, or Resolve closed), every method
// returns a structured failure rather than inventing media — the panel stays usable.

// ---------------------------------------------------------------------------
// Types (FROZEN interface — the screens are migrated against this by Agent C)
// ---------------------------------------------------------------------------

export interface BridgeStatus {
  connected: boolean
  product?: string
  project?: string
  timeline?: string
  timecode?: string
  fps?: number
  width?: number
  height?: number
  colorSpace?: string
  capabilities?: string[]
  bridgeCompatible?: boolean
  compatibilityError?: string
}

// A grab result ready for the reference grids. ok:true → real bytes were
// captured (blobUrl set, caller owns/revokes it); ok:false → bridge down or
// nothing under the playhead. Failed grabs never masquerade as media.
export interface Grab {
  ok: boolean
  blobUrl?: string
  name: string // e.g. "Reels · 00:00:16:15"
  timecode: string // "00:00:16:15" or '—' when unknown
  error?: string
  captureKind?: 'source' | 'timeline-output'
  sourceKind?: 'still-image' | 'video' | 'audio' | 'generated' | 'unknown'
  trimmed?: boolean
  sourceStartFrame?: number
  sourceEndFrame?: number
  durationSeconds?: number
  captureEdge?: 'start' | 'end'
  originalTimecode?: string
  projectId?: string
  timelineId?: string
  itemId?: string
  itemStartFrame?: number
  itemEndFrame?: number
  mediaPoolItemId?: string
  timelineFps?: number
  captureFrame?: number
  trackType?: string
  trackIndex?: number
}

export interface ResolvePlacementAnchor {
  itemId: string
  startFrame: number
  endFrame: number
  sourceStartFrame?: number
  sourceEndFrame?: number
  mediaPoolItemId?: string
  trackIndex?: number
}

export interface PlaceInput {
  url: string
  name: string
  kind: 'image' | 'video' | 'audio'
  placement?: 'playhead' | 'replace' | 'append' | 'media-pool'
  recordFrame?: number
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
export interface PlaceResult {
  ok: boolean
  path?: string
  error?: string
}

export interface BeatMarkerInput {
  time: number
  confidence: number
  name: string
}

export interface BeatMarkerUndoToken {
  path: string
  target: 'timeline' | 'media-pool'
  customData: string[]
}

export interface BeatMarkerApplyResult {
  ok: boolean
  target?: 'timeline' | 'media-pool'
  applied?: number
  fps?: number
  operationId?: string
  undoToken?: BeatMarkerUndoToken
  error?: string
}

// ---------------------------------------------------------------------------
// Status cache + subscription
// ---------------------------------------------------------------------------

// Held by reference so a `useSyncExternalStore` snapshot stays stable — we only
// swap in a new object when the JSON actually changes (see refreshStatus).
let status: BridgeStatus = { connected: false }
const listeners = new Set<() => void>()

// Poll only while someone is listening, so an idle panel makes no traffic.
const POLL_MS = 5000
// The current bridge deliberately gives Resolve initialization up to three
// seconds.  Keep the renderer deadline above that server-side bound; the old
// 1.5s timeout made a healthy cold bridge look disconnected on first launch.
const STATUS_TIMEOUT_MS = 4500
const REQUIRED_BRIDGE_CAPABILITIES = ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'] as const
const BRIDGE_UPDATE_REQUIRED = 'EasyField Resolve integration is outdated — install the current plugin before using timeline or Media Pool actions'
let pollTimer: ReturnType<typeof setInterval> | null = null

function notify() {
  for (const cb of listeners) cb()
}

// Fetch with an AbortController timeout. Rejects on timeout/network like fetch.
async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 1500): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Percent-decode a response header, tolerating malformed input.
function decodeHeader(res: Response, name: string): string | undefined {
  const raw = res.headers.get(name)
  if (raw == null) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

async function refreshStatus(): Promise<BridgeStatus> {
  let next: BridgeStatus
  try {
    const res = await fetchWithTimeout('/bridge/status', {}, STATUS_TIMEOUT_MS)
    // The server answers 200 even when Resolve is closed; a non-ok here means
    // the bridge itself is unreachable → treat as disconnected.
    if (!res.ok) throw new Error(`status ${res.status}`)
    const json = (await res.json()) as BridgeStatus
    const reportedConnected = !!json.connected
    const capabilities = Array.isArray(json.capabilities) ? json.capabilities : []
    const bridgeCompatible = !reportedConnected || REQUIRED_BRIDGE_CAPABILITIES.every((capability) => capabilities.includes(capability))
    next = {
      ...json,
      capabilities,
      // A pre-capability bridge can append directly to a user track while
      // ignoring the requested placement mode. Never advertise it as usable.
      connected: reportedConnected && bridgeCompatible,
      bridgeCompatible,
      compatibilityError: reportedConnected && !bridgeCompatible ? BRIDGE_UPDATE_REQUIRED : undefined,
    }
  } catch {
    next = { connected: false }
  }
  // Only replace the cached object (and notify) when something actually changed,
  // so useSyncExternalStore keeps a stable snapshot between real updates.
  if (JSON.stringify(next) !== JSON.stringify(status)) {
    status = next
    notify()
  }
  return status
}

function startPolling() {
  if (pollTimer != null) return
  pollTimer = setInterval(() => void refreshStatus(), POLL_MS)
}

function stopPolling() {
  if (pollTimer == null) return
  clearInterval(pollTimer)
  pollTimer = null
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) startPolling()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) stopPolling()
  }
}

// ---------------------------------------------------------------------------
// Grabs (frame / clip / audio)
// ---------------------------------------------------------------------------

// The server caps clip/audio extraction at 30s and rendered boundaries at 20s.
// Keep the renderer above both so a healthy queued operation is not abandoned
// while it is still allowed to run server-side.
const GRAB_TIMEOUT_MS = 35000

// Turn a successful grab response into real local bytes. Errors are returned as
// structured failures so callers can explain the problem without creating a
// fake Library artifact.
async function grab(
  endpoint: string,
  preferName: boolean,
  requiredCapability?: string,
  capabilityLabel = 'rendered timeline frame',
  timeoutMs = GRAB_TIMEOUT_MS,
): Promise<Grab> {
  if (status.compatibilityError) {
    return { ok: false, name: 'Timeline', timecode: status.timecode ?? '—', error: status.compatibilityError }
  }
  if (requiredCapability && status.connected && !status.capabilities?.includes(requiredCapability)) {
    return {
      ok: false,
      name: 'Timeline',
      timecode: status.timecode ?? '—',
      error: `Update the EasyField Resolve integration to capture the ${capabilityLabel}.`,
    }
  }
  try {
    const res = await fetchWithTimeout(endpoint, {}, timeoutMs)
    const contentType = res.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('application/json')) {
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (payload?.ok === false) throw new Error(payload.error || 'Timeline capture is unavailable')
      if (!res.ok) throw new Error(payload?.error || `Timeline capture failed (${res.status})`)
      throw new Error('Resolve returned an invalid capture response')
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(payload?.error || `Timeline capture failed (${res.status})`)
    }
    const blob = await res.blob()
    if (!blob.size) throw new Error('Resolve returned an empty capture')
    const blobUrl = URL.createObjectURL(blob)
    const timecode = decodeHeader(res, 'X-EF-Timecode') || '—'
    const nameHeader = decodeHeader(res, 'X-EF-Name')
    const timelineHeader = decodeHeader(res, 'X-EF-Timeline')
    const numericHeader = (name: string): number | undefined => {
      const raw = decodeHeader(res, name)
      if (raw == null || raw === '') return undefined
      const value = Number(raw)
      return Number.isFinite(value) ? value : undefined
    }
    // Frame grabs are labelled by the timeline; clip/audio prefer the clip name.
    const label = (preferName ? nameHeader || timelineHeader : timelineHeader) || 'Timeline'
    const captureKind = decodeHeader(res, 'X-EF-Capture-Kind')
    const sourceKind = decodeHeader(res, 'X-EF-Source-Kind')
    return {
      ok: true,
      blobUrl,
      name: `${label} · ${timecode}`,
      timecode,
      captureKind: captureKind === 'timeline-output' ? 'timeline-output' : 'source',
      sourceKind: sourceKind === 'still-image'
        ? 'still-image'
        : sourceKind === 'video'
          ? 'video'
          : sourceKind === 'audio'
            ? 'audio'
          : sourceKind === 'generated'
            ? 'generated'
            : sourceKind === 'unknown'
              ? 'unknown'
              : undefined,
      trimmed: decodeHeader(res, 'X-EF-Trimmed') === 'true',
      sourceStartFrame: numericHeader('X-EF-Source-Start-Frame'),
      sourceEndFrame: numericHeader('X-EF-Source-End-Frame'),
      durationSeconds: numericHeader('X-EF-Duration-Seconds'),
      captureEdge: decodeHeader(res, 'X-EF-Capture-Edge') === 'start'
        ? 'start'
        : decodeHeader(res, 'X-EF-Capture-Edge') === 'end'
          ? 'end'
          : undefined,
      originalTimecode: decodeHeader(res, 'X-EF-Original-Timecode'),
      projectId: decodeHeader(res, 'X-EF-Project-Id'),
      timelineId: decodeHeader(res, 'X-EF-Timeline-Id'),
      itemId: decodeHeader(res, 'X-EF-Item-Id'),
      itemStartFrame: numericHeader('X-EF-Item-Start-Frame'),
      itemEndFrame: numericHeader('X-EF-Item-End-Frame'),
      mediaPoolItemId: decodeHeader(res, 'X-EF-Media-Pool-Item-Id'),
      timelineFps: numericHeader('X-EF-Timeline-Fps'),
      captureFrame: numericHeader('X-EF-Capture-Frame'),
      trackType: decodeHeader(res, 'X-EF-Track-Type'),
      trackIndex: numericHeader('X-EF-Track-Index'),
    }
  } catch (error) {
    // Bridge down or nothing under the playhead — refresh in the background so
    // the status badge catches up, but never invent a successful capture.
    void refreshStatus()
    const timecode = status.timecode ?? '—'
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'Timeline capture timed out'
      : error instanceof TypeError
        ? 'Resolve bridge is unavailable'
        : error instanceof Error
          ? error.message
          : 'Timeline capture failed'
    return { ok: false, name: 'Timeline', timecode, error: message }
  }
}

// ---------------------------------------------------------------------------
// Place onto the timeline
// ---------------------------------------------------------------------------

const PLACE_TIMEOUT_MS = 120000 // the server may download a large video first

const BRIDGE_DOWN = 'Bridge not running — start EasyField from DaVinci or npm run plugin:start'
const MANAGED_ARTIFACT_PATH = /^\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

function classifyPlacementUrl(url: string): { artifactId?: string; invalidManagedArtifact?: boolean } {
  const match = MANAGED_ARTIFACT_PATH.exec(url)
  if (match) return { artifactId: match[1] }
  // Never let a malformed same-origin Artifact Store path fall through to the
  // generic URL downloader. Main accepts only the opaque id for managed media.
  if (/^\/artifacts(?:\/|$)/i.test(url)) return { invalidManagedArtifact: true }
  return {}
}

function fallbackContentType(kind: PlaceInput['kind']): string {
  return kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mp4' : 'video/mp4'
}

async function placeToTimeline(input: PlaceInput): Promise<PlaceResult> {
  if (status.compatibilityError) return { ok: false, error: status.compatibilityError }
  const requestedPlacement = input.placement ?? 'playhead'
  const usesManagedInterval = requestedPlacement !== 'append' && requestedPlacement !== 'media-pool'
  if (usesManagedInterval && status.connected && !status.capabilities?.includes('place-interval-safe')) {
    return { ok: false, error: 'Update the EasyField Resolve integration before placing media on a managed timeline track.' }
  }
  if (usesManagedInterval && input.kind === 'video' && status.connected && !status.capabilities?.includes('place-linked-av')) {
    return { ok: false, error: 'Update the EasyField Resolve integration before placing video with preserved embedded audio.' }
  }
  const placementSource = classifyPlacementUrl(input.url)
  if (placementSource.invalidManagedArtifact) {
    return { ok: false, error: 'Invalid managed Library artifact reference.' }
  }
  if (placementSource.artifactId && status.connected && !status.capabilities?.includes('place-managed-artifact')) {
    return { ok: false, error: 'Update the EasyField Resolve integration before placing a saved Library artifact.' }
  }
  if (input.recordFrame != null && status.connected && !status.capabilities?.includes('place-at-frame')) {
    return { ok: false, error: 'Update the EasyField Resolve integration to place media at an exact captured frame.' }
  }
  if (input.anchorItemId && status.connected && !status.capabilities?.includes('validate-placement-anchor')) {
    return { ok: false, error: 'Update the EasyField Resolve integration before placing timed Foley against a captured clip.' }
  }
  const hasDetailedAnchor = input.anchorItemSourceStartFrame != null
    || input.anchorItemSourceEndFrame != null
    || !!input.anchorMediaPoolItemId
    || input.anchorTrackIndex != null
    || !!input.validationAnchors?.length
  if (hasDetailedAnchor && status.connected && !status.capabilities?.includes('validate-placement-anchor-v2')) {
    return { ok: false, error: 'Update the EasyField Resolve integration before placing against a verified captured shot.' }
  }
  try {
    let res: Response
    if (input.url.startsWith('blob:')) {
      // Binary mode: hand the raw bytes to the server (it can't fetch a blob: URL).
      const blob = await fetch(input.url).then((r) => r.blob())
      res = await fetchWithTimeout(
        '/bridge/place',
        {
          method: 'POST',
          headers: {
            'Content-Type': blob.type || fallbackContentType(input.kind),
            'X-EF-Name': encodeURIComponent(input.name), // Hebrew-safe
            'X-EF-Kind': input.kind,
            'X-EF-Placement': input.placement ?? 'playhead',
            ...(input.recordFrame != null ? { 'X-EF-Record-Frame': String(input.recordFrame) } : {}),
            ...(input.projectId ? { 'X-EF-Project-Id': input.projectId } : {}),
            ...(input.timelineId ? { 'X-EF-Timeline-Id': input.timelineId } : {}),
            ...(input.anchorItemId ? { 'X-EF-Anchor-Item-Id': input.anchorItemId } : {}),
            ...(input.anchorItemStartFrame != null ? { 'X-EF-Anchor-Item-Start-Frame': String(input.anchorItemStartFrame) } : {}),
            ...(input.anchorItemEndFrame != null ? { 'X-EF-Anchor-Item-End-Frame': String(input.anchorItemEndFrame) } : {}),
            ...(input.anchorItemSourceStartFrame != null ? { 'X-EF-Anchor-Source-Start-Frame': String(input.anchorItemSourceStartFrame) } : {}),
            ...(input.anchorItemSourceEndFrame != null ? { 'X-EF-Anchor-Source-End-Frame': String(input.anchorItemSourceEndFrame) } : {}),
            ...(input.anchorMediaPoolItemId ? { 'X-EF-Anchor-Media-Pool-Item-Id': input.anchorMediaPoolItemId } : {}),
            ...(input.anchorTrackIndex != null ? { 'X-EF-Anchor-Track-Index': String(input.anchorTrackIndex) } : {}),
            ...(input.validationAnchors?.length
              ? { 'X-EF-Validation-Anchors': encodeURIComponent(JSON.stringify(input.validationAnchors)) }
              : {}),
          },
          body: blob,
        },
        PLACE_TIMEOUT_MS,
      )
    } else {
      // JSON mode: public provider media is downloaded by Main. Managed Library
      // media sends only its opaque artifactId; renderer filesystem paths are
      // neither known nor accepted by the privileged host.
      res = await fetchWithTimeout(
        '/bridge/place',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(placementSource.artifactId
              ? { artifactId: placementSource.artifactId }
              : { url: input.url }),
            name: input.name,
            kind: input.kind,
            placement: input.placement ?? 'playhead',
            recordFrame: input.recordFrame,
            projectId: input.projectId,
            timelineId: input.timelineId,
            anchorItemId: input.anchorItemId,
            anchorItemStartFrame: input.anchorItemStartFrame,
            anchorItemEndFrame: input.anchorItemEndFrame,
            anchorItemSourceStartFrame: input.anchorItemSourceStartFrame,
            anchorItemSourceEndFrame: input.anchorItemSourceEndFrame,
            anchorMediaPoolItemId: input.anchorMediaPoolItemId,
            anchorTrackIndex: input.anchorTrackIndex,
            validationAnchors: input.validationAnchors,
          }),
        },
        PLACE_TIMEOUT_MS,
      )
    }
    const json = (await res.json().catch(() => null)) as PlaceResult | null
    if (!res.ok || !json) return { ok: false, error: json?.error || `Place failed (${res.status})` }
    return { ok: !!json.ok, path: json.path, error: json.error }
  } catch {
    return { ok: false, error: BRIDGE_DOWN }
  }
}

async function applyBeatMarkers(input: {
  path: string
  target: 'timeline' | 'media-pool'
  analysisId: string
  color: string
  markers: BeatMarkerInput[]
}): Promise<BeatMarkerApplyResult> {
  if (status.compatibilityError) return { ok: false, error: status.compatibilityError }
  if (status.connected && !status.capabilities?.includes('beat-markers')) {
    return { ok: false, error: 'Update the EasyField Resolve integration to import Beat Detection markers.' }
  }
  try {
    const response = await fetchWithTimeout('/bridge/beat/apply-markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }, 30000)
    const result = (await response.json().catch(() => null)) as BeatMarkerApplyResult | null
    return response.ok && result ? result : { ok: false, error: result?.error || `Marker apply failed (${response.status})` }
  } catch {
    return { ok: false, error: BRIDGE_DOWN }
  }
}

async function undoBeatMarkers(token: BeatMarkerUndoToken): Promise<{ ok: boolean; removed?: number; error?: string }> {
  try {
    const response = await fetchWithTimeout('/bridge/beat/undo-markers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token),
    }, 30000)
    const result = (await response.json().catch(() => null)) as { ok?: boolean; removed?: number; error?: string } | null
    return response.ok && result ? { ok: result.ok === true, removed: result.removed, error: result.error } : { ok: false, error: result?.error || `Marker undo failed (${response.status})` }
  } catch {
    return { ok: false, error: BRIDGE_DOWN }
  }
}

function revokeGrabBlob(result: Grab): void {
  if (result.blobUrl) URL.revokeObjectURL(result.blobUrl)
}

async function grabUpscaleSource(): Promise<Grab> {
  // The image-aware endpoint is the only safe classifier: for a still it sends
  // original source bytes, while for a video it identifies the exact item but
  // returns only a rendered probe frame. A video is therefore captured again
  // through the strict trimmed-source endpoint below.
  const probe = await grab(
    '/bridge/grab/edit-image-source',
    true,
    'grab-edit-image-source',
    'Upscale source under the playhead',
  )
  if (!probe.ok || !probe.blobUrl) return probe
  if (probe.sourceKind === 'still-image') return probe
  if (probe.sourceKind !== 'video') {
    revokeGrabBlob(probe)
    return {
      ok: false,
      name: probe.name,
      timecode: probe.timecode,
      error: 'Upscale Grab supports a file-backed still image or video clip under the playhead.',
    }
  }

  revokeGrabBlob(probe)
  const video = await grab(
    '/bridge/grab/edit-video-source',
    true,
    'grab-edit-video-source',
    'exact trimmed Upscale video source under the playhead',
    122000,
  )
  if (!video.ok || !video.blobUrl) return video

  const identityKeys = ['projectId', 'timelineId', 'itemId'] as const
  const missingIdentity = identityKeys.some((key) => !probe[key] || !video[key])
  const changedIdentity = identityKeys.some((key) => probe[key] !== video[key])
  if (missingIdentity || changedIdentity || video.sourceKind !== 'video') {
    revokeGrabBlob(video)
    return {
      ok: false,
      name: video.name,
      timecode: video.timecode,
      error: missingIdentity
        ? 'Update the EasyField Resolve integration before using adaptive Upscale Grab.'
        : 'The timeline source changed during capture. Keep the playhead on one clip and try again.',
    }
  }
  return video
}

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

export const resolve = {
  isBridgeConnected: (): boolean => status.connected,
  getStatus: (): BridgeStatus => status,
  refreshStatus,
  subscribe,
  getTimelineName: (): string => status.timeline || 'Timeline',
  grabFrame: (): Promise<Grab> => grab('/bridge/grab/frame', false),
  grabEditImageSource: (): Promise<Grab> => grab(
    '/bridge/grab/edit-image-source',
    true,
    'grab-edit-image-source',
    'Edit Image source under the playhead',
  ),
  grabEditVideoSource: (): Promise<Grab> => grab(
    '/bridge/grab/edit-video-source',
    true,
    'grab-edit-video-source',
    'trimmed Edit Video source under the playhead',
    122000,
  ),
  grabUpscaleSource,
  grabShotStartFrame: (): Promise<Grab> => grab('/bridge/grab/shot-start-frame', true, 'grab-shot-start-frame', 'rendered shot start frame'),
  grabShotEndFrame: (): Promise<Grab> => grab('/bridge/grab/shot-end-frame', true, 'grab-shot-end-frame', 'rendered shot end frame'),
  grabClip: (): Promise<Grab> => grab('/bridge/grab/clip', true),
  grabAudio: (): Promise<Grab> => grab('/bridge/grab/audio', true),
  applyBeatMarkers,
  undoBeatMarkers,
  placeToTimeline,
}

// Kick a first status read on module load so the badge is warm by first paint.
void refreshStatus()
