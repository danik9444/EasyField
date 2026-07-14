import { useId, type CSSProperties } from 'react'
import {
  durationOptionAt,
  durationOptionIndex,
  formatDurationAriaValue,
  formatDurationValue,
  uniqueDurationOptions,
} from '../data/durationOptions'

interface DurationSliderProps {
  options: readonly string[]
  value: string
  onChange: (value: string) => void
  label?: string
  ariaLabel?: string
  compact?: boolean
  className?: string
  disabled?: boolean
  formatValue?: (value: string) => string
  formatAriaValue?: (value: string) => string
}

export function DurationSlider({
  options,
  value,
  onChange,
  label = 'DURATION',
  ariaLabel,
  compact = false,
  className = '',
  disabled = false,
  formatValue = formatDurationValue,
  formatAriaValue = formatDurationAriaValue,
}: DurationSliderProps) {
  const generatedId = useId()
  const values = uniqueDurationOptions(options)
  if (values.length === 0) return null

  const selectedIndex = durationOptionIndex(values, value)
  const maxIndex = Math.max(0, values.length - 1)
  const progress = maxIndex === 0 ? 50 : (selectedIndex / maxIndex) * 100
  const selectedValue = values[selectedIndex]
  const inputId = `ef-duration-${generatedId.replace(/:/g, '')}`
  const style = { '--ef-duration-progress': `${progress}%` } as CSSProperties
  const classes = [
    'ef-field',
    'ef-duration-slider',
    compact ? 'ef-duration-slider--compact' : '',
    values.length === 1 ? 'is-fixed' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={classes} data-duration-value={selectedValue}>
      <div className="ef-duration-slider-head">
        <label className="ef-field-label" htmlFor={inputId}>{label}</label>
        <output className="ef-duration-value" htmlFor={inputId}>{formatValue(selectedValue)}</output>
      </div>
      <input
        id={inputId}
        className="ef-duration-range"
        type="range"
        min={0}
        max={maxIndex}
        step={1}
        value={selectedIndex}
        disabled={disabled || values.length === 1}
        aria-label={ariaLabel ?? label}
        aria-valuetext={formatAriaValue(selectedValue)}
        style={style}
        onChange={(event) => onChange(durationOptionAt(values, Number(event.target.value)) ?? selectedValue)}
      />
      <div className="ef-duration-scale" aria-hidden="true">
        <span>{formatValue(values[0])}</span>
        {values.length > 1 && <span>{formatValue(values[values.length - 1])}</span>}
      </div>
    </div>
  )
}
