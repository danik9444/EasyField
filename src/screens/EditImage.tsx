import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { ChipField } from '../components/ChipField'
import { PromptCard } from '../components/PromptCard'
import { MaskCanvas } from '../components/MaskCanvas'
import { MediaActionMenu, type MediaAction } from '../components/MediaActionMenu'
import { ReferenceImageGrid } from '../components/ReferenceImageGrid'
import { PriceEstimate } from '../components/PriceEstimate'
import { ProviderLogo } from '../components/ProviderLogo'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { imageEditRunEstimate, resolveCharged, formatCharged } from '../data/pricing'
import { resolve } from '../services/resolve'
import { sendToTimeline } from '../services/timeline'
import { runImageEdit, isConnected, isGenerationExit } from '../services/run'
import { Lightbox } from '../components/Lightbox'
import { addCreation } from '../data/creations'
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, IMAGE_MODEL_ALIASES } from '../data/models'
import { IDEOGRAM_V3_EDIT_PROMPT_MAX, IMAGE_MODEL_CONFIG, resolveImageOptions, type ImageOptions } from '../data/imageModelConfig'
import { IMAGE_EDIT_SPECIALIST_META, IMAGE_MODEL_META } from '../data/modelPresentation'
import { loadValue, saveValue } from '../data/prefs'
import { getSpendApproval } from '../services/spendGuard'
import { loadSettings } from '../settings'
import type { ReferenceImage } from '../data/referenceImage'
import type { EnhanceReference } from '../services/chat'
import { promptCharacterCount } from '../data/promptLimits'

// Whole-image prompt edits using cloud models that support image editing.
const CUSTOM_MODELS = IMAGE_MODELS
// Mask-based inpainting — the current verified cloud adapter with dedicated
// image_url + mask_url fields.
const INPAINT_MODELS = ['Ideogram V3 Edit']

// Cloud upscale models. Topaz exposes an upscale_factor; Recraft Crisp has
// no settings beyond the source image.
const UPSCALE_MODELS = ['Topaz Image Upscale', 'Recraft Crisp Upscale']
const TOPAZ_FACTORS = ['1×', '2×', '4×', '8×'] // topaz/image-upscale upscale_factor
// Remove-background uses the verified Recraft endpoint with no settings.
const REMOVE_BG_MODEL = 'Recraft Remove BG'
const PREFS_KEY = 'edit-image'
const BRUSH_MIN = 8
const BRUSH_MAX = 60
const MASK_COLORS = ['#3EE88C', '#FF5A5A', '#5B8CFF', '#FFD24A', '#E26BD2']
const DEFAULT_MASK_COLOR = MASK_COLORS[0]
const IMAGE_EDIT_REFERENCE_SCAFFOLD = [
  'Edit image 1 only; it is the primary image being edited.',
  'Images 2 and later are supporting visual references only. Do not replace image 1 or transfer their composition unless the edit instruction explicitly asks for it.',
  '',
  'Edit instruction: ',
].join('\n')

const CAPTIONS: Record<string, string> = {
  custom: 'GENERATING…',
  inpaint: 'PAINTING EDIT…',
  upscale: 'UPSCALING…',
  removebg: 'REMOVING BACKGROUND…',
}

type Phase = 'form' | 'generating' | 'done'
type EditMode = 'custom' | 'inpaint'
type UtilityAction = 'upscale' | 'removebg' | null

interface EditImageProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
  // A source handed off from the Library (its URL is shared, so we never revoke it).
  incomingSource?: { url: string; name?: string }
}

interface EditPrefs {
  mode?: EditMode
  // Legacy migration from the former category strip.
  operation?: string
  customModel?: string
  inpaintModel?: string
  prompt?: string
  brushSize?: string
  maskColor?: string
  upscaleModel?: string
  upscaleFactor?: string
  customPerModel?: Record<string, ImageOptions>
}

function loadEditState(): EditPrefs {
  try {
    const raw = loadValue(PREFS_KEY)
    return raw ? (JSON.parse(raw) as EditPrefs) : {}
  } catch {
    return {}
  }
}

export function EditImage({ onBack, toast, onSpend, incomingSource }: EditImageProps) {
  const saved = useRef(loadEditState()).current
  const [phase, setPhase] = useState<Phase>('form')
  const [charged, setCharged] = useState<number | null>(null)
  const [mode, setMode] = useState<EditMode>(() => saved.mode ?? (saved.operation === 'inpaint' ? 'inpaint' : 'custom'))
  const [utilityAction, setUtilityAction] = useState<UtilityAction>(() =>
    saved.operation === 'upscale' || saved.operation === 'removebg' ? saved.operation : null,
  )
  const savedCustomModel = saved.customModel ? IMAGE_MODEL_ALIASES[saved.customModel] ?? saved.customModel : ''
  const initialCustomModel = CUSTOM_MODELS.includes(savedCustomModel) ? savedCustomModel : DEFAULT_IMAGE_MODEL
  const customPerModelRef = useRef<Record<string, ImageOptions>>(saved.customPerModel ?? {})
  const [customModel, setCustomModel] = useState(initialCustomModel)
  const initialCustomOpts = useRef(resolveImageOptions(initialCustomModel, customPerModelRef.current[initialCustomModel] ?? customPerModelRef.current[saved.customModel ?? ''])).current
  const [customAspect, setCustomAspect] = useState(initialCustomOpts.aspect)
  const [customResolution, setCustomResolution] = useState(initialCustomOpts.resolution)
  const [customExtras, setCustomExtras] = useState(initialCustomOpts.extraOptionValues)
  const [inpaintModel, setInpaintModel] = useState(() => (INPAINT_MODELS.includes(saved.inpaintModel ?? '') ? saved.inpaintModel! : INPAINT_MODELS[0]))
  const [prompt, setPrompt] = useState(saved.prompt ?? 'Remove the microphone and clean up the background')
  const [brushSize, setBrushSize] = useState(() => {
    const b = Number(saved.brushSize)
    return b >= BRUSH_MIN && b <= BRUSH_MAX ? b : 24
  })
  const [maskColor, setMaskColor] = useState(() => (/^#[0-9a-fA-F]{6}$/.test(saved.maskColor ?? '') ? saved.maskColor! : DEFAULT_MASK_COLOR))
  const [upscaleModel, setUpscaleModel] = useState(() => (UPSCALE_MODELS.includes(saved.upscaleModel ?? '') ? saved.upscaleModel! : UPSCALE_MODELS[0]))
  const [upscaleFactor, setUpscaleFactor] = useState(() => (TOPAZ_FACTORS.includes(saved.upscaleFactor ?? '') ? saved.upscaleFactor! : '2×'))

  const idCounterRef = useRef(1)
  const nextId = () => `src-${idCounterRef.current++}`
  const borrowedUrl = incomingSource?.url
  const [source, setSource] = useState<ReferenceImage | null>(() =>
    incomingSource
      ? { id: nextId(), kind: 'upload', name: incomingSource.name ?? 'From library', url: incomingSource.url }
      : null,
  )
  const sourceRef = useRef<ReferenceImage | null>(source)
  const sourceCaptureIdRef = useRef(0)
  const autoGrabAttemptedRef = useRef(false)
  const sourceGrabPendingRef = useRef(false)
  const [sourceGrabPending, setSourceGrabPending] = useState(false)
  const [refImages, setRefImages] = useState<ReferenceImage[]>([])
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const clearMaskRef = useRef<() => void>(() => {})
  const exportMaskRef = useRef<() => Promise<Blob | null>>(async () => null)
  const [hasMask, setHasMask] = useState(false)
  const cleanupRef = useRef({ sourceUrl: null as string | null, refImages })
  const activeRunRef = useRef(false)
  const unmountedRef = useRef(false)
  const generation = useGenerationJobControl()

  useEffect(() => {
    sourceRef.current = source
    cleanupRef.current = { sourceUrl: source?.kind === 'upload' && source.url !== borrowedUrl ? source.url : null, refImages }
  })

  useEffect(
    () => {
      unmountedRef.current = false
      return () => {
        unmountedRef.current = true
        sourceCaptureIdRef.current += 1
        if (activeRunRef.current) return
        const c = cleanupRef.current
        if (c.sourceUrl) URL.revokeObjectURL(c.sourceUrl)
        c.refImages.forEach((r) => {
          if (r.kind === 'upload') URL.revokeObjectURL(r.url)
        })
      }
    },
    [],
  )

  const replaceSource = useCallback((next: ReferenceImage) => {
    const previous = sourceRef.current
    if (previous?.kind === 'upload' && previous.url !== borrowedUrl && (next.kind !== 'upload' || previous.url !== next.url)) {
      URL.revokeObjectURL(previous.url)
    }
    sourceRef.current = next
    setSource(next)
    setUtilityAction(null)
    setPhase('form')
    setResultUrl(null)
    setCharged(null)
    setError(null)
  }, [borrowedUrl])

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
      toast(`Source capture failed · ${grabbed.error || 'place the playhead over an image or video clip'}`)
      return
    }
    replaceSource({ id: nextId(), kind: 'upload', name: grabbed.name, url: grabbed.blobUrl })
    if (announce) {
      toast(grabbed.sourceKind === 'still-image'
        ? 'Source still loaded from the clip under the playhead'
        : 'Current video frame captured from the timeline')
    }
  }, [replaceSource, toast])

  // With no hand-off source, try the timeline once. A failed capture leaves the
  // upload prompt intact instead of inventing a source with no pixels.
  useEffect(() => {
    if (incomingSource || autoGrabAttemptedRef.current) return
    autoGrabAttemptedRef.current = true
    let alive = true
    const timer = window.setTimeout(() => void (async () => {
      const bridge = resolve.isBridgeConnected() ? resolve.getStatus() : await resolve.refreshStatus()
      if (!alive || !bridge.connected) return
      await grabPrimarySource(false)
    })(), 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grabPrimarySource, incomingSource])

  // Additional reference images the custom-edit model can consume. The source
  // frame occupies one input slot, so the budget is the model's max minus one.
  const refMax = Math.max(0, IMAGE_MODEL_CONFIG[customModel].maxReferenceImages - 1)

  // The image being edited plus any extra references feed the prompt enhancer's
  // vision so the edit instruction is grounded in what's actually on screen.
  const toRef = (r: ReferenceImage, role: string): EnhanceReference =>
    r.kind === 'upload'
      ? { role, label: r.name, imageUrl: r.url }
      : { role, note: `timeline frame at ${r.timecode}` }
  const enhanceRefs: EnhanceReference[] = [
    ...(source ? [toRef(source, 'primary image to edit')] : []),
    ...(mode === 'custom' && !utilityAction
      ? refImages.map((r) => toRef(r, 'supporting visual reference — not the image being edited'))
      : []),
  ]

  const addRefFiles = (files: File[]) => {
    const remaining = refMax - refImages.length
    if (remaining <= 0) return
    const toAdd: ReferenceImage[] = files
      .slice(0, remaining)
      .map((file) => ({ id: `ref-${idCounterRef.current++}`, kind: 'upload', name: file.name, url: URL.createObjectURL(file) }))
    setRefImages((prev) => [...prev, ...toAdd])
    if (files.length > toAdd.length) {
      toast(`Only ${toAdd.length} added — ${customModel} allows up to ${refMax} reference image${refMax === 1 ? '' : 's'} alongside the source`)
    }
  }

  const grabRef = async () => {
    if (refImages.length >= refMax) return
    const g = await resolve.grabFrame()
    if (!g.ok || !g.blobUrl) {
      toast(`Reference capture failed · ${g.error || 'check Resolve and the playhead'}`)
      return
    }
    const item: ReferenceImage = { id: `up-${idCounterRef.current++}`, kind: 'upload', name: g.name, url: g.blobUrl }
    setRefImages((prev) => (prev.length >= refMax ? prev : [...prev, item]))
  }

  const removeRefAt = (id: string) => {
    setRefImages((prev) => {
      const target = prev.find((r) => r.id === id)
      if (target?.kind === 'upload') URL.revokeObjectURL(target.url)
      return prev.filter((r) => r.id !== id)
    })
  }

  useEffect(() => {
    customPerModelRef.current = {
      ...customPerModelRef.current,
      [customModel]: { aspect: customAspect, resolution: customResolution, extraOptionValues: customExtras },
    }
    saveValue(
      PREFS_KEY,
      JSON.stringify({
        mode,
        operation: utilityAction ?? mode,
        customModel,
        inpaintModel,
        prompt,
        brushSize: String(brushSize),
        maskColor,
        upscaleModel,
        upscaleFactor,
        customPerModel: customPerModelRef.current,
      }),
    )
  }, [mode, utilityAction, customModel, inpaintModel, prompt, brushSize, maskColor, upscaleModel, upscaleFactor, customAspect, customResolution, customExtras])

  // Switch the custom-edit model, restoring that model's remembered parameters
  // and trimming references beyond the new model's budget.
  const changeCustomModel = (next: string) => {
    const s = resolveImageOptions(next, customPerModelRef.current[next])
    setCustomModel(next)
    setCustomAspect(s.aspect)
    setCustomResolution(s.resolution)
    setCustomExtras(s.extraOptionValues)
    const nextRefMax = Math.max(0, IMAGE_MODEL_CONFIG[next].maxReferenceImages - 1)
    if (refImages.length > nextRefMax) {
      refImages.slice(nextRefMax).forEach((r) => {
        if (r.kind === 'upload') URL.revokeObjectURL(r.url)
      })
      setRefImages((prev) => prev.slice(0, nextRefMax))
      toast(`${next} allows up to ${nextRefMax} reference image${nextRefMax === 1 ? '' : 's'} — trimmed extras`)
    }
  }

  const pickSource = (file: File) => {
    if (activeRunRef.current) return
    sourceCaptureIdRef.current += 1
    sourceGrabPendingRef.current = false
    setSourceGrabPending(false)
    replaceSource({ id: nextId(), kind: 'upload', name: file.name, url: URL.createObjectURL(file) })
  }

  const registerClear = useCallback((fn: () => void) => {
    clearMaskRef.current = fn
  }, [])

  const registerMaskExport = useCallback((fn: () => Promise<Blob | null>) => {
    exportMaskRef.current = fn
  }, [])

  const mediaActions: MediaAction[] = source
    ? [
        { id: 'upscale', label: 'Upscale image…', description: 'Topaz or Recraft · choose before running' },
        { id: 'removebg', label: 'Remove background…', description: 'Recraft · transparent PNG result' },
      ]
    : []

  const apply = async () => {
    setError(null)
    if (!utilityAction && promptOverLimit) {
      setError(`${activeEditModel} prompt is over its ${activePromptProviderMax.toLocaleString()}-character provider limit after EasyField's edit context is included.`)
      return
    }
    let mask: ReferenceImage | null = null
    if (!utilityAction && mode === 'inpaint') {
      const maskBlob = await exportMaskRef.current()
      if (!maskBlob) {
        setError('Paint the area you want to replace before running Inpaint.')
        return
      }
      mask = { id: `mask-${idCounterRef.current++}`, kind: 'upload', name: 'easyfield-inpaint-mask.png', url: URL.createObjectURL(maskBlob) }
    }
    setPhase('generating')
    const controller = generation.begin()
    activeRunRef.current = true
    try {
      const res =
        utilityAction === 'upscale'
          ? await runImageEdit({ operation: 'upscale', source, upscaleModel, factor: upscaleFactor }, { signal: controller.signal, onJobCreated: generation.attachJob })
          : utilityAction === 'removebg'
            ? await runImageEdit({ operation: 'removebg', source }, { signal: controller.signal, onJobCreated: generation.attachJob })
            : mode === 'inpaint'
              ? await runImageEdit(
                  { operation: 'inpaint', source, model: inpaintModel, prompt, mask },
                  { signal: controller.signal, onJobCreated: generation.attachJob },
                )
              : await runImageEdit(
                { operation: 'custom', source, model: customModel, prompt, aspect: customAspect, resolution: customResolution, extras: customExtras, refs: refImages },
                { signal: controller.signal, onJobCreated: generation.attachJob },
              )
      if (controller.signal.aborted) return
      if (res.droppedPlayheads) toast(`${res.droppedPlayheads} timeline reference(s) skipped — upload images or connect DaVinci`)
      if (!res.urls.length) {
        setError('No result was returned — please try again.')
        setPhase('form')
        return
      }
      const operation = utilityAction ?? mode
      const priceModel = mode === 'inpaint' && !utilityAction ? inpaintModel : customModel
      const c = res.credits ?? resolveCharged(imageEditRunEstimate(operation, priceModel, customResolution, customExtras, upscaleModel, operation === 'custom' ? (source ? 1 : 0) + refImages.length : 0))
      setCharged(c)
      onSpend(c ?? 0)
      setResultUrl(res.urls[0])
      addCreation({
        kind: 'image',
        url: res.urls[0],
        model: utilityAction === 'upscale' ? upscaleModel : utilityAction === 'removebg' ? REMOVE_BG_MODEL : mode === 'inpaint' ? inpaintModel : customModel,
        prompt: utilityAction ? `${utilityAction} source image` : prompt,
      })
      setPhase('done')
    } catch (e) {
      if (controller.signal.aborted || isGenerationExit(e)) {
        setPhase('form')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setPhase('form')
    } finally {
      if (mask?.kind === 'upload') URL.revokeObjectURL(mask.url)
      generation.finish(controller)
      activeRunRef.current = false
      if (unmountedRef.current) {
        const c = cleanupRef.current
        if (c.sourceUrl) URL.revokeObjectURL(c.sourceUrl)
        c.refImages.forEach((r) => {
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
      ? 'Edit continues in Activity · the result will be saved to Library'
      : 'Edit cancelled')
  }

  const operation = utilityAction ?? mode
  const connected = isConnected()
  const priceModel = mode === 'inpaint' && !utilityAction ? inpaintModel : customModel
  const editEstimate = imageEditRunEstimate(operation, priceModel, customResolution, customExtras, upscaleModel, operation === 'custom' ? (source ? 1 : 0) + refImages.length : 0)
  const spendApproval = getSpendApproval(editEstimate, loadSettings().spendLimit)
  const spendBlocked = connected && !spendApproval.approved
  const sourceReady = source?.kind === 'upload' && !!source.url
  const promptMissing = !utilityAction && !prompt.trim()
  const activeEditModel = mode === 'inpaint' ? inpaintModel : customModel
  const activePromptProviderMax = mode === 'inpaint'
    ? IDEOGRAM_V3_EDIT_PROMPT_MAX
    : IMAGE_MODEL_CONFIG[customModel].promptMax
  const promptScaffoldLength = mode === 'custom' && refImages.length > 0
    ? promptCharacterCount(IMAGE_EDIT_REFERENCE_SCAFFOLD)
    : 0
  const activePromptMax = Math.max(1, activePromptProviderMax - promptScaffoldLength)
  const promptOverLimit = !utilityAction && promptCharacterCount(prompt) > activePromptMax
  const maskMissing = !utilityAction && mode === 'inpaint' && !hasMask
  const footerHasError = !!error || spendBlocked || promptMissing || promptOverLimit || maskMissing
  const footerMessage = error
    ? `✕ ${error}`
    : !sourceReady
      ? 'Add or capture a source image to run this edit.'
      : promptMissing
        ? 'Describe the image edit you want.'
        : promptOverLimit
          ? `${activeEditModel} allows ${activePromptProviderMax.toLocaleString()} prompt characters including EasyField's source/reference instructions · shorten by ${(promptCharacterCount(prompt) - activePromptMax).toLocaleString()}.`
        : maskMissing
          ? 'Paint the area you want Inpaint to replace.'
          : !connected
            ? 'Connect EasyField Cloud to run this edit'
            : spendBlocked
              ? spendApproval.reason
              : utilityAction === 'upscale'
                ? 'Upscale is ready · the primary image stays unchanged'
              : utilityAction === 'removebg'
                  ? 'Transparent PNG will be saved as a new Library result'
                  : 'Primary image stays the edit target · references are guidance only'

  const activeModelOptions = mode === 'inpaint' ? INPAINT_MODELS : CUSTOM_MODELS
  const selectActiveModel = mode === 'inpaint' ? setInpaintModel : changeCustomModel

  return (
    <div className="ef-screen ef-legacy-workspace ef-edit-image-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Edit Image</span>
        <span className="ef-spacer" />
        <Dropdown
          options={activeModelOptions}
          selected={activeEditModel}
          onSelect={selectActiveModel}
          label="Image edit model"
          optionMeta={mode === 'inpaint' ? IMAGE_EDIT_SPECIALIST_META : IMAGE_MODEL_META}
        />
      </div>

      <div className="ef-scroll ef-create-scroll">
        <div className="ef-edit-mode-bar" role="group" aria-label="Image editing mode">
          <span><small>EDIT MODE</small><strong>{mode === 'inpaint' ? 'Paint a precise area' : 'Transform the whole image'}</strong></span>
          <div className="ef-setting-segmented">
            <button type="button" className={mode === 'custom' ? 'is-selected' : ''} aria-pressed={mode === 'custom'} onClick={() => { setMode('custom'); setUtilityAction(null) }}>Prompt edit</button>
            <button type="button" className={mode === 'inpaint' ? 'is-selected' : ''} aria-pressed={mode === 'inpaint'} onClick={() => { setMode('inpaint'); setUtilityAction(null) }}>Inpaint</button>
          </div>
        </div>

        <div className="ef-primary-media-heading">
          <span className="ef-field-label">IMAGE TO EDIT</span>
          <span>PRIMARY SOURCE</span>
        </div>
        <MediaActionMenu
          label="Primary image"
          actions={mediaActions}
          disabled={!sourceReady}
          onSelect={(id) => setUtilityAction(id === 'upscale' ? 'upscale' : id === 'removebg' ? 'removebg' : null)}
        >
          <MaskCanvas
            source={source}
            maskable={mode === 'inpaint' && !utilityAction}
            brushSize={brushSize}
            color={maskColor}
            onPick={pickSource}
            onGrab={() => { void grabPrimarySource() }}
            grabPending={sourceGrabPending}
            disabled={phase === 'generating'}
            onClearRef={registerClear}
            onMaskExportRef={registerMaskExport}
            onMaskChange={setHasMask}
          />
        </MediaActionMenu>

        {utilityAction && (
          <section className="ef-quick-action-card" aria-labelledby="ef-image-utility-title">
            <header>
              <span>
                <small>MEDIA ACTION</small>
                <strong id="ef-image-utility-title">{utilityAction === 'upscale' ? 'Upscale source image' : 'Remove source background'}</strong>
              </span>
              <button type="button" className="ef-icon-btn" aria-label="Close media action" onClick={() => setUtilityAction(null)}>×</button>
            </header>
            <p>{utilityAction === 'upscale'
              ? 'Enhance the primary image as a new result. Your source and prompt-edit draft stay untouched.'
              : 'Create a new transparent PNG with Recraft. The primary source remains unchanged.'}</p>
            {utilityAction === 'upscale' ? (
              <>
                <div className="ef-field">
                  <span className="ef-field-label">MODEL</span>
                  <Dropdown options={UPSCALE_MODELS} selected={upscaleModel} onSelect={setUpscaleModel} label="Upscale model" align="left" variant="field" optionMeta={IMAGE_EDIT_SPECIALIST_META} />
                </div>
                {upscaleModel === 'Topaz Image Upscale' && <ChipField label="FACTOR" options={TOPAZ_FACTORS} selected={upscaleFactor} onSelect={setUpscaleFactor} />}
              </>
            ) : (
              <div className="ef-field">
                <span className="ef-field-label">MODEL</span>
                <span className="ef-model-static"><ProviderLogo brand="recraft" size={17} />{REMOVE_BG_MODEL}</span>
              </div>
            )}
          </section>
        )}

        {!utilityAction && mode === 'inpaint' && (
          <>
            <div className="ef-inpaint-tools" role="group" aria-label="Inpaint brush tools">
              <div className="ef-field">
                <span className="ef-field-label">MASK COLOR</span>
              <div className="ef-color-row">
                {MASK_COLORS.map((c) => (
                  <button
                    key={c}
                    className={'ef-color-swatch' + (c === maskColor ? ' selected' : '')}
                    style={{ background: c }}
                    aria-label={`Mask color ${c}`}
                    onClick={() => setMaskColor(c)}
                  />
                ))}
                <input
                  className="ef-color-input"
                  type="color"
                  value={maskColor}
                  onChange={(e) => setMaskColor(e.target.value)}
                  aria-label="Custom mask color"
                />
              </div>
            </div>
            <div className="ef-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">BRUSH</span>
                <span className="ef-spacer" />
                <span className="ef-ref-count">{brushSize}px</span>
              </div>
              <input
                className="ef-brush-slider"
                type="range"
                min={BRUSH_MIN}
                max={BRUSH_MAX}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                aria-label="Brush size"
              />
            </div>
            </div>
          </>
        )}

        {!utilityAction && (
          <>
            <PromptCard prompt={prompt} onPromptChange={(value) => { setPrompt(value); setError(null) }} maxLength={activePromptMax} enhancerKey="enhancer-edit" targetModel={activeEditModel} mediaKind="image" purpose="edit" references={enhanceRefs} onSpend={onSpend} />
          </>
        )}

        {!utilityAction && mode === 'custom' && (
          <>
            {refMax > 0 && (
              <ReferenceImageGrid
                images={refImages}
                max={refMax}
                onAddFiles={addRefFiles}
                onRemove={removeRefAt}
                onGrabPlayhead={grabRef}
                label="SUPPORTING REFERENCES · NOT EDITED"
              />
            )}
            {IMAGE_MODEL_CONFIG[customModel].aspectRatios.length > 0 && (
              <div className="ef-field">
                <span className="ef-field-label">ASPECT</span>
                <Dropdown
                  options={IMAGE_MODEL_CONFIG[customModel].aspectRatios}
                  selected={customAspect}
                  onSelect={setCustomAspect}
                  label="Aspect ratio"
                  align="left"
                  variant="field"
                />
              </div>
            )}
            {IMAGE_MODEL_CONFIG[customModel].resolutions.length > 0 && (
              <ChipField label="RESOLUTION" options={IMAGE_MODEL_CONFIG[customModel].resolutions} selected={customResolution} onSelect={setCustomResolution} />
            )}
            {IMAGE_MODEL_CONFIG[customModel].extraOptions.map((opt) => (
              <ChipField
                key={opt.key}
                label={opt.label}
                options={opt.values}
                selected={customExtras[opt.key]}
                onSelect={(v) => setCustomExtras((prev) => ({ ...prev, [opt.key]: v }))}
              />
            ))}
          </>
        )}

        {phase === 'generating' && (
          <>
            <div className="ef-gen-block" role="status" aria-live="polite" aria-atomic="true" aria-label={CAPTIONS[operation]}>
              <div className="ef-skeleton" style={{ aspectRatio: '4 / 3' }} aria-hidden="true" />
              <span className="ef-gen-caption">{CAPTIONS[operation]}</span>
            </div>
            <GenerationCancelControl job={generation.job} onExit={exitGeneration} noun="edit" />
          </>
        )}

        {phase === 'done' && resultUrl && (
          <div className="ef-done-block" role="region" aria-label="Edited image result">
            <button type="button" className="ef-result-tile" aria-label="Preview edited image" onClick={() => setLightbox(resultUrl)} style={{ aspectRatio: '4 / 3', backgroundImage: `url("${resultUrl}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundColor: '#0b0b10' }}>
              <span className="ef-result-overlay">⤢ Enlarge</span>
            </button>
            <div className="ef-charged">{formatCharged(charged)}</div>
            <div className="ef-result-actions">
              <button type="button" className="ef-ghost-btn" onClick={() => setPhase('form')}>↺ Edit another</button>
              <button
                type="button"
                className="ef-send-btn"
                onClick={() => sendToTimeline([{ url: resultUrl, name: utilityAction ? `${utilityAction} image` : prompt.slice(0, 40) || 'EasyField edit' }], 'image', toast)}
              >
                Send to timeline
              </button>
            </div>
          </div>
        )}
      </div>

      {phase === 'form' && (
        <footer className="ef-create-footer" aria-label="Image edit summary">
          <PriceEstimate estimate={editEstimate} />
          <div className={`ef-create-footer-message ${footerHasError ? 'is-error' : !sourceReady || !connected ? 'is-help' : 'is-ready'}`} role={footerHasError ? 'alert' : 'status'} aria-live="polite">
            {footerHasError && !error && <span aria-hidden="true">✕ </span>}
            {footerMessage}
          </div>
          <button type="button" className="ef-generate ef-create-footer-action" onClick={apply} disabled={!sourceReady || promptMissing || promptOverLimit || maskMissing || !connected || !spendApproval.approved}>
            <Icon glyph="spark" color="#0E0E13" size={13} /> {utilityAction === 'upscale' ? 'Upscale image' : utilityAction === 'removebg' ? 'Remove background' : mode === 'inpaint' ? 'Apply inpaint' : 'Apply edit'}
          </button>
        </footer>
      )}

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
