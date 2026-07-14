import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ProviderLogo } from './ProviderLogo'
import type { ProviderBrandId } from '../data/providerBrands'

export interface DropdownOptionMeta {
  description?: string
  group?: string
  badge?: string
  eyebrow?: string
  searchTerms?: string[]
  disabled?: boolean
  disabledReason?: string
  providerBrand?: ProviderBrandId
}

interface DropdownProps {
  options: string[]
  selected: string
  onSelect: (value: string) => void
  label: string
  align?: 'left' | 'right'
  variant?: 'badge' | 'field'
  optionMeta?: Record<string, DropdownOptionMeta>
  searchable?: boolean
}

interface MenuPosition {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
  opensAbove: boolean
}

const EMPTY_OPTION_META: Record<string, DropdownOptionMeta> = {}
const VIEWPORT_MARGIN = 8
const MENU_GAP = 6

function optionMonogram(option: string, meta?: DropdownOptionMeta): string {
  const source = meta?.group ?? meta?.eyebrow ?? option
  return source.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '·'
}

export function Dropdown({
  options,
  selected,
  onSelect,
  label,
  align = 'right',
  variant = 'badge',
  optionMeta: optionMetaProp,
  searchable,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState<MenuPosition>({ left: VIEWPORT_MARGIN, width: 280, maxHeight: 360, top: 48, opensAbove: false })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const optionMeta = optionMetaProp ?? EMPTY_OPTION_META
  const hasDetails = Object.keys(optionMeta).length > 0

  const selectedMeta = optionMeta[selected]
  const searchEnabled = searchable ?? (hasDetails || options.length >= 20)
  const showMenuHeader = hasDetails || searchEnabled
  const isModelMenu = hasDetails && /\b(model|engine)\b/i.test(label)
  const visibleOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return options
    return options.filter((option) => {
      const meta = optionMeta[option]
      return [option, meta?.description, meta?.group, meta?.eyebrow, ...(meta?.searchTerms ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized)
    })
  }, [optionMeta, options, query])

  const selectedVisibleIndex = Math.max(0, visibleOptions.indexOf(selected))

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const maximumWidth = Math.max(220, viewportWidth - VIEWPORT_MARGIN * 2)
    const preferredWidth = hasDetails || searchEnabled
      ? Math.max(rect.width, isModelMenu ? 460 : 420)
      : variant === 'field'
        ? Math.max(rect.width, 240)
        : Math.max(rect.width, 220)
    const width = Math.min(preferredWidth, maximumWidth)
    const rawLeft = align === 'right' ? rect.right - width : rect.left
    const left = Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), viewportWidth - width - VIEWPORT_MARGIN)
    const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN
    const desiredHeight = hasDetails || searchEnabled
      ? isModelMenu ? 560 : 500
      : Math.min(380, 12 + options.length * 46)
    const opensAbove = spaceBelow < Math.min(230, desiredHeight) && spaceAbove > spaceBelow
    const availableHeight = Math.max(132, opensAbove ? spaceAbove : spaceBelow)
    const maxHeight = Math.min(desiredHeight, availableHeight)

    setMenuPosition({
      left,
      width,
      maxHeight,
      ...(opensAbove
        ? { bottom: viewportHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
      opensAbove,
    })
  }, [align, hasDetails, isModelMenu, options.length, searchEnabled, variant])

  const focusOption = (index: number) => {
    if (!visibleOptions.length) return
    const next = (index + visibleOptions.length) % visibleOptions.length
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }

  const openMenu = (index = selectedVisibleIndex) => {
    if (!options.length) return
    updateMenuPosition()
    setQuery('')
    setActiveIndex(index)
    setOpen(true)
  }

  const closeMenu = (returnFocus = true) => {
    setOpen(false)
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  useEffect(() => {
    if (!open) return
    updateMenuPosition()
    const frame = requestAnimationFrame(() => {
      if (searchEnabled) searchRef.current?.focus()
      else optionRefs.current[activeIndex]?.focus()
    })
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
      } else if (event.key === 'Tab') {
        setOpen(false)
      }
    }
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu(false)
    }
    document.addEventListener('keydown', onDocumentKeyDown)
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onDocumentKeyDown)
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, searchEnabled, updateMenuPosition])

  useEffect(() => {
    if (!open) return
    setActiveIndex(Math.max(0, visibleOptions.indexOf(selected)))
  }, [open, query, selected, visibleOptions])

  const selectOption = (value: string) => {
    if (optionMeta[value]?.disabled) return
    onSelect(value)
    closeMenu()
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      openMenu(event.key === 'End' || event.key === 'ArrowUp' ? options.length - 1 : Math.max(0, options.indexOf(selected)))
    }
  }

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(visibleOptions.length - 1)
    } else if (!searchEnabled && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const start = index + 1
      const ordered = [...visibleOptions.slice(start), ...visibleOptions.slice(0, start)]
      const match = ordered.findIndex((option) => option.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
      if (match >= 0) {
        event.preventDefault()
        focusOption((start + match) % visibleOptions.length)
      }
    }
  }

  const popoverStyle: CSSProperties = {
    left: menuPosition.left,
    width: menuPosition.width,
    maxHeight: menuPosition.maxHeight,
    ...(menuPosition.opensAbove ? { bottom: menuPosition.bottom } : { top: menuPosition.top }),
  }

  return (
    <div className="ef-dropdown">
      <button
        ref={triggerRef}
        type="button"
        className={'ef-dropdown-trigger' + (variant === 'field' ? ' field' : '')}
        aria-label={`${label}: ${selected}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onKeyDown={onTriggerKeyDown}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        {selectedMeta?.providerBrand && (
          <ProviderLogo brand={selectedMeta.providerBrand} size={variant === 'field' ? 19 : 17} className="ef-dropdown-trigger-logo" />
        )}
        <span className="ef-dropdown-trigger-copy">
          <strong>{selected}</strong>
          {selectedMeta?.badge && <small>{selectedMeta.badge}</small>}
        </span>
        <span className="ef-dropdown-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className={'ef-dropdown-popover' + (menuPosition.opensAbove ? ' opens-above' : '') + (hasDetails ? ' has-details' : '') + (isModelMenu ? ' is-model-menu' : '')}
          style={popoverStyle}
        >
          {showMenuHeader && (
            <div className="ef-dropdown-menu-head">
              <span>{label}</span>
              <small>{visibleOptions.length === options.length ? `${options.length} options` : `${visibleOptions.length} of ${options.length}`}</small>
            </div>
          )}

          {searchEnabled && (
            <label className="ef-dropdown-search-wrap">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={`Search ${label.toLocaleLowerCase()}…`}
                aria-label={`Search ${label}`}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    focusOption(0)
                  }
                }}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>×</button>}
            </label>
          )}

          <div id={listboxId} className="ef-dropdown-list ef-scroll" role="listbox" aria-label={label}>
            {visibleOptions.map((option, index) => {
              const meta = optionMeta[option]
              const groupChanged = !!meta?.group && meta.group !== optionMeta[visibleOptions[index - 1]]?.group
              const isSelected = option === selected
              return (
                <div className="ef-dropdown-option-wrap" key={option}>
                  {groupChanged && <span className="ef-dropdown-group" role="presentation">{meta.group}</span>}
                  <button
                    ref={(element) => { optionRefs.current[index] = element }}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={!!meta?.disabled}
                    tabIndex={index === activeIndex ? 0 : -1}
                    className={'ef-dropdown-option' + (!meta ? ' is-simple' : '') + (isSelected ? ' selected' : '') + (meta?.disabled ? ' is-disabled' : '')}
                    onFocus={() => setActiveIndex(index)}
                    onKeyDown={(event) => onOptionKeyDown(event, index)}
                    onClick={() => selectOption(option)}
                  >
                    {meta && (
                      <span className="ef-dropdown-option-mark" aria-hidden="true">
                        {meta.providerBrand
                          ? <ProviderLogo brand={meta.providerBrand} size={isModelMenu ? 25 : 21} />
                          : optionMonogram(option, meta)}
                      </span>
                    )}
                    <span className="ef-dropdown-option-copy">
                      {meta?.eyebrow && <small>{meta.eyebrow}</small>}
                      <strong>{option}</strong>
                      {(meta?.description || meta?.disabledReason) && <span>{meta.disabledReason ?? meta.description}</span>}
                    </span>
                    <span className="ef-dropdown-option-end">
                      {meta?.badge && <small>{meta.badge}</small>}
                    </span>
                  </button>
                </div>
              )
            })}
            {!visibleOptions.length && <div className="ef-dropdown-empty" role="status">No options match “{query.trim()}”.</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
