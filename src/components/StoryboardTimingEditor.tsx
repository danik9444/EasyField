import { useMemo, type CSSProperties, type KeyboardEvent } from 'react'
import {
  STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
  STORYBOARD_MIN_TOTAL_DURATION_SECONDS,
  formatStoryboardDuration,
  formatStoryboardTimecode,
  storyboardSceneTimings,
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
  onEvenSplit: () => void
}

function parseDuration(value: string): number {
  const parsed = Number(value.replace(/s$/i, ''))
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function totalDurationOptions(sceneCount: number, selected: number): string[] {
  const minimum = Math.max(STORYBOARD_MIN_TOTAL_DURATION_SECONDS, sceneCount)
  const values = new Set<number>([minimum, selected])
  for (
    let seconds = STORYBOARD_MIN_TOTAL_DURATION_SECONDS;
    seconds <= STORYBOARD_MAX_TOTAL_DURATION_SECONDS;
    seconds += 5
  ) values.add(seconds)
  return [...values]
    .filter((seconds) => seconds >= minimum && seconds <= STORYBOARD_MAX_TOTAL_DURATION_SECONDS)
    .sort((left, right) => left - right)
    .map((seconds) => `${seconds}s`)
}

export function StoryboardTimingEditor({
  timingMode,
  totalDurationSeconds,
  scenes,
  disabled = false,
  onTimingModeChange,
  onTotalDurationChange,
  onEvenSplit,
}: StoryboardTimingEditorProps) {
  const options = useMemo(
    () => totalDurationOptions(scenes.length, totalDurationSeconds),
    [scenes.length, totalDurationSeconds],
  )
  const timings = storyboardSceneTimings(scenes)
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
          <p>Leave it out, let EasyField pace the story, or set every scene exactly.</p>
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
                options={options}
                value={`${totalDurationSeconds}s`}
                onChange={(value) => onTotalDurationChange(parseDuration(value))}
                label="TOTAL STORY DURATION"
                ariaLabel="Total storyboard duration"
                className="ef-story-total-duration"
                disabled={disabled}
                formatValue={(value) => formatStoryboardDuration(parseDuration(value))}
                formatAriaValue={(value) => `${parseDuration(value)} seconds total storyboard duration`}
              />
              <button
                type="button"
                className="ef-story-even-split"
                onClick={onEvenSplit}
                disabled={disabled || scenes.length <= 1}
              >
                Even split
              </button>
            </div>
          ) : (
            <div className="ef-story-auto-timing" role="status">
              <div>
                <span>AUTO PACE</span>
                <strong>{formatStoryboardDuration(totalDurationSeconds)}</strong>
              </div>
              <p>Updates from the story and scene detail. Full Storyboard lets the AI refine the final pacing.</p>
            </div>
          )}

          <div
            className="ef-story-pacing-track"
            role="list"
            aria-label={`${formatStoryboardDuration(totalDurationSeconds)} divided across ${scenes.length} scene${scenes.length === 1 ? '' : 's'}`}
          >
            {timings.map((timing, index) => {
              const style = {
                '--ef-story-segment-weight': timing.durationSeconds,
                '--ef-story-segment-index': index,
              } as CSSProperties
              return (
                <div
                  key={timing.sceneId}
                  className="ef-story-pacing-segment"
                  role="listitem"
                  style={style}
                  title={`Scene ${index + 1} · ${formatStoryboardTimecode(timing.startSeconds)}–${formatStoryboardTimecode(timing.endSeconds)} · ${formatStoryboardDuration(timing.durationSeconds)}`}
                  aria-label={`Scene ${index + 1}, ${formatStoryboardDuration(timing.durationSeconds)}, from ${formatStoryboardTimecode(timing.startSeconds)} to ${formatStoryboardTimecode(timing.endSeconds)}`}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                </div>
              )
            })}
          </div>
          <div className="ef-story-pacing-scale" aria-hidden="true">
            <span>{formatStoryboardTimecode(0)}</span>
            <strong>{scenes.length} scene{scenes.length === 1 ? '' : 's'} · {formatStoryboardDuration(totalDurationSeconds)}</strong>
            <span>{formatStoryboardTimecode(totalDurationSeconds)}</span>
          </div>
        </>
      )}
    </section>
  )
}
