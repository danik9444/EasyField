import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { TtsVoice } from '../data/elevenLabsConfig'
import { host } from '../services/host'
import { isGenerationExit } from '../services/run'
import { GenerationCancelControl, useGenerationJobControl } from './GenerationCancelControl'

type VoiceFilter = 'all' | 'favorites' | 'narration' | 'conversation' | 'presenter' | 'character'

export interface VoiceAuditionRunOptions {
  signal: AbortSignal
  onJobCreated: (jobId: string) => void
}

interface VoicePickerProps {
  voices: TtsVoice[]
  value: string
  onChange: (voiceId: string) => void
  label?: string
  onAudition?: (voiceId: string, options: VoiceAuditionRunOptions) => Promise<string>
  auditionPriceLabel?: string
}

interface VoicePickerState {
  favorites: string[]
  recent: string[]
}

interface VoiceMenuPosition {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
  opensAbove: boolean
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 6

const FILTERS: Array<{ id: VoiceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'narration', label: 'Narration' },
  { id: 'conversation', label: 'Conversational' },
  { id: 'presenter', label: 'Presenter' },
  { id: 'character', label: 'Character' },
]

function voiceParts(label: string): { name: string; descriptor: string } {
  const [name, ...descriptor] = label.split(' — ')
  return { name, descriptor: descriptor.join(' — ') || 'Preset voice' }
}

function useCase(label: string): Exclude<VoiceFilter, 'all' | 'favorites'> {
  const value = label.toLowerCase()
  if (/(character|villain|cowboy|pirate|viking|sergeant|professor|trickster|femme fatale|medieval)/.test(value)) return 'character'
  if (/(announcer|presenter|radio|host|dj|creator|support agent)/.test(value)) return 'presenter'
  if (/(narrator|books|poetic|meditative|serene|grounded|soothing)/.test(value)) return 'narration'
  return 'conversation'
}

export function VoicePicker({ voices, value, onChange, label = 'Voice', onAudition, auditionPriceLabel }: VoicePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<VoiceFilter>('all')
  const [favorites, setFavorites] = useState<string[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [auditioningId, setAuditioningId] = useState<string | null>(null)
  const [auditionGenerating, setAuditionGenerating] = useState(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [auditionError, setAuditionError] = useState<string | null>(null)
  const [auditionNotice, setAuditionNotice] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<VoiceMenuPosition>({ left: VIEWPORT_MARGIN, width: 420, maxHeight: 520, top: 48, opensAbove: false })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const auditionCacheRef = useRef(new Map<string, string>())
  const auditionGeneration = useGenerationJobControl()
  const selected = voices.find((voice) => voice.id === value) ?? voices[0]
  const selectedParts = voiceParts(selected?.label ?? 'Choose a voice')

  useEffect(() => {
    void host.getState<VoicePickerState>('settings', 'voice-picker').then((saved) => {
      if (!saved) return
      setFavorites(saved.favorites?.filter((id) => voices.some((voice) => voice.id === id)) ?? [])
      setRecent(saved.recent?.filter((id) => voices.some((voice) => voice.id === id)) ?? [])
    })
  }, [voices])

  useEffect(() => () => {
    audioRef.current?.pause()
    audioRef.current = null
  }, [])

  const persist = (nextFavorites: string[], nextRecent: string[]) => {
    void host.setState<VoicePickerState>('settings', 'voice-picker', { favorites: nextFavorites, recent: nextRecent })
  }

  const close = useCallback((returnFocus = true) => {
    setOpen(false)
    setQuery('')
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.min(440, Math.max(280, viewportWidth - VIEWPORT_MARGIN * 2))
    if (viewportWidth < 700) {
      setMenuPosition({
        left: VIEWPORT_MARGIN,
        width,
        top: 72,
        maxHeight: Math.max(300, viewportHeight - 80),
        opensAbove: false,
      })
      return
    }
    const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.left), viewportWidth - width - VIEWPORT_MARGIN)
    const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN
    const opensAbove = spaceBelow < 300 && spaceAbove > spaceBelow
    const availableHeight = Math.max(260, opensAbove ? spaceAbove : spaceBelow)
    const maxHeight = Math.min(520, availableHeight)

    setMenuPosition({
      left,
      width,
      maxHeight,
      ...(opensAbove
        ? { bottom: viewportHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
      opensAbove,
    })
  }, [])

  const openPicker = () => {
    updateMenuPosition()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'Tab') setOpen(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || sheetRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [close, open, updateMenuPosition])

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return voices.filter((voice) => {
      const filterMatch = filter === 'all' || (filter === 'favorites' ? favorites.includes(voice.id) : useCase(voice.label) === filter)
      return filterMatch && (!normalized || voice.label.toLowerCase().includes(normalized))
    })
  }, [favorites, filter, query, voices])

  const recentVoices = filter === 'all' && !query.trim()
    ? recent.map((id) => voices.find((voice) => voice.id === id)).filter((voice): voice is TtsVoice => !!voice)
    : []

  const choose = (voiceId: string) => {
    const nextRecent = [voiceId, ...recent.filter((id) => id !== voiceId)].slice(0, 6)
    setRecent(nextRecent)
    persist(favorites, nextRecent)
    onChange(voiceId)
    close()
  }

  const toggleFavorite = (voiceId: string) => {
    const next = favorites.includes(voiceId) ? favorites.filter((id) => id !== voiceId) : [voiceId, ...favorites]
    setFavorites(next)
    persist(next, recent)
  }

  const audition = async (voiceId: string) => {
    if (!onAudition || auditioningId) return
    setAuditionError(null)
    setAuditionNotice(null)
    if (playingId === voiceId && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setPlayingId(null)
      return
    }
    audioRef.current?.pause()
    setPlayingId(null)
    setAuditioningId(voiceId)
    const cachedUrl = auditionCacheRef.current.get(voiceId)
    const controller = cachedUrl ? null : auditionGeneration.begin()
    setAuditionGenerating(!!controller)
    try {
      const url = cachedUrl ?? await onAudition(voiceId, {
        signal: controller!.signal,
        onJobCreated: auditionGeneration.attachJob,
      })
      if (controller?.signal.aborted) return
      auditionCacheRef.current.set(voiceId, url)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setPlayingId((current) => current === voiceId ? null : current)
      audio.onerror = () => {
        setPlayingId(null)
        setAuditionError('This preview could not be played. Try again.')
      }
      await audio.play()
      setPlayingId(voiceId)
    } catch (error) {
      if (controller?.signal.aborted || isGenerationExit(error)) return
      setAuditionError(error instanceof Error ? error.message : 'Voice preview failed.')
    } finally {
      if (controller) auditionGeneration.finish(controller)
      setAuditionGenerating(false)
      setAuditioningId(null)
    }
  }

  const exitAudition = () => {
    const outcome = auditionGeneration.exit()
    if (!outcome) return
    setAuditionGenerating(false)
    setAuditionNotice(outcome === 'backgrounded'
      ? 'Sample continues in Activity and will be saved to Library.'
      : 'Voice sample generation cancelled.')
  }

  const menuStyle: CSSProperties = {
    left: menuPosition.left,
    width: menuPosition.width,
    maxHeight: menuPosition.maxHeight,
    ...(menuPosition.opensAbove ? { bottom: menuPosition.bottom } : { top: menuPosition.top }),
  }

  const renderVoice = (voice: TtsVoice) => {
    const parts = voiceParts(voice.label)
    const favorite = favorites.includes(voice.id)
    return (
      <article className={'ef-voice-card' + (voice.id === value ? ' is-selected' : '')} key={voice.id}>
        <button type="button" className="ef-voice-card-main" aria-pressed={voice.id === value} onClick={() => choose(voice.id)}>
          <span className="ef-voice-avatar" aria-hidden="true">{parts.name.slice(0, 1).toUpperCase()}</span>
          <span className="ef-voice-copy"><strong>{parts.name}</strong><small>{parts.descriptor}</small></span>
          <span className="ef-voice-usecase">{useCase(voice.label)}</span>
        </button>
        {onAudition && (
          <button
            type="button"
            className={'ef-voice-audition' + (playingId === voice.id ? ' is-playing' : '')}
            aria-label={`${playingId === voice.id ? 'Stop' : 'Play'} ${parts.name} voice sample`}
            title={playingId === voice.id ? 'Stop sample' : 'Play sample'}
            disabled={!!auditioningId && auditioningId !== voice.id}
            onClick={() => void audition(voice.id)}
          >{auditioningId === voice.id ? '…' : playingId === voice.id ? '■' : '▶'}</button>
        )}
        <button type="button" className={'ef-voice-favorite' + (favorite ? ' is-favorite' : '')} aria-label={`${favorite ? 'Remove' : 'Add'} ${parts.name} ${favorite ? 'from' : 'to'} favorites`} aria-pressed={favorite} onClick={() => toggleFavorite(voice.id)}>{favorite ? '★' : '☆'}</button>
      </article>
    )
  }

  return (
    <div className="ef-voice-picker">
      <span className="ef-field-label">{label.toUpperCase()}</span>
      <button ref={triggerRef} type="button" className="ef-voice-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : openPicker())}>
        <span className="ef-voice-avatar" aria-hidden="true">{selectedParts.name.slice(0, 1).toUpperCase()}</span>
        <span className="ef-voice-copy"><strong>{selectedParts.name}</strong><small>{selectedParts.descriptor}</small></span>
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {auditionGenerating && !open && (
        <GenerationCancelControl
          job={auditionGeneration.job}
          onExit={exitAudition}
          noun="voice sample"
        />
      )}

      {open && createPortal(
          <div ref={sheetRef} className={'ef-voice-sheet ef-voice-sheet--anchored' + (menuPosition.opensAbove ? ' opens-above' : '')} style={menuStyle} role="dialog" aria-label="Choose a voice">
            <header className="ef-voice-sheet-head">
              <div><span>VOICE LIBRARY</span><strong>Find the right performance</strong><small>{voices.length} verified ElevenLabs preset voices</small></div>
              <button type="button" className="ef-icon-btn" onClick={() => close()} aria-label="Close voice picker">×</button>
            </header>
            <input type="search" className="ef-voice-search" autoFocus value={query} placeholder="Search a name or description…" aria-label="Search voices" onChange={(event) => setQuery(event.target.value)} />
            <div className="ef-voice-filters" role="group" aria-label="Filter voices by use case">
              {FILTERS.map((item) => <button type="button" key={item.id} className={filter === item.id ? 'is-active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}{item.id === 'favorites' && favorites.length ? <span>{favorites.length}</span> : null}</button>)}
            </div>
            <div className="ef-scroll ef-voice-list">
              {!!recentVoices.length && <section className="ef-voice-section"><h3>RECENTLY USED</h3>{recentVoices.map(renderVoice)}</section>}
              <section className="ef-voice-section"><h3>{filter === 'favorites' ? 'FAVORITES' : query.trim() ? 'MATCHING VOICES' : 'ALL VOICES'}</h3>{visible.map(renderVoice)}</section>
              {!visible.length && <div className="ef-voice-empty">No voices match this search and filter.</div>}
            </div>
            {auditionGenerating && (
              <GenerationCancelControl
                job={auditionGeneration.job}
                onExit={exitAudition}
                noun="voice sample"
              />
            )}
            <footer className="ef-voice-sheet-foot"><span><i /> Voice clone is planned but disabled for beta</span><small className={auditionError ? 'is-error' : ''} role={auditionError ? 'alert' : auditionNotice ? 'status' : undefined}>{auditionError ?? auditionNotice ?? (onAudition ? `Sample${auditionPriceLabel ? ` · ${auditionPriceLabel}` : ''} · cached for this session` : 'Choose a voice to continue.')}</small></footer>
          </div>,
        document.body,
      )}
    </div>
  )
}
