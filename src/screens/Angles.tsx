import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PromptCard } from '../components/PromptCard'
import { MaskCanvas } from '../components/MaskCanvas'
import { PriceEstimate } from '../components/PriceEstimate'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { Lightbox } from '../components/Lightbox'
import {
  ANGLES_MODELS,
  DEFAULT_ANGLES_MODEL,
  MAX_RANDOM_ANGLES,
  MIN_RANDOM_ANGLES,
  angleAspectRatios,
  angleDirectionPromptMax,
  createCustomAngleEntry,
  createRandomAngleEntries,
  normalizeAnglesDraft,
  normalizeRandomAngleCount,
  type AngleRequestEntry,
  type AnglesMode,
} from '../data/angles'
import { IMAGE_MODEL_CONFIG, resolveImageOptions, type ImageOptions } from '../data/imageModelConfig'
import { IMAGE_MODEL_META } from '../data/modelPresentation'
import { imageRunEstimate, resolveCharged, formatCharged } from '../data/pricing'
import { isDecodableReferenceImageFile, type ReferenceImage } from '../data/referenceImage'
import { addCreations } from '../data/creations'
import { host } from '../services/host'
import { resolve } from '../services/resolve'
import { sendToTimeline } from '../services/timeline'
import { isConnected, isGenerationExit, runAnglesBatch, saveUrl } from '../services/run'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import type { EnhanceReference } from '../services/chat'
import { promptCharacterCount } from '../data/promptLimits'

const DRAFT_KEY = 'default:angles'
const CAPTURE_ERROR = 'place the playhead over a still or video clip'

type Phase = 'form' | 'generating' | 'done'

interface AngleResult {
  id: string
  url: string
  label: string
  prompt: string
}

interface AnglesProps {
  onBack: () => void
  toast: (message: string) => void
  onSpend: (credits: number) => void
}

export function Angles({ onBack, toast, onSpend }: AnglesProps) {
  const initialDraft = useMemo(() => normalizeAnglesDraft(null), [])
  const initialOptions = useMemo(() => resolveImageOptions(DEFAULT_ANGLES_MODEL), [])
  const [draftReady, setDraftReady] = useState(false)
  const [phase, setPhase] = useState<Phase>('form')
  const [mode, setMode] = useState<AnglesMode>(initialDraft.mode)
  const [model, setModel] = useState(initialDraft.model)
  const [randomCount, setRandomCount] = useState(initialDraft.randomCount)
  const [customPrompt, setCustomPrompt] = useState(initialDraft.customPrompt)
  const [aspect, setAspect] = useState(initialOptions.aspect)
  const [resolution, setResolution] = useState(initialOptions.resolution)
  const [extras, setExtras] = useState(initialOptions.extraOptionValues)
  const perModelRef = useRef<Record<string, ImageOptions>>({})

  const idCounterRef = useRef(1)
  const [source, setSource] = useState<ReferenceImage | null>(null)
  const sourceRef = useRef<ReferenceImage | null>(null)
  const sourceCaptureIdRef = useRef(0)
  const sourceGrabPendingRef = useRef(false)
  const autoGrabAttemptedRef = useRef(false)
  const [sourceGrabPending, setSourceGrabPending] = useState(false)
  const cleanupSourceRef = useRef<string | null>(null)
  const activeRunRef = useRef(false)
  const unmountedRef = useRef(false)

  const [frozenEntries, setFrozenEntries] = useState<AngleRequestEntry[]>([])
  const [results, setResults] = useState<AngleResult[]>([])
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([])
  const [charged, setCharged] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const generation = useGenerationJobControl()

  useEffect(() => {
    let active = true
    void host.getState<unknown>('drafts', DRAFT_KEY).then((saved) => {
      if (!active) return
      const draft = normalizeAnglesDraft(saved)
      const options = resolveImageOptions(draft.model, draft.perModel[draft.model])
      perModelRef.current = draft.perModel
      setMode(draft.mode)
      setModel(draft.model)
      setRandomCount(draft.randomCount)
      setCustomPrompt(draft.customPrompt)
      setAspect(options.aspect)
      setResolution(options.resolution)
      setExtras(options.extraOptionValues)
      setDraftReady(true)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!draftReady) return
    perModelRef.current = {
      ...perModelRef.current,
      [model]: { aspect, resolution, extraOptionValues: extras },
    }
    const timer = window.setTimeout(() => {
      void host.setState('drafts', DRAFT_KEY, {
        schemaVersion: 1,
        mode,
        model,
        randomCount,
        customPrompt,
        perModel: perModelRef.current,
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [aspect, customPrompt, draftReady, extras, mode, model, randomCount, resolution])

  useEffect(() => {
    sourceRef.current = source
    cleanupSourceRef.current = source?.kind === 'upload' ? source.url : null
  })

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      sourceCaptureIdRef.current += 1
      if (!activeRunRef.current && cleanupSourceRef.current) URL.revokeObjectURL(cleanupSourceRef.current)
    }
  }, [])

  const resetOutput = useCallback(() => {
    setPhase('form')
    setFrozenEntries([])
    setResults([])
    setSelectedResultIds([])
    setCharged(null)
    setError(null)
  }, [])

  const replaceSource = useCallback((next: ReferenceImage) => {
    const previous = sourceRef.current
    if (previous?.kind === 'upload' && (next.kind !== 'upload' || previous.url !== next.url)) URL.revokeObjectURL(previous.url)
    sourceRef.current = next
    setSource(next)
    resetOutput()
  }, [resetOutput])

  const pickSource = useCallback(async (file: File) => {
    if (activeRunRef.current) return
    const captureId = ++sourceCaptureIdRef.current
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    if (!(await isDecodableReferenceImageFile(file))) {
      if (captureId === sourceCaptureIdRef.current) toast('Image skipped · use JPEG, PNG or WebP up to 10 MB')
      return
    }
    if (captureId !== sourceCaptureIdRef.current || unmountedRef.current) return
    replaceSource({ id: `source-${idCounterRef.current++}`, kind: 'upload', name: file.name, url: URL.createObjectURL(file) })
  }, [replaceSource, toast])

  const grabPrimarySource = useCallback(async (announce = true) => {
    if (activeRunRef.current || sourceGrabPendingRef.current) return
    const captureId = ++sourceCaptureIdRef.current
    sourceGrabPendingRef.current = true
    setSourceGrabPending(true)
    const grabbed = await resolve.grabEditImageSource()
    if (captureId !== sourceCaptureIdRef.current || unmountedRef.current) {
      if (grabbed.ok && grabbed.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
      return
    }
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    if (!grabbed.ok || !grabbed.blobUrl) {
      if (announce) toast(`Angle source capture failed · ${grabbed.error || CAPTURE_ERROR}`)
      return
    }
    replaceSource({ id: `source-${idCounterRef.current++}`, kind: 'upload', name: grabbed.name, url: grabbed.blobUrl })
    if (announce) toast(grabbed.sourceKind === 'still-image' ? 'Original still loaded from the timeline clip' : 'Displayed timeline frame captured as the angle source')
  }, [replaceSource, toast])

  useEffect(() => {
    if (autoGrabAttemptedRef.current) return
    autoGrabAttemptedRef.current = true
    let active = true
    const timer = window.setTimeout(() => void (async () => {
      const bridge = resolve.isBridgeConnected() ? resolve.getStatus() : await resolve.refreshStatus()
      if (active && bridge.connected && !sourceRef.current) await grabPrimarySource(false)
    })(), 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [grabPrimarySource])

  const changeModel = (nextModel: string) => {
    perModelRef.current = {
      ...perModelRef.current,
      [model]: { aspect, resolution, extraOptionValues: extras },
    }
    const next = resolveImageOptions(nextModel, perModelRef.current[nextModel])
    setModel(nextModel)
    setAspect(next.aspect)
    setResolution(next.resolution)
    setExtras(next.extraOptionValues)
    resetOutput()
  }

  const config = IMAGE_MODEL_CONFIG[model]
  const supportedAspectRatios = angleAspectRatios(model)
  const providerPromptMax = config.promptMax
  const customPromptMax = angleDirectionPromptMax(model)
  const sourceReady = source?.kind === 'upload' && !!source.url
  const customEntry = createCustomAngleEntry(customPrompt)
  const outputCount = mode === 'random' ? randomCount : 1
  const estimate = imageRunEstimate(model, resolution, extras, outputCount, { referenceCount: 1 })
  const connected = isConnected()
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const promptMissing = mode === 'custom' && !customEntry
  const promptOverLimit = mode === 'custom' && !!customEntry && promptCharacterCount(customEntry.prompt) > providerPromptMax
  const canGenerate = draftReady && sourceReady && !promptMissing && !promptOverLimit && connected && spendApproval.approved && !sourceGrabPending

  const enhanceReferences: EnhanceReference[] = source?.kind === 'upload'
    ? [{ role: 'primary source — preserve subject and scene; change camera viewpoint only', label: source.name, imageUrl: source.url }]
    : []
  const promptContextKey = source?.kind === 'upload' ? `${source.id}:${source.url}` : 'no-angle-source'

  const generate = async () => {
    if (activeRunRef.current) return
    if (!sourceReady || !source) {
      setError('Upload or grab a source image first.')
      return
    }
    const entries = mode === 'random' ? createRandomAngleEntries(randomCount) : customEntry ? [customEntry] : []
    if (!entries.length) {
      setError('Describe the custom camera angle you want.')
      return
    }
    if (entries.some((entry) => promptCharacterCount(entry.prompt) > providerPromptMax)) {
      setError(`${model} accepts up to ${providerPromptMax.toLocaleString()} prompt characters including EasyField's camera-preservation instructions.`)
      return
    }
    setError(null)
    setResults([])
    setSelectedResultIds([])
    setFrozenEntries(entries)
    setPhase('generating')
    const controller = generation.begin()
    activeRunRef.current = true
    try {
      const response = await runAnglesBatch({ source, model, aspect, resolution, extras, entries }, {
        signal: controller.signal,
        onJobCreated: generation.attachJob,
      })
      if (controller.signal.aborted) return
      if (response.failedJobs) toast(`${response.failedJobs} angle request${response.failedJobs === 1 ? '' : 's'} failed · completed views were kept`)
      if (response.pendingJobs) toast(`${response.pendingJobs} angle request${response.pendingJobs === 1 ? ' is' : 's are'} still tracked in Activity`)
      const completed = response.items.flatMap((item) => item.urls.map((url, index) => ({
        id: `${item.id}-${index}`,
        url,
        label: item.label,
        prompt: item.prompt,
      })))
      if (!completed.length) {
        setError('No camera-angle result was returned · try again.')
        setPhase('form')
        return
      }
      const actualCharge = response.credits ?? resolveCharged(estimate)
      setCharged(actualCharge)
      onSpend(actualCharge ?? 0)
      setResults(completed)
      addCreations(completed.map((result) => ({
        kind: 'image',
        url: result.url,
        model,
        prompt: result.prompt,
        meta: `Angles · ${result.label} · ${resolution || aspect}`,
      })))
      setPhase('done')
    } catch (runError) {
      if (controller.signal.aborted || isGenerationExit(runError)) {
        setPhase('form')
        return
      }
      setError(runError instanceof Error ? runError.message : String(runError))
      setPhase('form')
    } finally {
      generation.finish(controller)
      activeRunRef.current = false
      if (unmountedRef.current && cleanupSourceRef.current) URL.revokeObjectURL(cleanupSourceRef.current)
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    toast(outcome === 'backgrounded'
      ? 'Angles continue in Activity · finished views will be saved to Library'
      : 'Angle generation cancelled')
  }

  const selectedResults = results.filter((result) => selectedResultIds.includes(result.id))
  const toggleResult = (id: string) => setSelectedResultIds((current) => current.includes(id)
    ? current.filter((resultId) => resultId !== id)
    : [...current, id])
  const placeSelected = async () => {
    if (!selectedResults.length || placing) return
    setPlacing(true)
    try {
      await sendToTimeline(selectedResults.map((result) => ({ url: result.url, name: `EasyField ${result.label}` })), 'image', toast)
    } finally {
      setPlacing(false)
    }
  }

  const footerHasError = !!error || spendBlocked || promptMissing || promptOverLimit
  const footerMessage = error
    ? `✕ ${error}`
    : !draftReady
      ? 'Restoring your Angles draft…'
      : !sourceReady
        ? 'Upload a still or grab the media under the Resolve playhead.'
        : promptMissing
          ? 'Describe the camera position, elevation, lens or framing.'
          : promptOverLimit
            ? `${model} allows ${providerPromptMax.toLocaleString()} prompt characters including the camera-preservation instructions · shorten the direction.`
          : !connected
            ? 'Connect EasyField Cloud to generate camera angles'
            : spendBlocked
              ? spendApproval.reason
              : mode === 'random'
                ? `${randomCount} distinct camera positions · identity preservation requested`
                : 'One precise custom viewpoint · identity preservation requested'

  const registerUnusedClear = useCallback((_clear: () => void) => {}, [])

  return (
    <div className="ef-screen ef-legacy-workspace ef-angles-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Angles</span>
        <span className="ef-spacer" />
        <Dropdown options={[...ANGLES_MODELS]} selected={model} onSelect={changeModel} label="Angles model" optionMeta={IMAGE_MODEL_META} />
      </div>

      <div className="ef-scroll ef-create-scroll">
        <div className="ef-edit-mode-bar ef-angles-mode-bar" role="group" aria-label="Camera angle mode">
          <span>
            <small>ANGLE MODE</small>
            <strong>{mode === 'random' ? 'A distinct coverage set' : 'Direct one exact viewpoint'}</strong>
          </span>
          <div className="ef-setting-segmented">
            <button type="button" className={mode === 'random' ? 'is-selected' : ''} aria-pressed={mode === 'random'} onClick={() => { setMode('random'); resetOutput() }}>Random angles</button>
            <button type="button" className={mode === 'custom' ? 'is-selected' : ''} aria-pressed={mode === 'custom'} onClick={() => { setMode('custom'); resetOutput() }}>Custom angle</button>
          </div>
        </div>

        <div className="ef-angles-workbench">
          <div className="ef-angles-source-column">
            <div className="ef-primary-media-heading">
              <span className="ef-field-label">SOURCE IMAGE</span>
              <span>PRIMARY IDENTITY REFERENCE</span>
            </div>
            <div className="ef-angles-source-card">
              <MaskCanvas
                source={source}
                maskable={false}
                brushSize={24}
                color="#E26BD2"
                onPick={(file) => { void pickSource(file) }}
                onGrab={() => { void grabPrimarySource() }}
                grabPending={sourceGrabPending}
                disabled={phase === 'generating'}
                onClearRef={registerUnusedClear}
                emptyTitle="Choose the view to orbit"
                emptyDescription="Upload a still, or grab a still or the displayed video frame under the Resolve playhead."
                sourceLabel="Choose the primary source for camera angles"
                uploadLabel="Upload source"
                grabLabel="Grab from timeline"
                replaceGrabLabel="Grab new source"
                changeLabel="Change source"
              />
            </div>
            <p className="ef-angles-source-note"><Icon glyph="angles" size={12} /> The source always stays image 1. Angles change the camera only—not the subject or scene.</p>
          </div>

          <div className="ef-angles-controls-column">
            {mode === 'random' ? (
              <section className="ef-angle-direction-card" aria-labelledby="ef-random-angles-title">
                <header>
                  <span><small>RANDOM ANGLES</small><strong id="ef-random-angles-title">Build a coverage set</strong></span>
                  <em>{randomCount} {randomCount === 1 ? 'VIEW' : 'VIEWS'}</em>
                </header>
                <p>Every result gets a different camera position, selected only when you generate. Subject, wardrobe, scene and style stay matched.</p>
                <div className="ef-angle-count-control" role="group" aria-labelledby="ef-angle-count-label">
                  <div className="ef-angle-count-copy">
                    <span id="ef-angle-count-label">NUMBER OF VIEWS</span>
                    <small>Choose {MIN_RANDOM_ANGLES}–{MAX_RANDOM_ANGLES} distinct camera positions</small>
                  </div>
                  <div className="ef-angle-count-stepper">
                    <button type="button" aria-label="Decrease number of views" disabled={randomCount <= MIN_RANDOM_ANGLES} onClick={() => setRandomCount((count) => normalizeRandomAngleCount(count - 1))}>
                      <span aria-hidden="true">−</span>
                    </button>
                    <output className="ef-angle-count-value" aria-live="polite" aria-atomic="true" aria-label={`${randomCount} camera view${randomCount === 1 ? '' : 's'} selected`}>
                      <strong aria-hidden="true">{randomCount}</strong>
                      <span aria-hidden="true">{randomCount === 1 ? 'view' : 'views'}</span>
                    </output>
                    <button type="button" aria-label="Increase number of views" disabled={randomCount >= MAX_RANDOM_ANGLES} onClick={() => setRandomCount((count) => normalizeRandomAngleCount(count + 1))}>
                      <span aria-hidden="true">+</span>
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <section className="ef-angle-direction-card ef-angle-custom-card" aria-labelledby="ef-custom-angle-title">
                <header>
                  <span><small>CUSTOM ANGLE</small><strong id="ef-custom-angle-title">Direct the camera</strong></span>
                  <em>1 VIEW</em>
                </header>
                <PromptCard
                  prompt={customPrompt}
                  onPromptChange={(value) => { setCustomPrompt(value); setError(null) }}
                  maxLength={customPromptMax}
                  enhancerKey="enhancer-angles-custom"
                  targetModel={model}
                  mediaKind="image"
                  purpose="angle"
                  placeholder="Describe camera position, elevation, lens or framing…"
                  references={enhanceReferences}
                  contextKey={promptContextKey}
                  onSpend={onSpend}
                />
                <p className="ef-angle-preservation-note"><Icon glyph="spark" size={11} /> Prompt enhancement sees the source image. Generation asks the selected model to preserve identity, scene and styling.</p>
              </section>
            )}

            <section className="ef-angle-output-card" aria-labelledby="ef-angle-output-title">
              <div className="ef-angle-card-heading"><span><small>OUTPUT</small><strong id="ef-angle-output-title">Image settings</strong></span></div>
              {supportedAspectRatios.length > 0 && (
                <div className="ef-field">
                  <span className="ef-field-label">ASPECT</span>
                  <Dropdown options={[...supportedAspectRatios]} selected={aspect} onSelect={setAspect} label="Aspect ratio" align="left" variant="field" />
                </div>
              )}
              {config.resolutions.length > 0 && <ChipField label="RESOLUTION" options={config.resolutions} selected={resolution} onSelect={setResolution} />}
              {config.extraOptions.map((option) => (
                <ChipField key={option.key} label={option.label} options={option.values} selected={extras[option.key]} onSelect={(value) => setExtras((current) => ({ ...current, [option.key]: value }))} />
              ))}
            </section>
          </div>
        </div>

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block ef-angles-generation" role="status" aria-live="polite" aria-atomic="true" aria-label={`Generating ${frozenEntries.length} camera angle${frozenEntries.length === 1 ? '' : 's'}`}>
              <div className="ef-result-grid">
                {frozenEntries.map((entry, index) => <div key={entry.id} className="ef-skeleton" style={{ animationDelay: `${index * 0.14}s` }} aria-hidden="true" />)}
              </div>
              <span className="ef-gen-caption">ORBITING TO {frozenEntries.length} VIEW{frozenEntries.length === 1 ? '' : 'S'}…</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun="angle generation" />
          </>
        )}

        {phase === 'done' && (
          <div className="ef-done-block ef-angles-results" role="region" aria-label={`${results.length} generated camera-angle results`}>
            <div className="ef-result-review-head">
              <span><strong>Review camera angles</strong><small>Every result is already secured in Library. Select only what should reach the timeline.</small></span>
              <em>{selectedResultIds.length} / {results.length}</em>
            </div>
            <div className="ef-result-grid">
              {results.map((result, index) => (
                <div className={'ef-result-choice' + (selectedResultIds.includes(result.id) ? ' is-selected' : '')} key={result.id}>
                  <button type="button" className="ef-result-tile" aria-label={`Preview ${result.label} result ${index + 1}`} onClick={() => setLightbox(result.url)} style={{ backgroundImage: `url("${result.url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
                    <span className="ef-angle-result-label">{result.label}</span>
                    <span className="ef-result-overlay">⤢ Enlarge</span>
                  </button>
                  <button type="button" className="ef-result-select" aria-label={`${selectedResultIds.includes(result.id) ? 'Deselect' : 'Select'} ${result.label} for timeline placement`} aria-pressed={selectedResultIds.includes(result.id)} onClick={() => toggleResult(result.id)}>{selectedResultIds.includes(result.id) ? '✓' : '+'}</button>
                </div>
              ))}
            </div>
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => { setPhase('form'); setFrozenEntries([]) }}>↺ Generate more</button>
              <button type="button" className="ef-ghost-btn" onClick={() => results.forEach((result, index) => saveUrl(result.url, `easyfield-angle-${index + 1}.png`))}>↓ Save all</button>
              <button type="button" className="ef-send-btn" disabled={!selectedResults.length || placing} onClick={() => { void placeSelected() }}>{placing ? 'Placing…' : selectedResults.length ? `Place ${selectedResults.length} selected` : 'Select to place'}</button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Camera-angle generation summary">
          <PriceEstimate estimate={estimate} />
          <div className={`ef-create-footer-message ${footerHasError ? 'is-error' : !sourceReady || !connected || !draftReady ? 'is-help' : 'is-ready'}`} role={footerHasError ? 'alert' : 'status'} aria-live="polite">{footerMessage}</div>
          <button
            type="button"
            className="ef-generate ef-create-footer-action"
            disabled={!canGenerate}
            aria-label={mode === 'random' ? `Generate ${randomCount} random camera angle${randomCount === 1 ? '' : 's'}` : 'Generate custom camera angle'}
            onClick={() => { void generate() }}
          >
            <Icon glyph="angles" color="#0E0E13" size={13} /> {mode === 'random' ? `Generate ×${randomCount}` : 'Generate angle'}
          </button>
        </footer>
      )}

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
