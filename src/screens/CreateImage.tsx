import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PromptCard } from '../components/PromptCard'
import { ReferenceImageGrid } from '../components/ReferenceImageGrid'
import { CharacterBuilderPanel } from '../components/CharacterBuilderPanel'
import { resolve } from '../services/resolve'
import { sendToTimeline } from '../services/timeline'
import { runImage, isConnected, isGenerationExit, saveUrl } from '../services/run'
import { host } from '../services/host'
import { Lightbox } from '../components/Lightbox'
import { addCreations } from '../data/creations'
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, IMAGE_MODEL_ALIASES } from '../data/models'
import { IMAGE_MODEL_CONFIG, defaultOptionsFor } from '../data/imageModelConfig'
import { IMAGE_MODEL_META } from '../data/modelPresentation'
import { PriceEstimate } from '../components/PriceEstimate'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { imageRunEstimate, resolveCharged, formatCharged } from '../data/pricing'
import { loadGenPrefs, saveGenPrefs } from '../data/prefs'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import { isDecodableReferenceImageFile, type ReferenceImage } from '../data/referenceImage'
import type { EnhanceReference } from '../services/chat'
import { promptCharacterCount } from '../data/promptLimits'
import {
  compileCharacterPrompt,
  createDefaultCharacterDraft,
  normalizeCharacterDraft,
  type CharacterDraft,
} from '../data/characterBuilder'

const STYLES = ['None', 'Cinematic', 'Realistic', 'Anime', 'Product', 'Character', 'Storyboard']
const COUNTS = ['1', '2', '3', '4']
const DEFAULT_COUNT = '4'
const DEFAULT_PROMPT = 'Macro shot of a vinyl record spinning, dust particles in a beam of light'
const CHARACTER_DRAFT_KEY = 'default:character-builder'

type Phase = 'form' | 'generating' | 'done'

interface ImagePerModel {
  aspect: string
  resolution: string
  extraOptionValues: Record<string, string>
}

// Resolve a model's settings from stored prefs, falling back to defaults and
// dropping any value no longer valid for the model's current config.
function resolveImageSettings(model: string, stored?: ImagePerModel): ImagePerModel {
  const cfg = IMAGE_MODEL_CONFIG[model]
  const def = defaultOptionsFor(model)
  const extraOptionValues: Record<string, string> = {}
  cfg.extraOptions.forEach((opt) => {
    const v = stored?.extraOptionValues?.[opt.key]
    extraOptionValues[opt.key] = v && opt.values.includes(v) ? v : opt.values[0]
  })
  return {
    aspect: stored && cfg.aspectRatios.includes(stored.aspect) ? stored.aspect : def.aspect,
    resolution: stored && cfg.resolutions.includes(stored.resolution) ? stored.resolution : def.resolution,
    extraOptionValues,
  }
}

interface CreateImageProps {
  mode?: 'image' | 'character'
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
}

export function CreateImage({ mode = 'image', onBack, toast, onSpend }: CreateImageProps) {
  const [phase, setPhase] = useState<Phase>('form')
  const [charged, setCharged] = useState<number | null>(null)
  const prefsKey = mode === 'character' ? 'create-character' : 'create-image'
  const prefsRef = useRef(loadGenPrefs<ImagePerModel>(prefsKey))
  const initialModel = useMemo(() => {
    const saved = prefsRef.current.model
    const m = saved ? IMAGE_MODEL_ALIASES[saved] ?? saved : undefined
    return m && IMAGE_MODELS.includes(m) ? m : DEFAULT_IMAGE_MODEL
  }, [])
  const initialSettings = useMemo(
    () => resolveImageSettings(initialModel, prefsRef.current.perModel?.[initialModel] ?? prefsRef.current.perModel?.[prefsRef.current.model ?? '']),
    [initialModel],
  )
  const [model, setModel] = useState(initialModel)
  const [style, setStyle] = useState(() => {
    const saved = prefsRef.current.style === 'Avatar' ? 'Character' : prefsRef.current.style
    return saved && STYLES.includes(saved) ? saved : mode === 'character' ? 'Character' : 'Cinematic'
  })
  const [count, setCount] = useState(() => COUNTS.includes(prefsRef.current.count ?? '') ? prefsRef.current.count! : mode === 'character' ? '1' : DEFAULT_COUNT)
  const [aspect, setAspect] = useState(initialSettings.aspect)
  const [resolution, setResolution] = useState(initialSettings.resolution)
  const [extraOptionValues, setExtraOptionValues] = useState(initialSettings.extraOptionValues)
  const [prompt, setPrompt] = useState(() => typeof prefsRef.current.prompt === 'string' ? prefsRef.current.prompt : DEFAULT_PROMPT)
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft>(() => createDefaultCharacterDraft())
  const [characterDraftReady, setCharacterDraftReady] = useState(mode !== 'character')
  const [refImages, setRefImages] = useState<ReferenceImage[]>([])
  const [results, setResults] = useState<{ id: string; url: string }[]>([])
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [placing, setPlacing] = useState(false)
  const idCounterRef = useRef(1)
  const refImagesRef = useRef(refImages)
  const activeRunRef = useRef(false)
  const unmountedRef = useRef(false)
  const generation = useGenerationJobControl()

  useEffect(() => {
    refImagesRef.current = refImages
  })

  useEffect(
    () => {
      // React StrictMode intentionally runs an effect setup/cleanup cycle in
      // development. Reset the sentinel on every setup so the simulated
      // cleanup is not mistaken for a real unmount by later async work.
      unmountedRef.current = false
      return () => {
        unmountedRef.current = true
        if (!activeRunRef.current) {
          refImagesRef.current.forEach((r) => {
            if (r.kind === 'upload') URL.revokeObjectURL(r.url)
          })
        }
      }
    },
    [],
  )

  useEffect(() => {
    if (mode !== 'character') return
    let active = true
    void host.getState<CharacterDraft>('drafts', CHARACTER_DRAFT_KEY).then((saved) => {
      if (!active) return
      setCharacterDraft(normalizeCharacterDraft(saved))
      setCharacterDraftReady(true)
    })
    return () => { active = false }
  }, [mode])

  useEffect(() => {
    if (mode !== 'character' || !characterDraftReady) return
    const timer = window.setTimeout(() => {
      void host.setState('drafts', CHARACTER_DRAFT_KEY, normalizeCharacterDraft(characterDraft))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [characterDraft, characterDraftReady, mode])

  // Persist settings on every change; each model remembers its own config.
  useEffect(() => {
    const p = prefsRef.current
    p.model = model
    p.style = style
    p.prompt = prompt
    p.count = count
    p.perModel = { ...p.perModel, [model]: { aspect, resolution, extraOptionValues } }
    saveGenPrefs(prefsKey, p)
  }, [model, style, prompt, count, aspect, resolution, extraOptionValues, prefsKey])

  const config = IMAGE_MODEL_CONFIG[model]
  const providerPromptMax = config.promptMax
  const maxReferenceImages = config.maxReferenceImages
  const currentReferenceLimit = mode === 'character' ? Math.min(3, maxReferenceImages) : maxReferenceImages
  const normalizedCharacterDraft = useMemo(() => normalizeCharacterDraft(characterDraft), [characterDraft])
  const effectiveReferences = useMemo(() => {
    if (mode !== 'character') return refImages
    if (normalizedCharacterDraft.mode !== 'reference') return []
    const primaryId = normalizedCharacterDraft.referenceAssetId
    return primaryId
      ? [...refImages].sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId))
      : refImages
  }, [mode, normalizedCharacterDraft.mode, normalizedCharacterDraft.referenceAssetId, refImages])
  const effectivePrompt = mode === 'character'
    ? compileCharacterPrompt(normalizedCharacterDraft)
    : style && style !== 'None' ? `${prompt}. ${style} style.` : prompt
  const styleScaffold = mode !== 'character' && style && style !== 'None' ? `. ${style} style.` : ''
  const userPromptMax = Math.max(1, providerPromptMax - promptCharacterCount(styleScaffold))
  const promptOverLimit = promptCharacterCount(effectivePrompt) > providerPromptMax
  const characterReferenceReady = mode !== 'character'
    || normalizedCharacterDraft.mode !== 'reference'
    || effectiveReferences.length > 0

  // What the prompt enhancer should factor in: attached reference images (shown
  // to the vision model) plus timeline-frame placeholders (described by timecode).
  const enhanceRefs: EnhanceReference[] = refImages.map((r) =>
    r.kind === 'upload'
      ? { role: 'reference image', label: r.name, imageUrl: r.url }
      : { role: 'reference image', note: `timeline frame at ${r.timecode}` },
  )

  const handleModelChange = (nextModel: string) => {
    const cfg = IMAGE_MODEL_CONFIG[nextModel]
    const nextReferenceLimit = mode === 'character' ? Math.min(3, cfg.maxReferenceImages) : cfg.maxReferenceImages
    const s = resolveImageSettings(nextModel, prefsRef.current.perModel?.[nextModel])
    setModel(nextModel)
    setAspect(s.aspect)
    setResolution(s.resolution)
    setExtraOptionValues(s.extraOptionValues)
    if (refImages.length > nextReferenceLimit) {
      const removed = refImages.slice(nextReferenceLimit)
      removed.forEach((r) => {
        if (r.kind === 'upload') URL.revokeObjectURL(r.url)
      })
      setRefImages(refImages.slice(0, nextReferenceLimit))
      toast(
        `${nextModel} supports up to ${nextReferenceLimit} ${mode === 'character' ? 'character sample' : 'reference image'}${nextReferenceLimit === 1 ? '' : 's'} — trimmed extras`,
      )
    }
  }

  const grabPlayhead = async () => {
    // Check the budget before the await, then again inside the updater — the grab
    // is async, so state may have changed by the time it resolves.
    if (refImages.length >= currentReferenceLimit) return
    const g = await resolve.grabFrame()
    if (!g.ok || !g.blobUrl) {
      toast(`Frame capture failed · ${g.error || 'check Resolve and the playhead'}`)
      return
    }
    const item: ReferenceImage = { id: `up-${idCounterRef.current++}`, kind: 'upload', name: g.name, url: g.blobUrl }
    setRefImages((prev) => {
      if (prev.length < currentReferenceLimit) return [...prev, item]
      URL.revokeObjectURL(item.url)
      return prev
    })
  }

  const addRefFiles = async (files: File[]) => {
    const validity = await Promise.all(files.map(isDecodableReferenceImageFile))
    const validFiles = files.filter((_, index) => validity[index])
    const remaining = Math.max(0, currentReferenceLimit - refImagesRef.current.length)
    const toAdd = validFiles.slice(0, remaining)
    const newItems: ReferenceImage[] = toAdd.map((file) => ({
      id: `up-${idCounterRef.current++}`,
      kind: 'upload',
      name: file.name,
      url: URL.createObjectURL(file),
    }))
    setRefImages((prev) => {
      const slots = Math.max(0, currentReferenceLimit - prev.length)
      const kept = newItems.slice(0, slots)
      newItems.slice(slots).forEach((item) => { if (item.kind === 'upload') URL.revokeObjectURL(item.url) })
      return kept.length ? [...prev, ...kept] : prev
    })
    const invalidCount = files.length - validFiles.length
    if (invalidCount) toast(`${invalidCount} reference${invalidCount === 1 ? '' : 's'} skipped — use JPEG, PNG or WebP up to 10 MB`)
    if (validFiles.length > toAdd.length) {
      toast(`Only ${toAdd.length} added — ${model} allows up to ${currentReferenceLimit} references`)
    }
  }

  const removeRefAt = (id: string) => {
    setRefImages((prev) => {
      const target = prev.find((r) => r.id === id)
      if (target?.kind === 'upload') URL.revokeObjectURL(target.url)
      return prev.filter((r) => r.id !== id)
    })
  }

  const generate = async () => {
    if (activeRunRef.current) return
    if (!effectivePrompt.trim()) {
      setError('Describe the image before generating.')
      return
    }
    if (promptOverLimit) {
      setError(`${model} accepts up to ${providerPromptMax.toLocaleString()} prompt characters, including EasyField's selected style and character direction.`)
      return
    }
    if (!characterReferenceReady) {
      setError(currentReferenceLimit > 0 ? 'Add a character sample before generating.' : `${model} does not accept character samples — choose a reference-capable model.`)
      return
    }
    setError(null)
    setSelectedResultIds([])
    setPhase('generating')
    const controller = generation.begin()
    activeRunRef.current = true
    try {
      const res = await runImage(
        { jobTitle: mode === 'character' ? 'Character' : 'Create image', model, prompt: effectivePrompt, aspect, resolution, extras: extraOptionValues, refs: effectiveReferences, count: Number(count) },
        { signal: controller.signal, onJobCreated: generation.attachJob },
      )
      if (controller.signal.aborted) return
      if (res.droppedPlayheads) toast(`${res.droppedPlayheads} timeline frame(s) skipped — upload images or connect DaVinci`)
      if (res.failedJobs) toast(`${res.failedJobs} image request${res.failedJobs === 1 ? '' : 's'} failed — completed results were kept`)
      if (res.pendingJobs) toast(`${res.pendingJobs} image request${res.pendingJobs === 1 ? ' is' : 's are'} still being tracked in Activity`)
      if (!res.urls.length) {
        setError('No image was returned — please try again.')
        setPhase('form')
        return
      }
      const c = res.credits ?? resolveCharged(imageRunEstimate(model, resolution, extraOptionValues, Number(count), { referenceCount: effectiveReferences.length }))
      setCharged(c)
      onSpend(c ?? 0)
      setResults(res.urls.map((url, i) => ({ id: `img-${i}`, url })))
      addCreations(res.urls.map((url) => ({
        kind: 'image',
        url,
        model,
        prompt: effectivePrompt,
        meta: mode === 'character' ? `Character · ${resolution || aspect}` : resolution || aspect,
      })))
      setPhase('done')
    } catch (e) {
      if (controller.signal.aborted || isGenerationExit(e)) {
        setPhase('form')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setPhase('form')
    } finally {
      generation.finish(controller)
      activeRunRef.current = false
      if (unmountedRef.current) {
        refImagesRef.current.forEach((r) => {
          if (r.kind === 'upload') URL.revokeObjectURL(r.url)
        })
      }
    }
  }

  const exitGeneration = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setPhase('form')
    toast(outcome === 'backgrounded'
      ? 'Generation continues in Activity · the result will be saved to Library'
      : 'Generation cancelled')
  }

  const connected = isConnected()
  const estimate = imageRunEstimate(model, resolution, extraOptionValues, Number(count), { referenceCount: effectiveReferences.length })
  const spendApproval = getSpendApproval(estimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const selectedResults = results.filter((result) => selectedResultIds.includes(result.id))
  const toggleResult = (id: string) => {
    setSelectedResultIds((current) => current.includes(id) ? current.filter((resultId) => resultId !== id) : [...current, id])
  }
  const placeSelectedResults = async () => {
    if (placing || !selectedResults.length) return
    setPlacing(true)
    try {
      await sendToTimeline(selectedResults.map((result) => ({
        url: result.url,
        name: mode === 'character'
          ? `EasyField ${normalizedCharacterDraft.basics.type} character`
          : prompt.slice(0, 40) || 'EasyField image',
      })), 'image', toast)
    } finally {
      setPlacing(false)
    }
  }

  const outputSettings = (
    <>
      <div className="ef-field">
        <span className="ef-field-label">ASPECT</span>
        <Dropdown options={config.aspectRatios} selected={aspect} onSelect={setAspect} label="Aspect ratio" align="left" variant="field" />
      </div>

      {config.resolutions.length > 0 && (
        <ChipField label="RESOLUTION" options={config.resolutions} selected={resolution} onSelect={setResolution} />
      )}

      {config.extraOptions.map((opt) => (
        <ChipField
          key={opt.key}
          label={opt.label}
          options={opt.values}
          selected={extraOptionValues[opt.key]}
          onSelect={(value) => setExtraOptionValues((previous) => ({ ...previous, [opt.key]: value }))}
        />
      ))}

      <ChipField label={mode === 'character' ? 'VARIATIONS' : 'IMAGES'} options={COUNTS} selected={count} onSelect={setCount} />
    </>
  )

  return (
    <div className={`ef-screen ef-legacy-workspace ef-create-image-screen${mode === 'character' ? ' ef-character-screen' : ''}`}>
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">{mode === 'character' ? 'Character' : 'Create Image'}</span>
        <span className="ef-spacer" />
        <Dropdown options={IMAGE_MODELS} selected={model} onSelect={handleModelChange} label="Image model" optionMeta={IMAGE_MODEL_META} />
      </div>

      <div className="ef-scroll ef-create-scroll">
        {mode === 'character' ? (
          <>
            <CharacterBuilderPanel
              draft={characterDraft}
              onChange={(next) => { setCharacterDraft(next); setError(null) }}
              referenceImages={refImages}
              maxReferences={currentReferenceLimit}
              onAddReferenceFiles={addRefFiles}
              onRemoveReference={removeRefAt}
              onGrabReference={grabPlayhead}
              targetModel={model}
              promptMax={providerPromptMax}
              onSpend={onSpend}
              toast={toast}
            />
            <section className="ef-character-output-panel" aria-labelledby="ef-character-output-title">
              <div className="ef-character-section-heading ef-character-section-heading--compact">
                <div>
                  <span className="ef-character-step">OUTPUT · VARIATIONS</span>
                  <h2 id="ef-character-output-title">Generation settings</h2>
                </div>
              </div>
              {outputSettings}
            </section>
          </>
        ) : (
          <>
            <ReferenceImageGrid images={refImages} max={maxReferenceImages} onAddFiles={addRefFiles} onRemove={removeRefAt} onGrabPlayhead={grabPlayhead} />
            <PromptCard prompt={prompt} onPromptChange={(value) => { setPrompt(value); setError(null) }} maxLength={userPromptMax} enhancerKey="enhancer-image" targetModel={model} mediaKind="image" style={style} references={enhanceRefs} onSpend={onSpend} />
            <ChipField label="STYLE" options={STYLES} selected={style} onSelect={setStyle} chipClassName="ef-style-chip" />
            {outputSettings}
          </>
        )}

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-atomic="true" aria-label={`Generating ${count} image${count === '1' ? '' : 's'}`}>
              <div className="ef-result-grid">
                {Array.from({ length: Number(count) }, (_, i) => i * 0.15).map((delay) => (
                  <div key={delay} className="ef-skeleton" style={{ animationDelay: `${delay}s` }} aria-hidden="true" />
                ))}
              </div>
              <span className="ef-gen-caption">DREAMING UP {count} FRAME{count === '1' ? '' : 'S'}…</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} />
          </>
        )}

        {phase === 'done' && (
          <div className="ef-done-block" role="region" aria-label={`${results.length} generated image results`}>
            <div className="ef-result-review-head">
              <span><strong>Choose results</strong><small>Only selected images will be placed on the timeline.</small></span>
              <em>{selectedResultIds.length} / {results.length}</em>
            </div>
            <div className="ef-result-grid">
              {results.map((r, index) => (
                <div className={'ef-result-choice' + (selectedResultIds.includes(r.id) ? ' is-selected' : '')} key={r.id}>
                  <button
                    type="button"
                    className="ef-result-tile"
                    aria-label={`Preview generated image ${index + 1}`}
                    onClick={() => setLightbox(r.url)}
                    style={{ backgroundImage: `url("${r.url}")`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                  >
                    <span className="ef-result-overlay">⤢ Enlarge</span>
                  </button>
                  <button
                    type="button"
                    className="ef-result-select"
                    aria-label={`${selectedResultIds.includes(r.id) ? 'Deselect' : 'Select'} image ${index + 1} for timeline placement`}
                    aria-pressed={selectedResultIds.includes(r.id)}
                    onClick={() => toggleResult(r.id)}
                  >
                    {selectedResultIds.includes(r.id) ? '✓' : '+'}
                  </button>
                </div>
              ))}
            </div>
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ Create another</button>
              <button type="button" className="ef-ghost-btn" onClick={() => results.forEach((r, i) => saveUrl(r.url, `easyfield-${mode === 'character' ? 'character-' : ''}${i + 1}.png`))}>↓ Save all</button>
              <button
                type="button"
                className="ef-send-btn"
                disabled={selectedResults.length === 0 || placing}
                onClick={() => void placeSelectedResults()}
              >
                {placing ? 'Placing…' : selectedResults.length ? `Place ${selectedResults.length} selected` : 'Select to place'}
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label={`${mode === 'character' ? 'Character' : 'Image'} generation summary`}>
          <PriceEstimate estimate={estimate} />
          <div
            id="create-image-footer-message"
            className={`ef-create-footer-message ${error || spendBlocked || promptOverLimit ? 'is-error' : connected ? 'is-ready' : 'is-help'}`}
            role={error || spendBlocked || promptOverLimit ? 'alert' : 'status'}
            aria-live={error || spendBlocked || promptOverLimit ? 'assertive' : 'polite'}
          >
            {error
              ? `✕ ${error}`
              : promptOverLimit
                ? `✕ ${model} allows ${providerPromptMax.toLocaleString()} prompt characters · shorten the current brief`
              : !connected
                ? 'Connect EasyField Cloud to generate'
                : !characterDraftReady
                  ? 'Loading character design…'
                  : !characterReferenceReady
                    ? currentReferenceLimit > 0
                      ? 'Add a character sample to generate'
                      : `${model} does not accept character samples`
                : spendBlocked
                  ? `✕ ${spendApproval.reason}`
                  : `${count} ${mode === 'character' ? 'character' : 'image'}${count === '1' ? '' : 's'} · ${resolution || aspect}`}
          </div>
          <button
            type="button"
            className="ef-generate ef-create-footer-action"
            onClick={generate}
            disabled={!connected || !spendApproval.approved || !characterDraftReady || !characterReferenceReady || promptOverLimit}
            aria-describedby="create-image-footer-message"
          >
            <Icon glyph="spark" color="#0E0E13" size={13} /> Generate
          </button>
        </footer>
      )}

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
