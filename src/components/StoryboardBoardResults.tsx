import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { StoryboardOutputStrategy } from '../data/storyboard'
import { Icon } from '../icons'

export type StoryboardBoardResultsState = 'idle' | 'loading' | 'pending' | 'error'

export interface StoryboardBoardCandidateView {
  id: string
  url: string | null
  strategy: StoryboardOutputStrategy
  approved: boolean
  stale: boolean
  model?: string
}

export type StoryboardBoardResultView = StoryboardBoardCandidateView

export interface StoryboardBoardResultsProps {
  candidates: readonly StoryboardBoardCandidateView[]
  selectedCandidateId?: string | null
  state?: StoryboardBoardResultsState
  requestedVersions?: number
  currentRunCandidateIds?: readonly string[]
  statusNote?: string
  error?: string
  disabled?: boolean
  title?: string
  onSelectCandidate: (candidateId: string) => void
  onUseCandidate: (candidateId: string) => void
  onPreview?: (url: string, candidateId: string) => void
  onCancel?: () => void
  onOpenLibrary: () => void
  onDownloadCandidate: (candidateId: string) => void
}

const MAX_VISIBLE_CANDIDATES = 4

function strategyLabel(strategy: StoryboardOutputStrategy): string {
  return strategy === 'scene-composite' ? 'Exact composite' : 'Single generation'
}

function visibleBoardCandidates(
  candidates: readonly StoryboardBoardResultView[],
  activeCandidateId?: string,
  approvedCandidateId?: string,
): StoryboardBoardResultView[] {
  if (candidates.length <= MAX_VISIBLE_CANDIDATES) return [...candidates]

  const required = new Set([activeCandidateId, approvedCandidateId].filter(Boolean))
  const optionalSlots = Math.max(0, MAX_VISIBLE_CANDIDATES - required.size)
  const optionalIds = new Set(
    candidates
      .filter((candidate) => !required.has(candidate.id))
      .slice(-optionalSlots)
      .map((candidate) => candidate.id),
  )
  return candidates.filter((candidate) => required.has(candidate.id) || optionalIds.has(candidate.id))
}

export function StoryboardBoardResults({
  candidates,
  selectedCandidateId,
  state = 'idle',
  requestedVersions = 1,
  currentRunCandidateIds,
  statusNote,
  error,
  disabled = false,
  title = 'Choose the final board.',
  onSelectCandidate,
  onUseCandidate,
  onPreview,
  onCancel,
  onOpenLibrary,
  onDownloadCandidate,
}: StoryboardBoardResultsProps) {
  const titleId = useId()
  const statusId = useId()
  const thumbnailRefs = useRef<Array<HTMLButtonElement | null>>([])
  const approvedCandidate = candidates.find((candidate) => candidate.approved)
  const activeCandidate = candidates.find((candidate) => candidate.id === selectedCandidateId)
    ?? approvedCandidate
    ?? candidates.at(-1)
  const visibleCandidates = visibleBoardCandidates(candidates, activeCandidate?.id, approvedCandidate?.id)
  const busy = state === 'loading' || state === 'pending'
  const currentCandidates = candidates.filter((candidate) => !candidate.stale)
  const currentRunIds = new Set(currentRunCandidateIds ?? [])
  const countedCandidates = busy && currentRunCandidateIds
    ? currentCandidates.filter((candidate) => currentRunIds.has(candidate.id))
    : currentCandidates
  const readyCount = Math.min(MAX_VISIBLE_CANDIDATES, countedCandidates.filter((candidate) => Boolean(candidate.url)).length)
  const normalizedRequestedVersions = Number.isFinite(requestedVersions)
    ? Math.min(MAX_VISIBLE_CANDIDATES, Math.max(1, Math.round(requestedVersions)))
    : 1
  const totalCount = Math.max(normalizedRequestedVersions, Math.min(MAX_VISIBLE_CANDIDATES, currentCandidates.length))
  const stateCopy = state === 'pending'
    ? 'Finishing in Activity'
    : state === 'loading'
      ? requestedVersions > 1 ? `Creating ${requestedVersions} board versions` : 'Creating complete board'
      : state === 'error'
        ? 'Board generation needs attention'
        : activeCandidate
          ? `${readyCount} board version${readyCount === 1 ? '' : 's'} ready`
          : 'No complete board yet'

  const moveThumbnailFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!visibleCandidates.length) return
    const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    if (!previous && !next && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? visibleCandidates.length - 1
        : (index + (previous ? -1 : 1) + visibleCandidates.length) % visibleCandidates.length
    const candidate = visibleCandidates[nextIndex]
    onSelectCandidate(candidate.id)
    thumbnailRefs.current[nextIndex]?.focus()
  }

  return (
    <section
      className={`ef-story-board-results${activeCandidate?.approved ? ' has-approved' : ''}${state === 'error' ? ' has-error' : ''}`}
      aria-labelledby={titleId}
      aria-busy={busy}
      aria-describedby={statusId}
    >
      <header className="ef-story-board-results-head">
        <div>
          <span>COMPLETE BOARD</span>
          <h2 id={titleId}>{title}</h2>
          <p>Review every version at full size. You can change the selected board until you approve it.</p>
        </div>
        <strong aria-label={`${readyCount} of ${totalCount} requested board versions ready`}>
          {readyCount}/{totalCount}
        </strong>
      </header>

      <div className="ef-story-board-results-layout">
        <div className="ef-story-board-result-main">
          {activeCandidate?.url ? (
            <button
              type="button"
              className="ef-story-board-result-preview"
              onClick={() => onPreview?.(activeCandidate.url!, activeCandidate.id)}
              disabled={!onPreview}
              aria-label={`Enlarge selected complete storyboard. ${strategyLabel(activeCandidate.strategy)}${activeCandidate.approved ? ', approved' : ''}.`}
            >
              <img src={activeCandidate.url} alt="Selected complete storyboard" />
              <span className="ef-story-board-result-zoom" aria-hidden="true">⤢ Enlarge</span>
              <span className="ef-story-board-result-kind">
                <Icon glyph="board" size={12} />
                {strategyLabel(activeCandidate.strategy)}
                {activeCandidate.model && <em>{activeCandidate.model}</em>}
              </span>
              {activeCandidate.approved && <b>APPROVED BOARD</b>}
              {activeCandidate.stale && <b className="is-outdated">OUTDATED · INPUTS CHANGED</b>}
            </button>
          ) : (
            <div className={`ef-story-board-result-placeholder${busy ? ' is-busy' : ''}`} role="status">
              <span><Icon glyph={state === 'error' ? 'board' : 'spark'} size={20} /></span>
              <strong>{stateCopy}</strong>
              <small>{state === 'pending'
                ? 'Finished versions appear here as Activity restores them.'
                : state === 'loading'
                  ? 'Every completed version is saved to Library immediately.'
                  : state === 'error'
                    ? 'Completed versions are still safe in Library.'
                    : 'Generate a complete storyboard to review it here.'}</small>
            </div>
          )}

          <div id={statusId} className={`ef-story-board-result-status is-${state}`} role={state === 'error' ? 'alert' : 'status'} aria-live="polite">
            <i aria-hidden="true" />
            <span>{error || statusNote || stateCopy}</span>
          </div>
        </div>

        {visibleCandidates.length > 0 && (
          <div className="ef-story-board-result-versions">
            <span>BOARD VERSIONS</span>
            <div role="radiogroup" aria-label="Complete storyboard versions">
              {visibleCandidates.map((candidate, index) => {
                const selected = candidate.id === activeCandidate?.id
                return (
                  <button
                    key={candidate.id}
                    ref={(element) => { thumbnailRefs.current[index] = element }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`Board version ${index + 1}. ${strategyLabel(candidate.strategy)}${candidate.approved ? '. Approved board.' : ''}${candidate.stale ? '. Outdated because storyboard inputs changed.' : ''}${candidate.url ? '' : ' Restoring from Library.'}`}
                    tabIndex={selected || (!activeCandidate && index === 0) ? 0 : -1}
                    className={`${selected ? 'is-selected' : ''}${candidate.approved ? ' is-approved' : ''}${candidate.stale ? ' is-stale' : ''}${candidate.url ? '' : ' is-restoring'}`}
                    disabled={disabled}
                    onKeyDown={(event) => moveThumbnailFocus(event, index)}
                    onClick={() => onSelectCandidate(candidate.id)}
                  >
                    {candidate.url
                      ? <img src={candidate.url} alt="" />
                      : <span><Icon glyph="img" size={16} /></span>}
                    <small>{String(index + 1).padStart(2, '0')}</small>
                    {candidate.approved && <b aria-hidden="true">✓</b>}
                    {candidate.stale && <em aria-hidden="true">OLD</em>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <footer className="ef-story-board-result-actions">
        {busy && onCancel && (
          <button type="button" className="is-cancel" onClick={onCancel}>
            × Cancel generation
          </button>
        )}
        <button type="button" className="is-secondary" onClick={onOpenLibrary}>
          <Icon glyph="img" size={13} />
          Open Library
        </button>
        <button
          type="button"
          className="is-secondary"
          onClick={() => activeCandidate && onDownloadCandidate(activeCandidate.id)}
          disabled={disabled || !activeCandidate?.url}
        >
          <span aria-hidden="true">↓</span>
          Download
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => activeCandidate && onUseCandidate(activeCandidate.id)}
          disabled={disabled || busy || !activeCandidate?.url || activeCandidate.approved || activeCandidate.stale}
        >
          <Icon glyph={activeCandidate?.approved ? 'board' : 'spark'} size={13} />
          {activeCandidate?.approved ? 'Board selected' : activeCandidate?.stale ? 'Inputs changed' : 'Use this board'}
        </button>
      </footer>
    </section>
  )
}
