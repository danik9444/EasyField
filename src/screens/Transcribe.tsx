import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Dropdown, type DropdownOptionMeta } from '../components/Dropdown'
import { Icon } from '../icons'
import { LibraryPickerButton } from '../components/LibraryPicker'
import { ProviderLogo } from '../components/ProviderLogo'
import { copyLibraryCreationForWorkspace } from '../services/librarySelection'
import { resolve, type Grab } from '../services/resolve'
import { host } from '../services/host'
import { prepareJobLedger, startJob } from '../services/jobCenter'
import { saveUrl } from '../services/run'
import {
  addCreation,
  attachCreationCompanion,
  getCreations,
  type Creation,
} from '../data/creations'
import {
  WHISPER_MODELS,
  WHISPER_LANGUAGES,
  createTranscriptCompanion,
  createTranscriptDocument,
  isRtlWhisperLanguage,
  isWhisperLanguageCode,
  transcriptFileName,
  transcriptToSrt,
  transcriptToText,
  transcriptToVtt,
  updateTranscriptSegment,
  whisperLanguageAliases,
  type EasyFieldTranscriptDocument,
  type TranscriptLanguageChoice,
  type TranscriptSourceAnchor,
  type TranscriptTask,
  type WhisperLanguageCode,
  type WhisperModelId,
} from '../data/transcript'
import {
  LocalTranscriptionError,
  downloadWhisperModel,
  getWhisperRuntimeStatus,
  installWhisperRuntime,
  transcribeLocally,
  type WhisperRuntimeStatus,
} from '../services/transcription'

interface TranscribeProps {
  onBack: () => void
  toast: (message: string) => void
  onToggleWindowMode: () => void
  windowMode: 'compact' | 'expanded'
  onOpenCaptions: (transcriptId: string, sourceCreationId: string) => void
}

interface TranscribeSettings {
  model: WhisperModelId
  language: TranscriptLanguageChoice
  task: TranscriptTask
  wordTimestamps: boolean
  initialPrompt: string
  conditionOnPreviousText: boolean
  temperature: number
  beamSize: number
}

interface TranscribeSource {
  name: string
  kind: 'audio' | 'video'
  file: File
  url: string
  libraryCreationId?: string
  fromTimeline?: boolean
  anchor?: TranscriptSourceAnchor
}

type Phase = 'idle' | 'installing' | 'downloading' | 'transcribing' | 'complete' | 'error'

const DEFAULT_SETTINGS: TranscribeSettings = {
  model: 'turbo',
  language: 'auto',
  task: 'transcribe',
  wordTimestamps: true,
  initialPrompt: '',
  conditionOnPreviousText: true,
  temperature: 0,
  beamSize: 5,
}

const MEDIA_ACCEPT = '.wav,.mp3,.m4a,.aac,.flac,.ogg,.aiff,.aif,.mp4,.mov,.m4v,.webm,audio/*,video/*'
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024
const DEFAULT_LANGUAGE_FAVORITES: readonly WhisperLanguageCode[] = ['he', 'en']
const LANGUAGE_MENU_MARGIN = 8
const LANGUAGE_MENU_GAP = 6

interface LanguagePickerPosition {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
  opensAbove: boolean
}

interface LanguagePickerProps {
  selected: TranscriptLanguageChoice
  favorites: readonly WhisperLanguageCode[]
  supportsCantonese: boolean
  onSelect: (language: WhisperLanguageCode) => void
  onToggleFavorite: (language: WhisperLanguageCode) => void
}

const nativeLanguageNames = new Map<WhisperLanguageCode, string>()

function languageNativeName(language: typeof WHISPER_LANGUAGES[number]): string {
  const cached = nativeLanguageNames.get(language.code)
  if (cached) return cached
  try {
    const name = new Intl.DisplayNames([language.code], { type: 'language' }).of(language.code)
    if (name && name.toLocaleLowerCase() !== language.name.toLocaleLowerCase()) {
      nativeLanguageNames.set(language.code, name)
      return name
    }
  } catch { /* Fall back to the canonical English label. */ }
  nativeLanguageNames.set(language.code, language.name)
  return language.name
}

function LanguagePicker({ selected, favorites, supportsCantonese, onSelect, onToggleFavorite }: LanguagePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeCode, setActiveCode] = useState<WhisperLanguageCode>('he')
  const [position, setPosition] = useState<LanguagePickerPosition>({ left: LANGUAGE_MENU_MARGIN, width: 360, maxHeight: 500, top: 48, opensAbove: false })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Partial<Record<WhisperLanguageCode, HTMLButtonElement | null>>>({})
  const menuId = useId()
  const listboxId = `${menuId}-listbox`
  const favoriteSet = useMemo(() => new Set(favorites), [favorites])
  const selectedLanguage = selected === 'auto' ? null : WHISPER_LANGUAGES.find((language) => language.code === selected)

  const filteredLanguages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return [...WHISPER_LANGUAGES]
    return WHISPER_LANGUAGES.filter((language) => [
      language.name,
      languageNativeName(language),
      language.code,
      ...whisperLanguageAliases(language),
    ].join(' ').toLocaleLowerCase().includes(normalized))
  }, [query])

  const favoriteLanguages = filteredLanguages.filter((language) => favoriteSet.has(language.code))
  const otherLanguages = filteredLanguages.filter((language) => !favoriteSet.has(language.code))
  const visibleLanguages = [...favoriteLanguages, ...otherLanguages]

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const maximumWidth = Math.max(250, viewportWidth - LANGUAGE_MENU_MARGIN * 2)
    const width = Math.min(Math.max(rect.width, 460), maximumWidth)
    const left = Math.min(Math.max(LANGUAGE_MENU_MARGIN, rect.left), viewportWidth - width - LANGUAGE_MENU_MARGIN)
    const spaceBelow = viewportHeight - rect.bottom - LANGUAGE_MENU_GAP - LANGUAGE_MENU_MARGIN
    const spaceAbove = rect.top - LANGUAGE_MENU_GAP - LANGUAGE_MENU_MARGIN
    const opensAbove = spaceBelow < 280 && spaceAbove > spaceBelow
    const availableHeight = Math.max(190, opensAbove ? spaceAbove : spaceBelow)
    setPosition({
      left,
      width,
      maxHeight: Math.min(560, availableHeight),
      ...(opensAbove
        ? { bottom: viewportHeight - rect.top + LANGUAGE_MENU_GAP }
        : { top: rect.bottom + LANGUAGE_MENU_GAP }),
      opensAbove,
    })
  }, [])

  const close = useCallback((returnFocus = true) => {
    setOpen(false)
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  const openPicker = () => {
    updatePosition()
    setQuery('')
    setActiveCode(selectedLanguage?.code ?? favoriteLanguages[0]?.code ?? 'en')
    setOpen(true)
  }

  const focusVisible = (index: number) => {
    if (!visibleLanguages.length) return
    const next = (index + visibleLanguages.length) % visibleLanguages.length
    const code = visibleLanguages[next].code
    setActiveCode(code)
    optionRefs.current[code]?.focus()
  }

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, code: WhisperLanguageCode) => {
    const index = visibleLanguages.findIndex((language) => language.code === code)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusVisible(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusVisible(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusVisible(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusVisible(visibleLanguages.length - 1)
    } else if (event.key.toLocaleLowerCase() === 'f' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      onToggleFavorite(code)
    }
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [close, open, updatePosition])

  useEffect(() => {
    if (!open || visibleLanguages.some((language) => language.code === activeCode)) return
    setActiveCode(visibleLanguages[0]?.code ?? 'en')
  }, [activeCode, open, visibleLanguages])

  const selectLanguage = (language: typeof WHISPER_LANGUAGES[number]) => {
    if (language.code === 'yue' && !supportsCantonese) return
    onSelect(language.code)
    close()
  }

  const renderSection = (label: string, languages: typeof filteredLanguages) => languages.length > 0 && (
    <section className="ef-language-picker-section" aria-label={label}>
      <h3>{label}<small>{languages.length}</small></h3>
      {languages.map((language) => {
        const isSelected = selected === language.code
        const isFavorite = favoriteSet.has(language.code)
        const isDisabled = language.code === 'yue' && !supportsCantonese
        const nativeName = languageNativeName(language)
        return <div className={`ef-language-option-row${isSelected ? ' is-selected' : ''}${isDisabled ? ' is-disabled' : ''}`} role="presentation" key={language.code}>
          <button
            ref={(node) => { optionRefs.current[language.code] = node }}
            id={`${menuId}-${language.code}`}
            type="button"
            role="option"
            tabIndex={activeCode === language.code ? 0 : -1}
            aria-selected={isSelected}
            aria-disabled={isDisabled}
            className="ef-language-option-main"
            onFocus={() => setActiveCode(language.code)}
            onKeyDown={(event) => onOptionKeyDown(event, language.code)}
            onClick={() => selectLanguage(language)}
          >
            <span className="ef-language-option-code" aria-hidden="true">{language.code.toLocaleUpperCase()}</span>
            <span className="ef-language-option-copy"><strong>{language.name}</strong><small>{isDisabled ? 'Large v3 or Turbo required' : nativeName === language.name ? 'OpenAI Whisper language' : nativeName}</small></span>
            {isSelected && <span className="ef-language-option-check" aria-hidden="true">✓</span>}
          </button>
          <button
            type="button"
            className={`ef-language-favorite${isFavorite ? ' is-favorite' : ''}`}
            aria-label={`${isFavorite ? 'Remove' : 'Add'} ${language.name} ${isFavorite ? 'from' : 'to'} favorites`}
            aria-pressed={isFavorite}
            title={`${isFavorite ? 'Remove from' : 'Add to'} favorites · keyboard shortcut F`}
            onClick={() => onToggleFavorite(language.code)}
          >{isFavorite ? '★' : '☆'}</button>
        </div>
      })}
    </section>
  )

  return <div className="ef-language-picker">
    <button
      ref={triggerRef}
      type="button"
      className={`ef-language-picker-trigger${selectedLanguage ? ' has-selection' : ''}`}
      aria-label={`Spoken language: ${selectedLanguage?.name ?? 'choose a language'}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      onClick={() => open ? close() : openPicker()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          openPicker()
        }
      }}
    >
      <span className="ef-language-picker-icon" aria-hidden="true">文</span>
      <span><small>SPECIFIC LANGUAGE</small><strong>{selectedLanguage?.name ?? 'Choose language'}</strong></span>
      {selectedLanguage && <em>{selectedLanguage.code.toLocaleUpperCase()}</em>}
      <i aria-hidden="true">⌄</i>
    </button>

    {open && createPortal(<div
      ref={menuRef}
      id={menuId}
      className={`ef-language-picker-popover${position.opensAbove ? ' opens-above' : ''}`}
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        ...(position.opensAbove ? { bottom: position.bottom } : { top: position.top }),
      }}
      role="dialog"
      aria-label="Choose spoken language"
    >
      <header><span><strong>Spoken language</strong><small>OpenAI Whisper · 100 supported</small></span><em>{filteredLanguages.length} languages</em></header>
      <label className="ef-language-picker-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search language or code…"
          aria-label="Search supported languages"
          aria-controls={listboxId}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusVisible(0)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              focusVisible(visibleLanguages.length - 1)
            }
          }}
        />
        {query && <button type="button" aria-label="Clear language search" onClick={() => setQuery('')}>×</button>}
      </label>
      <div id={listboxId} className="ef-language-picker-list ef-scroll" role="listbox" aria-label="Supported spoken languages">
        {renderSection('FAVORITES', favoriteLanguages)}
        {renderSection(query ? 'MATCHING LANGUAGES' : 'ALL LANGUAGES', otherLanguages)}
        {!visibleLanguages.length && <div className="ef-language-picker-empty" role="status"><strong>No language found</strong><small>Try a language name, native name or code.</small></div>}
      </div>
      <footer><span><b>★</b> Favorites stay at the top</span><small>↑↓ Navigate · Enter select · F favorite · Esc close</small></footer>
    </div>, document.body)}
  </div>
}

function formatBytes(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`
  return `${Math.round(value / 1_000_000)} MB`
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const remaining = Math.floor(whole % 60)
  const decimal = Math.floor((whole % 1) * 10)
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}.${decimal}`
}

function isSupportedMedia(file: File): 'audio' | 'video' | null {
  if (!file.size || file.size > MAX_SOURCE_BYTES) return null
  if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)) return 'video'
  if (file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|flac|ogg|aiff|aif)$/i.test(file.name)) return 'audio'
  return null
}

function decodeGrabFileName(grab: Grab, kind: 'audio' | 'video'): string {
  const extension = kind === 'audio' ? '.wav' : '.mp4'
  const clean = grab.name.replace(/[\\/\u0000-\u001f\u007f]/g, ' ').replace(/\.(wav|mp3|mp4|mov)(?=\s|·|$)/gi, '').replace(/\s+/g, ' ').trim()
  return `${clean || `Timeline ${kind}`}${extension}`
}

function anchorFromGrab(grab: Grab): TranscriptSourceAnchor {
  return {
    projectId: grab.projectId,
    timelineId: grab.timelineId,
    itemId: grab.itemId,
    itemStartFrame: grab.itemStartFrame,
    itemEndFrame: grab.itemEndFrame,
    timelineFps: grab.timelineFps,
    sourceStartFrame: grab.sourceStartFrame,
    sourceEndFrame: grab.sourceEndFrame,
    durationSeconds: grab.durationSeconds,
    trackType: grab.trackType,
    trackIndex: grab.trackIndex,
  }
}

function downloadText(data: string, fileName: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }))
  saveUrl(url, fileName)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function modelSupportsCantonese(model: WhisperModelId): boolean {
  return model === 'large-v3' || model === 'turbo'
}

function normalizeLanguageFavorites(value: unknown): WhisperLanguageCode[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { codes?: unknown }).codes)
      ? (value as { codes: unknown[] }).codes
      : null
  if (!candidate) return [...DEFAULT_LANGUAGE_FAVORITES]
  return [...new Set(candidate.filter(isWhisperLanguageCode))]
}

function normalizeSettings(value: Partial<TranscribeSettings> | null | undefined): TranscribeSettings {
  const model = WHISPER_MODELS.some((item) => item.id === value?.model) ? value!.model! : DEFAULT_SETTINGS.model
  const savedLanguage = String(value?.language ?? '')
  const language: TranscriptLanguageChoice = (
    savedLanguage === 'auto'
    || (isWhisperLanguageCode(savedLanguage) && (savedLanguage !== 'yue' || modelSupportsCantonese(model)))
  ) ? savedLanguage as TranscriptLanguageChoice : DEFAULT_SETTINGS.language
  const task = value?.task === 'translate' && model !== 'turbo' ? 'translate' : 'transcribe'
  return {
    model,
    language,
    task,
    wordTimestamps: value?.wordTimestamps !== false,
    initialPrompt: String(value?.initialPrompt ?? '').slice(0, 2_000),
    conditionOnPreviousText: value?.conditionOnPreviousText !== false,
    temperature: Math.min(1, Math.max(0, Number(value?.temperature) || 0)),
    beamSize: Math.min(10, Math.max(1, Math.round(Number(value?.beamSize) || 5))),
  }
}

export function Transcribe({ onBack, toast, onToggleWindowMode, windowMode, onOpenCaptions }: TranscribeProps) {
  const [settings, setSettings] = useState<TranscribeSettings>(DEFAULT_SETTINGS)
  const [settingsHydrated, setSettingsHydrated] = useState(false)
  const [favoriteLanguages, setFavoriteLanguages] = useState<WhisperLanguageCode[]>([...DEFAULT_LANGUAGE_FAVORITES])
  const [languageFavoritesHydrated, setLanguageFavoritesHydrated] = useState(false)
  const [runtime, setRuntime] = useState<WhisperRuntimeStatus | null>(null)
  const [source, setSource] = useState<TranscribeSource | null>(null)
  const [transcript, setTranscript] = useState<EasyFieldTranscriptDocument | null>(null)
  const [sourceCreationId, setSourceCreationId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<TranscribeSource | null>(null)
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    sourceRef.current = source
  }, [source])

  useEffect(() => {
    let active = true
    void host.getState<Partial<TranscribeSettings>>('drafts', 'transcribe:settings').then((saved) => {
      if (!active) return
      setSettings(normalizeSettings(saved))
      setSettingsHydrated(true)
    })
    const controller = new AbortController()
    void getWhisperRuntimeStatus(controller.signal).then((status) => { if (active) setRuntime(status) })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    let active = true
    void host.getState<unknown>('settings', 'transcribe:language-favorites').then((saved) => {
      if (!active) return
      setFavoriteLanguages(normalizeLanguageFavorites(saved))
      setLanguageFavoritesHydrated(true)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!settingsHydrated) return
    const timer = window.setTimeout(() => void host.setState('drafts', 'transcribe:settings', settings), 180)
    return () => window.clearTimeout(timer)
  }, [settings, settingsHydrated])

  useEffect(() => {
    if (!languageFavoritesHydrated) return
    const timer = window.setTimeout(() => void host.setState('settings', 'transcribe:language-favorites', favoriteLanguages), 180)
    return () => window.clearTimeout(timer)
  }, [favoriteLanguages, languageFavoritesHydrated])

  useEffect(() => () => {
    abortRef.current?.abort()
    if (sourceRef.current?.url) URL.revokeObjectURL(sourceRef.current.url)
  }, [])

  useEffect(() => {
    if (!transcript || !sourceCreationId) return
    const timer = window.setTimeout(() => {
      void host.setState('transcripts', transcript.id, transcript)
      attachCreationCompanion(sourceCreationId, createTranscriptCompanion(transcript))
    }, 260)
    return () => window.clearTimeout(timer)
  }, [sourceCreationId, transcript])

  const model = WHISPER_MODELS.find((item) => item.id === settings.model) ?? WHISPER_MODELS[1]
  const modelStatus = runtime?.models.find((item) => item.id === settings.model)
  const runtimeReady = runtime?.available === true
  const modelReady = runtimeReady && modelStatus?.downloaded === true
  const busy = phase === 'installing' || phase === 'downloading' || phase === 'transcribing'

  const modelMeta = useMemo<Record<string, DropdownOptionMeta>>(() => Object.fromEntries(WHISPER_MODELS.map((item) => [
    item.name,
    {
      eyebrow: 'OPENAI',
      group: 'WHISPER',
      description: `${item.description} ${formatBytes(item.approximateBytes)} · ${item.memoryLabel}.`,
      badge: item.badge ?? item.speedLabel,
      providerBrand: 'openai',
      searchTerms: [item.id, item.speedLabel, item.translation ? 'translate' : 'transcribe only'],
    },
  ])), [])

  const replaceSource = (next: TranscribeSource | null) => {
    const previous = sourceRef.current
    if (previous?.url && previous.url !== next?.url) URL.revokeObjectURL(previous.url)
    sourceRef.current = next
    setSource(next)
    setTranscript(null)
    setSourceCreationId(null)
    setSearch('')
    setError('')
    setPhase('idle')
  }

  const useFile = (file: File, provenance: Partial<Pick<TranscribeSource, 'libraryCreationId' | 'fromTimeline' | 'anchor'>> = {}) => {
    const kind = isSupportedMedia(file)
    if (!kind) {
      toast(file.size > MAX_SOURCE_BYTES ? 'Media must be 1 GB or smaller' : 'Choose a readable audio or video file')
      return
    }
    replaceSource({ name: file.name, kind, file, url: URL.createObjectURL(file), ...provenance })
  }

  const chooseLibrary = async (creations: Creation[]) => {
    const creation = creations[0]
    if (!creation) return
    const file = await copyLibraryCreationForWorkspace(creation)
    useFile(file, { libraryCreationId: creation.id, fromTimeline: creation.fromTimeline })
  }

  const grabFromTimeline = async (kind: 'audio' | 'video') => {
    if (!resolve.isBridgeConnected()) await resolve.refreshStatus()
    const captured = kind === 'audio' ? await resolve.grabAudio() : await resolve.grabEditVideoSource()
    if (!captured.ok || !captured.blobUrl) {
      toast(captured.error || `Place the playhead over a ${kind} clip`)
      return
    }
    try {
      const response = await fetch(captured.blobUrl)
      if (!response.ok) throw new Error(`Timeline ${kind} could not be read (${response.status}).`)
      const blob = await response.blob()
      useFile(new File([blob], decodeGrabFileName(captured, kind), {
        type: blob.type || (kind === 'audio' ? 'audio/wav' : 'video/mp4'),
        lastModified: Date.now(),
      }), { fromTimeline: true, anchor: anchorFromGrab(captured) })
      toast(`${kind === 'audio' ? 'Audio' : 'Video'} captured exactly as trimmed on the timeline`)
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Timeline capture failed')
    } finally {
      URL.revokeObjectURL(captured.blobUrl)
    }
  }

  const ensureLibrarySource = (current: TranscribeSource): Creation => {
    const existing = current.libraryCreationId
      ? getCreations().find((item) => item.id === current.libraryCreationId && item.kind === current.kind)
      : undefined
    if (existing) return existing
    const libraryUrl = URL.createObjectURL(current.file)
    const creation = addCreation({
      kind: current.kind,
      url: libraryUrl,
      prompt: current.name,
      model: 'OpenAI Whisper source',
      meta: current.fromTimeline ? 'Timeline trim · local transcription source' : 'Local transcription source',
      fromTimeline: current.fromTimeline,
    })
    if (!creation) {
      URL.revokeObjectURL(libraryUrl)
      throw new Error('The transcription source could not be saved to Library.')
    }
    return creation
  }

  const refreshRuntime = async () => {
    const status = await getWhisperRuntimeStatus()
    setRuntime(status)
    return status
  }

  const installRuntime = async () => {
    if (busy || !runtime?.runtimeInstallSupported) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('installing')
    setError('')
    try {
      const status = await installWhisperRuntime(controller.signal)
      setRuntime(status)
      setPhase('idle')
      toast('Local Whisper engine installed')
    } catch (reason) {
      if (controller.signal.aborted) { setPhase('idle'); return }
      const message = reason instanceof Error ? reason.message : 'The local Whisper engine could not be installed.'
      setError(message)
      setPhase('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const downloadModel = async () => {
    if (busy || !runtimeReady) return
    const controller = new AbortController()
    abortRef.current = controller
    await prepareJobLedger()
    const job = startJob({ title: `Download ${model.name}`, subtitle: formatBytes(model.approximateBytes), kind: 'audio', onCancel: () => controller.abort() })
    setPhase('downloading')
    setError('')
    try {
      await job.persisted
      job.update({ status: 'running', detail: 'Downloading and verifying the local model' })
      const status = await downloadWhisperModel(settings.model, controller.signal)
      setRuntime(status)
      setPhase('idle')
      job.succeed(0, 'Verified local model ready')
      toast(`${model.name} is ready offline`)
    } catch (reason) {
      if (controller.signal.aborted) { job.cancel(); setPhase('idle'); return }
      job.fail(reason)
      const message = reason instanceof Error ? reason.message : 'The Whisper model download failed.'
      setError(message)
      setPhase('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const transcribe = async () => {
    if (!source || !runtimeReady || !modelReady || busy) return
    const controller = new AbortController()
    abortRef.current = controller
    await prepareJobLedger()
    const job = startJob({ title: 'Local Transcription', subtitle: `${source.name} · ${model.name}`, kind: 'audio', onCancel: () => controller.abort() })
    setPhase('transcribing')
    setError('')
    try {
      await job.persisted
      job.update({ status: 'running', detail: `Transcribing locally with ${model.name}` })
      const result = await transcribeLocally(source.file, source.name, settings, controller.signal)
      result.engineVersion = result.engineVersion || runtime?.engineVersion || 'available'
      const librarySource = ensureLibrarySource(source)
      const document = createTranscriptDocument({
        result,
        sourceName: source.name,
        sourceKind: source.kind,
        sourceArtifactId: librarySource.id,
        libraryCreationId: librarySource.id,
        sourceAnchor: source.anchor,
        requestedLanguage: settings.language,
        task: settings.task,
        wordTimestamps: settings.wordTimestamps,
      })
      await host.setState('transcripts', document.id, document)
      if (!attachCreationCompanion(librarySource.id, createTranscriptCompanion(document))) throw new Error('The transcript could not be linked to its Library media.')
      setTranscript(document)
      setSourceCreationId(librarySource.id)
      setSource((current) => current ? { ...current, libraryCreationId: librarySource.id } : current)
      setPhase('complete')
      job.succeed(0, `${document.segments.length} timed segments · saved to Library`)
      toast('Transcript saved and linked to its Library media')
    } catch (reason) {
      if (controller.signal.aborted) {
        job.cancel()
        setPhase('idle')
        toast('Transcription cancelled')
        return
      }
      job.fail(reason)
      const message = reason instanceof Error ? reason.message : 'Local transcription failed.'
      if (reason instanceof LocalTranscriptionError && reason.code === 'WHISPER_RUNTIME_MISSING') await refreshRuntime()
      setError(message)
      setPhase('error')
      toast(message)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const cancel = () => abortRef.current?.abort()

  const downloadFormat = (format: 'srt' | 'vtt' | 'txt' | 'json') => {
    if (!transcript) return
    const data = format === 'srt'
      ? transcriptToSrt(transcript)
      : format === 'vtt'
        ? transcriptToVtt(transcript)
        : format === 'txt'
          ? transcriptToText(transcript)
          : JSON.stringify(transcript, null, 2)
    const mime = format === 'json' ? 'application/json' : format === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8'
    downloadText(data, transcriptFileName(transcript, format), mime)
  }

  const visibleSegments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return transcript?.segments.filter((segment) => !query || segment.text.toLocaleLowerCase().includes(query)) ?? []
  }, [search, transcript])

  const actionState = !runtimeReady
    ? runtime?.runtimeInstallSupported ? 'Install local engine' : 'Local runtime required'
    : !modelReady
      ? `Download ${model.name} · ${formatBytes(model.approximateBytes)}`
      : !source
        ? 'Choose audio or video'
        : phase === 'transcribing'
          ? 'Transcribing locally'
          : transcript
            ? 'Ready to transcribe again'
            : 'Ready for local transcription'

  const primaryDisabled = busy || (!runtimeReady && !runtime?.runtimeInstallSupported) || (runtimeReady && modelReady && !source)
  const runPrimary = () => {
    if (!runtimeReady) return void installRuntime()
    if (!modelReady) return void downloadModel()
    return void transcribe()
  }

  return (
    <div className="ef-screen ef-transcribe-screen" style={{ '--ef-tool-accent': '#3ED598' } as CSSProperties}>
      <header className="ef-workspace-header">
        <button type="button" className="ef-back-btn" onClick={onBack} aria-label="Back to tools">←</button>
        <span className="ef-workspace-icon" aria-hidden="true"><Icon glyph="transcribe" color="#3ED598" size={16} /></span>
        <span className="ef-workspace-heading"><small>ANALYZE · AUDIO & VIDEO</small><strong>Transcribe</strong></span>
        <span className="ef-spacer" />
        <span className="ef-draft-state" role="status"><i aria-hidden="true" /> Draft autosaves</span>
        <button type="button" className="ef-density-toggle" onClick={onToggleWindowMode} aria-label={`Switch to ${windowMode === 'compact' ? 'expanded' : 'compact'} view`}>{windowMode === 'compact' ? '↗' : '↙'}</button>
      </header>

      <div className="ef-transcribe-scroll ef-scroll">
        <section className="ef-transcribe-hero">
          <div><span>OPENAI WHISPER · ON-DEVICE</span><h1>Editable words, private by default.</h1><p>Transcribe 100 supported languages locally, keep word timing, then export or continue directly into Captions.</p></div>
          <div className={`ef-transcribe-engine${runtimeReady ? ' is-ready' : ''}`} role="status">
            <ProviderLogo brand="openai" size={20} />
            <span><small>LOCAL ENGINE</small><strong>{runtime == null ? 'Checking…' : runtimeReady ? `Whisper · ${runtime.engineVersion ?? 'ready'}` : 'Runtime required'}</strong></span>
            <em>OFFLINE</em>
          </div>
        </section>

        <section className="ef-transcribe-section ef-transcribe-source" aria-labelledby="transcribe-source-title">
          <header><span>01</span><div><small>SOURCE MEDIA</small><h2 id="transcribe-source-title">Use the exact cut you want transcribed.</h2></div></header>
          <div
            className={`ef-transcribe-source-stage${source ? ' has-source' : ''}${dragActive ? ' is-dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false) }}
            onDrop={(event) => { event.preventDefault(); setDragActive(false); const file = event.dataTransfer.files[0]; if (file) useFile(file) }}
          >
            {source ? <>
              <div className="ef-transcribe-source-info"><span><Icon glyph={source.kind === 'audio' ? 'music' : 'vid'} size={20} /></span><span><strong title={source.name}>{source.name}</strong><small>{source.libraryCreationId ? 'Linked to Library' : source.fromTimeline ? 'Exact visible timeline trim' : `Local ${source.kind}`}</small></span><button type="button" aria-label="Remove source media" onClick={() => replaceSource(null)}>×</button></div>
              {source.kind === 'audio'
                ? <audio ref={(node) => { mediaRef.current = node }} src={source.url} controls preload="metadata" />
                : <video ref={(node) => { mediaRef.current = node }} src={source.url} controls playsInline preload="metadata" />}
            </> : <div className="ef-transcribe-source-empty"><span><Icon glyph="transcribe" size={24} /></span><strong>Drop audio or video here</strong><small>WAV, MP3, M4A, FLAC, MP4 or MOV · up to 1 GB</small></div>}
            <div className="ef-transcribe-source-actions">
              <button type="button" onClick={() => inputRef.current?.click()}><Icon glyph="up" size={12} /> Upload</button>
              <LibraryPickerButton kinds={['audio', 'video']} max={1} onSelect={chooseLibrary} className="ef-library-source-btn" label="Library" ariaLabel="Choose audio or video from Library" pickerTitle="Choose media to transcribe" confirmLabel="Use media" />
              <button type="button" onClick={() => void grabFromTimeline('audio')}><Icon glyph="playhead" size={12} /> Grab audio</button>
              <button type="button" onClick={() => void grabFromTimeline('video')}><Icon glyph="playhead" size={12} /> Grab video</button>
            </div>
            <input ref={inputRef} hidden type="file" accept={MEDIA_ACCEPT} onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) useFile(file); event.target.value = '' }} />
          </div>
        </section>

        <section className="ef-transcribe-section" aria-labelledby="transcribe-model-title">
          <header><span>02</span><div><small>WHISPER MODEL</small><h2 id="transcribe-model-title">Choose speed or accuracy.</h2></div></header>
          <div className="ef-transcribe-model-row">
            <div className="ef-transcribe-model-picker">
              <Dropdown
                options={WHISPER_MODELS.map((item) => item.name)}
                selected={model.name}
                onSelect={(name) => {
                  const next = WHISPER_MODELS.find((item) => item.name === name)
                  if (!next) return
                  if (settings.language === 'yue' && !modelSupportsCantonese(next.id)) toast('Cantonese requires Whisper Large v3 or Turbo. Language reset to Auto detect.')
                  setSettings((current) => normalizeSettings({
                    ...current,
                    model: next.id,
                    ...(next.id === 'turbo' && current.task === 'translate' ? { task: 'transcribe' } : {}),
                  }))
                }}
                label="Whisper model"
                align="left"
                variant="field"
                optionMeta={modelMeta}
                searchable
              />
            </div>
            <div className="ef-transcribe-model-facts"><span><small>DOWNLOAD</small><strong>{formatBytes(model.approximateBytes)}</strong></span><span><small>MEMORY</small><strong>{model.memoryLabel}</strong></span><span><small>PROFILE</small><strong>{model.speedLabel}</strong></span></div>
          </div>
        </section>

        <section className="ef-transcribe-section" aria-labelledby="transcribe-language-title">
          <header><span>03</span><div><small>LANGUAGE & OUTPUT</small><h2 id="transcribe-language-title">Tell Whisper what to preserve.</h2></div></header>
          <div className="ef-transcribe-choice-layout">
            <div><span className="ef-transcribe-group-label">SPOKEN LANGUAGE</span><div className="ef-transcribe-language-control">
              <button type="button" className={`ef-transcribe-auto-language${settings.language === 'auto' ? ' is-selected' : ''}`} aria-pressed={settings.language === 'auto'} onClick={() => setSettings((current) => ({ ...current, language: 'auto' }))}><span aria-hidden="true">◎</span><span><small>RECOMMENDED</small><strong>Auto detect</strong></span>{settings.language === 'auto' && <i aria-hidden="true">✓</i>}</button>
              <LanguagePicker
                selected={settings.language}
                favorites={favoriteLanguages}
                supportsCantonese={modelSupportsCantonese(settings.model)}
                onSelect={(language) => setSettings((current) => ({ ...current, language }))}
                onToggleFavorite={(language) => setFavoriteLanguages((current) => current.includes(language) ? current.filter((code) => code !== language) : [...current, language])}
              />
            </div></div>
            <div><span className="ef-transcribe-group-label">TASK</span><div className="ef-transcribe-task-grid">
              <button type="button" className={settings.task === 'transcribe' ? 'is-selected' : ''} aria-pressed={settings.task === 'transcribe'} onClick={() => setSettings((current) => ({ ...current, task: 'transcribe' }))}><strong>Transcribe</strong><small>Keep the spoken language</small></button>
              <button type="button" disabled={!model.translation} className={settings.task === 'translate' ? 'is-selected' : ''} aria-pressed={settings.task === 'translate'} onClick={() => setSettings((current) => ({ ...current, task: 'translate' }))}><strong>Translate to English</strong><small>{model.translation ? 'Speech becomes English text' : 'Turbo is transcription-only'}</small></button>
            </div></div>
          </div>
          <label className="ef-transcribe-toggle"><span><strong>Word timestamps</strong><small>Keep timing for every recognized word and future styled captions.</small></span><input type="checkbox" checked={settings.wordTimestamps} onChange={(event) => setSettings((current) => ({ ...current, wordTimestamps: event.target.checked }))} /><i aria-hidden="true" /></label>
        </section>

        <section className={`ef-transcribe-section ef-transcribe-advanced${advancedOpen ? ' is-open' : ''}`}>
          <button type="button" className="ef-transcribe-advanced-trigger" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}><span><small>04 · ADVANCED</small><strong>Vocabulary & decoding</strong></span><em>{advancedOpen ? '−' : '+'}</em></button>
          {advancedOpen && <div className="ef-transcribe-advanced-body">
            <label className="ef-transcribe-vocabulary"><span><strong>Names and vocabulary</strong><small>Optional context for names, brands, technical terms or spelling. This stays on-device.</small></span><textarea value={settings.initialPrompt} maxLength={2000} placeholder="For example: DaVinci Resolve, EasyField, Nadav…" onChange={(event) => setSettings((current) => ({ ...current, initialPrompt: event.target.value }))} /><output>{settings.initialPrompt.length} / 2000</output></label>
            <div className="ef-transcribe-advanced-grid">
              <label><span>Beam size <output>{settings.beamSize}</output></span><input type="range" min="1" max="10" step="1" value={settings.beamSize} disabled={settings.temperature > 0} onChange={(event) => setSettings((current) => ({ ...current, beamSize: Number(event.target.value) }))} /><small>{settings.temperature > 0 ? 'Disabled while temperature is above zero' : 'Higher values consider more decoding paths'}</small></label>
              <label><span>Temperature <output>{settings.temperature.toFixed(1)}</output></span><input type="range" min="0" max="1" step="0.1" value={settings.temperature} onChange={(event) => setSettings((current) => ({ ...current, temperature: Number(event.target.value) }))} /><small>Zero is the most deterministic</small></label>
            </div>
            <label className="ef-transcribe-toggle"><span><strong>Use previous text as context</strong><small>Improves continuity across longer recordings; turn off if repetition appears.</small></span><input type="checkbox" checked={settings.conditionOnPreviousText} onChange={(event) => setSettings((current) => ({ ...current, conditionOnPreviousText: event.target.checked }))} /><i aria-hidden="true" /></label>
          </div>}
        </section>

        {!runtimeReady && runtime && <section className="ef-transcribe-runtime-card" role="status"><ProviderLogo brand="openai" size={20} /><div><strong>Local Whisper runtime required</strong><p>{runtime.error || 'Install the verified EasyField runtime pack to transcribe privately on this Mac.'}</p><small>No administrator password is needed for local models or runtime packs.</small></div>{runtime.runtimeInstallSupported && <button type="button" disabled={busy} onClick={() => void installRuntime()}>Install engine</button>}</section>}
        {runtimeReady && !modelReady && <section className="ef-transcribe-runtime-card is-model" role="status"><ProviderLogo brand="openai" size={20} /><div><strong>{model.name} is not downloaded</strong><p>{formatBytes(model.approximateBytes)} approximate download · stored locally · reusable offline.</p><small>Downloads start only when you approve them.</small></div><button type="button" disabled={busy} onClick={() => void downloadModel()}>{phase === 'downloading' ? 'Downloading…' : 'Download model'}</button></section>}
        {error && <p className="ef-inline-warning ef-transcribe-error" role="alert">{error}</p>}

        {transcript && <section className="ef-transcribe-result" aria-labelledby="transcript-result-title">
          <header><div><span>EDITABLE TRANSCRIPT</span><h2 id="transcript-result-title">Review every timed segment.</h2><p>{transcript.segments.length} segments · {transcript.words.length || 'No'} timed words · revision {transcript.revision}</p></div><span className="is-saved"><i /> LINKED IN LIBRARY</span></header>
          <div className="ef-transcribe-result-tools"><label><Icon glyph="mask" size={12} /><input aria-label="Search transcript" placeholder="Search transcript…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span>{visibleSegments.length} / {transcript.segments.length}</span></div>
          <div className="ef-transcript-editor">
            {visibleSegments.map((segment, index) => {
              const words = segment.wordIds.map((wordId) => transcript.words.find((word) => word.id === wordId)).filter(Boolean)
              return <article key={segment.id} className="ef-transcript-segment">
                <button type="button" className="ef-transcript-time" onClick={() => { if (mediaRef.current) { mediaRef.current.currentTime = segment.startSeconds; void mediaRef.current.play() } }} aria-label={`Play from ${formatTime(segment.startSeconds)}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{formatTime(segment.startSeconds)}</strong><small>{formatTime(segment.endSeconds)}</small></button>
                <div><textarea dir={isRtlWhisperLanguage(transcript.language) ? 'rtl' : 'auto'} aria-label={`Transcript segment ${index + 1}`} value={segment.text} onChange={(event) => setTranscript((current) => current ? updateTranscriptSegment(current, segment.id, event.target.value) : current)} />
                  {transcript.wordTimestamps && words.length > 0 && <details className="ef-transcript-words"><summary>{words.length} timed words</summary><div>{words.map((word) => word && <button type="button" key={word.id} onClick={() => { if (mediaRef.current) { mediaRef.current.currentTime = word.startSeconds; void mediaRef.current.play() } }} title={`${formatTime(word.startSeconds)} – ${formatTime(word.endSeconds)}`}>{word.text}</button>)}</div></details>}
                </div>
              </article>
            })}
          </div>
          <div className="ef-transcribe-export-row"><div><span>EXPORT & CONTINUE</span><small>Edits are included in every export and autosaved as a linked transcript.</small></div><div><button type="button" onClick={() => downloadFormat('srt')}>SRT</button><button type="button" onClick={() => downloadFormat('vtt')}>VTT</button><button type="button" onClick={() => downloadFormat('txt')}>TXT</button><button type="button" onClick={() => downloadFormat('json')}>JSON</button><button type="button" className="is-primary" onClick={() => sourceCreationId && onOpenCaptions(transcript.id, sourceCreationId)}>Open in Captions →</button></div></div>
        </section>}
      </div>

      <footer className="ef-workspace-actionbar ef-transcribe-actionbar">
        <div className="ef-run-summary"><span className="ef-privacy-chip is-local"><i />ON-DEVICE</span><span className="ef-workspace-cost">No upload · no credits</span></div>
        <span className={`ef-workspace-preflight${runtimeReady && modelReady && source ? ' is-ready' : ''}`}><i className={runtimeReady && modelReady && source ? 'is-ready' : ''} aria-hidden="true" />{actionState}</span>
        {busy && <button type="button" className="ef-transcribe-cancel" onClick={cancel}>Cancel</button>}
        <button type="button" className="ef-workspace-primary" disabled={primaryDisabled} onClick={runPrimary}>{phase === 'installing' ? 'Installing…' : phase === 'downloading' ? 'Downloading…' : phase === 'transcribing' ? 'Transcribing…' : !runtimeReady ? runtime?.runtimeInstallSupported ? 'Install local engine' : 'Runtime required' : !modelReady ? 'Download model' : transcript ? 'Transcribe again' : 'Transcribe'} <span aria-hidden="true">→</span></button>
      </footer>
    </div>
  )
}
