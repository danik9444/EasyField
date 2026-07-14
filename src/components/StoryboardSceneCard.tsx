import { useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from './Dropdown'
import { AGENT_MODELS } from '../data/models'
import { AGENT_MODEL_META } from '../data/modelPresentation'
import { STORYBOARD_MAX_EXPLANATION_LENGTH, STORYBOARD_MAX_TITLE_LENGTH } from '../data/storyboard'
import { GenerationCancelControl } from './GenerationCancelControl'
import { DurationSlider } from './DurationSlider'
import { formatStoryboardDuration, formatStoryboardTimecode, type StoryboardTimingMode } from '../data/storyboard'
import type { JobRecord } from '../services/jobCenter'
import { promptCharacterCount } from '../data/promptLimits'

export type StoryboardSceneRunState = 'idle' | 'enhancing' | 'generating' | 'error'

export interface StoryboardCandidateView {
  id: string
  url: string | null
  model: string
  createdAt: number
  approved: boolean
}

interface StoryboardSceneCardProps {
  index: number
  total: number
  title: string
  prompt: string
  explanation: string
  timingMode: StoryboardTimingMode
  durationSeconds: number
  startSeconds: number
  endSeconds: number
  durationOptions: readonly string[]
  maxLength: number
  runState: StoryboardSceneRunState
  error?: string
  statusNote?: string
  candidates: StoryboardCandidateView[]
  activeCandidateId?: string
  approvalStale: boolean
  connected: boolean
  batchRunning: boolean
  generationJob?: JobRecord | null
  enhancerModel: string
  onEnhancerModelChange: (model: string) => void
  onTitleChange: (value: string) => void
  onPromptChange: (value: string) => void
  onExplanationChange: (value: string) => void
  onDurationChange: (durationSeconds: number) => void
  onEnhance: () => void
  onGenerate: () => void
  onExitGeneration: () => void
  onSelectCandidate: (candidateId: string) => void
  onApproveCandidate: (candidateId: string) => void
  onAddCandidateToLibrary: (candidateId: string) => void
  onDownloadCandidate: (candidateId: string) => void
  onPreview: (url: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}

export function StoryboardSceneCard({
  index,
  total,
  title,
  prompt,
  explanation,
  timingMode,
  durationSeconds,
  startSeconds,
  endSeconds,
  durationOptions,
  maxLength,
  runState,
  error,
  statusNote,
  candidates,
  activeCandidateId,
  approvalStale,
  connected,
  batchRunning,
  generationJob,
  enhancerModel,
  onEnhancerModelChange,
  onTitleChange,
  onPromptChange,
  onExplanationChange,
  onDurationChange,
  onEnhance,
  onGenerate,
  onExitGeneration,
  onSelectCandidate,
  onApproveCandidate,
  onAddCandidateToLibrary,
  onDownloadCandidate,
  onPreview,
  onMoveUp,
  onMoveDown,
  onRemove,
}: StoryboardSceneCardProps) {
  const [promptExpanded, setPromptExpanded] = useState(false)
  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId)
    ?? candidates.find((candidate) => candidate.approved)
    ?? candidates.at(-1)
  const approvedCandidate = candidates.find((candidate) => candidate.approved)
  const busy = runState === 'enhancing' || runState === 'generating'
  const sceneLabel = `Scene ${String(index + 1).padStart(2, '0')}`
  const promptLength = promptCharacterCount(prompt)
  const promptOverLimit = promptLength > maxLength
  const promptNearLimit = !promptOverLimit && promptLength > maxLength * 0.9

  return (
    <article
      className={`ef-story-scene${approvedCandidate ? ' has-approved' : ''}${approvalStale ? ' is-stale' : ''}`}
      aria-labelledby={`story-scene-title-${index}`}
      aria-busy={busy}
    >
      <header className={`ef-story-scene-head${timingMode !== 'none' ? ' has-timing' : ''}`}>
        <div className="ef-story-scene-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
        <div className="ef-story-scene-title">
          <span>SCENE</span>
          <strong id={`story-scene-title-${index}`}>{title.trim() || sceneLabel}</strong>
        </div>
        {timingMode !== 'none' && (
          <div
            className="ef-story-scene-time"
            aria-label={`${sceneLabel} runs from ${formatStoryboardTimecode(startSeconds)} to ${formatStoryboardTimecode(endSeconds)}, ${formatStoryboardDuration(durationSeconds)}`}
          >
            <span>{formatStoryboardTimecode(startSeconds)}–{formatStoryboardTimecode(endSeconds)}</span>
            <strong>{formatStoryboardDuration(durationSeconds)}</strong>
          </div>
        )}
        <div className="ef-story-scene-state" role="status" aria-live="polite">
          {runState === 'generating'
            ? <><i className="is-running" /> Generating</>
            : runState === 'enhancing'
              ? <><i className="is-running" /> Improving prompt</>
              : approvedCandidate
                ? <><i className="is-ready" /> In storyboard</>
                : <><i /> Not generated</>}
        </div>
        <div className="ef-story-scene-order" aria-label={`${sceneLabel} order controls`}>
          <button type="button" onClick={onMoveUp} disabled={index === 0 || busy || batchRunning} aria-label={`Move ${sceneLabel} earlier`}>↑</button>
          <button type="button" onClick={onMoveDown} disabled={index === total - 1 || busy || batchRunning} aria-label={`Move ${sceneLabel} later`}>↓</button>
          <button type="button" className="is-remove" onClick={onRemove} disabled={busy || batchRunning || total <= 1} aria-label={`Remove ${sceneLabel}`}>×</button>
        </div>
      </header>

      <div className="ef-story-scene-body">
        <div className="ef-story-scene-copy">
          <label htmlFor={`story-scene-name-${index}`}>SCENE TITLE</label>
          <input
            id={`story-scene-name-${index}`}
            className="ef-story-scene-name"
            value={title}
            maxLength={STORYBOARD_MAX_TITLE_LENGTH}
            placeholder={sceneLabel}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          {timingMode === 'manual' && (
            <DurationSlider
              className="ef-story-scene-duration"
              options={durationOptions}
              value={`${durationSeconds}s`}
              onChange={(value) => onDurationChange(Number(value.replace(/s$/i, '')))}
              label="SCENE DURATION"
              ariaLabel={`${sceneLabel} duration`}
              compact
              disabled={busy || batchRunning}
              formatValue={(value) => formatStoryboardDuration(Number(value.replace(/s$/i, '')))}
              formatAriaValue={(value) => `${Number(value.replace(/s$/i, ''))} seconds for ${sceneLabel}`}
            />
          )}
          <label htmlFor={`story-scene-prompt-${index}`}>WHAT HAPPENS IN THIS SCENE?</label>
          <div className="ef-prompt-card ef-story-prompt-card">
            <textarea
              id={`story-scene-prompt-${index}`}
              className={'ef-prompt-textarea' + (promptExpanded ? ' expanded' : '')}
              value={prompt}
              rows={promptExpanded ? 11 : 4}
              placeholder="Describe the subject, action, setting, camera and mood…"
              aria-busy={runState === 'enhancing'}
              aria-invalid={promptOverLimit}
              onChange={(event) => onPromptChange(event.target.value)}
            />
            <div className="ef-prompt-footer ef-story-prompt-footer">
              <button
                type="button"
                className={'ef-enhance-btn' + (runState === 'enhancing' ? ' loading' : '')}
                aria-label={!connected ? 'Connect Kie.ai to improve this scene prompt' : `Improve ${sceneLabel} using the complete story, all scene rows and references with ${enhancerModel}`}
                title={!connected ? 'Connect Kie.ai to improve prompts' : `Uses the complete story, every scene row and all attached references · ${enhancerModel}`}
                disabled={!connected || prompt.trim().length < 3 || promptOverLimit || busy || batchRunning}
                onClick={onEnhance}
              >
                <Icon glyph="spark" size={12} />
              </button>
              <Dropdown
                options={AGENT_MODELS}
                selected={enhancerModel}
                onSelect={onEnhancerModelChange}
                label="Prompt enhancer model"
                align="left"
                optionMeta={AGENT_MODEL_META}
              />
              <span className="ef-spacer" />
              {runState === 'enhancing'
                ? <span className="ef-enhance-note" role="status">✨ directing…</span>
                : statusNote
                  ? <span className="ef-enhance-note" role="status">✨ {statusNote}</span>
                  : <span className={`ef-char-count${promptOverLimit ? ' is-over-limit' : promptNearLimit ? ' is-near-limit' : ''}`} role={promptOverLimit ? 'alert' : undefined}>
                    {promptLength.toLocaleString()} / {maxLength.toLocaleString()}{promptOverLimit ? ` · shorten by ${(promptLength - maxLength).toLocaleString()}` : ''}
                  </span>}
              <button
                type="button"
                className="ef-prompt-expand"
                title={promptExpanded ? 'Collapse prompt' : 'Expand prompt'}
                aria-label={promptExpanded ? `Collapse ${sceneLabel} prompt` : `Expand ${sceneLabel} prompt`}
                aria-expanded={promptExpanded}
                onClick={() => setPromptExpanded((expanded) => !expanded)}
              >
                {promptExpanded ? '⤡' : '⤢'}
              </button>
            </div>
          </div>
          {approvalStale && <div className="ef-story-prompt-stale">Prompt changed · approved frame kept</div>}
          <label htmlFor={`story-scene-explanation-${index}`}>STORY NOTE / EXPLANATION</label>
          <textarea
            id={`story-scene-explanation-${index}`}
            className="ef-story-scene-explanation"
            value={explanation}
            maxLength={STORYBOARD_MAX_EXPLANATION_LENGTH}
            rows={2}
            placeholder="Why this scene matters in the story (optional)…"
            onChange={(event) => onExplanationChange(event.target.value)}
          />
        </div>

        <div className="ef-story-scene-preview">
          {runState === 'generating' && !activeCandidate ? (
            <div className="ef-story-frame ef-story-frame--loading" role="status">
              <span><Icon glyph="spark" size={17} /></span>
              <strong>Creating frame</strong>
              <small>The result will be saved to Library.</small>
            </div>
          ) : activeCandidate?.url ? (
            <button
              type="button"
              className="ef-story-frame ef-story-frame--image"
              onClick={() => onPreview(activeCandidate.url!)}
              aria-label={`Enlarge ${sceneLabel} generated frame`}
            >
              <img src={activeCandidate.url} alt={`${sceneLabel} generated frame`} />
              <span>⤢ Enlarge</span>
              {activeCandidate.approved && <b>IN STORYBOARD</b>}
            </button>
          ) : activeCandidate ? (
            <div className="ef-story-frame ef-story-frame--missing" role="status">
              <span><Icon glyph="img" size={17} /></span>
              <strong>Restoring from Library</strong>
              <small>The saved frame will appear when local media is ready.</small>
            </div>
          ) : (
            <div className="ef-story-frame ef-story-frame--empty">
              <span><Icon glyph="board" size={18} /></span>
              <strong>Scene frame</strong>
              <small>Generate this scene or create every missing frame below.</small>
            </div>
          )}
        </div>
      </div>

      {candidates.length > 1 && (
        <div className="ef-story-candidates" aria-label={`${sceneLabel} variations`}>
          <span>VARIATIONS</span>
          <div>
            {candidates.map((candidate, candidateIndex) => (
              <button
                type="button"
                key={candidate.id}
                className={(candidate.id === activeCandidate?.id ? 'is-active' : '') + (candidate.approved ? ' is-approved' : '')}
                onClick={() => onSelectCandidate(candidate.id)}
                aria-label={`View ${sceneLabel} variation ${candidateIndex + 1}${candidate.approved ? ', currently in storyboard' : ''}`}
                aria-pressed={candidate.id === activeCandidate?.id}
              >
                {candidate.url ? <img src={candidate.url} alt="" /> : <Icon glyph="img" size={14} />}
                <small>{candidateIndex + 1}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <footer className="ef-story-scene-actions">
        <div className="ef-story-generation-actions">
          {activeCandidate && !activeCandidate.approved && (
            <button type="button" className="ef-story-approve" onClick={() => onApproveCandidate(activeCandidate.id)} disabled={busy || batchRunning}>
              Use this frame
            </button>
          )}
          {runState === 'generating' ? (
            <GenerationCancelControl job={generationJob ?? null} onExit={onExitGeneration} noun="frame generation" />
          ) : (
            <button
              type="button"
              className="ef-story-generate-one"
              onClick={onGenerate}
              disabled={!connected || prompt.trim().length < 3 || promptOverLimit || busy || batchRunning}
            >
              {candidates.length ? 'New variation' : 'Generate frame'}
            </button>
          )}
        </div>
        {activeCandidate?.url && (
          <div className="ef-story-result-actions" aria-label={`${sceneLabel} result actions`}>
            <button
              type="button"
              className="ef-story-library-action"
              aria-label={`Add ${sceneLabel} frame to Library and open Library`}
              title="Already saved safely · open in Library"
              onClick={() => onAddCandidateToLibrary(activeCandidate.id)}
            >
              <Icon glyph="img" size={13} />
              Add to Library
            </button>
            <button
              type="button"
              className="ef-story-download-action"
              onClick={() => onDownloadCandidate(activeCandidate.id)}
            >
              ↓ Download
            </button>
          </div>
        )}
      </footer>

      {error && <div className="ef-story-scene-error" role="alert">{error}</div>}
    </article>
  )
}
