import { Icon } from '../icons'
import { formatStoryboardDuration, formatStoryboardTimecode, type StoryboardTimingMode } from '../data/storyboard'

export interface StoryboardFinalSceneView {
  id: string
  title: string
  prompt: string
  explanation: string
  durationSeconds: number
  startSeconds: number
  endSeconds: number
  url: string | null
  approved: boolean
  stale: boolean
}

interface StoryboardFinalStripProps {
  scenes: StoryboardFinalSceneView[]
  timingMode: StoryboardTimingMode
  totalDurationSeconds: number
  onPreview: (url: string) => void
  onDownloadAll: () => void
  onOpenLibrary: () => void
  onExportBoard: () => void
  exporting: boolean
  canExportBoard: boolean
  exportDisabledReason?: string
}

export function StoryboardFinalStrip({
  scenes,
  timingMode,
  totalDurationSeconds,
  onPreview,
  onDownloadAll,
  onOpenLibrary,
  onExportBoard,
  exporting,
  canExportBoard,
  exportDisabledReason,
}: StoryboardFinalStripProps) {
  const approvedCount = scenes.filter((scene) => scene.approved).length
  const readyCount = scenes.filter((scene) => scene.approved && scene.url).length
  const complete = approvedCount === scenes.length && scenes.length > 0
  const exportHintId = 'ef-story-export-requirements'

  return (
    <section className={`ef-story-final${complete ? ' is-complete' : ''}`} aria-labelledby="ef-story-final-title">
      <header className="ef-story-final-head">
        <div>
          <span>FINAL STORYBOARD</span>
          <h2 id="ef-story-final-title">Your story, in order.</h2>
          <p>{complete ? 'Every scene has an approved frame. Existing frames stay untouched until you explicitly replace them.' : 'Approved frames appear here automatically. Missing scenes stay visible in their exact position.'}</p>
          {timingMode !== 'none' && (
            <small className="ef-story-final-timing">{timingMode === 'auto' ? 'AUTO · ' : ''}{formatStoryboardDuration(totalDurationSeconds)} · {scenes.length} scene{scenes.length === 1 ? '' : 's'}</small>
          )}
        </div>
        <strong>{approvedCount}/{scenes.length}</strong>
      </header>

      <div className="ef-story-board" aria-label={`${approvedCount} of ${scenes.length} storyboard scenes approved`}>
        {scenes.map((scene, index) => (
          <article className={`ef-story-board-card${scene.approved ? ' is-ready' : ''}${scene.stale ? ' is-stale' : ''}`} key={scene.id}>
            <div className="ef-story-board-frame">
              {scene.approved && scene.url ? (
                <button type="button" onClick={() => onPreview(scene.url!)} aria-label={`Enlarge storyboard scene ${index + 1}`}>
                  <img src={scene.url} alt={`Storyboard scene ${index + 1}`} />
                  <span>⤢</span>
                </button>
              ) : (
                <div aria-label={`Storyboard scene ${index + 1} has no approved frame`}>
                  <Icon glyph="board" size={16} />
                  <small>FRAME PENDING</small>
                </div>
              )}
              <b>{String(index + 1).padStart(2, '0')}</b>
            </div>
            <div className="ef-story-board-copy">
              {timingMode !== 'none' && (
                <span className="ef-story-board-timing">{formatStoryboardTimecode(scene.startSeconds)}–{formatStoryboardTimecode(scene.endSeconds)} · {formatStoryboardDuration(scene.durationSeconds)}</span>
              )}
              <strong>{scene.title.trim() || `Scene ${String(index + 1).padStart(2, '0')}`}</strong>
              <p>{scene.prompt.trim() || 'No scene description yet.'}</p>
              {scene.explanation.trim() && <em>{scene.explanation}</em>}
              {scene.stale && <small>Prompt changed · frame preserved</small>}
            </div>
          </article>
        ))}
      </div>

      <footer className="ef-story-final-actions">
        {!canExportBoard && exportDisabledReason && (
          <p id={exportHintId} className="ef-story-export-hint" role="status">{exportDisabledReason}</p>
        )}
        <button type="button" className="ef-ghost-btn" onClick={onOpenLibrary}>Open Library</button>
        <button type="button" className="ef-ghost-btn" onClick={onDownloadAll} disabled={!readyCount}>↓ Download approved frames</button>
        <button
          type="button"
          className="ef-story-export-board"
          onClick={onExportBoard}
          disabled={!canExportBoard || exporting}
          title={!canExportBoard ? exportDisabledReason : 'Create one high-resolution image with the full story, every frame and every scene explanation'}
          aria-describedby={!canExportBoard && exportDisabledReason ? exportHintId : undefined}
        >
          {exporting ? 'Building board…' : 'Export complete board'}
        </button>
      </footer>
    </section>
  )
}
