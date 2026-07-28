import { Icon } from '../icons'

export type StoryboardContinuityRole = 'previous' | 'next'

export interface StoryboardContinuityAsset {
  creationId: string
  name: string
  url: string
}

interface StoryboardContinuityAdvancedProps {
  open: boolean
  previous: StoryboardContinuityAsset | null
  next: StoryboardContinuityAsset | null
  disabled?: boolean
  disabledHint?: string
  canAttachPrevious?: boolean
  canAttachNext?: boolean
  previousAttachHint?: string
  nextAttachHint?: string
  referenceCount: number
  referenceLimit: number
  onToggle: () => void
  onChoose: (role: StoryboardContinuityRole) => void
  onRemove: (role: StoryboardContinuityRole) => void
  onPreview: (url: string) => void
}

const ROLE_COPY: Record<StoryboardContinuityRole, {
  eyebrow: string
  title: string
  description: string
  direction: string
}> = {
  previous: {
    eyebrow: 'INCOMING CONTINUITY',
    title: 'Previous storyboard',
    description: 'Continue from its final visual state without repeating its events.',
    direction: '← BEFORE',
  },
  next: {
    eyebrow: 'OUTGOING CONTINUITY',
    title: 'Next storyboard',
    description: 'Guide this ending toward its opening without revealing future events.',
    direction: 'AFTER →',
  },
}

function ContinuitySlot({
  role,
  asset,
  disabled,
  canAttach,
  attachHint,
  onChoose,
  onRemove,
  onPreview,
}: {
  role: StoryboardContinuityRole
  asset: StoryboardContinuityAsset | null
  disabled: boolean
  canAttach: boolean
  attachHint?: string
  onChoose: (role: StoryboardContinuityRole) => void
  onRemove: (role: StoryboardContinuityRole) => void
  onPreview: (url: string) => void
}) {
  const copy = ROLE_COPY[role]
  const chooseDisabled = disabled || (!asset && !canAttach)
  return (
    <article className={`ef-story-continuity-slot${asset ? ' has-asset' : ''}`} aria-label={copy.title}>
      <div className="ef-story-continuity-slot-head">
        <span className="ef-story-continuity-direction">{copy.direction}</span>
        <span className="ef-story-continuity-state">{asset ? 'ATTACHED' : 'OPTIONAL'}</span>
      </div>

      {asset ? (
        <button
          type="button"
          className="ef-story-continuity-preview"
          onClick={() => onPreview(asset.url)}
          aria-label={`Preview ${copy.title.toLocaleLowerCase()}: ${asset.name}`}
          title="View storyboard at full size"
        >
          <img src={asset.url} alt="" />
          <span><Icon glyph="img" size={13} /> View full board</span>
        </button>
      ) : (
        <div className="ef-story-continuity-placeholder" aria-hidden="true">
          <span><Icon glyph="board" size={20} /></span>
          <b>No board attached</b>
        </div>
      )}

      <div className="ef-story-continuity-copy">
        <small>{copy.eyebrow}</small>
        <strong>{copy.title}</strong>
        <p>{copy.description}</p>
        {asset && <span title={asset.name}>{asset.name}</span>}
        {!asset && !canAttach && attachHint && <em>{attachHint}</em>}
      </div>

      <div className="ef-story-continuity-actions">
        <button
          type="button"
          disabled={chooseDisabled}
          title={!asset && !canAttach ? attachHint : undefined}
          onClick={() => onChoose(role)}
        >
          <Icon glyph={asset ? 'edit' : 'up'} size={12} /> {asset ? 'Replace' : 'Attach'}
        </button>
        {asset && (
          <button
            type="button"
            className="is-remove"
            disabled={disabled}
            onClick={() => onRemove(role)}
            aria-label={`Remove ${copy.title.toLocaleLowerCase()}`}
          >
            Remove
          </button>
        )}
      </div>
    </article>
  )
}

export function StoryboardContinuityAdvanced({
  open,
  previous,
  next,
  disabled = false,
  disabledHint,
  canAttachPrevious = true,
  canAttachNext = true,
  previousAttachHint,
  nextAttachHint,
  referenceCount,
  referenceLimit,
  onToggle,
  onChoose,
  onRemove,
  onPreview,
}: StoryboardContinuityAdvancedProps) {
  const attachedCount = Number(Boolean(previous)) + Number(Boolean(next))
  return (
    <div className="ef-story-continuity-advanced">
      <button
        id="storyboard-continuity-toggle"
        type="button"
        className="ef-story-settings-toggle ef-story-continuity-toggle"
        aria-expanded={open}
        aria-controls="storyboard-continuity-region"
        onClick={onToggle}
      >
        <span>
          <strong>Advanced</strong>
          <small>{attachedCount
            ? `Adjacent storyboards · ${previous ? 'Previous attached' : 'No previous'} · ${next ? 'Next attached' : 'No next'}`
            : 'Add a previous or next storyboard for stronger visual continuity'}</small>
        </span>
        <span className={`ef-story-continuity-count${attachedCount ? ' has-items' : ''}`}>{attachedCount}/2</span>
        <b aria-hidden="true">⌄</b>
      </button>

      <section
        id="storyboard-continuity-region"
        className="ef-story-continuity-region"
        role="region"
        aria-labelledby="storyboard-continuity-toggle"
        hidden={!open}
      >
        <header>
          <div>
            <span>ADJACENT STORYBOARDS</span>
            <h3>Keep this board connected to the story around it.</h3>
            <p>These boards guide identity, world and boundary states only. They are never copied into the current result.</p>
          </div>
          <strong>{referenceCount} / {referenceLimit} model references</strong>
        </header>
        {disabled && disabledHint && <p className="ef-story-continuity-lock" role="status">{disabledHint}</p>}
        <div className="ef-story-continuity-grid">
          <ContinuitySlot
            role="previous"
            asset={previous}
            disabled={disabled}
            canAttach={canAttachPrevious}
            attachHint={previousAttachHint}
            onChoose={onChoose}
            onRemove={onRemove}
            onPreview={onPreview}
          />
          <ContinuitySlot
            role="next"
            asset={next}
            disabled={disabled}
            canAttach={canAttachNext}
            attachHint={nextAttachHint}
            onChoose={onChoose}
            onRemove={onRemove}
            onPreview={onPreview}
          />
        </div>
      </section>
    </div>
  )
}
