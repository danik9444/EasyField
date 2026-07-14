import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'
import { Icon } from '../icons'
import { Lightbox } from '../components/Lightbox'
import { Dropdown } from '../components/Dropdown'
import { resolve } from '../services/resolve'
import { sendToTimeline } from '../services/timeline'
import { importAudioWithBeatMarkers } from '../services/timeline'
import { saveUrl } from '../services/run'
import { parseBeatAnalysisCompanion } from '../data/beatWorkflow'
import {
  parseTranscriptCompanion,
  transcriptFileName,
  transcriptToSrt,
  transcriptToText,
  transcriptToVtt,
} from '../data/transcript'
import {
  useCreations,
  useFolders,
  usePersistenceState,
  addCreation,
  removeCreation,
  removeCreations,
  moveCreations,
  createFolder,
  renameFolder,
  deleteFolder,
  type Creation,
  type BeatCreationCompanion,
  type TranscriptCreationCompanion,
  type CreationCompanion,
  type CreationKind,
  type Folder,
} from '../data/creations'

interface LibraryProps {
  onBack: () => void
  onOpenCreate: () => void
  toast: (msg: string) => void
  onSendToEdit: (src: { kind: 'image' | 'video'; url: string; name?: string }) => void
  onOpenCaptions?: (transcriptId: string, sourceCreationId: string) => void
  initialQuery?: string
}

type View = 'grid' | 'list'
type SortKey = 'Newest' | 'Oldest' | 'Name' | 'Type'
type KindFilter = 'all' | CreationKind
type CollectionFilter = 'all' | 'recent' | 'generated' | 'timeline'

const KIND_TABS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
]
const SORTS: SortKey[] = ['Newest', 'Oldest', 'Name', 'Type']
const KIND_COLOR: Record<CreationKind, string> = { image: '#E26BD2', video: '#5B8CFF', audio: '#3ED598' }

type MenuState =
  | { x: number; y: number; kind: 'item'; item: Creation }
  | { x: number; y: number; kind: 'folder'; folder: Folder }
  | { x: number; y: number; kind: 'add' }

function latestBeatCompanion(creation: Creation): BeatCreationCompanion | null {
  return creation.companions?.find((companion): companion is BeatCreationCompanion => companion.kind === 'beat-analysis') ?? null
}

function latestTranscriptCompanion(creation: Creation): TranscriptCreationCompanion | null {
  return creation.companions?.find((companion): companion is TranscriptCreationCompanion => companion.kind === 'transcript') ?? null
}

export function Library({ onBack, onOpenCreate, toast, onSendToEdit, onOpenCaptions, initialQuery = '' }: LibraryProps) {
  const all = useCreations()
  const folders = useFolders()
  const persistenceState = usePersistenceState()

  const [query, setQuery] = useState(initialQuery)
  const [view, setView] = useState<View>('grid')
  const [sort, setSort] = useState<SortKey>('Newest')
  const [kind, setKind] = useState<KindFilter>('all')
  const [collection, setCollection] = useState<CollectionFilter>('all')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<Creation | null>(null)
  const [inspected, setInspected] = useState<Creation | null>(null)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLElement | null>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const inspectorReturnFocusRef = useRef<HTMLElement | null>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menu) return
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [menu])

  useEffect(() => {
    if (!inspected) return
    const current = all.find((creation) => creation.id === inspected.id)
    if (!current) {
      setInspected(null)
      return
    }
    if (current !== inspected) setInspected(current)
  }, [all, inspected])

  useEffect(() => {
    if (!inspected) return
    const frame = requestAnimationFrame(() => inspectorRef.current?.focus())
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A preview or picker layered above the inspector owns the first Escape.
      // Without this guard both window listeners run for the same key press and
      // the inspector disappears together with the topmost dialog.
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      setInspected(null)
      requestAnimationFrame(() => inspectorReturnFocusRef.current?.focus())
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [inspected])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = all.filter((c) => (folderId === null ? true : c.folderId === folderId))
    if (folderId === null && collection === 'recent') list = list.filter((c) => Date.now() - c.createdAt < 7 * 24 * 60 * 60 * 1000)
    else if (folderId === null && collection === 'generated') list = list.filter((c) => !c.fromTimeline)
    else if (folderId === null && collection === 'timeline') list = list.filter((c) => c.fromTimeline)
    if (kind !== 'all') list = list.filter((c) => c.kind === kind)
    if (q) {
      list = list.filter((c) =>
        [c.prompt, c.model, c.meta]
          .some((value) => (value ?? '').toLowerCase().includes(q)),
      )
    }
    const s = [...list]
    if (sort === 'Newest') s.sort((a, b) => b.createdAt - a.createdAt)
    else if (sort === 'Oldest') s.sort((a, b) => a.createdAt - b.createdAt)
    else if (sort === 'Name') s.sort((a, b) => (a.prompt ?? a.model ?? '').localeCompare(b.prompt ?? b.model ?? ''))
    else s.sort((a, b) => a.kind.localeCompare(b.kind) || b.createdAt - a.createdAt)
    return s
  }, [all, collection, folderId, kind, query, sort])

  const visual = items.filter((c) => c.kind !== 'audio')
  const audio = items.filter((c) => c.kind === 'audio')

  // ---- timeline grabs ----
  // A Library item is created only after Resolve returns actual bytes. Recording
  // a placeholder on a 409/network failure looked like a successful capture and
  // left users with an artifact that could never be opened or applied.
  const grabFailure = (error?: string) => toast(error ? `Capture failed · ${error}` : 'Capture failed · check Resolve and the playhead')
  const grabFrame = async () => {
    const g = await resolve.grabFrame()
    if (g.ok && g.blobUrl) {
      addCreation({ kind: 'image', url: g.blobUrl, model: g.name, meta: g.timecode, fromTimeline: true, folderId })
      toast('Frame grabbed from timeline')
    } else {
      grabFailure(g.error)
    }
  }
  const grabVideo = async () => {
    const g = await resolve.grabClip()
    if (g.ok && g.blobUrl) {
      addCreation({ kind: 'video', url: g.blobUrl, model: g.name, meta: g.timecode, fromTimeline: true, folderId })
      toast('Clip grabbed from timeline')
    } else {
      grabFailure(g.error)
    }
  }
  const grabSound = async () => {
    const g = await resolve.grabAudio()
    if (g.ok && g.blobUrl) {
      addCreation({ kind: 'audio', url: g.blobUrl, model: g.name, meta: g.timecode, fromTimeline: true, folderId })
      toast('Audio grabbed from timeline')
    } else {
      grabFailure(g.error)
    }
  }

  // ---- selection ----
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  const clearSel = () => {
    setSelected(new Set())
    setSelectMode(false)
  }
  const deleteSelected = () => {
    removeCreations(selected)
    toast(`${selected.size} deleted`)
    clearSel()
  }
  const sendSelected = async () => {
    const picked = all.filter((c) => selected.has(c.id))
    const withUrl = picked.filter((c) => !!c.url)
    const skipped = picked.length - withUrl.length
    if (!withUrl.length) {
      toast(skipped ? `${skipped} timeline placeholder${skipped === 1 ? '' : 's'} skipped — nothing to send` : 'Nothing to send')
      clearSel()
      return
    }
    // sendToTimeline handles one media kind per call — group the selection by kind.
    const byKind: Record<CreationKind, Creation[]> = { image: [], video: [], audio: [] }
    withUrl.forEach((c) => byKind[c.kind].push(c))
    clearSel()
    for (const k of ['image', 'video', 'audio'] as CreationKind[]) {
      const group = byKind[k]
      if (group.length) {
        await sendToTimeline(group.map((c) => ({ url: c.url, name: c.prompt || c.model || 'EasyField' })), k, toast)
      }
    }
    if (skipped) toast(`${skipped} timeline placeholder${skipped === 1 ? '' : 's'} skipped`)
  }
  const moveSelected = (label: string) => {
    if (label === '＋ New folder') {
      const f = createFolder('New folder')
      moveCreations(selected, f.id)
    } else if (label === 'Remove from folder') {
      moveCreations(selected, null)
    } else {
      const f = folders.find((x) => x.name === label)
      if (f) moveCreations(selected, f.id)
    }
    toast(`${selected.size} moved`)
    clearSel()
  }
  const moveOne = (creation: Creation, label: string) => {
    if (label === '＋ New folder') {
      const folder = createFolder('New folder')
      moveCreations([creation.id], folder.id)
    } else if (label === 'Remove from folder') {
      moveCreations([creation.id], null)
    } else {
      const folder = folders.find((item) => item.name === label)
      if (folder) moveCreations([creation.id], folder.id)
    }
    toast('Asset moved')
  }

  // ---- folders ----
  const commitNewFolder = () => {
    if (newFolderName.trim()) {
      const f = createFolder(newFolderName)
      setFolderId(f.id)
    }
    setNewFolderName('')
    setNewFolderOpen(false)
  }
  const commitRename = () => {
    if (renamingId && renameVal.trim()) renameFolder(renamingId, renameVal)
    setRenamingId(null)
  }
  const startRename = (f: Folder) => {
    setRenamingId(f.id)
    setRenameVal(f.name)
  }
  const removeFolder = (f: Folder) => {
    deleteFolder(f.id)
    if (folderId === f.id) setFolderId(null)
    toast('Folder deleted — items kept')
  }

  const open = (c: Creation) => {
    if (selectMode) return toggleSel(c.id)
    inspectorReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setInspected(c)
  }

  const closeInspector = () => {
    setInspected(null)
    requestAnimationFrame(() => inspectorReturnFocusRef.current?.focus())
  }

  // Right-click / menu openers.
  const openItemMenu = (e: MouseEvent<HTMLElement>, item: Creation) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    menuTriggerRef.current = active && e.currentTarget.contains(active)
      ? active
      : e.currentTarget.matches('button, [href], [tabindex]')
        ? e.currentTarget
        : e.currentTarget.querySelector<HTMLElement>('button, [href], [tabindex]')
    setMenu({
      x: e.clientX || rect.left,
      y: e.clientY || rect.bottom + 4,
      kind: 'item',
      item,
    })
  }
  const openItemActions = (e: MouseEvent<HTMLButtonElement>, item: Creation) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    menuTriggerRef.current = e.currentTarget
    setMenu({ x: rect.right, y: rect.bottom + 4, kind: 'item', item })
  }
  const openFolderMenu = (e: MouseEvent<HTMLElement>, folder: Folder) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    menuTriggerRef.current = e.currentTarget
    setMenu({
      x: e.clientX || rect.left,
      y: e.clientY || rect.bottom + 4,
      kind: 'folder',
      folder,
    })
  }
  const openAddMenu = (x: number, y: number, trigger?: HTMLElement) => {
    menuTriggerRef.current = trigger ?? null
    setMenu({ x, y, kind: 'add' })
  }
  const closeMenu = (returnFocus = true) => {
    setMenu(null)
    if (returnFocus) requestAnimationFrame(() => menuTriggerRef.current?.focus())
  }
  const moveFocusPastMenu = (backward: boolean) => {
    const menuElement = menuRef.current
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !menuElement?.contains(element) && element.offsetParent !== null)
    if (!focusable.length) {
      closeMenu(false)
      return
    }
    const triggerIndex = menuTriggerRef.current ? focusable.indexOf(menuTriggerRef.current) : -1
    const targetIndex = triggerIndex >= 0
      ? (triggerIndex + (backward ? -1 : 1) + focusable.length) % focusable.length
      : backward ? focusable.length - 1 : 0
    const target = focusable[targetIndex]
    closeMenu(false)
    requestAnimationFrame(() => target?.focus())
  }
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      moveFocusPastMenu(event.shiftKey)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[next].focus()
  }
  const ext = (c: Creation) => {
    const named = (c.prompt || c.model || '').match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()
    if (named) return named
    if (!/^(blob:|data:)/i.test(c.url)) {
      try {
        const fromUrl = new URL(c.url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase()
        if (fromUrl) return fromUrl
      } catch { /* fallback below */ }
    }
    return c.kind === 'image' ? 'png' : c.kind === 'video' ? 'mp4' : 'wav'
  }

  const downloadCompanion = (companion: CreationCompanion) => {
    const url = URL.createObjectURL(new Blob([companion.data], { type: companion.mimeType }))
    saveUrl(url, companion.fileName)
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const downloadTranscript = (companion: TranscriptCreationCompanion, format: 'srt' | 'vtt' | 'txt' | 'json') => {
    const document = parseTranscriptCompanion(companion)
    if (!document) {
      toast('This linked transcript is unavailable')
      return
    }
    const data = format === 'srt'
      ? transcriptToSrt(document)
      : format === 'vtt'
        ? transcriptToVtt(document)
        : format === 'txt'
          ? transcriptToText(document)
          : JSON.stringify(document, null, 2)
    const url = URL.createObjectURL(new Blob([data], { type: format === 'json' ? 'application/json' : format === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' }))
    saveUrl(url, transcriptFileName(document, format))
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const importBeatAsset = async (creation: Creation, companion: CreationCompanion, target: 'timeline' | 'media-pool') => {
    const document = parseBeatAnalysisCompanion(companion)
    if (!document || creation.kind !== 'audio') {
      toast('This linked beat map is unavailable or does not belong to audio')
      return
    }
    await importAudioWithBeatMarkers({
      url: creation.url,
      name: title(creation),
      target,
      analysisId: document.analysisId,
      color: document.settings.markerColor,
      markers: document.markers,
    }, toast)
  }

  const title = (c: Creation) => c.prompt || c.model || (c.fromTimeline ? 'Timeline capture' : 'Untitled')
  const durabilityLabel = (c: Creation) => (c.durability === 'link-only' ? 'Temporary provider link' : '')

  const moveOptions = [...folders.map((f) => f.name), 'Remove from folder', '＋ New folder']

  // ---- renderers ----
  const tileInner = (c: Creation) => (
    <>
      {c.kind === 'image' && c.url && <span className="ef-cr-thumb" style={{ backgroundImage: `url("${c.url}")` }} />}
      {c.kind === 'video' && c.url && (
        <video
          className="ef-cr-video"
          src={c.url}
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={(e) => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
          onMouseLeave={(e) => {
            const v = e.currentTarget as HTMLVideoElement
            v.pause()
            v.currentTime = 0
          }}
        />
      )}
      {!c.url && (
        <span className="ef-cr-placeholder-inner">
          <Icon glyph={c.kind === 'video' ? 'vid' : 'img'} size={16} />
          <span>{c.meta || 'timeline'}</span>
        </span>
      )}
      <span className="ef-cr-kind-dot" style={{ background: KIND_COLOR[c.kind] }} />
      {c.durability === 'link-only' && (
        <span className="ef-cr-link-badge" title="This provider link may expire. Send it to the Resolve timeline or save it locally.">
          Link only
        </span>
      )}
      {c.kind === 'video' && c.url && <span className="ef-cr-play">▶</span>}
      {latestTranscriptCompanion(c) && <span className="ef-cr-transcript-mark" title="Linked editable transcript"><Icon glyph="transcribe" size={10} /> Transcript</span>}
      <span className="ef-cr-tile-overlay">{c.url ? title(c) : `⌖ ${c.meta || 'Timeline'}`}</span>
      {selectMode && <span className={'ef-cr-check' + (selected.has(c.id) ? ' on' : '')}>{selected.has(c.id) ? '✓' : ''}</span>}
    </>
  )

  const gridTile = (c: Creation) => (
    <div className={'ef-cr-tilewrap' + (inspected?.id === c.id ? ' is-inspected' : '')} key={c.id}>
      <button
        type="button"
        className={'ef-cr-tile' + (c.url ? '' : ' placeholder') + (selectMode && selected.has(c.id) ? ' selected' : '')}
        aria-label={`${selectMode ? (selected.has(c.id) ? 'Deselect' : 'Select') : c.kind === 'audio' ? 'Play' : 'Open'} ${title(c)}${durabilityLabel(c) ? `. ${durabilityLabel(c)}` : ''}`}
        aria-pressed={selectMode ? selected.has(c.id) : undefined}
        onClick={() => open(c)}
        onContextMenu={(e) => openItemMenu(e, c)}
      >
        {tileInner(c)}
      </button>
      {!selectMode && (
        <button
          type="button"
          className="ef-cr-remove ef-cr-more"
          aria-label={`More actions for ${title(c)}`}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'item' && menu.item.id === c.id}
          aria-controls={menu?.kind === 'item' && menu.item.id === c.id ? menuId : undefined}
          onClick={(event) => openItemActions(event, c)}
        >⋯</button>
      )}
    </div>
  )

  const listRow = (c: Creation) => (
    <div
      key={c.id}
      className={'ef-cr-row' + (selectMode && selected.has(c.id) ? ' selected' : '') + (inspected?.id === c.id ? ' is-inspected' : '')}
      onContextMenu={(e) => openItemMenu(e, c)}
    >
      <button
        type="button"
        aria-label={`${selectMode ? (selected.has(c.id) ? 'Deselect' : 'Select') : c.kind === 'audio' ? 'Play' : 'Open'} ${title(c)}${durabilityLabel(c) ? `. ${durabilityLabel(c)}` : ''}`}
        aria-pressed={selectMode ? selected.has(c.id) : undefined}
        onClick={() => open(c)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
      >
        <span className={'ef-cr-row-thumb ef-cr-row-thumb--' + c.kind} style={c.kind === 'image' && c.url ? { backgroundImage: `url("${c.url}")` } : undefined}>
          {c.kind === 'video' && <span className="ef-cr-play sm">▶</span>}
          {c.kind === 'audio' && <Icon glyph="music" size={13} />}
        </span>
        <span className="ef-cr-row-text">
          <span className="ef-cr-row-title">{title(c)}</span>
          <span className="ef-cr-row-sub">{[c.model, c.meta, latestTranscriptCompanion(c) ? 'Linked transcript' : '', durabilityLabel(c)].filter(Boolean).join(' · ')}</span>
        </span>
        {selectMode && <span className={'ef-cr-check' + (selected.has(c.id) ? ' on' : '')} style={{ position: 'static' }}>{selected.has(c.id) ? '✓' : ''}</span>}
      </button>
      {!selectMode && (
        <button
          type="button"
          className="ef-cr-row-x ef-cr-more"
          style={{ border: 0, background: 'transparent', cursor: 'pointer' }}
          aria-label={`More actions for ${title(c)}`}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'item' && menu.item.id === c.id}
          aria-controls={menu?.kind === 'item' && menu.item.id === c.id ? menuId : undefined}
          onClick={(event) => openItemActions(event, c)}
        >⋯</button>
      )}
    </div>
  )

  const audioRow = (c: Creation) => (
    <div className={'ef-cr-audio' + (inspected?.id === c.id ? ' is-inspected' : '')} key={c.id} onContextMenu={(e) => openItemMenu(e, c)}>
      <div className="ef-cr-audio-head">
        <span className="ef-cr-audio-name">{title(c)}</span>
        {selectMode ? (
          <button type="button" className={'ef-cr-check inline' + (selected.has(c.id) ? ' on' : '')} aria-label={`${selected.has(c.id) ? 'Deselect' : 'Select'} ${title(c)}`} aria-pressed={selected.has(c.id)} onClick={() => toggleSel(c.id)}>{selected.has(c.id) ? '✓' : ''}</button>
        ) : (
          <button
            type="button"
            className="ef-cr-remove-inline ef-cr-more"
            aria-label={`More actions for ${title(c)}`}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'item' && menu.item.id === c.id}
            aria-controls={menu?.kind === 'item' && menu.item.id === c.id ? menuId : undefined}
            onClick={(event) => openItemActions(event, c)}
          >⋯</button>
        )}
      </div>
      {c.url ? (
        <audio className="ef-audio-player" src={c.url} controls aria-label={title(c)} style={{ width: '100%' }} />
      ) : (
        <div className="ef-cr-placeholder-audio"><Icon glyph="music" size={14} /> Timeline audio · {c.meta}</div>
      )}
      {c.model && c.model !== title(c) && <span className="ef-cr-sub">{c.model}</span>}
      {latestBeatCompanion(c) && (
        <span className="ef-library-beat-badge">
          <Icon glyph="beat" size={11} /> Beat map · {latestBeatCompanion(c)!.summary.bpm || '—'} BPM · {latestBeatCompanion(c)!.summary.markerCount} markers
        </span>
      )}
      {latestTranscriptCompanion(c) && (
        <span className="ef-library-transcript-badge">
          <Icon glyph="transcribe" size={11} /> Transcript · {latestTranscriptCompanion(c)!.summary.language.toUpperCase()} · {latestTranscriptCompanion(c)!.summary.segmentCount} segments
        </span>
      )}
      {c.durability === 'link-only' && <span className="ef-cr-sub">Temporary provider link · save locally to keep it</span>}
    </div>
  )

  return (
    <div className="ef-screen ef-library-screen">
      <div className="ef-sub-header">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-sub-title"><small>LOCAL ASSET WORKSPACE</small>Library</span>
        <span className="ef-spacer" />
        <span className="ef-model-badge">{items.length} / {all.length}</span>
      </div>

      <div className="ef-library-workbench">
        <aside className="ef-library-sidebar" aria-label="Library collections">
          <div className="ef-library-sidebar-head"><span>COLLECTIONS</span><button type="button" aria-label="Add folder or timeline media" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, r.bottom + 6, e.currentTarget) }}>+</button></div>
          <nav className="ef-library-collections">
            {([
              ['all', 'All assets', 'board'],
              ['recent', 'Recent', 'spark'],
              ['generated', 'Generated', 'img'],
              ['timeline', 'Timeline grabs', 'playhead'],
            ] as const).map(([id, label, glyph]) => (
              <button
                type="button"
                key={id}
                className={folderId === null && collection === id ? 'is-active' : ''}
                aria-pressed={folderId === null && collection === id}
                onClick={() => { setFolderId(null); setCollection(id) }}
              >
                <Icon glyph={glyph} size={12} /><span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="ef-library-folder-heading"><span>FOLDERS</span><small>{folders.length}</small></div>
          <div className="ef-folder-rail">
            {folders.map((f) =>
              renamingId === f.id ? (
                <input
                  key={f.id}
                  className="ef-folder-input"
                  autoFocus
                  aria-label={`Rename folder ${f.name}`}
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null) }}
                  onBlur={commitRename}
                />
              ) : (
                <button
                  key={f.id}
                  type="button"
                  className={'ef-folder-chip' + (folderId === f.id ? ' active' : '')}
                  aria-pressed={folderId === f.id}
                  aria-haspopup="menu"
                  aria-expanded={menu?.kind === 'folder' && menu.folder.id === f.id}
                  aria-controls={menu?.kind === 'folder' && menu.folder.id === f.id ? menuId : undefined}
                  onClick={() => { setFolderId(f.id); setCollection('all') }}
                  onContextMenu={(e) => openFolderMenu(e, f)}
                  title="Right-click to rename or delete"
                >
                  {f.name}
                </button>
              ),
            )}
            {newFolderOpen ? (
              <input
                className="ef-folder-input"
                autoFocus
                aria-label="New folder name"
                placeholder="Folder name…"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNewFolder()
                  if (e.key === 'Escape') { setNewFolderOpen(false); setNewFolderName('') }
                }}
                onBlur={commitNewFolder}
              />
            ) : (
              <button type="button" className="ef-folder-chip add" onClick={() => setNewFolderOpen(true)}>＋ New folder</button>
            )}
          </div>
        </aside>

        <main className="ef-library-main">
          <div className="ef-lib-controls">
            <div className="ef-kind-tabs">
              {KIND_TABS.map((t) => (
                <button key={t.id} type="button" className={'ef-kind-tab' + (kind === t.id ? ' active' : '')} aria-pressed={kind === t.id} onClick={() => setKind(t.id)}>{t.label}</button>
              ))}
            </div>
            <div className="ef-lib-controls-right">
              <Dropdown options={SORTS} selected={sort} onSelect={(s) => setSort(s as SortKey)} label="Sort" align="right" />
              <div className="ef-view-toggle">
                <button type="button" className={'ef-view-btn' + (view === 'grid' ? ' active' : '')} title="Grid" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>⊞</button>
                <button type="button" className={'ef-view-btn' + (view === 'list' ? ' active' : '')} title="List" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}>☰</button>
              </div>
              <button type="button" className={'ef-mini-btn' + (selectMode ? ' on' : '')} aria-pressed={selectMode} onClick={() => (selectMode ? clearSel() : setSelectMode(true))}>
                {selectMode ? 'Done' : 'Select'}
              </button>
            </div>
          </div>

          <div className="ef-search ef-library-search">
            <span className="ef-search-glyph"><Icon glyph="mask" size={13} /></span>
            <input aria-label="Search creations" placeholder="Search by prompt, model, or metadata…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>

          {(persistenceState === 'unavailable' || persistenceState === 'error') && (
            <div className="ef-storage-warning" role="alert">
              Library storage is unavailable. New items will last only for this session.
            </div>
          )}

          <div className="ef-scroll ef-library-scroll" onContextMenu={(e) => { e.preventDefault(); openAddMenu(e.clientX, e.clientY) }}>
            {all.length === 0 ? (
              <div className="ef-library-empty ef-library-empty--hero">
                <span className="ef-library-empty-icon" aria-hidden="true"><Icon glyph="board" size={24} /></span>
                <span className="ef-library-empty-kicker">YOUR LOCAL MEDIA VAULT</span>
                <h2>Build once. Keep every result.</h2>
                <p>Generated media and timeline grabs are saved here before anything is placed in Resolve.</p>
                <div className="ef-library-empty-actions">
                  <button type="button" className="is-primary" onClick={onOpenCreate}><Icon glyph="spark" size={12} /> Generate image</button>
                  <button type="button" onClick={() => void grabFrame()}><Icon glyph="playhead" size={12} /> Grab frame</button>
                  <button type="button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, r.bottom + 6, e.currentTarget) }}>More sources</button>
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="ef-library-empty ef-library-empty--hero"><h2>Nothing in this view</h2><p>Change the collection, media type, or search query.</p></div>
            ) : (
              <>
                {visual.length > 0 &&
                  (view === 'grid' ? (
                    <div className="ef-cr-grid">{visual.map(gridTile)}</div>
                  ) : (
                    <div className="ef-cr-rows">{visual.map(listRow)}</div>
                  ))}
                {audio.length > 0 && (
                  <div className="ef-cr-audio-list" style={{ marginTop: visual.length ? 12 : 0 }}>{audio.map(audioRow)}</div>
                )}
              </>
            )}
          </div>
        </main>

        {inspected && (
          <>
            <button type="button" className="ef-library-inspector-backdrop" aria-label="Close asset inspector" onClick={closeInspector} />
            <aside ref={inspectorRef} className="ef-library-inspector" aria-label={`Asset details: ${title(inspected)}`} tabIndex={-1}>
              <header className="ef-library-inspector-head">
                <div><span>ASSET INSPECTOR</span><strong>{title(inspected)}</strong></div>
                <button type="button" className="ef-icon-btn" aria-label="Close asset inspector" onClick={closeInspector}>×</button>
              </header>

              <div className="ef-library-inspector-scroll ef-scroll">
                <div className={`ef-library-inspector-preview is-${inspected.kind}`}>
                  {inspected.kind === 'image' && inspected.url && <span style={{ backgroundImage: `url("${inspected.url}")` }} />}
                  {inspected.kind === 'video' && inspected.url && <video src={inspected.url} controls playsInline />}
                  {inspected.kind === 'audio' && inspected.url && <><div className="ef-inspector-wave" aria-hidden="true">{Array.from({ length: 28 }, (_, index) => <i key={index} style={{ height: `${20 + ((index * 19) % 68)}%` }} />)}</div><audio src={inspected.url} controls /></>}
                  {!inspected.url && <div className="ef-library-inspector-placeholder"><Icon glyph={inspected.kind === 'video' ? 'vid' : inspected.kind === 'audio' ? 'music' : 'img'} size={24} /><span>Timeline placeholder</span></div>}
                </div>

                {inspected.durability === 'link-only' && <div className="ef-inspector-warning" role="status">Temporary provider link. Save or place this asset before the link expires.</div>}

                <dl className="ef-library-inspector-meta">
                  <div><dt>Type</dt><dd>{inspected.kind}</dd></div>
                  <div><dt>Created</dt><dd>{new Date(inspected.createdAt).toLocaleString()}</dd></div>
                  <div><dt>Source</dt><dd>{inspected.fromTimeline ? 'DaVinci Resolve timeline' : 'EasyField generation'}</dd></div>
                  <div><dt>Durability</dt><dd>{inspected.durability === 'link-only' ? 'Temporary link' : 'Local library'}</dd></div>
                  {inspected.model && <div><dt>Model</dt><dd>{inspected.model}</dd></div>}
                  {inspected.meta && <div><dt>Metadata</dt><dd>{inspected.meta}</dd></div>}
                  {inspected.folderId && <div><dt>Folder</dt><dd>{folders.find((folder) => folder.id === inspected.folderId)?.name ?? 'Folder'}</dd></div>}
                </dl>

                {inspected.prompt && <section className="ef-library-inspector-prompt"><span>PROMPT / DIRECTION</span><p>{inspected.prompt}</p></section>}

                {latestBeatCompanion(inspected) && (() => {
                  const beat = latestBeatCompanion(inspected)!
                  return (
                    <section className="ef-library-companion" aria-label="Linked Beat Detection analysis">
                      <header><span><Icon glyph="beat" size={13} /> LINKED BEAT MAP</span><small>Sidecar · revision {inspected.companions?.filter((item) => item.kind === 'beat-analysis').length ?? 1}</small></header>
                      <div>
                        <span><small>BPM</small><strong>{beat.summary.bpm || '—'}</strong></span>
                        <span><small>MARKERS</small><strong>{beat.summary.markerCount}</strong></span>
                        <span><small>CONFIDENCE</small><strong>{Math.round(beat.summary.confidence * 100)}%</strong></span>
                      </div>
                      <p>{beat.fileName} · librosa {beat.summary.engineVersion}</p>
                      <div className="ef-library-companion-actions">
                        <button type="button" onClick={() => downloadCompanion(beat)}>Download beat JSON</button>
                        {inspected.kind === 'audio' && <button type="button" onClick={() => void importBeatAsset(inspected, beat, 'media-pool')}>Media Pool + markers</button>}
                        {inspected.kind === 'audio' && <button type="button" className="is-primary" onClick={() => void importBeatAsset(inspected, beat, 'timeline')}>Timeline + markers</button>}
                      </div>
                    </section>
                  )
                })()}

                {latestTranscriptCompanion(inspected) && (() => {
                  const linkedTranscript = latestTranscriptCompanion(inspected)!
                  return (
                    <section className="ef-library-companion ef-library-companion--transcript" aria-label="Linked editable transcript">
                      <header><span><Icon glyph="transcribe" size={13} /> LINKED TRANSCRIPT</span><small>Sidecar · revision {inspected.companions?.filter((item) => item.kind === 'transcript').length ?? 1}</small></header>
                      <div>
                        <span><small>LANGUAGE</small><strong>{linkedTranscript.summary.language.toUpperCase()}</strong></span>
                        <span><small>SEGMENTS</small><strong>{linkedTranscript.summary.segmentCount}</strong></span>
                        <span><small>WORDS</small><strong>{linkedTranscript.summary.wordCount || '—'}</strong></span>
                      </div>
                      <p>{linkedTranscript.fileName} · OpenAI Whisper {linkedTranscript.summary.model}</p>
                      <div className="ef-library-companion-actions ef-library-transcript-actions">
                        <button type="button" onClick={() => downloadTranscript(linkedTranscript, 'srt')}>Download SRT</button>
                        <button type="button" onClick={() => downloadTranscript(linkedTranscript, 'vtt')}>Download VTT</button>
                        <button type="button" onClick={() => downloadTranscript(linkedTranscript, 'txt')}>Download TXT</button>
                        <button type="button" onClick={() => downloadTranscript(linkedTranscript, 'json')}>Transcript JSON</button>
                        {onOpenCaptions && <button type="button" className="is-primary" onClick={() => onOpenCaptions(linkedTranscript.id, inspected.id)}>Open in Captions →</button>}
                      </div>
                    </section>
                  )
                })()}

                <div className="ef-library-inspector-actions">
                  {inspected.url && inspected.kind !== 'audio' && <button type="button" className="is-primary" onClick={() => setLightbox(inspected)}>Open preview</button>}
                  {inspected.url && (inspected.kind === 'image' || inspected.kind === 'video') && <button type="button" onClick={() => onSendToEdit({ kind: inspected.kind === 'image' ? 'image' : 'video', url: inspected.url!, name: inspected.model })}>Use in Edit</button>}
                  {inspected.url && <button type="button" onClick={() => void sendToTimeline([{ url: inspected.url!, name: title(inspected) }], inspected.kind, toast)}>Place on timeline</button>}
                  {inspected.url && <button type="button" onClick={() => saveUrl(inspected.url!, `easyfield-${inspected.id}.${ext(inspected)}`)}>Save a copy</button>}
                </div>

                <div className="ef-library-inspector-manage">
                  <Dropdown options={moveOptions} selected="Move to…" onSelect={(label) => moveOne(inspected, label)} label="Move asset" align="right" />
                  <button type="button" className="is-danger" onClick={() => { const id = inspected.id; closeInspector(); removeCreation(id); toast('Asset removed from Library') }}>Delete asset</button>
                </div>
              </div>
            </aside>
          </>
        )}
      </div>

      {/* Selection action bar */}
      {selectMode && selected.size > 0 && (
        <div className="ef-select-bar">
          <span className="ef-select-count">{selected.size} selected</span>
          <span className="ef-spacer" />
          <Dropdown options={moveOptions} selected="Move to…" onSelect={moveSelected} label="Move to folder" align="right" />
          <button type="button" className="ef-mini-btn" onClick={sendSelected}>→ Timeline</button>
          <button type="button" className="ef-mini-btn danger" onClick={deleteSelected}>Delete</button>
        </div>
      )}

      {/* Right-click context menu */}
      {menu && (
        <>
          <div className="ef-ctx-overlay" aria-hidden="true" onClick={() => closeMenu()} onContextMenu={(e) => { e.preventDefault(); closeMenu() }} />
          <div
            ref={menuRef}
            id={menuId}
            className="ef-ctx-menu"
            role="menu"
            aria-label={menu.kind === 'item' ? `Actions for ${title(menu.item)}` : menu.kind === 'folder' ? `Actions for folder ${menu.folder.name}` : 'Add to library'}
            onKeyDown={onMenuKeyDown}
            style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 300) }}
          >
            {menu.kind === 'item' &&
              (() => {
                const c = menu.item
                return (
                  <>
                    {c.url && c.kind === 'image' && (
                      <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { onSendToEdit({ kind: 'image', url: c.url, name: c.model }); closeMenu() }}>✎ Send to Edit Image</button>
                    )}
                    {c.url && c.kind === 'video' && (
                      <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { onSendToEdit({ kind: 'video', url: c.url, name: c.model }); closeMenu() }}>✎ Send to Edit Video</button>
                    )}
                    {c.url && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { void sendToTimeline([{ url: c.url, name: c.prompt || c.model || 'EasyField' }], c.kind, toast); closeMenu() }}>→ Send to timeline</button>}
                    {c.url && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { saveUrl(c.url, `easyfield-${c.id}.${ext(c)}`); closeMenu() }}>↓ Save</button>}
                    {latestBeatCompanion(c) && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { downloadCompanion(latestBeatCompanion(c)!); closeMenu() }}>↓ Download beat JSON</button>}
                    {latestTranscriptCompanion(c) && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { downloadTranscript(latestTranscriptCompanion(c)!, 'srt'); closeMenu() }}>↓ Download transcript SRT</button>}
                    {latestTranscriptCompanion(c) && onOpenCaptions && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { onOpenCaptions(latestTranscriptCompanion(c)!.id, c.id); closeMenu() }}>CC Open transcript in Captions</button>}
                    {c.kind === 'audio' && latestBeatCompanion(c) && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { void importBeatAsset(c, latestBeatCompanion(c)!, 'media-pool'); closeMenu() }}>◎ Media Pool + beat markers</button>}
                    {c.kind === 'audio' && latestBeatCompanion(c) && <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { void importBeatAsset(c, latestBeatCompanion(c)!, 'timeline'); closeMenu() }}>⌖ Timeline + beat markers</button>}
                    <div className="ef-ctx-div" role="separator" />
                    <span className="ef-ctx-label" role="presentation">Move to folder</span>
                    {folders.map((f) => (
                      <button key={f.id} type="button" role="menuitem" className="ef-ctx-item sub" onClick={() => { moveCreations([c.id], f.id); toast('Moved'); closeMenu() }}>
                        {c.folderId === f.id ? '✓ ' : ''}{f.name}
                      </button>
                    ))}
                    {c.folderId && <button type="button" role="menuitem" className="ef-ctx-item sub" onClick={() => { moveCreations([c.id], null); closeMenu() }}>Remove from folder</button>}
                    <button type="button" role="menuitem" className="ef-ctx-item sub" onClick={() => { const f = createFolder('New folder'); moveCreations([c.id], f.id); setFolderId(f.id); closeMenu() }}>＋ New folder…</button>
                    <div className="ef-ctx-div" role="separator" />
                    <button type="button" role="menuitem" className="ef-ctx-item danger" onClick={() => { removeCreation(c.id); closeMenu() }}>🗑 Delete</button>
                  </>
                )
              })()}
            {menu.kind === 'folder' && (
              <>
                <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { startRename(menu.folder); closeMenu(false) }}>✎ Rename folder</button>
                <button type="button" role="menuitem" className="ef-ctx-item danger" onClick={() => { removeFolder(menu.folder); closeMenu() }}>🗑 Delete folder</button>
              </>
            )}
            {menu.kind === 'add' && (
              <>
                <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { setNewFolderOpen(true); closeMenu(false) }}>＋ New folder</button>
                <div className="ef-ctx-div" role="separator" />
                <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { void grabFrame(); closeMenu() }}>⌖ Grab frame</button>
                <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { void grabVideo(); closeMenu() }}>⌖ Grab video</button>
                <button type="button" role="menuitem" className="ef-ctx-item" onClick={() => { void grabSound(); closeMenu() }}>⌖ Grab sound</button>
              </>
            )}
          </div>
        </>
      )}

      {lightbox && <Lightbox url={lightbox.url} kind={lightbox.kind === 'video' ? 'video' : 'image'} onClose={() => setLightbox(null)} />}
    </div>
  )
}
