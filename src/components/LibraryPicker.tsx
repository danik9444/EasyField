import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useCreations, useFolders, usePersistenceState, type Creation, type CreationKind } from '../data/creations'
import { LIBRARY_PAGE_SIZE } from '../data/libraryLimits'
import { Icon } from '../icons'
import { Lightbox } from './Lightbox'
import { LibraryAudio, LibraryImage, LibraryVideo } from './LibraryMedia'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'audio[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

const KIND_LABELS: Record<CreationKind, string> = {
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
}

const KIND_GLYPHS = {
  image: 'img',
  video: 'vid',
  audio: 'music',
} as const

const EMPTY_IDS: readonly string[] = []

function displayName(creation: Creation): string {
  return creation.prompt?.trim() || creation.model?.trim() || `${creation.kind[0].toUpperCase()}${creation.kind.slice(1)} asset`
}

function matchesSearch(creation: Creation, query: string): boolean {
  if (!query) return true
  return [creation.prompt, creation.model, creation.meta, creation.kind]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .includes(query)
}

interface LibraryPickerProps {
  open: boolean
  kinds: readonly CreationKind[]
  max: number
  title?: string
  description?: string
  confirmLabel?: string
  excludedIds?: readonly string[]
  onConfirm: (creations: Creation[]) => void | Promise<void>
  onClose: () => void
}

export function LibraryPicker({
  open,
  kinds,
  max,
  title = 'Choose from Library',
  description = 'Select existing EasyField media without changing or removing the Library original.',
  confirmLabel,
  excludedIds = EMPTY_IDS,
  onConfirm,
  onClose,
}: LibraryPickerProps) {
  const creations = useCreations()
  const folders = useFolders()
  const persistenceState = usePersistenceState()
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  const descriptionId = useId()
  const statusId = useId()
  const [query, setQuery] = useState('')
  const [activeKind, setActiveKind] = useState<CreationKind | 'all'>('all')
  const [activeFolder, setActiveFolder] = useState<string>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ url: string; kind: 'image' | 'video' } | null>(null)
  const [page, setPage] = useState(0)
  const allowedKinds = useMemo(() => [...new Set(kinds)], [kinds])
  const excludedIdSet = useMemo(() => new Set(excludedIds), [excludedIds])
  const unlimited = !Number.isFinite(max)
  const effectiveMax = unlimited ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(max))

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActiveKind('all')
    setActiveFolder('all')
    setSelectedIds([])
    setBusy(false)
    setError('')
    setPreview(null)
    setPage(0)
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      previousFocus?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setSelectedIds((current) => current.filter((id) => !excludedIdSet.has(id) && creations.some((creation) => creation.id === id && allowedKinds.includes(creation.kind))))
  }, [allowedKinds, creations, excludedIdSet, open])

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return creations.filter((creation) => (
      allowedKinds.includes(creation.kind)
      && (activeKind === 'all' || creation.kind === activeKind)
      && (activeFolder === 'all' || (activeFolder === 'root' ? !creation.folderId : creation.folderId === activeFolder))
      && !!creation.url
      && matchesSearch(creation, normalizedQuery)
    ))
  }, [activeFolder, activeKind, allowedKinds, creations, query])
  const pageCount = Math.max(1, Math.ceil(visible.length / LIBRARY_PAGE_SIZE))
  const pageItems = useMemo(
    () => visible.slice(page * LIBRARY_PAGE_SIZE, (page + 1) * LIBRARY_PAGE_SIZE),
    [page, visible],
  )

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1))
  }, [pageCount])

  const goToPage = (nextPage: number) => {
    setPage(Math.max(0, Math.min(nextPage, pageCount - 1)))
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }))
  }

  if (!open || typeof document === 'undefined') return null

  const close = () => {
    if (!busy && !preview) onCloseRef.current()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (preview) setPreview(null)
      else close()
      return
    }
    if (event.key !== 'Tab' || preview || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.getAttribute('aria-hidden') !== 'true')
    if (!focusable.length) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const toggle = (id: string) => {
    if (busy || effectiveMax < 1) return
    setError('')
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((selectedId) => selectedId !== id)
      if (effectiveMax === 1) return [id]
      if (!unlimited && current.length >= effectiveMax) return current
      return [...current, id]
    })
  }

  const confirm = async () => {
    const selected = selectedIds
      .map((id) => creations.find((creation) => creation.id === id))
      .filter((creation): creation is Creation => !!creation && !excludedIdSet.has(creation.id) && allowedKinds.includes(creation.kind) && !!creation.url)
    const bounded = unlimited ? selected : selected.slice(0, effectiveMax)
    if (!bounded.length || busy) return
    setBusy(true)
    setError('')
    try {
      await onConfirm(bounded)
      onCloseRef.current()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The selected Library media could not be added.')
      setBusy(false)
    }
  }

  const resultLabel = persistenceState === 'loading'
    ? 'Loading your Library…'
    : visible.length
      ? `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`
      : creations.length
        ? 'No matching media'
        : 'Your Library is empty'

  return createPortal(
    <div
      className="ef-library-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={dialogRef}
        className="ef-library-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="ef-library-picker-head">
          <span className="ef-library-picker-mark" aria-hidden="true"><Icon glyph="board" size={16} /></span>
          <div>
            <span className="ef-library-picker-kicker">EASYFIELD LIBRARY</span>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button type="button" className="ef-library-picker-close" disabled={busy} onClick={close} aria-label="Close Library picker">×</button>
        </header>

        <div className="ef-library-picker-tools">
          <label className="ef-library-picker-search">
            <span aria-hidden="true">⌕</span>
            <input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} placeholder="Search Library…" aria-label="Search Library" />
          </label>
          {allowedKinds.length > 1 && (
            <div className="ef-library-picker-filters" role="group" aria-label="Filter by media type">
              <button type="button" className={activeKind === 'all' ? 'is-active' : ''} aria-pressed={activeKind === 'all'} onClick={() => { setActiveKind('all'); setPage(0) }}>All</button>
              {allowedKinds.map((kind) => (
                <button type="button" key={kind} className={activeKind === kind ? 'is-active' : ''} aria-pressed={activeKind === kind} onClick={() => { setActiveKind(kind); setPage(0) }}>{KIND_LABELS[kind]}</button>
              ))}
            </div>
          )}
          {folders.length > 0 && (
            <label className="ef-library-picker-folder">
              <span>Collection</span>
              <select value={activeFolder} onChange={(event) => { setActiveFolder(event.target.value); setPage(0) }} aria-label="Library collection">
                <option value="all">All Library</option>
                <option value="root">Unfiled</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="ef-library-picker-summary">
          <span>{resultLabel}</span>
          <strong id={statusId} aria-live="polite">{unlimited ? `${selectedIds.length} selected` : `${selectedIds.length} / ${effectiveMax} selected`}</strong>
        </div>

        <div ref={scrollRef} className="ef-library-picker-scroll ef-scroll">
          {visible.length > 0 ? (
            <>
              <div className="ef-library-picker-grid">
                {pageItems.map((creation) => {
                  const selected = selectedIds.includes(creation.id)
                  const alreadyAttached = excludedIdSet.has(creation.id)
                  const selectionBlocked = alreadyAttached || (!unlimited && !selected && selectedIds.length >= effectiveMax)
                  const name = displayName(creation)
                  return (
                    <article key={creation.id} className={'ef-library-picker-item' + (selected ? ' is-selected' : '') + (selectionBlocked ? ' is-blocked' : '')}>
                      <button
                        type="button"
                        className="ef-library-picker-select"
                        aria-pressed={selected}
                        aria-label={alreadyAttached ? `${name} is already attached` : `${selected ? 'Deselect' : 'Select'} ${name}`}
                        aria-describedby={statusId}
                        disabled={selectionBlocked || busy}
                        onClick={() => toggle(creation.id)}
                      >
                        <span className={'ef-library-picker-thumb is-' + creation.kind}>
                          {creation.kind === 'image' && <LibraryImage className="ef-library-picker-media" src={creation.url} />}
                          {creation.kind === 'video' && <LibraryVideo className="ef-library-picker-media" src={creation.url} />}
                          {creation.kind === 'audio' && <Icon glyph="music" size={24} />}
                          <i className="ef-library-picker-selection-dot" aria-hidden="true" />
                        </span>
                        <span className="ef-library-picker-item-copy">
                          <strong title={name}>{name}</strong>
                          <small><Icon glyph={KIND_GLYPHS[creation.kind]} size={10} /> {creation.model || KIND_LABELS[creation.kind]}{creation.meta ? ` · ${creation.meta}` : ''}</small>
                        </span>
                      </button>
                      <div className="ef-library-picker-item-actions">
                        {creation.kind !== 'audio' ? (
                          <button type="button" disabled={busy} onClick={() => setPreview({ url: creation.url, kind: creation.kind === 'image' ? 'image' : 'video' })}>Preview</button>
                        ) : (
                          <LibraryAudio className="ef-library-picker-audio-shell" src={creation.url} ariaLabel={`Preview ${name}`} />
                        )}
                        {alreadyAttached
                          ? <span>Attached</span>
                          : creation.durability === 'link-only' && <span title="EasyField is still localizing this provider link">Cloud link</span>}
                      </div>
                    </article>
                  )
                })}
              </div>
              {pageCount > 1 && (
                <nav className="ef-library-pagination" aria-label="Library picker pages">
                  <button type="button" disabled={page === 0 || busy} onClick={() => goToPage(page - 1)}>‹ Previous</button>
                  <span>
                    Page {page + 1} of {pageCount}
                    <small>{page * LIBRARY_PAGE_SIZE + 1}–{Math.min((page + 1) * LIBRARY_PAGE_SIZE, visible.length)} of {visible.length}</small>
                  </span>
                  <button type="button" disabled={page + 1 >= pageCount || busy} onClick={() => goToPage(page + 1)}>Next ›</button>
                </nav>
              )}
            </>
          ) : (
            <div className="ef-library-picker-empty" role="status">
              <span><Icon glyph="board" size={22} /></span>
              <strong>{resultLabel}</strong>
              <p>{query ? 'Try a different search or collection.' : `Add ${allowedKinds.map((kind) => KIND_LABELS[kind].toLocaleLowerCase()).join(' or ')} to Library first.`}</p>
            </div>
          )}
        </div>

        {error && <p className="ef-library-picker-error" role="alert">{error}</p>}

        <footer className="ef-library-picker-actions">
          <span>Library originals stay untouched.</span>
          <button type="button" className="is-secondary" disabled={busy} onClick={close}>Cancel</button>
          <button type="button" className="is-primary" disabled={!selectedIds.length || busy} aria-describedby={statusId} onClick={() => void confirm()}>
            {busy ? 'Adding…' : confirmLabel || (effectiveMax === 1 ? 'Use selected media' : `Add ${selectedIds.length || ''} selected`.trim())}
          </button>
        </footer>
      </div>
      {preview && <Lightbox url={preview.url} kind={preview.kind} onClose={() => setPreview(null)} />}
    </div>,
    document.body,
  )
}

interface LibraryPickerButtonProps {
  kinds: readonly CreationKind[]
  max: number
  onSelect: (creations: Creation[]) => void | Promise<void>
  disabled?: boolean
  className?: string
  label?: string
  ariaLabel?: string
  title?: string
  pickerTitle?: string
  pickerDescription?: string
  confirmLabel?: string
  excludedIds?: readonly string[]
  iconSize?: number
}

export function LibraryPickerButton({
  kinds,
  max,
  onSelect,
  disabled = false,
  className = 'ef-library-source-btn',
  label = 'Library',
  ariaLabel = 'Choose from Library',
  title = 'Choose from Library',
  pickerTitle,
  pickerDescription,
  confirmLabel,
  excludedIds,
  iconSize = 12,
}: LibraryPickerButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} disabled={disabled || max < 1} onClick={() => setOpen(true)} aria-label={ariaLabel} title={title} aria-haspopup="dialog" aria-expanded={open}>
        <Icon glyph="board" size={iconSize} /> {label}
      </button>
      <LibraryPicker
        open={open}
        kinds={kinds}
        max={max}
        title={pickerTitle}
        description={pickerDescription}
        confirmLabel={confirmLabel}
        excludedIds={excludedIds}
        onConfirm={onSelect}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
