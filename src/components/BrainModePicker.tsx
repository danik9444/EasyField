import { useRef, type KeyboardEvent } from 'react'
import { BRAIN_MODES, getBrainMode, type BrainModeId } from '../data/superBrainModes'

interface BrainModePickerProps {
  value: BrainModeId
  onChange: (mode: BrainModeId) => void
  locked?: boolean
  onReset?: () => void
}

export function BrainModePicker({ value, onChange, locked = false, onReset }: BrainModePickerProps) {
  const selected = getBrainMode(value)
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([])

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (locked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const last = BRAIN_MODES.length - 1
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (index - 1 + BRAIN_MODES.length) % BRAIN_MODES.length
          : (index + 1) % BRAIN_MODES.length
    const next = BRAIN_MODES[nextIndex]
    onChange(next.id)
    buttonsRef.current[nextIndex]?.focus()
  }

  return (
    <section className="ef-brain-mode-picker" aria-labelledby="ef-brain-mode-label">
      <div className="ef-brain-mode-head">
        <span id="ef-brain-mode-label">WORKFLOW MODE</span>
        <strong>{selected.title}</strong>
        {locked && <em>LOCKED TO DRAFT</em>}
        {locked && onReset && <button type="button" onClick={onReset}>New draft</button>}
      </div>
      <div className="ef-brain-mode-grid" role="radiogroup" aria-labelledby="ef-brain-mode-label" aria-describedby="ef-brain-mode-note">
        {BRAIN_MODES.map((mode, index) => {
          const active = mode.id === value
          return (
            <button
              key={mode.id}
              ref={(node) => { buttonsRef.current[index] = node }}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? 'is-selected' : ''}
              disabled={locked}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(mode.id)}
              onKeyDown={(event) => move(event, index)}
            >
              <span className="ef-brain-mode-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="ef-brain-mode-copy">
                <span><strong>{mode.title}</strong><em>{mode.badge}</em></span>
                <small>{mode.description}</small>
              </span>
              <i aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <p id="ef-brain-mode-note">
        Auto-run skips separate plan approval, never required cost, upload, privacy or destructive-action confirmations.
        {' '}Run modes currently stop at execution preflight until the execution adapters are connected.
        {locked ? ' Start a new draft to change mode.' : ''}
      </p>
    </section>
  )
}
