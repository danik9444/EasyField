import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../icons'
import { Dropdown } from './Dropdown'
import { AGENT_MODELS } from '../data/models'
import { AGENT_MODEL_META } from '../data/modelPresentation'
import {
  STORYBOARD_MAX_EXPLANATION_LENGTH,
  STORYBOARD_MAX_TITLE_LENGTH,
  STORYBOARD_MAX_VERSIONS,
  STORYBOARD_MIN_VERSIONS,
  formatStoryboardDuration,
  formatStoryboardTimecode,
  type StoryboardSceneDurationMode,
  type StoryboardTimingMode,
} from '../data/storyboard'
import { GenerationCancelControl } from './GenerationCancelControl'
import { DurationSlider } from './DurationSlider'
import type { JobRecord } from '../services/jobCenter'
import { promptCharacterCount } from '../data/promptLimits'

export type StoryboardSceneRunState = 'idle' | 'enhancing' | 'generating' | 'pending' | 'error'

export interface StoryboardCandidateView {
  id: string
  url: string | null
  model: string
  createdAt: number
  approved: boolean
}

interface StoryboardVersionPickerProps {
  value: number
  onChange: (value: number) => void
  label: string
  ariaLabel: string
  disabled?: boolean
  compact?: boolean
  detail?: string
}

const STORYBOARD_VERSION_OPTIONS = Array.from(
  { length: STORYBOARD_MAX_VERSIONS - STORYBOARD_MIN_VERSIONS + 1 },
  (_, index) => STORYBOARD_MIN_VERSIONS + index,
)
const STORYBOARD_SCENE_TIMING_OPTIONS = ['Auto', 'Manual']

export function StoryboardVersionPicker({
  value,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  compact = false,
  detail,
}: StoryboardVersionPickerProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const move = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    if (!previous && !next && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const targetIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? STORYBOARD_VERSION_OPTIONS.length - 1
        : (index + (previous ? -1 : 1) + STORYBOARD_VERSION_OPTIONS.length) % STORYBOARD_VERSION_OPTIONS.length
    onChange(STORYBOARD_VERSION_OPTIONS[targetIndex])
    refs.current[targetIndex]?.focus()
  }

  return (
    <div className={`ef-story-version-picker${compact ? ' is-compact' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span>{label}{detail && <small>{detail}</small>}</span>
      <div role="radiogroup" aria-label={ariaLabel}>
        {STORYBOARD_VERSION_OPTIONS.map((option, index) => (
          <button
            ref={(element) => { refs.current[index] = element }}
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            tabIndex={option === value ? 0 : -1}
            className={option === value ? 'is-selected' : ''}
            disabled={disabled}
            onKeyDown={(event) => move(event, index)}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}

interface StoryboardSceneCardProps {
  index: number
  total: number
  title: string
  prompt: string
  explanation: string
  timingMode: StoryboardTimingMode
  durationMode: StoryboardSceneDurationMode
  sceneTimingControl: boolean
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
  referenceCount: number
  referenceLimit: number
  /** Read-only continuity references that can seed prompt improvement but are not scene inputs. */
  contextReferenceCount?: number
  sceneReferencesEnabled: boolean
  sceneGenerationEnabled: boolean
  exactReferenceIsApproved: boolean
  versionCount: number
  generationVersionCount: number
  versionEstimate: string
  canEnhanceFromReferences: boolean
  onEnhancerModelChange: (model: string) => void
  onOpenReferences: () => void
  onVersionCountChange: (value: number) => void
  onTitleChange: (value: string) => void
  onPromptChange: (value: string) => void
  onExplanationChange: (value: string) => void
  onDurationChange: (durationSeconds: number) => void
  onDurationChoice: (durationMode: StoryboardSceneDurationMode, durationSeconds?: number) => void
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
  durationMode,
  sceneTimingControl,
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
  referenceCount,
  referenceLimit,
  contextReferenceCount = 0,
  sceneReferencesEnabled,
  sceneGenerationEnabled,
  exactReferenceIsApproved,
  versionCount,
  generationVersionCount,
  versionEstimate,
  canEnhanceFromReferences,
  onEnhancerModelChange,
  onOpenReferences,
  onVersionCountChange,
  onTitleChange,
  onPromptChange,
  onExplanationChange,
  onDurationChange,
  onDurationChoice,
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
  const activeCandidate = sceneGenerationEnabled
    ? candidates.find((candidate) => candidate.id === activeCandidateId)
      ?? candidates.find((candidate) => candidate.approved)
      ?? candidates.at(-1)
    : undefined
  const approvedCandidate = sceneGenerationEnabled
    ? candidates.find((candidate) => candidate.approved)
    : undefined
  const busy = runState === 'enhancing' || runState === 'generating' || runState === 'pending'
  const sceneLabel = `Scene ${String(index + 1).padStart(2, '0')}`
  const promptLength = promptCharacterCount(prompt)
  const promptOverLimit = promptLength > maxLength
  const promptNearLimit = !promptOverLimit && promptLength > maxLength * 0.9
  const canImproveFromScene = prompt.trim().length >= 3 || referenceCount + contextReferenceCount > 0 || canEnhanceFromReferences
  const exactReuseReady = sceneReferencesEnabled && prompt.trim().length === 0 && referenceCount === 1
  const canResolveScene = prompt.trim().length >= 3 || exactReuseReady
  const exactReferenceAlreadyUsed = exactReuseReady && exactReferenceIsApproved
  const displayedVersionCount = exactReuseReady ? 1 : versionCount
  const generationActionLabel = exactReferenceAlreadyUsed
    ? 'Reference in storyboard'
    : exactReuseReady
      ? 'Use exact reference'
      : versionCount > 1
        ? candidates.length ? `Create ${versionCount} new versions` : `Generate ${versionCount} versions`
        : candidates.length ? 'New variation' : 'Generate frame'
  const generationActionEstimate = exactReuseReady ? 'No credits' : versionEstimate
  const showTiming = sceneTimingControl || timingMode !== 'none'

  return (
    <article
      className={`ef-story-scene${approvedCandidate ? ' has-approved' : ''}${approvalStale ? ' is-stale' : ''}`}
      aria-labelledby={`story-scene-title-${index}`}
      aria-busy={busy}
    >
      <header className={`ef-story-scene-head${showTiming ? ' has-timing' : ''}`}>
        <div className="ef-story-scene-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
        <div className="ef-story-scene-summary">
          <div className="ef-story-scene-title">
            <span>SCENE</span>
            <strong id={`story-scene-title-${index}`}>{title.trim() || sceneLabel}</strong>
          </div>
          <div className="ef-story-scene-meta">
            <div className="ef-story-scene-state" role="status" aria-live="polite">
              {runState === 'generating'
                ? <><i className="is-running" /> Generating</>
                : runState === 'pending'
                  ? <><i className="is-running" /> Finishing in Activity</>
                : runState === 'enhancing'
                  ? <><i className="is-running" /> Improving prompt</>
                  : !sceneGenerationEnabled
                    ? <><i className="is-ready" /> Included in complete board</>
                  : approvedCandidate
                    ? <><i className="is-ready" /> In storyboard</>
                    : <><i /> Not generated</>}
            </div>
            {showTiming && (sceneTimingControl ? (
              <div
                className={`ef-story-scene-time ef-story-scene-time--select${durationMode === 'auto' ? ' is-auto' : ''}`}
                title={durationMode === 'auto'
                  ? 'Auto chooses this scene duration from the complete story only when the final storyboard is created'
                  : `Manual scene duration: ${formatStoryboardDuration(durationSeconds)}`}
              >
                <span>{durationMode === 'auto'
                  ? 'DURATION'
                  : `DURATION · ${formatStoryboardDuration(durationSeconds)}`}</span>
                <Dropdown
                  options={STORYBOARD_SCENE_TIMING_OPTIONS}
                  selected={durationMode === 'auto' ? 'Auto' : 'Manual'}
                  disabled={busy || batchRunning}
                  label={`${sceneLabel} timing mode`}
                  searchable={false}
                  align="right"
                  popoverClassName="ef-scene-timing-menu"
                  onSelect={(value) => {
                    if (value === 'Auto') onDurationChoice('auto')
                    else onDurationChoice('manual', durationSeconds)
                  }}
                />
              </div>
            ) : (
              <div
                className="ef-story-scene-time"
                aria-label={`${sceneLabel} runs from ${formatStoryboardTimecode(startSeconds)} to ${formatStoryboardTimecode(endSeconds)}, ${formatStoryboardDuration(durationSeconds)}`}
              >
                <span>{formatStoryboardTimecode(startSeconds)}–{formatStoryboardTimecode(endSeconds)}</span>
                <strong>{formatStoryboardDuration(durationSeconds)}</strong>
              </div>
            ))}
          </div>
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
          {((sceneTimingControl && durationMode === 'manual') || (!sceneTimingControl && timingMode === 'manual')) && (
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
              className="ef-prompt-textarea"
              value={prompt}
              rows={4}
              placeholder="Describe the subject, action, setting, camera and mood…"
              aria-busy={runState === 'enhancing'}
              aria-invalid={promptOverLimit}
              onChange={(event) => onPromptChange(event.target.value)}
            />
            <div className="ef-prompt-footer ef-story-prompt-footer">
              <button
                type="button"
                className={'ef-enhance-btn' + (runState === 'enhancing' ? ' loading' : '')}
                aria-label={!connected ? 'Connect EasyField Cloud to improve this scene prompt' : `Improve ${sceneLabel} using the complete story, all scene rows and references with ${enhancerModel}`}
                title={!connected ? 'Connect EasyField Cloud to improve prompts' : `Uses the complete story, every scene row and all attached references · ${enhancerModel}`}
                disabled={!connected || !canImproveFromScene || promptOverLimit || busy || batchRunning}
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
              {sceneReferencesEnabled && (
                <button
                  type="button"
                  className={`ef-story-scene-reference-trigger${referenceCount ? ' has-references' : ''}`}
                  onClick={onOpenReferences}
                  disabled={busy || batchRunning || referenceLimit === 0}
                  aria-label={`Choose references for ${sceneLabel}. ${referenceCount} of ${referenceLimit} attached.`}
                  title={referenceLimit === 0 ? 'The selected image model does not accept references' : 'Choose references used only by this scene'}
                >
                  <Icon glyph="img" size={13} />
                  <span>Refs</span>
                  <b>{referenceCount}</b>
                </button>
              )}
              <span className="ef-spacer" />
              {runState === 'enhancing'
                ? <span className="ef-enhance-note" role="status">✨ directing…</span>
                : statusNote
                  ? <span className="ef-enhance-note" role="status">✨ {statusNote}</span>
                  : <span className={`ef-char-count${promptOverLimit ? ' is-over-limit' : promptNearLimit ? ' is-near-limit' : ''}`} role={promptOverLimit ? 'alert' : undefined}>
                    {promptLength.toLocaleString()} / {maxLength.toLocaleString()}{promptOverLimit ? ` · shorten by ${(promptLength - maxLength).toLocaleString()}` : ''}
                  </span>}
            </div>
          </div>
          {approvalStale && <div className="ef-story-prompt-stale">Scene inputs changed · create an updated frame</div>}
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
          {(runState === 'generating' || runState === 'pending') && !activeCandidate ? (
            <div className="ef-story-frame ef-story-frame--loading" role="status">
              <span><Icon glyph="spark" size={17} /></span>
              <strong>{generationVersionCount > 1 ? `Creating ${generationVersionCount} versions` : 'Creating frame'}</strong>
              <small>{runState === 'pending' ? 'Completed versions appear here as Activity recovers them.' : generationVersionCount > 1 ? 'Every completed version is saved to Library.' : 'The result will be saved to Library.'}</small>
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
              <strong>{sceneGenerationEnabled ? 'Scene frame' : 'Part of one complete board'}</strong>
              <small>{sceneGenerationEnabled
                ? 'Generate this scene or create every missing frame below.'
                : 'This scene is generated inside the complete storyboard image.'}</small>
            </div>
          )}
        </div>
      </div>

      {sceneGenerationEnabled && candidates.length > 1 && (
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
        {sceneGenerationEnabled ? <div className="ef-story-generation-actions">
          <StoryboardVersionPicker
            value={displayedVersionCount}
            onChange={onVersionCountChange}
            label="VERSIONS"
            ariaLabel={`${sceneLabel} generation versions`}
            disabled={busy || batchRunning || exactReuseReady}
            compact
            detail={exactReuseReady ? 'EXACT REFERENCE · 1' : undefined}
          />
          {activeCandidate && !activeCandidate.approved && (
            <button type="button" className="ef-story-approve" onClick={() => onApproveCandidate(activeCandidate.id)} disabled={busy || batchRunning}>
              Use this frame
            </button>
          )}
          {runState === 'generating' || runState === 'pending' ? (
            <GenerationCancelControl job={generationJob ?? null} onExit={onExitGeneration} noun={generationVersionCount > 1 ? 'version generation' : 'frame generation'} />
          ) : (
            <button
              type="button"
              className="ef-story-generate-one"
              onClick={onGenerate}
              disabled={exactReferenceAlreadyUsed || (!connected && !exactReuseReady) || !canResolveScene || promptOverLimit || busy || batchRunning}
            >
              <span>{generationActionLabel}</span>
              <small className="ef-story-action-estimate">{generationActionEstimate}</small>
            </button>
          )}
        </div> : (
          <div className="ef-story-board-only-note">
            <Icon glyph="board" size={13} />
            <span><strong>Single board mode</strong><small>No separate image is generated for this scene.</small></span>
          </div>
        )}
        {sceneGenerationEnabled && activeCandidate?.url && (
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
