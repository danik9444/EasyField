import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Icon, type GlyphName } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { PromptCard } from '../components/PromptCard'
import { ChipField } from '../components/ChipField'
import { DurationSlider } from '../components/DurationSlider'
import { Lightbox } from '../components/Lightbox'
import { GenerationCancelControl, useGenerationJobControl } from '../components/GenerationCancelControl'
import { LibraryPickerButton } from '../components/LibraryPicker'
import { renderAnimation } from '../services/animationRender'
import { isGenerationExit } from '../services/run'
import { sendToTimeline } from '../services/timeline'
import { resolve } from '../services/resolve'
import { type EnhanceReference, type EnhanceSupportingContext } from '../services/chat'
import {
  ANIMATION_DOCUMENT_ACCEPT,
  extractAnimationDocument,
  isAnimationDocumentFile,
} from '../services/animationDocuments'
import { fetchAnimationUrlContext } from '../services/urlContext'
import {
  ANIM_ENGINES,
  ANIMATION_RECIPES,
  ANIMATION_SOUND_OPTIONS,
  ANIM_ASPECTS,
  ANIM_FPS,
  ANIM_DURATIONS,
  ANIM_BGS,
  buildAnimationPromptContext,
  displayTextForAnimation,
  normalizeAnimationPrompts,
  normalizeAnimRecipe,
  normalizeAnimSoundMode,
  renderModeForRecipe,
  type AnimSettings,
  type AnimEngine,
  type AnimRecipeId,
  type AnimSoundMode,
} from '../data/animationConfig'
import { ANIMATION_ENGINE_META } from '../data/modelPresentation'
import { loadValue, saveValue } from '../data/prefs'
import { addCreation, type Creation } from '../data/creations'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'

const PREFS_KEY = 'animation'
const PROMPT_MAX = 1_600
const MAX_SOURCES = 16
const MAX_URL_SOURCES = 3
const MAX_CONTEXT_CHARS = 80_000
const MAX_RENDER_AUDIO_BYTES = 24 * 1024 * 1024
const INPUT_ACCEPT = `image/*,video/*,audio/*,${ANIMATION_DOCUMENT_ACCEPT}`

type AnimationSourceKind = 'image' | 'video' | 'audio' | 'document' | 'url'

interface AnimationSource {
  id: string
  kind: AnimationSourceKind
  name: string
  url?: string
  posterUrl?: string
  text?: string
  meta: string
  durationSeconds?: number
  ownedUrl?: boolean
}

interface AnimationProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend?: (credits: number) => void
}

interface AnimPrefs {
  engine?: string
  mode?: string
  recipe?: string
  text?: string
  prompts?: Partial<Record<AnimRecipeId, string>>
  preset?: string
  sound?: string | boolean
  aspect?: string
  fps?: string
  duration?: string
  bg?: string
}

const RECIPE_ICONS: Record<AnimRecipeId, GlyphName> = {
  custom: 'anim',
  'smart-captions': 'cap',
  'text-motion-graphics': 'transcribe',
  'product-video': 'vid',
  'intros-outros': 'film',
  'overlays-graphics': 'board',
  'website-to-video': 'playhead',
  'audio-visualizer': 'music',
  'data-to-video': 'beat',
}

const RECIPE_LABELS = ANIMATION_RECIPES.map((item) => item.label)
const RECIPE_OPTION_META = Object.fromEntries(ANIMATION_RECIPES.map((item) => [item.label, {
  eyebrow: 'ANIMATION FORMAT',
  description: item.description,
  badge: item.inputHint,
  searchTerms: [item.id, item.inputHint],
}]))

const SOURCE_ICONS: Record<Exclude<AnimationSourceKind, 'image' | 'video'>, GlyphName> = {
  audio: 'music',
  document: 'transcribe',
  url: 'playhead',
}

function loadAnimState(): AnimPrefs {
  try {
    const raw = loadValue(PREFS_KEY)
    return raw ? (JSON.parse(raw) as AnimPrefs) : {}
  } catch {
    return {}
  }
}

const readAccent = () =>
  (typeof getComputedStyle !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--ef-accent').trim() : '') || '#E26BD2'

const sourceId = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `animation-${Date.now()}-${Math.random().toString(36).slice(2)}`

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolveValue, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolveValue(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The selected image could not be read.'))
    reader.readAsDataURL(file)
  })
}

function probeMediaDuration(url: string, kind: 'video' | 'audio'): Promise<number | undefined> {
  return new Promise((resolveValue) => {
    const media = document.createElement(kind)
    let settled = false
    const finish = (value?: number) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      media.onloadedmetadata = null
      media.onerror = null
      media.removeAttribute('src')
      media.load()
      resolveValue(value)
    }
    const timer = window.setTimeout(() => finish(), 8_000)
    media.preload = 'metadata'
    media.onloadedmetadata = () => {
      finish(Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined)
    }
    media.onerror = () => finish()
    media.src = url
  })
}

function createVideoPoster(url: string): Promise<string | undefined> {
  return new Promise((resolveValue) => {
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    let settled = false
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolveValue(value)
    }
    const draw = () => {
      try {
        const width = video.videoWidth || 1280
        const height = video.videoHeight || 720
        const scale = Math.min(1, 1280 / Math.max(width, height))
        canvas.width = Math.max(2, Math.round(width * scale))
        canvas.height = Math.max(2, Math.round(height * scale))
        const context = canvas.getContext('2d')
        if (!context) return finish()
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        finish(canvas.toDataURL('image/jpeg', 0.86))
      } catch {
        finish()
      }
    }
    const timer = window.setTimeout(() => finish(), 10_000)
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    video.onloadeddata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0.12) {
        video.onseeked = draw
        video.currentTime = Math.min(0.12, video.duration / 3)
      } else draw()
    }
    video.onerror = () => finish()
    video.src = url
  })
}

function mediaMeta(kind: AnimationSourceKind, durationSeconds?: number): string {
  const duration = durationSeconds ? ` · ${durationSeconds.toFixed(durationSeconds < 10 ? 1 : 0)}s` : ''
  if (kind === 'image') return 'Image reference'
  if (kind === 'video') return `Video reference${duration}`
  if (kind === 'audio') return `Audio reference${duration}`
  if (kind === 'url') return 'Website context'
  return 'Document context'
}

function contextFromSources(sources: readonly AnimationSource[]): string {
  const blocks = sources.map((source) => {
    if (source.kind === 'document') return `DOCUMENT · ${source.name}\n${source.text ?? ''}`
    if (source.kind === 'url') return `WEBSITE · ${source.name}\nSource: ${source.url ?? ''}\n${source.text ?? ''}`
    const duration = source.durationSeconds ? `, ${source.durationSeconds.toFixed(1)} seconds` : ''
    return `${source.kind.toUpperCase()} REFERENCE · ${source.name}${duration}`
  })
  const text = blocks.join('\n\n').trim()
  if (text.length <= MAX_CONTEXT_CHARS) return text
  return `${text.slice(0, MAX_CONTEXT_CHARS - 40).trimEnd()}\n\n[Additional context was safely truncated.]`
}

export function Animation({ onBack, toast, onSpend }: AnimationProps) {
  const saved = useRef(loadAnimState()).current
  const savedRecipe = useRef(saved.recipe ?? saved.mode).current
  const initialRecipe = useRef(normalizeAnimRecipe(savedRecipe)).current
  const [engine, setEngine] = useState<AnimEngine>(() => (saved.engine === 'Remotion' ? 'Remotion' : 'HyperFrames'))
  const [recipe, setRecipe] = useState<AnimRecipeId>(initialRecipe)
  const [prompts, setPrompts] = useState<Partial<Record<AnimRecipeId, string>>>(() => (
    normalizeAnimationPrompts(saved.prompts, savedRecipe, saved.text)
  ))
  const [soundMode, setSoundMode] = useState<AnimSoundMode>(() => normalizeAnimSoundMode(saved.sound))
  const [aspect, setAspect] = useState(() => (ANIM_ASPECTS.includes(saved.aspect ?? '') ? saved.aspect! : '16:9'))
  const [fps, setFps] = useState(() => (ANIM_FPS.includes(saved.fps ?? '') ? saved.fps! : '30'))
  const [duration, setDuration] = useState(() => (ANIM_DURATIONS.includes(saved.duration ?? '') ? saved.duration! : '5'))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [sources, setSources] = useState<AnimationSource[]>([])
  const [ingesting, setIngesting] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const [urlError, setUrlError] = useState('')
  const [preview, setPreview] = useState<{ url: string; kind: 'image' | 'video' } | null>(null)
  const accent = useRef(readAccent()).current
  const fileRef = useRef<HTMLInputElement>(null)
  const sourcesRef = useRef<AnimationSource[]>([])
  const urlAbortRef = useRef<AbortController | null>(null)

  const [exporting, setExporting] = useState(false)
  const [exportUrl, setExportUrl] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const generation = useGenerationJobControl()

  const selectedRecipe = ANIMATION_RECIPES.find((item) => item.id === recipe) ?? ANIMATION_RECIPES[0]
  const prompt = prompts[recipe] ?? ''
  const outputAudioSource = soundMode === 'with-sound'
    ? sources.find((source) => source.kind === 'audio' && source.url) ?? null
    : null
  const soundReady = soundMode === 'without-sound' || outputAudioSource !== null

  useEffect(() => {
    saveValue(PREFS_KEY, JSON.stringify({ engine, recipe, prompts, sound: soundMode, aspect, fps, duration } satisfies AnimPrefs))
  }, [engine, recipe, prompts, soundMode, aspect, fps, duration])

  useEffect(() => {
    sourcesRef.current = sources
  }, [sources])

  useEffect(() => () => {
    urlAbortRef.current?.abort()
    sourcesRef.current.forEach((source) => {
      if (source.ownedUrl && source.url?.startsWith('blob:')) URL.revokeObjectURL(source.url)
    })
  }, [])

  const contextText = useMemo(() => contextFromSources(sources), [sources])
  const renderAssetUrls = useMemo(() => sources
    .flatMap((source) => source.kind === 'image' && source.url ? [source.url] : source.posterUrl ? [source.posterUrl] : [])
    .filter((url) => /^data:image\//i.test(url))
    .slice(0, 4), [sources])
  const displayText = useMemo(() => displayTextForAnimation(recipe, prompt, contextText), [recipe, prompt, contextText])
  const settings = useMemo<AnimSettings>(() => ({
    engine,
    recipe,
    mode: renderModeForRecipe(recipe, renderAssetUrls.length),
    text: displayText,
    preset: selectedRecipe.defaultPreset,
    accent,
    bg: ANIM_BGS[0],
    aspect,
    fps: Number(fps),
    durationSec: Number(duration),
  }), [engine, recipe, renderAssetUrls.length, displayText, selectedRecipe.defaultPreset, accent, aspect, fps, duration])

  const enhancementReferences = useMemo<EnhanceReference[]>(() => {
    const references: EnhanceReference[] = []
    sources.forEach((source) => {
      if (source.kind === 'image' && source.url) references.push({ role: 'animation image reference', label: source.name, imageUrl: source.url })
      else if (source.kind === 'video' && source.url) references.push({ role: 'animation video reference', label: source.name, videoUrl: source.url, durationSeconds: source.durationSeconds })
      else if (source.kind === 'audio') references.push({
        role: 'animation audio reference',
        label: source.name,
        durationSeconds: source.durationSeconds,
        note: soundMode === 'with-sound'
          ? 'Use this audio as the synchronized output track and design the motion around its rhythm.'
          : 'Use this audio reference only to guide rhythm and pacing; the final output remains silent.',
      })
      else if (source.kind === 'document') references.push({
        role: 'animation document reference',
        label: source.name,
        note: 'Extracted document content is supplied in the read-only animation context.',
      })
      else if (source.kind === 'url') references.push({
        role: 'animation website reference',
        label: source.name,
        note: 'Safely extracted website content is supplied in the read-only animation context.',
      })
    })
    return references.slice(0, 16)
  }, [soundMode, sources])
  const compiledPromptContext = useMemo(
    () => buildAnimationPromptContext(recipe, soundMode, contextText),
    [contextText, recipe, soundMode],
  )
  const supportingContext = useMemo<EnhanceSupportingContext>(() => ({
    label: 'Animation brief context',
    text: compiledPromptContext,
    instruction: 'When written direction exists, treat it as the primary creative command. In reference-led Auto, draft only the minimum animation direction authorized by the selected format, sound decision and attached evidence. Do not invent claims, copy, data, assets, motion, transitions or sound content that the prompt and evidence do not supply.',
  }), [compiledPromptContext])
  const contextKey = useMemo(() => `${recipe}|${soundMode}|${sources.map((source) => `${source.id}:${source.text?.length ?? 0}`).join('|')}`, [recipe, soundMode, sources])

  const updatePrompt = (value: string) => setPrompts((current) => ({ ...current, [recipe]: value }))

  const selectRecipe = (nextRecipe: AnimRecipeId) => {
    if (nextRecipe === recipe) return
    setRecipe(nextRecipe)
    setExportError(null)
  }

  const selectRecipeLabel = (label: string) => {
    const next = ANIMATION_RECIPES.find((item) => item.label === label)
    if (next) selectRecipe(next.id)
  }

  const sourceFromFile = async (file: File): Promise<AnimationSource> => {
    if (isAnimationDocumentFile(file)) {
      const result = await extractAnimationDocument(file)
      return { id: sourceId(), kind: 'document', name: file.name, text: result.text, meta: result.meta }
    }
    if (file.type.startsWith('image/')) {
      if (file.size > 32 * 1024 * 1024) throw new Error(`${file.name} is larger than the 32 MB image limit.`)
      return { id: sourceId(), kind: 'image', name: file.name, url: await readAsDataUrl(file), meta: mediaMeta('image') }
    }
    if (file.type.startsWith('video/')) {
      if (file.size > 512 * 1024 * 1024) throw new Error(`${file.name} is larger than the 512 MB video limit.`)
      const url = URL.createObjectURL(file)
      const durationSeconds = await probeMediaDuration(url, 'video')
      const posterUrl = await createVideoPoster(url)
      return { id: sourceId(), kind: 'video', name: file.name, url, posterUrl, durationSeconds, meta: mediaMeta('video', durationSeconds), ownedUrl: true }
    }
    if (file.type.startsWith('audio/')) {
      if (file.size > 256 * 1024 * 1024) throw new Error(`${file.name} is larger than the 256 MB audio limit.`)
      const url = URL.createObjectURL(file)
      const durationSeconds = await probeMediaDuration(url, 'audio')
      return { id: sourceId(), kind: 'audio', name: file.name, url, durationSeconds, meta: mediaMeta('audio', durationSeconds), ownedUrl: true }
    }
    throw new Error(`${file.name} is not a supported image, video, audio, text, Word or Excel file.`)
  }

  const addFiles = async (files: File[]) => {
    const room = MAX_SOURCES - sourcesRef.current.length
    if (room < 1) {
      toast(`Animations supports up to ${MAX_SOURCES} attached sources.`)
      return
    }
    setIngesting(true)
    const added: AnimationSource[] = []
    const errors: string[] = []
    try {
      for (const file of files.slice(0, room)) {
        try {
          added.push(await sourceFromFile(file))
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      if (added.length) {
        setSources((current) => [...current, ...added].slice(0, MAX_SOURCES))
        toast(`${added.length} ${added.length === 1 ? 'source' : 'sources'} added to the animation context`)
      }
      if (errors.length) toast(errors[0]!)
      if (files.length > room) toast(`Only ${room} more sources could be added.`)
    } finally {
      setIngesting(false)
    }
  }

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length) void addFiles(files)
  }

  const addLibrarySources = async (selected: Creation[]) => {
    const files = await Promise.all(selected.map((creation) => copyLibraryCreationForWorkspace(creation)))
    await addFiles(files)
  }

  const addGrab = async (kind: 'frame' | 'video' | 'audio') => {
    const grabbed = kind === 'frame' ? await resolve.grabFrame() : kind === 'video' ? await resolve.grabClip() : await resolve.grabAudio()
    if (!grabbed.ok || !grabbed.blobUrl) {
      toast(grabbed.error || `No ${kind} is available at the playhead.`)
      return
    }
    try {
      const response = await fetch(grabbed.blobUrl)
      if (!response.ok) throw new Error(`The grabbed ${kind} could not be read.`)
      const blob = await response.blob()
      const fallbackType = kind === 'frame' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav'
      const extension = kind === 'frame' ? 'png' : kind === 'video' ? 'mp4' : 'wav'
      await addFiles([new File([blob], `${grabbed.name || `Timeline ${kind}`}.${extension}`, { type: blob.type || fallbackType })])
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error))
    } finally {
      if (grabbed.blobUrl.startsWith('blob:')) URL.revokeObjectURL(grabbed.blobUrl)
    }
  }

  const addWebsite = async () => {
    if (urlBusy || !urlInput.trim()) return
    if (sources.filter((source) => source.kind === 'url').length >= MAX_URL_SOURCES) {
      setUrlError(`Add up to ${MAX_URL_SOURCES} website references.`)
      return
    }
    const controller = new AbortController()
    urlAbortRef.current?.abort()
    urlAbortRef.current = controller
    setUrlBusy(true)
    setUrlError('')
    try {
      const result = await fetchAnimationUrlContext(urlInput.trim(), { signal: controller.signal })
      if (controller.signal.aborted) return
      const websiteSource: AnimationSource = {
        id: sourceId(),
        kind: 'url',
        name: result.title || new URL(result.finalUrl).hostname,
        url: result.finalUrl,
        text: result.text,
        meta: `Website context${result.truncated ? ' · safely shortened' : ''}`,
      }
      setSources((current) => [...current, websiteSource].slice(0, MAX_SOURCES))
      setUrlInput('')
      toast('Website context added')
    } catch (error) {
      if (!controller.signal.aborted) setUrlError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted) {
        setUrlBusy(false)
        urlAbortRef.current = null
      }
    }
  }

  const removeSource = (id: string) => {
    setSources((current) => {
      const source = current.find((item) => item.id === id)
      if (source?.ownedUrl && source.url?.startsWith('blob:')) URL.revokeObjectURL(source.url)
      return current.filter((item) => item.id !== id)
    })
  }

  const doExport = async () => {
    if (!prompt.trim()) {
      setExportError('Describe the animation before rendering.')
      return
    }
    if (!soundReady) {
      setExportError('Add an audio file, choose one from Library or Grab audio before rendering with sound.')
      return
    }
    const controller = generation.begin()
    setExporting(true)
    setExportError(null)
    try {
      let audioDataUrl: string | undefined
      if (outputAudioSource?.url) {
        const audioResponse = await fetch(outputAudioSource.url)
        if (!audioResponse.ok) throw new Error('The selected animation audio could not be read.')
        const audioBlob = await audioResponse.blob()
        if (!audioBlob.size) throw new Error('The selected animation audio is empty.')
        if (audioBlob.size > MAX_RENDER_AUDIO_BYTES) throw new Error('Animation output audio must be 24 MB or smaller.')
        if (audioBlob.type && !audioBlob.type.toLowerCase().startsWith('audio/')) throw new Error('Choose a valid audio file for the animation output.')
        audioDataUrl = await readAsDataUrl(audioBlob)
      }
      const url = await renderAnimation(settings, renderAssetUrls, { audioDataUrl, onJobCreated: generation.attachJob })
      setExportUrl(url)
      addCreation({
        kind: 'video',
        url,
        model: engine,
        prompt,
        meta: `${selectedRecipe.label} · ${aspect} · ${duration}s · ${fps}fps · ${soundMode === 'with-sound' ? 'sound' : 'silent'}`,
      })
      toast(`${selectedRecipe.label} render complete`)
    } catch (error) {
      if (controller.signal.aborted || isGenerationExit(error)) return
      setExportError(error instanceof Error ? error.message : String(error))
    } finally {
      generation.finish(controller)
      setExporting(false)
    }
  }

  const exitRender = () => {
    const outcome = generation.exit()
    if (!outcome) return
    setExporting(false)
    toast('Animation render cancelled')
  }

  return (
    <div className="ef-screen ef-legacy-workspace ef-animation-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title">Animations</span>
        <span className="ef-spacer" />
        <Dropdown options={[...ANIM_ENGINES]} selected={engine} onSelect={(value) => setEngine(value as AnimEngine)} label="Animation model" optionMeta={ANIMATION_ENGINE_META} searchable={false} />
      </div>

      <div className="ef-scroll ef-create-scroll">
        <section className="ef-animation-purpose-picker" aria-labelledby="animation-purpose-title">
          <header className="ef-animation-purpose-head">
            <span className="ef-animation-step" aria-hidden="true">01</span>
            <div>
              <small>START HERE · ANIMATION TYPE</small>
              <h2 id="animation-purpose-title">What do you want to create?</h2>
              <p>Your choice becomes part of the prompt context together with every attached source.</p>
            </div>
          </header>

          <div className="ef-animation-purpose-layout">
            <div className="ef-animation-purpose-choice">
              <span className="ef-animation-purpose-icon" aria-hidden="true"><Icon glyph={RECIPE_ICONS[recipe]} size={18} /></span>
              <div className="ef-animation-purpose-select">
                <span className="ef-field-label">ANIMATION TYPE</span>
                <Dropdown
                  options={[...RECIPE_LABELS]}
                  selected={selectedRecipe.label}
                  onSelect={selectRecipeLabel}
                  label="Animation type"
                  align="left"
                  variant="field"
                  optionMeta={RECIPE_OPTION_META}
                  searchable={false}
                />
              </div>
              <div className="ef-animation-purpose-copy">
                <strong>{selectedRecipe.label}</strong>
                <span>{selectedRecipe.description}</span>
                <small>Useful context · {selectedRecipe.inputHint}</small>
              </div>
            </div>

            <fieldset className="ef-animation-sound-choice">
              <legend>SOUND</legend>
              <div className="ef-animation-sound-options" role="radiogroup" aria-label="Animation sound output">
                {ANIMATION_SOUND_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={soundMode === option.id}
                    className={`ef-animation-sound-option${soundMode === option.id ? ' is-selected' : ''}`}
                    onClick={() => { setSoundMode(option.id); setExportError(null) }}
                  >
                    {option.id === 'with-sound'
                      ? <Icon glyph="music" size={13} />
                      : <span className="ef-animation-silent-icon" aria-hidden="true">∅</span>}
                    <span className="ef-animation-sound-copy"><strong>{option.label}</strong><small>{option.id === 'with-sound' ? 'Use attached track' : 'Silent output'}</small></span>
                  </button>
                ))}
              </div>
              <p className={soundMode === 'with-sound' && !outputAudioSource ? 'is-warning' : ''}>
                {soundMode === 'with-sound'
                  ? outputAudioSource
                    ? `${outputAudioSource.name} will be synchronized as the output track.`
                    : 'Attach audio below. The first attached audio file becomes the output track.'
                  : 'The result stays silent. Attached audio can still guide rhythm and prompt enhancement.'}
              </p>
            </fieldset>
          </div>
        </section>

        <div className="ef-animation-compose-grid">
          <section className="ef-animation-command-column" aria-labelledby="animation-command-title">
            <header className="ef-animation-compose-head">
              <span className="ef-animation-step" aria-hidden="true">02</span>
              <div><small>PRIMARY CONTROL</small><h2 id="animation-command-title">Direct everything from the prompt.</h2><p>Describe the hierarchy, content, timing, transitions, layout and visual style.</p></div>
            </header>

            <div className="ef-field ef-animation-prompt-field">
              <div className="ef-ref-header">
                <span className="ef-field-label">{selectedRecipe.label.toUpperCase()} PROMPT</span>
                <span className="ef-spacer" />
                <span className="ef-ref-count">Prompt or attached sources</span>
              </div>
              <PromptCard
                prompt={prompt}
                onPromptChange={updatePrompt}
                maxLength={PROMPT_MAX}
                enhancerKey={`animation-enhancer-${recipe}`}
                targetModel={`${engine} · ${selectedRecipe.label}`}
                mediaKind="video"
                purpose="animation"
                ariaLabel={`${selectedRecipe.label} animation prompt`}
                placeholder={selectedRecipe.placeholder}
                references={enhancementReferences}
                supportingContext={supportingContext}
                contextKey={contextKey}
                onSpend={onSpend}
              />
            </div>

            <div className="ef-animation-context-note"><Icon glyph="spark" size={13} /><span>{selectedRecipe.label}, {soundMode === 'with-sound' ? 'sound output' : 'silent output'} and {sources.length || 'no'} attached {sources.length === 1 ? 'source' : 'sources'} are included in enhancement context. With no written prompt, Enhance creates a reference-led Auto draft.</span></div>

            <button type="button" id="animation-advanced-toggle" className="ef-advanced-toggle" aria-expanded={advancedOpen} aria-controls="animation-advanced-options" onClick={() => setAdvancedOpen((open) => !open)}>
              <span className="ef-advanced-toggle-label">Technical output</span>
              <span className="ef-advanced-summary">{aspect} · {duration}s · {fps} FPS</span>
              <span className="ef-advanced-chevron" aria-hidden="true">⌄</span>
            </button>
            <div id="animation-advanced-options" className="ef-advanced-region ef-animation-output-options" role="region" aria-labelledby="animation-advanced-toggle" hidden={!advancedOpen}>
              <div className="ef-field">
                <span className="ef-field-label">ASPECT</span>
                <Dropdown options={ANIM_ASPECTS} selected={aspect} onSelect={setAspect} label="Aspect ratio" align="left" variant="field" />
              </div>
              <ChipField label="FPS" options={ANIM_FPS} selected={fps} onSelect={setFps} />
              <DurationSlider options={ANIM_DURATIONS} value={duration} onChange={setDuration} ariaLabel="Animation duration" />
            </div>
          </section>

          <section className="ef-animation-source-hub ef-animation-source-column" aria-labelledby="animation-source-title">
            <div className="ef-animation-source-head">
              <div>
                <small>03 · OPTIONAL CONTEXT</small>
                <h2 id="animation-source-title">Add source material</h2>
                <p>Images, video, audio, documents and public URLs</p>
              </div>
              <span>{sources.length} / {MAX_SOURCES}</span>
            </div>

            <div className="ef-animation-source-actions" aria-label="Add animation source">
              <button type="button" disabled={ingesting || sources.length >= MAX_SOURCES} onClick={() => fileRef.current?.click()}><Icon glyph="up" size={12} /> {ingesting ? 'Reading…' : 'Upload files'}</button>
              <LibraryPickerButton
                kinds={['image', 'video', 'audio']}
                max={Math.max(0, MAX_SOURCES - sources.length)}
                onSelect={addLibrarySources}
                disabled={ingesting}
                className="ef-library-source-btn"
                label="Library"
                ariaLabel="Choose animation sources from Library"
                pickerTitle="Choose animation source material"
                confirmLabel="Add sources"
              />
              <button type="button" disabled={ingesting || sources.length >= MAX_SOURCES} onClick={() => void addGrab('frame')}><Icon glyph="playhead" size={12} /> Grab frame</button>
              <button type="button" disabled={ingesting || sources.length >= MAX_SOURCES} onClick={() => void addGrab('video')}><Icon glyph="vid" size={12} /> Grab video</button>
              <button type="button" disabled={ingesting || sources.length >= MAX_SOURCES} onClick={() => void addGrab('audio')}><Icon glyph="music" size={12} /> Grab audio</button>
            </div>
            <input ref={fileRef} type="file" accept={INPUT_ACCEPT} multiple onChange={handleFiles} style={{ display: 'none' }} />

            <form className="ef-animation-url-form" onSubmit={(event) => { event.preventDefault(); void addWebsite() }}>
              <label htmlFor="animation-url">Public website URL · HTTPS only</label>
              <input id="animation-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://example.com/page" value={urlInput} onChange={(event) => { setUrlInput(event.target.value); setUrlError('') }} disabled={urlBusy || sources.length >= MAX_SOURCES} />
              <button type="submit" disabled={urlBusy || !urlInput.trim() || sources.length >= MAX_SOURCES}>{urlBusy ? 'Reading…' : 'Add URL'}</button>
              {urlError && <p role="alert">{urlError}</p>}
            </form>

            {sources.length ? (
              <div className="ef-animation-source-list" aria-label="Attached animation sources">
                {sources.map((source) => (
                  <article key={source.id} className={`ef-animation-source-card${source.id === outputAudioSource?.id ? ' is-output-audio' : ''}`}>
                    {source.kind === 'image' && source.url ? (
                      <button type="button" className="ef-animation-source-preview" onClick={() => setPreview({ url: source.url!, kind: 'image' })} aria-label={`Preview ${source.name}`}><img src={source.url} alt="" /></button>
                    ) : source.kind === 'video' && source.url ? (
                      <button type="button" className="ef-animation-source-preview" onClick={() => setPreview({ url: source.url!, kind: 'video' })} aria-label={`Preview ${source.name}`}><video src={source.url} muted playsInline preload="metadata" /></button>
                    ) : source.kind === 'audio' && source.url ? (
                      <div className="ef-animation-source-preview"><Icon glyph="music" size={19} /></div>
                    ) : (
                      <div className="ef-animation-source-preview"><Icon glyph={SOURCE_ICONS[source.kind as 'document' | 'url']} size={19} /></div>
                    )}
                    <div className="ef-animation-source-copy">
                      <strong title={source.name}>{source.name}</strong>
                      <span>{source.meta}{source.id === outputAudioSource?.id ? ' · Output track' : ''}</span>
                      {source.kind === 'audio' && source.url && <audio src={source.url} controls preload="metadata" aria-label={`Preview ${source.name}`} />}
                    </div>
                    <button type="button" className="ef-animation-source-remove" onClick={() => removeSource(source.id)} aria-label={`Remove ${source.name}`}>×</button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="ef-animation-empty-sources"><Icon glyph={RECIPE_ICONS[recipe]} size={18} /><span>{selectedRecipe.inputHint} · optional context for the prompt and composition.</span></div>
            )}
          </section>
        </div>

        {exportUrl && (
          <section className="ef-animation-result-shell" aria-labelledby="animation-result-title">
            <header><span><small>RENDER COMPLETE</small><strong id="animation-result-title">{selectedRecipe.label}</strong></span><em>{soundMode === 'with-sound' ? 'Sound' : 'Silent'}</em></header>
            <video className="ef-anim-result" src={exportUrl} controls loop style={{ aspectRatio: aspect.replace(':', ' / ') }} />
            <div className="ef-result-actions">
              <a className="ef-ghost-btn" href={exportUrl} download="easyfield-animation.mp4" style={{ textAlign: 'center', textDecoration: 'none', lineHeight: '2.4' }}>↓ Download</a>
              <button className="ef-send-btn" onClick={() => sendToTimeline([{ url: exportUrl, name: `${selectedRecipe.label} animation` }], 'video', toast)}>Send to timeline</button>
            </div>
          </section>
        )}
      </div>

      <footer className="ef-create-footer" aria-label="Animation render summary">
        <div className="ef-price"><span className="ef-price-label">LOCAL RENDER</span><span className="ef-spacer" /><span className="ef-price-value">{selectedRecipe.label} · {duration}s</span></div>
        <div className={`ef-create-footer-message ${exportError ? 'is-error' : 'is-ready'}`} role={exportError ? 'alert' : 'status'} aria-live="polite">
          {exportError ? `✕ ${exportError}` : exporting ? `Rendering with ${engine}…` : exportUrl ? 'Saved to Library · ready to render another' : !soundReady ? 'Attach an audio track for sound output' : 'Local render · no credits'}
        </div>
        {exporting ? (
          <GenerationCancelControl job={generation.job} onExit={exitRender} noun="render" local />
        ) : (
          <button type="button" className="ef-generate ef-create-footer-action" onClick={() => void doExport()} disabled={!prompt.trim() || !soundReady}>
            <Icon glyph="spark" color="#0E0E13" size={13} /> Render · {engine}
          </button>
        )}
      </footer>
      {preview && <Lightbox url={preview.url} kind={preview.kind} onClose={() => setPreview(null)} />}
    </div>
  )
}
