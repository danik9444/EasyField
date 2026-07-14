import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { Icon } from '../icons'
import { ChipField } from '../components/ChipField'
import { GenerationBatchCancelControl, useGenerationBatchJobControl } from '../components/GenerationCancelControl'
import { LibraryPickerButton } from '../components/LibraryPicker'
import { Lightbox } from '../components/Lightbox'
import { PriceEstimate } from '../components/PriceEstimate'
import { ProviderLogo } from '../components/ProviderLogo'
import { addCreations, type Creation } from '../data/creations'
import {
  formatCharged,
  formatEstimate,
  resolveCharged,
  upscaleBatchEstimate,
  upscaleRunEstimate,
} from '../data/pricing'
import type { MediaFile, ReferenceImage } from '../data/referenceImage'
import {
  TOPAZ_IMAGE_MODEL,
  TOPAZ_VIDEO_MODEL,
  topazFactorsForSource,
  topazModelForKind,
  topazUploadName,
  validateTopazSource,
  type UpscaleMediaKind,
} from '../data/upscale'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { resolve } from '../services/resolve'
import { canBackgroundJob, getJobs } from '../services/jobCenter'
import {
  isConnected,
  isGenerationExit,
  runUpscaleBatch,
  saveUrl,
  type UpscaleBatchItemResult,
} from '../services/run'
import { getSpendApproval } from '../services/spendGuard'
import { mapLimit } from '../services/taskQueue'
import { sendToTimeline } from '../services/timeline'
import { loadSettings } from '../settings'

const SOURCE_ACCEPT = '.jpg,.jpeg,.png,.webp,.mp4,.mov,.mkv,image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/x-matroska'
const PREFERS_FACTOR = '2×'
const SOURCE_LOAD_CONCURRENCY = 3

type Phase = 'form' | 'generating'
type SourceOrigin = 'upload' | 'library' | 'timeline'
type ItemStatus = 'ready' | 'running' | 'done' | 'error' | 'pending'

interface UpscaleItem {
  id: string
  mediaKind: UpscaleMediaKind
  name: string
  uploadName: string
  url: string
  mimeType: string
  byteSize: number
  width?: number
  height?: number
  durationSeconds?: number
  origin: SourceOrigin
  trimmed?: boolean
  factor: string
  status: ItemStatus
  resultUrls: string[]
  charged: number | null
  error?: string
}

interface PendingSource {
  id: string
  origin: SourceOrigin
  displayName?: string
  getFile: () => Promise<File>
}

interface UpscaleProps {
  onBack: () => void
  toast: (message: string) => void
  onSpend: (credits: number) => void
}

function readableBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function readableDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return minutes ? `${minutes}:${remainder.toFixed(0).padStart(2, '0')}` : `${remainder.toFixed(remainder < 10 ? 2 : 1)}s`
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob)
    const result = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    if (!result.width || !result.height) throw new Error('empty image')
    return result
  } catch {
    throw new Error('The selected image could not be decoded.')
  }
}

async function videoMetadata(url: string): Promise<{ width?: number; height?: number; durationSeconds?: number }> {
  return await new Promise((resolveMetadata) => {
    const video = document.createElement('video')
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      const width = Number(video.videoWidth) || undefined
      const height = Number(video.videoHeight) || undefined
      const durationSeconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined
      video.removeAttribute('src')
      video.load()
      resolveMetadata({ width, height, durationSeconds })
    }
    const timer = window.setTimeout(finish, 8000)
    video.preload = 'metadata'
    video.onloadedmetadata = finish
    video.onerror = finish
    video.src = url
    video.load()
  })
}

function sourceBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[a-z0-9]{2,5}$/i, '').trim()
  const safe = withoutExtension
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  return safe || 'easyfield-upscale'
}

function resultName(item: UpscaleItem, resultIndex = 0): string {
  const factor = item.factor.replace('×', 'x')
  const identity = item.id.replace(/[^a-z0-9]/gi, '').slice(-6) || String(resultIndex + 1).padStart(2, '0')
  const suffix = item.resultUrls.length > 1 ? `-${resultIndex + 1}` : ''
  return `${sourceBaseName(item.name)}-topaz-${factor}-${identity}${suffix}.${item.mediaKind === 'image' ? 'png' : 'mp4'}`
}

function sourceMeta(item: UpscaleItem): string[] {
  return [
    item.width && item.height ? `${item.width} × ${item.height}` : null,
    readableDuration(item.durationSeconds),
    readableBytes(item.byteSize),
    item.origin === 'timeline'
      ? item.mediaKind === 'video' ? 'EXACT TIMELINE CUT' : 'ORIGINAL STILL SOURCE'
      : item.origin.toUpperCase(),
  ].filter((value): value is string => !!value)
}

function statusLabel(status: ItemStatus): string {
  if (status === 'running') return 'UPSCALING'
  if (status === 'done') return 'SAVED'
  if (status === 'error') return 'NEEDS ATTENTION'
  if (status === 'pending') return 'IN ACTIVITY'
  return 'READY'
}

function toRunSource(item: UpscaleItem): ReferenceImage | MediaFile {
  return item.mediaKind === 'image'
    ? {
        id: item.id,
        kind: 'upload',
        name: item.uploadName,
        url: item.url,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        width: item.width,
        height: item.height,
      }
    : {
        id: item.id,
        kind: 'upload',
        name: item.uploadName,
        url: item.url,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        durationSeconds: item.durationSeconds,
        width: item.width,
        height: item.height,
      }
}

export function Upscale({ onBack, toast, onSpend }: UpscaleProps) {
  const [phase, setPhase] = useState<Phase>('form')
  const [items, setItems] = useState<UpscaleItem[]>([])
  const [sourceBusy, setSourceBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const addFilesButtonRef = useRef<HTMLButtonElement>(null)
  const sourceCardRef = useRef<HTMLElement>(null)
  const itemsRef = useRef<UpscaleItem[]>([])
  const loadIdRef = useRef(0)
  const sourceQueueRef = useRef<Promise<void>>(Promise.resolve())
  const sourceLoadCountRef = useRef(0)
  const activeRunRef = useRef(false)
  const activeBatchIdsRef = useRef(new Set<string>())
  const itemJobIdsRef = useRef(new Map<string, string>())
  const unmountedRef = useRef(false)
  const idRef = useRef(1)
  const runIdRef = useRef(0)
  const savedResultUrlsRef = useRef(new Set<string>())
  const generation = useGenerationBatchJobControl()

  const commitItems = useCallback((update: (current: UpscaleItem[]) => UpscaleItem[]) => {
    setItems((current) => {
      const next = update(current)
      itemsRef.current = next
      return next
    })
  }, [])

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      loadIdRef.current += 1
      if (!activeRunRef.current) itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url))
    }
  }, [])

  const nextSourceId = useCallback(() => `upscale-source-${Date.now()}-${idRef.current++}`, [])

  const buildItem = useCallback(async (
    id: string,
    blob: Blob,
    url: string,
    name: string,
    origin: SourceOrigin,
    expectedKind?: UpscaleMediaKind,
    trimmed?: boolean,
  ): Promise<UpscaleItem> => {
    const validationName = name || topazUploadName(expectedKind ?? 'image', blob.type)
    const validated = validateTopazSource({ name: validationName, type: blob.type, size: blob.size }, expectedKind)
    const metadata: { width?: number; height?: number; durationSeconds?: number } = validated.kind === 'image'
      ? await imageDimensions(blob)
      : await videoMetadata(url)
    const factors = topazFactorsForSource(validated.kind, metadata.width, metadata.height)
    if (!factors.length) throw new Error('This image already exceeds Topaz’s 20,000 px input/output boundary.')
    return {
      id,
      mediaKind: validated.kind,
      name: name || validationName,
      uploadName: topazUploadName(validated.kind, validated.mimeType),
      url,
      mimeType: validated.mimeType,
      byteSize: validated.byteSize,
      width: metadata.width,
      height: metadata.height,
      durationSeconds: metadata.durationSeconds,
      origin,
      trimmed,
      factor: factors.includes(PREFERS_FACTOR) ? PREFERS_FACTOR : factors[0],
      status: 'ready',
      resultUrls: [],
      charged: null,
    }
  }, [])

  const loadPendingSources = useCallback(async (pending: PendingSource[]) => {
    const loadId = loadIdRef.current
    const outcomes = await mapLimit(pending, SOURCE_LOAD_CONCURRENCY, async (entry) => {
      let url: string | null = null
      try {
        const file = await entry.getFile()
        url = URL.createObjectURL(file)
        const item = await buildItem(entry.id, file, url, entry.displayName || file.name, entry.origin)
        return { item, error: null as string | null }
      } catch (reason) {
        if (url) URL.revokeObjectURL(url)
        return { item: null, error: reason instanceof Error ? reason.message : 'The source could not be loaded.' }
      }
    })

    if (loadId !== loadIdRef.current || unmountedRef.current) {
      outcomes.forEach(({ item }) => { if (item) URL.revokeObjectURL(item.url) })
      return
    }

    const added = outcomes.flatMap(({ item }) => item ? [item] : [])
    const failures = outcomes.flatMap(({ error: reason }) => reason ? [reason] : [])
    if (added.length) {
      commitItems((current) => [...current, ...added])
      const imageCount = added.filter((item) => item.mediaKind === 'image').length
      const videoCount = added.length - imageCount
      const detail = [imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '', videoCount ? `${videoCount} video${videoCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
      toast(`${added.length} source${added.length === 1 ? '' : 's'} added · ${detail}`)
    }
    if (failures.length) {
      const message = `${failures.length} source${failures.length === 1 ? '' : 's'} skipped · ${failures[0]}`
      setError(message)
      toast(message)
    }
  }, [buildItem, commitItems, toast])

  const appendPendingSources = useCallback((pending: PendingSource[]): Promise<void> => {
    if (!pending.length || activeRunRef.current) return Promise.resolve()
    sourceLoadCountRef.current += 1
    setSourceBusy(true)
    setError(null)
    const execute = async () => {
      try {
        await loadPendingSources(pending)
      } finally {
        sourceLoadCountRef.current = Math.max(0, sourceLoadCountRef.current - 1)
        if (!unmountedRef.current && sourceLoadCountRef.current === 0) setSourceBusy(false)
      }
    }
    const scheduled = sourceQueueRef.current.then(execute, execute)
    sourceQueueRef.current = scheduled.catch(() => undefined)
    return scheduled
  }, [loadPendingSources])

  const addFiles = useCallback(async (files: File[], origin: SourceOrigin = 'upload') => {
    await appendPendingSources(files.map((file) => ({
      id: nextSourceId(),
      origin,
      displayName: file.name,
      getFile: async () => file,
    })))
  }, [appendPendingSources, nextSourceId])

  const chooseLibrary = async (creations: Creation[]) => {
    await appendPendingSources(creations.map((creation) => ({
      id: nextSourceId(),
      origin: 'library' as const,
      displayName: creation.prompt?.trim() || creation.model?.trim() || `${creation.kind} Library item`,
      getFile: () => copyLibraryCreationForWorkspace(creation),
    })))
  }

  const grabSource = async () => {
    if (activeRunRef.current || sourceLoadCountRef.current > 0) return
    const loadId = loadIdRef.current
    sourceLoadCountRef.current += 1
    setSourceBusy(true)
    setError(null)
    let grabbed: Awaited<ReturnType<typeof resolve.grabUpscaleSource>> | null = null
    try {
      grabbed = await resolve.grabUpscaleSource()
      if (loadId !== loadIdRef.current || unmountedRef.current) {
        if (grabbed.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
        return
      }
      if (!grabbed.ok || !grabbed.blobUrl || (grabbed.sourceKind !== 'still-image' && grabbed.sourceKind !== 'video')) {
        const message = grabbed.error || 'Place the playhead over a file-backed image or video clip.'
        setError(message)
        toast(`Upscale Grab failed · ${message}`)
        return
      }
      const response = await fetch(grabbed.blobUrl)
      if (!response.ok) throw new Error(`Captured media could not be read (${response.status}).`)
      const blob = await response.blob()
      const kind: UpscaleMediaKind = grabbed.sourceKind === 'still-image' ? 'image' : 'video'
      const next = await buildItem(nextSourceId(), blob, grabbed.blobUrl, grabbed.name, 'timeline', kind, grabbed.trimmed)
      if (loadId !== loadIdRef.current || unmountedRef.current) {
        URL.revokeObjectURL(grabbed.blobUrl)
        return
      }
      commitItems((current) => [...current, next])
      toast(kind === 'image'
        ? 'Original still source added · Topaz Image selected'
        : `Exact trimmed timeline clip added${grabbed.durationSeconds ? ` · ${grabbed.durationSeconds.toFixed(2)}s` : ''} · Topaz Video selected`)
    } catch (reason) {
      if (grabbed?.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
      const message = reason instanceof Error ? reason.message : 'Captured media could not be loaded.'
      setError(message)
      toast(message)
    } finally {
      sourceLoadCountRef.current = Math.max(0, sourceLoadCountRef.current - 1)
      if (loadId === loadIdRef.current && !unmountedRef.current && sourceLoadCountRef.current === 0) setSourceBusy(false)
    }
  }

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length) void addFiles(files)
  }

  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    if (activeRunRef.current) return
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length) void addFiles(files)
  }

  const removeItem = (id: string) => {
    if (activeRunRef.current) return
    const itemIndex = itemsRef.current.findIndex((candidate) => candidate.id === id)
    const item = itemsRef.current[itemIndex]
    if (!item) return
    if (lightbox === item.url || item.resultUrls.includes(lightbox ?? '')) setLightbox(null)
    URL.revokeObjectURL(item.url)
    commitItems((current) => current.filter((candidate) => candidate.id !== id))
    window.requestAnimationFrame(() => {
      const remaining = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-upscale-remove]'))
      remaining[Math.min(itemIndex, remaining.length - 1)]?.focus()
      if (!remaining.length) addFilesButtonRef.current?.focus()
    })
  }

  const setFactor = (id: string, factor: string) => {
    if (activeRunRef.current) return
    commitItems((current) => current.map((item) => {
      if (item.id !== id || item.status === 'running' || item.status === 'pending') return item
      const factors = topazFactorsForSource(item.mediaKind, item.width, item.height)
      if (!factors.includes(factor)) return item
      return { ...item, factor, status: 'ready', resultUrls: [], charged: null, error: undefined }
    }))
  }

  const prepareAgain = (id: string) => {
    if (activeRunRef.current) return
    commitItems((current) => current.map((item) => item.id === id
      ? { ...item, status: 'ready', resultUrls: [], charged: null, error: undefined }
      : item))
  }

  const saveCompletedItem = useCallback((result: UpscaleBatchItemResult, runId: number) => {
    const source = itemsRef.current.find((item) => item.id === result.id)
    if (!source) return
    const freshUrls = result.urls.filter((url) => {
      const resultIdentity = `${runId}:${result.id}:${url}`
      if (savedResultUrlsRef.current.has(resultIdentity)) return false
      savedResultUrlsRef.current.add(resultIdentity)
      return true
    })
    if (freshUrls.length) {
      addCreations(freshUrls.map((url) => ({
        kind: result.kind,
        url,
        model: result.model,
        prompt: `Topaz upscale · ${source.name}`,
        meta: [result.factor, source.width && source.height ? `${source.width}×${source.height} source` : null, source.origin === 'timeline' ? source.trimmed ? 'timeline cut' : 'timeline source' : source.origin].filter(Boolean).join(' · '),
        fromTimeline: source.origin === 'timeline',
      })))
    }
    const estimate = upscaleRunEstimate(source.mediaKind, result.factor, source)
    const charged = result.credits ?? resolveCharged(estimate)
    if (charged != null) onSpend(charged)
    if (!unmountedRef.current) {
      commitItems((current) => current.map((item) => item.id === result.id
        ? { ...item, status: 'done', resultUrls: result.urls, charged, error: undefined }
        : item))
    }
  }, [commitItems, onSpend])

  const runItems = async (onlyIds?: readonly string[]) => {
    if (activeRunRef.current || sourceBusy) return
    const idFilter = onlyIds ? new Set(onlyIds) : null
    const candidates = itemsRef.current.filter((item) => (
      (idFilter ? idFilter.has(item.id) : item.status === 'ready')
      && item.status !== 'running'
      && item.status !== 'pending'
    ))
    if (!candidates.length) return

    const candidateIds = new Set(candidates.map((item) => item.id))
    activeBatchIdsRef.current = candidateIds
    setError(null)
    commitItems((current) => current.map((item) => candidateIds.has(item.id)
      ? { ...item, status: 'running', resultUrls: [], charged: null, error: undefined }
      : item))
    setPhase('generating')
    const controller = generation.begin()
    const runId = ++runIdRef.current
    itemJobIdsRef.current = new Map()
    activeRunRef.current = true
    try {
      const result = await runUpscaleBatch(candidates.map((item) => ({
        id: item.id,
        sourceName: item.name,
        kind: item.mediaKind,
        source: toRunSource(item),
        factor: item.factor,
        width: item.width,
        height: item.height,
        durationSeconds: item.durationSeconds,
      })), {
        signal: controller.signal,
        onJobCreated: generation.attachJob,
        onItemJobCreated: (itemId, jobId) => itemJobIdsRef.current.set(itemId, jobId),
        onItemCompleted: async (completed) => saveCompletedItem(completed, runId),
      })

      if (!controller.signal.aborted && !unmountedRef.current) {
        const byId = new Map(result.items.map((item) => [item.id, item]))
        commitItems((current) => current.map((item) => {
          if (!candidateIds.has(item.id) || item.status === 'done') return item
          const outcome = byId.get(item.id)
          if (!outcome) return { ...item, status: 'error', error: 'Topaz returned no result for this source.' }
          if (outcome.urls.length) return { ...item, status: 'done', resultUrls: outcome.urls, charged: outcome.credits, error: undefined }
          return { ...item, status: outcome.pending ? 'pending' : 'error', error: outcome.error || 'Topaz returned no media result.' }
        }))
        if (result.failedJobs) toast(`${result.failedJobs} Upscale task${result.failedJobs === 1 ? '' : 's'} failed · completed results were kept`)
        if (result.pendingJobs) toast(`${result.pendingJobs} paid task${result.pendingJobs === 1 ? ' is' : 's are'} still tracked in Activity`)
      }
    } catch (reason) {
      if (!controller.signal.aborted && !isGenerationExit(reason) && !unmountedRef.current) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        commitItems((current) => current.map((item) => candidateIds.has(item.id) && item.status === 'running'
          ? { ...item, status: 'error', error: message }
          : item))
      }
    } finally {
      generation.finish(controller)
      activeRunRef.current = false
      activeBatchIdsRef.current = new Set()
      itemJobIdsRef.current = new Map()
      if (!unmountedRef.current) setPhase('form')
      else itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url))
    }
  }

  const exitGeneration = () => {
    const jobsById = new Map(getJobs().map((job) => [job.id, job]))
    const backgroundItemIds = new Set(
      Array.from(itemJobIdsRef.current.entries())
        .filter(([, jobId]) => {
          const job = jobsById.get(jobId)
          return !!job && canBackgroundJob(job)
        })
        .map(([itemId]) => itemId),
    )
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    commitItems((current) => current.map((item) => item.status === 'running'
      ? backgroundItemIds.has(item.id)
        ? { ...item, status: 'pending', error: 'Accepted work continues in Activity; unsubmitted work was stopped.' }
        : { ...item, status: 'ready', error: undefined }
      : item))
    toast(outcome === 'backgrounded'
      ? 'Accepted Topaz tasks continue in Activity · every finished result will be saved to Library'
      : 'Upscale batch cancelled before submission')
    window.requestAnimationFrame(() => sourceCardRef.current?.focus())
  }

  const importToMediaPool = async (item: UpscaleItem, url: string, index: number) => {
    const placed = await resolve.placeToTimeline({
      url,
      name: resultName(item, index),
      kind: item.mediaKind,
      placement: 'media-pool',
    })
    toast(placed.ok ? 'Upscaled result imported to Media Pool' : `Media Pool import failed · ${placed.error || 'check Resolve'}`)
  }

  const readyItems = items.filter((item) => item.status === 'ready')
  const completedCount = items.filter((item) => item.status === 'done').length
  const activeBatchTotal = activeBatchIdsRef.current.size
  const activeBatchCompleted = items.filter((item) => activeBatchIdsRef.current.has(item.id) && item.status === 'done').length
  const failedCount = items.filter((item) => item.status === 'error').length
  const pendingCount = items.filter((item) => item.status === 'pending').length
  const imageCount = items.filter((item) => item.mediaKind === 'image').length
  const videoCount = items.length - imageCount
  const estimate = upscaleBatchEstimate(readyItems.map((item) => ({
    kind: item.mediaKind,
    factor: item.factor,
    width: item.width,
    height: item.height,
    durationSeconds: item.durationSeconds,
  })))
  const connected = isConnected()
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const footerMessage = error
    ? `✕ ${error}`
    : sourceBusy
      ? 'Reading source media…'
      : !items.length
        ? 'Add any number of images or videos. Each source becomes one verified Topaz task.'
        : !connected
          ? 'Connect Kie.ai to run Topaz upscale.'
          : readyItems.length
            ? `${readyItems.length} ready · ${imageCount} image${imageCount === 1 ? '' : 's'} · ${videoCount} video${videoCount === 1 ? '' : 's'}`
            : failedCount
              ? `${failedCount} source${failedCount === 1 ? '' : 's'} need attention · retry from the source card`
              : pendingCount
                ? `${pendingCount} source${pendingCount === 1 ? '' : 's'} continue in Activity`
                : 'All results are saved · add more sources or upscale one again.'

  return (
    <div className="ef-screen ef-legacy-workspace ef-upscale-screen">
      <div className="ef-sub-header ef-upscale-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title"><small>EDIT · FOOTAGE</small>Upscale</span>
        <span className="ef-spacer" />
        <span className={'ef-upscale-header-model' + (items.length ? ' is-ready' : '')} aria-label="Topaz models are selected automatically for every source">
          <ProviderLogo brand="topaz" size={18} />
          <span><small>TOPAZ · AUTO</small><strong>{items.length ? `${items.length} source${items.length === 1 ? '' : 's'}` : 'Select sources'}</strong></span>
        </span>
      </div>

      <div className="ef-scroll ef-create-scroll ef-upscale-scroll">
        <section className="ef-upscale-intro" aria-label="Automatic Topaz batch selection">
          <span className="ef-upscale-intro-icon"><Icon glyph="up" size={20} /></span>
          <div><small>MULTIPLE SOURCES · ONE SAFE TASK EACH</small><strong>Improve a whole set without mixing up the media.</strong><p>Every still uses Topaz Image. Every video uses Topaz Video. Grab keeps original stills and exact visible timeline cuts.</p></div>
        </section>

        <section
          ref={sourceCardRef}
          tabIndex={-1}
          className={'ef-upscale-source-card' + (dragActive ? ' is-dragging' : '')}
          aria-labelledby="ef-upscale-source-title"
          onDragEnter={(event) => {
            event.preventDefault()
            if (!sourceBusy && phase !== 'generating') setDragActive(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragActive(false)
          }}
          onDrop={dropFiles}
        >
          <header>
            <div><small>01 · SOURCE QUEUE</small><strong id="ef-upscale-source-title">{items.length ? `${items.length} source${items.length === 1 ? '' : 's'} in this batch` : 'Choose images and videos'}</strong></div>
            {!!items.length && <span className="ef-upscale-source-counts"><b>{imageCount} IMG</b><b>{videoCount} VID</b></span>}
          </header>

          {!items.length ? (
            <div className={'ef-upscale-stage' + (dragActive ? ' is-dragging' : '')} aria-busy={sourceBusy}>
              <div className="ef-upscale-empty">
                <span><Icon glyph="up" size={24} /></span>
                <strong>{sourceBusy ? 'Reading sources…' : dragActive ? 'Drop all media here' : 'Drop images and videos here'}</strong>
                <p>JPG, PNG, WEBP up to 10 MB each · MP4, MOV, MKV up to 50 MB each</p>
              </div>
            </div>
          ) : (
            <div className="ef-upscale-queue">
              {items.map((item, itemIndex) => {
                const factors = topazFactorsForSource(item.mediaKind, item.width, item.height)
                const itemEstimate = upscaleRunEstimate(item.mediaKind, item.factor, item)
                const locked = item.status === 'running' || item.status === 'pending'
                return (
                  <article className={`ef-upscale-item is-${item.mediaKind} is-${item.status}`} key={item.id} aria-label={`${item.name}, ${statusLabel(item.status)}`}>
                    <header className="ef-upscale-item-head">
                      <span className="ef-upscale-item-index">{String(itemIndex + 1).padStart(2, '0')}</span>
                      <span className="ef-upscale-item-title"><small>{item.origin === 'timeline' ? 'TIMELINE' : item.origin.toUpperCase()}</small><strong title={item.name}>{item.name}</strong></span>
                      <span className={`ef-upscale-item-status is-${item.status}`}>{statusLabel(item.status)}</span>
                      <button type="button" className="ef-upscale-item-remove" data-upscale-remove disabled={phase === 'generating'} onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name}`}>×</button>
                    </header>

                    <div className="ef-upscale-item-body">
                      <div className="ef-upscale-item-source">
                        <div className="ef-upscale-item-preview">
                          {item.mediaKind === 'image' ? (
                            <button type="button" className="ef-upscale-image-preview" onClick={() => setLightbox(item.url)} aria-label={`Open ${item.name} preview`}><img src={item.url} alt={item.name} loading="lazy" /><span>⤢ View source</span></button>
                          ) : (
                            <video src={item.url} controls playsInline preload="none" aria-label={`Source video: ${item.name}`} />
                          )}
                        </div>
                        <div className="ef-upscale-source-meta">{sourceMeta(item).map((value) => <span key={value}>{value}</span>)}</div>
                      </div>

                      <div className="ef-upscale-item-settings">
                        <div className="ef-upscale-item-model"><ProviderLogo brand="topaz" size={17} /><span><small>AUTO MODEL</small><strong>{topazModelForKind(item.mediaKind)}</strong></span></div>
                        <fieldset disabled={locked || phase === 'generating'} className="ef-upscale-factor-fieldset">
                          <ChipField label="UPSCALE FACTOR" options={factors} selected={item.factor} onSelect={(value) => setFactor(item.id, value)} presentation="chips" />
                        </fieldset>
                        <div className="ef-upscale-item-price"><span>EST. ITEM COST</span><strong>{formatEstimate(itemEstimate)}</strong></div>
                        {item.error && <p className="ef-upscale-item-error" role="alert">{item.error}</p>}
                        {item.status === 'error' && <button type="button" className="ef-upscale-item-retry" disabled={phase === 'generating' || !connected} onClick={() => void runItems([item.id])}>↻ Retry this source</button>}
                        {item.status === 'pending' && <p className="ef-upscale-item-note">This paid task is owned by Activity. Its result will appear in Library when ready.</p>}
                      </div>
                    </div>

                    {item.resultUrls.length > 0 && (
                      <div className="ef-upscale-item-results">
                        <div className="ef-upscale-item-result-head"><span><small>TOPAZ RESULT</small><strong>Saved to Library</strong></span><span>{formatCharged(item.charged)}</span></div>
                        {item.resultUrls.map((url, resultIndex) => (
                          <div className="ef-upscale-item-result" key={url}>
                            {item.mediaKind === 'image' ? (
                              <button type="button" className="ef-upscale-image-preview" onClick={() => setLightbox(url)} aria-label={`Open upscaled result ${resultIndex + 1}`}><img src={url} alt={`Upscaled ${item.name}`} loading="lazy" /><span>⤢ Enlarge</span></button>
                            ) : (
                              <video src={url} controls playsInline preload="none" aria-label={`Upscaled Topaz result for ${item.name}`} />
                            )}
                            <div className="ef-upscale-result-actions">
                              <button type="button" onClick={() => saveUrl(url, resultName(item, resultIndex))}>↓ Download</button>
                              <button type="button" onClick={() => void importToMediaPool(item, url, resultIndex)}>＋ Media Pool</button>
                              <button type="button" className="is-primary" onClick={() => void sendToTimeline([{ url, name: resultName(item, resultIndex) }], item.mediaKind, toast)}>Send to timeline</button>
                            </div>
                          </div>
                        ))}
                        <button type="button" className="ef-upscale-again" disabled={phase === 'generating'} onClick={() => prepareAgain(item.id)}>↺ Upscale this source again</button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}

          <div className="ef-upscale-source-actions" role="group" aria-label="Add Upscale sources">
            <button ref={addFilesButtonRef} type="button" disabled={sourceBusy || phase === 'generating'} onClick={() => fileInputRef.current?.click()}><Icon glyph="up" size={12} /> {items.length ? 'Add files' : 'Upload'}</button>
            <LibraryPickerButton
              kinds={['image', 'video']}
              max={Number.POSITIVE_INFINITY}
              disabled={sourceBusy || phase === 'generating'}
              onSelect={chooseLibrary}
              className="ef-upscale-source-action ef-library-source-btn"
              ariaLabel="Choose images and videos from Library"
              pickerTitle="Choose media to upscale"
              pickerDescription="Choose any number of images and videos. EasyField creates one verified Topaz task for each source."
              confirmLabel="Add selected sources"
            />
            <button type="button" className="is-grab" disabled={sourceBusy || phase === 'generating'} onClick={() => void grabSource()} aria-label="Append an original still or exact trimmed video from the Resolve playhead"><Icon glyph="playhead" size={12} /> {sourceBusy ? 'Reading…' : 'Grab one'}</button>
          </div>
          <input ref={fileInputRef} type="file" accept={SOURCE_ACCEPT} multiple disabled={sourceBusy || phase === 'generating'} onChange={pickFiles} hidden />
        </section>

        <section className={'ef-upscale-settings' + (items.length ? ' is-ready' : '')} aria-labelledby="ef-upscale-settings-title">
          <header><div><small>02 · BATCH REVIEW</small><strong id="ef-upscale-settings-title">{items.length ? `${readyItems.length} ready · ${completedCount} saved` : 'Waiting for sources'}</strong></div><ProviderLogo brand="topaz" size={22} /></header>
          <p>Kie accepts one source per Topaz task. EasyField keeps every item separate, selects the correct endpoint automatically and preserves partial results if another item fails.</p>
          <div className="ef-upscale-safety-note"><span aria-hidden="true">◎</span><p><strong>Non-destructive.</strong> Originals stay untouched. Every completed output is immediately saved as a new Library item.</p></div>
        </section>

        {phase === 'generating' && (
          <section className="ef-upscale-batch-progress" role="status" aria-live="polite" aria-label="Topaz batch progress">
            <span className="ef-upscale-progress-orb"><Icon glyph="spark" size={16} /></span>
            <div><small>TOPAZ · BATCH IN PROGRESS</small><strong>{activeBatchCompleted} of {activeBatchTotal} secured</strong><p>Results appear above and save to Library as soon as each source finishes.</p></div>
            <GenerationBatchCancelControl jobs={generation.jobs} onExit={exitGeneration} noun="Upscale batch" />
          </section>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Upscale batch summary">
          <PriceEstimate estimate={estimate} />
          <div className={`ef-create-footer-message ${error ? 'is-error' : !items.length || !connected || sourceBusy || !readyItems.length ? 'is-help' : 'is-ready'}`} role={error ? 'alert' : 'status'} aria-live="polite">{footerMessage}</div>
          <button type="button" className="ef-generate ef-create-footer-action" disabled={!readyItems.length || sourceBusy || !connected || !spendApproval.approved} onClick={() => void runItems()}><Icon glyph="spark" color="#0E0E13" size={13} /> Upscale {readyItems.length || ''} {readyItems.length === 1 ? 'source' : 'sources'}</button>
        </footer>
      )}

      {lightbox && <Lightbox url={lightbox} kind="image" onClose={() => setLightbox(null)} />}
    </div>
  )
}

export const UPSCALE_MODELS = [TOPAZ_IMAGE_MODEL, TOPAZ_VIDEO_MODEL] as const
