import { useId, useRef, type KeyboardEvent } from 'react'
import { Dropdown } from './Dropdown'

interface ChipFieldProps {
  label: string
  options: string[]
  selected: string
  onSelect: (value: string) => void
  chipClassName?: string
  presentation?: 'auto' | 'chips' | 'dropdown'
}

export function ChipField({ label, options, selected, onSelect, chipClassName = 'ef-aspect-chip', presentation = 'auto' }: ChipFieldProps) {
  const labelId = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const useDropdown = presentation === 'dropdown' || (presentation === 'auto' && options.length >= 6)

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if (!horizontal && !vertical && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
    onSelect(options[next])
    refs.current[next]?.focus()
  }

  if (useDropdown) {
    return (
      <div className="ef-field ef-choice-field ef-choice-field--dropdown">
        <span id={labelId} className="ef-field-label">{label}</span>
        <Dropdown options={options} selected={selected} onSelect={onSelect} label={label} align="left" variant="field" searchable={false} />
      </div>
    )
  }

  return (
    <div className="ef-field ef-choice-field" role="radiogroup" aria-labelledby={labelId}>
      <div className="ef-choice-field-head">
        <span id={labelId} className="ef-field-label">{label}</span>
      </div>
      <div className="ef-aspect-row">
        {options.map((value, index) => (
          <button
            ref={(element) => { refs.current[index] = element }}
            key={value}
            type="button"
            role="radio"
            aria-checked={value === selected}
            tabIndex={value === selected || (!options.includes(selected) && index === 0) ? 0 : -1}
            className={chipClassName + (value === selected ? ' selected' : '')}
            onKeyDown={(event) => move(event, index)}
            onClick={() => onSelect(value)}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  )
}
