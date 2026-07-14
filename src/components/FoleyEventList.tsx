import { Icon } from '../icons'
import { formatFoleyTime, type FoleyEventState } from '../data/soundEffects'

interface FoleyEventListProps {
  summary: string
  events: FoleyEventState[]
  disabled?: boolean
  onToggle: (id: string) => void
  onPromptChange: (id: string, prompt: string) => void
  onGenerate: (id: string) => void
  onPlace: (id: string) => void
  onAnalyzeAgain: () => void
}

export function FoleyEventList({
  summary,
  events,
  disabled = false,
  onToggle,
  onPromptChange,
  onGenerate,
  onPlace,
  onAnalyzeAgain,
}: FoleyEventListProps) {
  const approved = events.filter((event) => event.approved).length
  const completed = events.filter((event) => event.urls.length > 0).length
  return (
    <section className="ef-foley-plan" aria-labelledby="ef-foley-plan-title">
      <header className="ef-foley-plan-head">
        <span>
          <small>REVIEW BEFORE GENERATION</small>
          <strong id="ef-foley-plan-title">Timed Foley events</strong>
        </span>
        <span className="ef-foley-plan-count">{approved} approved · {completed} generated</span>
        <button type="button" className="ef-ghost-btn" disabled={disabled} onClick={onAnalyzeAgain}>Analyze again</button>
      </header>
      <p className="ef-foley-summary">{summary}</p>
      {events.length === 0 ? (
        <div className="ef-foley-empty" role="status">
          <strong>No clear Foley events were found</strong>
          <span>Try Guided prompt with more specific direction, or choose another clip.</span>
        </div>
      ) : (
        <div className="ef-foley-events">
          {events.map((event, index) => (
            <article className={`ef-foley-event is-${event.status}${event.approved ? ' is-approved' : ''}`} key={event.id}>
              <div className="ef-foley-event-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
              <div className="ef-foley-event-main">
                <header>
                  <label className="ef-foley-approve">
                    <input type="checkbox" checked={event.approved} disabled={disabled} onChange={() => onToggle(event.id)} />
                    <span>
                      <strong>{event.title}</strong>
                      <small>{formatFoleyTime(event.startSeconds)}–{formatFoleyTime(event.endSeconds)}</small>
                    </span>
                  </label>
                  <span className={`ef-foley-confidence is-${event.confidence}`}>{event.confidence} confidence</span>
                </header>
                <p>{event.reason}</p>
                <label className="ef-foley-prompt-label">
                  <span>SOUND PROMPT</span>
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={event.prompt}
                    disabled={disabled}
                    aria-label={`Sound prompt for ${event.title}`}
                    onChange={(change) => onPromptChange(event.id, change.target.value)}
                  />
                  <small>{event.prompt.length} / 500</small>
                </label>
                {event.error && <span className="ef-foley-event-error" role="alert">{event.error}</span>}
                {event.urls.map((url, urlIndex) => (
                  <audio key={`${event.id}-${urlIndex}`} controls src={url} aria-label={`Preview ${event.title} result ${urlIndex + 1}`} />
                ))}
              </div>
              <div className="ef-foley-event-actions">
                <button
                  type="button"
                  className="ef-ghost-btn"
                  disabled={disabled || !event.approved || !event.prompt.trim()}
                  onClick={() => onGenerate(event.id)}
                >
                  <Icon glyph="spark" size={11} /> {event.status === 'generating' ? 'Generating…' : event.urls.length ? 'Regenerate' : 'Generate'}
                </button>
                {event.urls.length > 0 && (
                  <button type="button" className="ef-send-btn" disabled={disabled} onClick={() => onPlace(event.id)}>Place at event</button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
