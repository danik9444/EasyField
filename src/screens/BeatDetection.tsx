import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Icon } from '../icons'
import { LibraryPickerButton } from '../components/LibraryPicker'
import { BeatAnalysisResult } from '../components/BeatAnalysisResult'
import { host } from '../services/host'
import { resolve } from '../services/resolve'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { prepareJobLedger, startJob } from '../services/jobCenter'
import { saveUrl } from '../services/run'
import { importAudioWithBeatMarkers } from '../services/timeline'
import {
  BeatDetectionError,
  detectBeats,
  getBeatRuntimeStatus,
  type BeatDetectionResult,
  type BeatRuntimeStatus,
} from '../services/beatDetection'
import {
  addCreation,
  attachCreationCompanion,
  getCreations,
  type Creation,
  type CreationCompanion,
} from '../data/creations'
import {
  BEAT_MARKER_COLORS,
  BEAT_STYLE_PRESETS,
  DEFAULT_BEAT_MARKER_SETTINGS,
  buildBeatMarkers,
  createBeatAnalysisCompanion,
  effectiveBeatMarkerSettings,
  normalizeBeatMarkerSettings,
  type BeatMarkerSettings,
} from '../data/beatWorkflow'

interface BeatDetectionProps {
  onBack: () => void
  toast: (message: string) => void
  onToggleWindowMode: () => void
  windowMode: 'compact' | 'expanded'
}

interface BeatSource {
  name: string
  file: File
  url: string
  libraryCreationId?: string
  fromTimeline?: boolean
}

type Phase = 'idle' | 'analyzing' | 'complete' | 'error'

const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.aac,.flac,.ogg,.aiff,.aif,audio/*'
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024

function isAudioFile(file: File): boolean {
  return file.size > 0
    && file.size <= MAX_SOURCE_BYTES
    && (file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|flac|ogg|aiff|aif)$/i.test(file.name))
}

function timelineAudioName(name: string): string {
  const clean = name
    .replace(/[\\/\u0000-\u001f\u007f]/g, ' ')
    .replace(/\.(wav|mp3|m4a)(?=\s|·|$)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${clean || 'Timeline audio'}.wav`
}

function downloadText(data: string, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }))
  saveUrl(url, fileName)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatSeconds(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Full'
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return minutes ? `${minutes}:${seconds.toFixed(1).padStart(4, '0')}` : `${seconds.toFixed(1)}s`
}

export function BeatDetection({ onBack, toast, onToggleWindowMode, windowMode }: BeatDetectionProps) {
  const [runtime, setRuntime] = useState<BeatRuntimeStatus | null>(null)
  const [settings, setSettings] = useState<BeatMarkerSettings>(DEFAULT_BEAT_MARKER_SETTINGS)
  const [hydrated, setHydrated] = useState(false)
  const [source, setSource] = useState<BeatSource | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<BeatDetectionResult | null>(null)
  const [analysisId, setAnalysisId] = useState<string | null>(null)
  const [analyzedAt, setAnalyzedAt] = useState<number | null>(null)
  const [libraryCreationId, setLibraryCreationId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [importing, setImporting] = useState<'timeline' | 'media-pool' | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<BeatSource | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    sourceRef.current = source
  }, [source])

  useEffect(() => {
    let active = true
    void host.getState<BeatMarkerSettings>('drafts', 'beat-detection:settings').then((saved) => {
      if (!active) return
      setSettings(normalizeBeatMarkerSettings(saved))
      setHydrated(true)
    })
    const controller = new AbortController()
    void getBeatRuntimeStatus(controller.signal).then((status) => {
      if (active) setRuntime(status)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const timer = window.setTimeout(() => void host.setState('drafts', 'beat-detection:settings', settings), 180)
    return () => window.clearTimeout(timer)
  }, [hydrated, settings])

  useEffect(() => () => {
    abortRef.current?.abort()
    if (sourceRef.current?.url) URL.revokeObjectURL(sourceRef.current.url)
  }, [])

  const markers = useMemo(() => result ? buildBeatMarkers(result, settings) : [], [result, settings])
  const effectiveSettings = useMemo(() => effectiveBeatMarkerSettings(settings), [settings])

  const companion = useMemo<CreationCompanion | null>(() => {
    if (!source || !result || !analysisId || !analyzedAt || !libraryCreationId) return null
    return createBeatAnalysisCompanion({
      sourceName: source.name,
      sourceKind: 'audio',
      libraryCreationId,
      result,
      settings,
      markers,
      now: analyzedAt,
      analysisId,
    })
  }, [analysisId, analyzedAt, libraryCreationId, markers, result, settings, source])

  // A settings change updates the same analysis revision instead of flooding
  // the Library with a new companion on every slider movement.
  useEffect(() => {
    if (!companion || !libraryCreationId) return
    const timer = window.setTimeout(() => attachCreationCompanion(libraryCreationId, companion), 420)
    return () => window.clearTimeout(timer)
  }, [companion, libraryCreationId])

  const clearAnalysis = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase('idle')
    setResult(null)
    setAnalysisId(null)
    setAnalyzedAt(null)
    setLibraryCreationId(null)
    setError('')
  }

  const replaceSource = (next: BeatSource | null) => {
    const previous = sourceRef.current
    if (previous?.url && previous.url !== next?.url) URL.revokeObjectURL(previous.url)
    sourceRef.current = next
    setSource(next)
    clearAnalysis()
  }

  const useFile = (file: File, provenance: Pick<BeatSource, 'libraryCreationId' | 'fromTimeline'> = {}) => {
    if (!isAudioFile(file)) {
      toast(file.size > MAX_SOURCE_BYTES ? 'Audio must be 1 GB or smaller' : 'Choose a readable audio file')
      return
    }
    replaceSource({ name: file.name, file, url: URL.createObjectURL(file), ...provenance })
  }

  const chooseLibrary = async (creations: Creation[]) => {
    const creation = creations[0]
    if (!creation) return
    const file = await copyLibraryCreationForWorkspace(creation)
    useFile(file, { libraryCreationId: creation.id, fromTimeline: creation.fromTimeline })
  }

  const grabTimelineAudio = async () => {
    if (!resolve.isBridgeConnected()) await resolve.refreshStatus()
    const captured = await resolve.grabAudio()
    if (!captured.ok || !captured.blobUrl) {
      toast(captured.error || 'Place the playhead over an audio clip')
      return
    }
    try {
      const response = await fetch(captured.blobUrl)
      if (!response.ok) throw new Error(`Timeline audio could not be read (${response.status}).`)
      const blob = await response.blob()
      useFile(new File([blob], timelineAudioName(captured.name), { type: blob.type || 'audio/wav', lastModified: Date.now() }), { fromTimeline: true })
      toast('Timeline audio captured with its visible trim')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Timeline audio capture failed')
    } finally {
      URL.revokeObjectURL(captured.blobUrl)
    }
  }

  const ensureLibrarySource = (currentSource: BeatSource, detected: BeatDetectionResult, selectedMarkers: ReturnType<typeof buildBeatMarkers>): { creation: Creation; companion: CreationCompanion } => {
    let creation = currentSource.libraryCreationId
      ? getCreations().find((item) => item.id === currentSource.libraryCreationId && item.kind === 'audio') ?? null
      : null
    if (!creation) {
      const libraryUrl = URL.createObjectURL(currentSource.file)
      creation = addCreation({
        kind: 'audio',
        url: libraryUrl,
        prompt: currentSource.name,
        model: 'librosa Beat Detection',
        meta: `${detected.bpm || '—'} BPM · ${detected.durationSeconds.toFixed(1)}s`,
        fromTimeline: currentSource.fromTimeline,
      })
      if (!creation) {
        URL.revokeObjectURL(libraryUrl)
        throw new Error('The analyzed audio could not be saved to Library.')
      }
    }
    const nextCompanion = createBeatAnalysisCompanion({
      sourceName: currentSource.name,
      sourceKind: 'audio',
      libraryCreationId: creation.id,
      result: detected,
      settings,
      markers: selectedMarkers,
    })
    if (!attachCreationCompanion(creation.id, nextCompanion)) throw new Error('The beat map could not be linked to its Library audio.')
    return { creation, companion: nextCompanion }
  }

  const analyze = async () => {
    if (!source || runtime?.available !== true || phase === 'analyzing') return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    await prepareJobLedger()
    const job = startJob({
      title: 'Beat Detection',
      subtitle: source.name,
      kind: 'audio',
      onCancel: () => controller.abort(),
    })
    setPhase('analyzing')
    setError('')
    try {
      await job.persisted
      job.update({ status: 'running', detail: 'Analyzing locally with librosa' })
      const detected = await detectBeats(source.file, source.name, controller.signal)
      const selectedMarkers = buildBeatMarkers(detected, settings)
      const saved = ensureLibrarySource(source, detected, selectedMarkers)
      setResult(detected)
      setAnalysisId(saved.companion.id)
      setAnalyzedAt(saved.companion.createdAt)
      setLibraryCreationId(saved.creation.id)
      setSource((current) => current ? { ...current, libraryCreationId: saved.creation.id } : current)
      setPhase('complete')
      job.succeed(0, `${selectedMarkers.length} markers · linked in Library`)
      toast(`${selectedMarkers.length} markers ready · audio and beat map saved to Library`)
    } catch (reason) {
      if (controller.signal.aborted) {
        job.fail(new Error('Cancelled'))
        setPhase('idle')
        return
      }
      const message = reason instanceof Error ? reason.message : 'Beat analysis failed.'
      if (reason instanceof BeatDetectionError && reason.code === 'BEAT_RUNTIME_MISSING') {
        setRuntime({ ok: false, available: false, engine: 'librosa', code: reason.code, error: message, setupGuide: reason.setupGuide })
      }
      job.fail(reason)
      setError(message)
      setPhase('error')
      toast(message)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const importWithMarkers = async (target: 'timeline' | 'media-pool') => {
    if (!source || !companion || !markers.length || importing) return
    setImporting(target)
    try {
      await importAudioWithBeatMarkers({
        url: source.url,
        name: source.name,
        target,
        analysisId: companion.id,
        color: effectiveSettings.markerColor,
        markers,
      }, toast)
    } finally {
      setImporting(null)
    }
  }

  const updateSetting = <K extends keyof BeatMarkerSettings>(key: K, value: BeatMarkerSettings[K]) => {
    setSettings((current) => normalizeBeatMarkerSettings({ ...current, [key]: value }))
  }

  const sourceReady = !!source
  const runtimeReady = runtime?.available === true
  const actionMessage = !sourceReady
    ? 'Choose an audio source'
    : runtime == null
      ? 'Checking local engine'
      : !runtimeReady
        ? 'librosa runtime required'
        : phase === 'analyzing'
          ? 'Analyzing locally'
          : result
            ? `${markers.length} reviewed markers`
            : 'Ready for local analysis'

  const sourceSection = (
    <section className="ef-beat-section ef-beat-source" aria-labelledby="beat-source-title">
      <header><span>01</span><div><small>SOURCE AUDIO</small><h2 id="beat-source-title">Analyze the exact sound you will use.</h2></div></header>
      <div
        className={`ef-beat-source-stage${source ? ' has-source' : ''}${dragActive ? ' is-dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false) }}
        onDrop={(event) => {
          event.preventDefault()
          setDragActive(false)
          const file = event.dataTransfer.files[0]
          if (file) useFile(file)
        }}
      >
        {source ? (
          <>
            <div className="ef-beat-source-info"><span className="ef-beat-source-icon"><Icon glyph="music" size={20} /></span><span><strong title={source.name}>{source.name}</strong><small>{source.libraryCreationId ? 'Linked to Library' : source.fromTimeline ? 'Captured from timeline' : 'Local audio'}</small></span><button type="button" aria-label="Remove source audio" onClick={() => replaceSource(null)}>×</button></div>
            <audio src={source.url} controls preload="metadata" aria-label={`Preview ${source.name}`} />
          </>
        ) : (
          <div className="ef-beat-source-empty"><span><Icon glyph="music" size={24} /></span><strong>Drop one audio file here</strong><small>WAV, MP3, M4A, AAC, FLAC, OGG or AIFF · up to 1 GB</small></div>
        )}
        <div className="ef-beat-source-actions">
          <button type="button" onClick={() => inputRef.current?.click()}><Icon glyph="up" size={12} /> Upload</button>
          <LibraryPickerButton kinds={['audio']} max={1} onSelect={chooseLibrary} className="ef-library-source-btn" label="Library" ariaLabel="Choose audio from Library" pickerTitle="Choose audio for Beat Detection" confirmLabel="Use audio" />
          <button type="button" onClick={() => void grabTimelineAudio()}><Icon glyph="playhead" size={12} /> Grab</button>
        </div>
        <input ref={inputRef} type="file" hidden accept={AUDIO_ACCEPT} onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) useFile(file); event.target.value = '' }} />
      </div>
    </section>
  )

  return (
    <div className="ef-screen ef-beat-screen" style={{ '--ef-tool-accent': '#3ED598' } as React.CSSProperties}>
      <header className="ef-workspace-header">
        <button type="button" className="ef-back-btn" onClick={onBack} aria-label="Back to tools">←</button>
        <span className="ef-workspace-icon" aria-hidden="true"><Icon glyph="beat" color="#3ED598" size={16} /></span>
        <span className="ef-workspace-heading"><small>ANALYZE · AUDIO</small><strong>Beat Detection</strong></span>
        <span className="ef-spacer" />
        <span className="ef-draft-state" role="status"><i aria-hidden="true" /> Settings autosave</span>
        <button type="button" className="ef-density-toggle" onClick={onToggleWindowMode} aria-label={`Switch to ${windowMode === 'compact' ? 'expanded' : 'compact'} view`}>
          {windowMode === 'compact' ? '↗' : '↙'}
        </button>
      </header>

      <div className="ef-beat-scroll ef-scroll">
        <section className="ef-beat-hero">
          <div>
            <span>LOCAL RHYTHM ANALYSIS</span>
            <h1>Turn one sound into an editable beat map.</h1>
            <p>librosa detects the rhythm on-device. Choose the marker density precisely, then import the same audio with its markers.</p>
          </div>
          <div className={`ef-beat-engine ${runtimeReady ? 'is-ready' : ''}`} role="status">
            <i aria-hidden="true" />
            <span><small>ENGINE</small><strong>{runtime == null ? 'Checking…' : runtimeReady ? `librosa ${runtime.engineVersion ?? ''}` : 'Setup required'}</strong></span>
            <em>OFFLINE</em>
          </div>
        </section>

        {sourceSection}

        <section className="ef-beat-section" aria-labelledby="beat-style-title">
          <header><span>02</span><div><small>MARKER STYLE</small><h2 id="beat-style-title">Choose the editorial rhythm.</h2></div></header>
          <div className="ef-beat-style-grid">
            {BEAT_STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={settings.styleId === preset.id ? 'is-selected' : ''}
                aria-pressed={settings.styleId === preset.id}
                onClick={() => updateSetting('styleId', preset.id)}
              >
                <span><strong>{preset.name}</strong><small>{preset.description}</small></span><em>{preset.detail}</em>
              </button>
            ))}
          </div>

          <div className="ef-beat-appearance">
            <span>MARKER COLOR</span>
            <div role="radiogroup" aria-label="Resolve marker color">
              {BEAT_MARKER_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={settings.markerColor === color}
                  className={settings.markerColor === color ? 'is-selected' : ''}
                  style={{ '--beat-color': `var(--ef-marker-${color.toLowerCase()}, #3ED598)` } as React.CSSProperties}
                  onClick={() => updateSetting('markerColor', color)}
                  title={color}
                ><i />{color}</button>
              ))}
            </div>
          </div>
        </section>

        {settings.styleId === 'custom' && (
          <section className="ef-beat-section ef-beat-custom" aria-labelledby="beat-custom-title">
            <header><span>03</span><div><small>CUSTOM FILTER</small><h2 id="beat-custom-title">Control exactly which beats become markers.</h2></div></header>
            <div className="ef-beat-control-grid">
              <label><span>Every Nth beat <output>{settings.everyNth}</output></span><input type="range" min="1" max="16" step="1" value={settings.everyNth} onChange={(event) => updateSetting('everyNth', Number(event.target.value))} /></label>
              <label><span>Minimum confidence <output>{Math.round(settings.minimumConfidence * 100)}%</output></span><input type="range" min="0" max="100" step="1" value={Math.round(settings.minimumConfidence * 100)} onChange={(event) => updateSetting('minimumConfidence', Number(event.target.value) / 100)} /></label>
              <label><span>Minimum spacing <output>{settings.minimumGapSeconds.toFixed(2)}s</output></span><input type="range" min="0" max="2" step="0.01" value={settings.minimumGapSeconds} onChange={(event) => updateSetting('minimumGapSeconds', Number(event.target.value))} /></label>
              <label><span>Timing offset <output>{settings.offsetSeconds > 0 ? '+' : ''}{settings.offsetSeconds.toFixed(2)}s</output></span><input type="range" min="-0.5" max="0.5" step="0.01" value={settings.offsetSeconds} onChange={(event) => updateSetting('offsetSeconds', Number(event.target.value))} /></label>
            </div>
            <div className="ef-beat-range-row">
              <label><span>Start at</span><input type="number" min="0" step="0.1" value={settings.rangeStartSeconds ?? ''} placeholder="0.0" onChange={(event) => updateSetting('rangeStartSeconds', event.target.value === '' ? null : Number(event.target.value))} /><small>seconds</small></label>
              <label><span>End at</span><input type="number" min="0" step="0.1" value={settings.rangeEndSeconds ?? ''} placeholder="Full" onChange={(event) => updateSetting('rangeEndSeconds', event.target.value === '' ? null : Number(event.target.value))} /><small>seconds</small></label>
              <label className="ef-beat-prefix"><span>Marker name</span><input value={settings.markerPrefix} maxLength={32} onChange={(event) => updateSetting('markerPrefix', event.target.value)} /></label>
            </div>
          </section>
        )}

        {!runtimeReady && runtime && (
          <section className="ef-beat-runtime-card" role="status"><strong>librosa runtime required</strong><p>{runtime.error || 'Install the managed local analysis pack to enable Beat Detection.'}</p><code>{runtime.setupGuide || 'plugin/python/README.md'}</code></section>
        )}
        {error && <p className="ef-inline-warning ef-beat-error" role="alert">{error}</p>}

        {result && companion && source && (
          <BeatAnalysisResult
            result={result}
            markers={markers}
            sourceName={source.name}
            savedToLibrary
            rangeLabel={`${formatSeconds(effectiveSettings.rangeStartSeconds)} – ${formatSeconds(effectiveSettings.rangeEndSeconds)}`}
            onDownloadAudio={() => saveUrl(source.url, source.name)}
            onDownloadSidecar={() => downloadText(companion.data, companion.fileName, companion.mimeType)}
            onDownloadBoth={() => {
              saveUrl(source.url, source.name)
              window.setTimeout(() => downloadText(companion.data, companion.fileName, companion.mimeType), 120)
            }}
            onImportMediaPool={() => void importWithMarkers('media-pool')}
            onImportTimeline={() => void importWithMarkers('timeline')}
            importing={importing}
          />
        )}
      </div>

      <footer className="ef-workspace-actionbar ef-beat-actionbar">
        <div className="ef-run-summary"><span className="ef-privacy-chip is-local"><i />ON-DEVICE</span><span className="ef-workspace-cost">No upload · no credits</span></div>
        <span className={`ef-workspace-preflight${sourceReady && runtimeReady ? ' is-ready' : ''}`}><i className={sourceReady && runtimeReady ? 'is-ready' : ''} aria-hidden="true" />{actionMessage}</span>
        <button type="button" className="ef-workspace-primary" disabled={!sourceReady || !runtimeReady || phase === 'analyzing'} onClick={() => void analyze()}>
          {phase === 'analyzing' ? 'Analyzing…' : result ? 'Analyze again' : 'Analyze beats'} <span aria-hidden="true">→</span>
        </button>
      </footer>
    </div>
  )
}
