import type { KeyboardEvent } from 'react'
import {
  STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
  STORYBOARD_MIN_TOTAL_DURATION_SECONDS,
  type StoryboardScene,
  type StoryboardTimingMode,
} from '../data/storyboard'
import { DurationSlider } from './DurationSlider'

interface StoryboardTimingEditorProps {
  timingMode: StoryboardTimingMode
  totalDurationSeconds: number
  scenes: readonly StoryboardScene[]
  disabled?: boolean
  onTimingModeChange: (timingMode: StoryboardTimingMode) => void
  onTotalDurationChange: (durationSeconds: number) => void
}

function parseDuration(value: string): number {
  const parsed = Number(value.replace(/s$/i, ''))
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

const FULL_STORYBOARD_DURATION_OPTIONS = Array.from(
  { length: STORYBOARD_MAX_TOTAL_DURATION_SECONDS - STORYBOARD_MIN_TOTAL_DURATION_SECONDS + 1 },
  (_, index) => `${STORYBOARD_MIN_TOTAL_DURATION_SECONDS + index}s`,
)

export function StoryboardTimingEditor({
  timingMode,
  totalDurationSeconds,
  disabled = false,
  onTimingModeChange,
  onTotalDurationChange,
}: StoryboardTimingEditorProps) {
  const timingModes: Array<{ value: StoryboardTimingMode; label: string; note: string }> = [
    { value: 'none', label: 'No timing', note: 'Visual board only' },
    { value: 'auto', label: 'Auto', note: 'Pace from the story' },
    { value: 'manual', label: 'Manual', note: 'Set exact times' },
  ]

  const handleModeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: StoryboardTimingMode) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = timingModes.findIndex((mode) => mode.value === current)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? timingModes.length - 1
        : (currentIndex + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + timingModes.length) % timingModes.length
    const nextButton = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[nextIndex]
    onTimingModeChange(timingModes[nextIndex].value)
    nextButton?.focus()
  }

  return (
    <section className="ef-story-timing-editor" aria-labelledby="ef-story-timing-title">
      <header className="ef-story-timing-head">
        <div>
          <span>STORY TIMING</span>
          <h3 id="ef-story-timing-title">Timing is optional.</h3>
          <p>Leave it out, let EasyField pace the final board, or choose any total duration from 5 to 90 seconds.</p>
        </div>
      </header>

      <div className="ef-story-timing-modes" role="radiogroup" aria-label="Storyboard timing mode">
        {timingModes.map((mode) => (
          <button
            type="button"
            role="radio"
            key={mode.value}
            className={timingMode === mode.value ? 'is-selected' : ''}
            aria-checked={timingMode === mode.value}
            tabIndex={timingMode === mode.value ? 0 : -1}
            disabled={disabled}
            onClick={() => onTimingModeChange(mode.value)}
            onKeyDown={(event) => handleModeKeyDown(event, mode.value)}
          >
            <strong>{mode.label}</strong>
            <small>{mode.note}</small>
          </button>
        ))}
      </div>

      {timingMode === 'none' ? (
        <div className="ef-story-timing-empty" role="status">
          <strong>No duration will be shown.</strong>
          <span>The storyboard, Library item and one-image export stay completely untimed.</span>
        </div>
      ) : (
        <>
          {timingMode === 'manual' ? (
            <div className="ef-story-manual-timing">
              <DurationSlider
                options={FULL_STORYBOARD_DURATION_OPTIONS}
                value={`${totalDurationSeconds}s`}
                onChange={(value) => onTotalDurationChange(parseDuration(value))}
                label="TOTAL STORY DURATION"
                ariaLabel="Total storyboard duration"
                className="ef-story-total-duration"
                disabled={disabled}
                formatValue={(value) => `${parseDuration(value)}s`}
                formatAriaValue={(value) => `${parseDuration(value)} seconds total storyboard duration`}
              />
            </div>
          ) : (
            <div className="ef-story-auto-timing" role="status">
              <div>
                <span>AUTO PACE</span>
                <strong>5–90s</strong>
              </div>
              <p>The final storyboard chooses its natural overall pace from the Story Brief when it is generated.</p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
