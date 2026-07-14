import { useId } from 'react'

interface MultiSelectChipsProps {
  label: string
  options: string[]
  selected: string[]
  max: number
  onChange: (values: string[]) => void
}

export function MultiSelectChips({ label, options, selected, max, onChange }: MultiSelectChipsProps) {
  const labelId = useId()
  const countId = useId()

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((item) => item !== value))
    } else if (selected.length < max) {
      onChange([...selected, value])
    }
  }

  return (
    <div className="ef-field ef-choice-field" role="group" aria-labelledby={labelId} aria-describedby={countId}>
      <div className="ef-choice-field-head">
        <span id={labelId} className="ef-field-label">{label}</span>
        <span id={countId} className="ef-choice-current">{selected.length} / {max} selected</span>
      </div>
      <div className="ef-chip-row ef-multiselect-row">
        {options.map((option) => {
          const isSelected = selected.includes(option)
          const atMax = !isSelected && selected.length >= max
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isSelected}
              aria-label={`${isSelected ? 'Remove' : 'Add'} ${option}${atMax ? `; maximum ${max} reached` : ''}`}
              className={'ef-style-chip' + (isSelected ? ' selected' : '')}
              disabled={atMax}
              onClick={() => toggle(option)}
            >
              <span aria-hidden="true">{isSelected ? '✓' : '+'}</span>{option}
            </button>
          )
        })}
      </div>
    </div>
  )
}
