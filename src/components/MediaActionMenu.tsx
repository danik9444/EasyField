import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export interface MediaAction {
  id: string
  label: string
  description?: string
  disabled?: boolean
}

interface MediaActionMenuProps {
  label: string
  actions: MediaAction[]
  disabled?: boolean
  onSelect: (id: string) => void
  children: ReactNode
}

interface MenuPoint {
  x: number
  y: number
}

const MENU_WIDTH = 244
const VIEWPORT_GAP = 8

export function MediaActionMenu({ label, actions, disabled = false, onSelect, children }: MediaActionMenuProps) {
  const [menu, setMenu] = useState<MenuPoint | null>(null)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const close = (returnFocus = true) => {
    setMenu(null)
    if (returnFocus) requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  const openAt = (x: number, y: number, returnFocus?: HTMLElement | null) => {
    if (disabled || !actions.length) return
    returnFocusRef.current = returnFocus ?? triggerRef.current
    setMenu({ x, y })
  }

  const openFromTrigger = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    openAt(rect.right, rect.bottom + 5, event.currentTarget)
  }

  const openFromContext = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled || !actions.length) return
    event.preventDefault()
    event.stopPropagation()
    openAt(event.clientX, event.clientY, triggerRef.current)
  }

  useEffect(() => {
    if (!menu) return
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
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
    items[next]?.focus()
  }

  const select = (action: MediaAction) => {
    if (action.disabled) return
    close(false)
    onSelect(action.id)
  }

  const left = menu ? Math.max(VIEWPORT_GAP, Math.min(menu.x, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP)) : 0
  const top = menu ? Math.max(VIEWPORT_GAP, Math.min(menu.y, window.innerHeight - Math.min(300, 62 + actions.length * 58))) : 0

  return (
    <div
      className="ef-media-action-host"
      onContextMenu={openFromContext}
      onKeyDown={(event) => {
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          openAt(rect.right - 16, rect.top + 46, triggerRef.current)
        }
      }}
    >
      {children}
      {!disabled && actions.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          className="ef-media-actions-trigger"
          aria-label={`${label} actions`}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          aria-controls={menu ? menuId : undefined}
          title="Media actions"
          onClick={openFromTrigger}
        >
          <span aria-hidden="true">•••</span>
        </button>
      )}

      {menu && createPortal(
        <>
          <button
            type="button"
            className="ef-ctx-overlay ef-media-actions-overlay"
            aria-label="Close media actions"
            onClick={() => close()}
            onContextMenu={(event) => {
              event.preventDefault()
              close()
            }}
          />
          <div
            ref={menuRef}
            id={menuId}
            className="ef-ctx-menu ef-media-actions-menu"
            role="menu"
            aria-label={`${label} actions`}
            style={{ left, top, width: MENU_WIDTH }}
            onKeyDown={moveFocus}
          >
            <span className="ef-ctx-label" role="presentation">MEDIA ACTIONS</span>
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className="ef-ctx-item ef-media-action-item"
                disabled={action.disabled}
                onClick={() => select(action)}
              >
                <span>{action.label}</span>
                {action.description && <small>{action.description}</small>}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
