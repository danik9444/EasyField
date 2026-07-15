import { PromptCard } from './PromptCard'
import { DurationSlider } from './DurationSlider'
import type { EnhanceReference } from '../services/chat'
import {
  appendMultiShotScene,
  buildMultiShotEnhancementContext,
  moveMultiShotScene,
  removeMultiShotScene,
  totalMultiShotDuration,
  updateMultiShotSceneDuration,
  weightedMultiShotPromptLength,
  type MultiShotRules,
  type MultiShotScene,
} from '../data/videoMultiShot'

export type Shot = MultiShotScene

interface StoryboardEditorProps {
  continuityDirection: string
  shots: Shot[]
  rules: MultiShotRules
  onChange: (shots: Shot[]) => void
  makeId: () => string
  targetModel: string
  aspect: string
  resolution: string
  sound: boolean
  references: EnhanceReference[]
  referenceManifest: string[]
  referenceOptions: Array<{
    elementId?: string
    tag: string
    label: string
    description?: string
    mediaKind?: 'images' | 'video' | 'missing'
  }>
  onAddElement?: (shotId: string) => void
  onEditElement?: (shotId: string, elementId: string) => void
  onDeleteElement?: (elementId: string) => void
  elementLimitReached?: boolean
  contextVersion: string
  enhancerKey: string
  onSpend?: (credits: number) => void
}

const CONTEXT_INSTRUCTION = 'Treat this complete sequence, every ordered sibling shot, its timing and all source material as read-only context. Rewrite only the current field. Preserve subject identity, world, chronology, camera logic and visual continuity; never merge, reorder or silently rewrite other shots.'

export function StoryboardEditor({
  continuityDirection,
  shots,
  rules,
  onChange,
  makeId,
  targetModel,
  aspect,
  resolution,
  sound,
  references,
  referenceManifest,
  referenceOptions,
  onAddElement,
  onEditElement,
  onDeleteElement,
  elementLimitReached = false,
  contextVersion,
  enhancerKey,
  onSpend,
}: StoryboardEditorProps) {
  const total = totalMultiShotDuration(shots)
  const contextInput = { model: targetModel, brief: continuityDirection, scenes: shots, aspect, resolution, referenceManifest, sound }
  const durationOptions = Array.from({ length: rules.shotMax - rules.shotMin + 1 }, (_, index) => String(index + rules.shotMin))

  const update = (id: string, patch: Partial<Shot>) =>
    onChange(shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot))

  const selectedTags = (shot: Shot): string[] => {
    const available = referenceOptions.map((option) => option.tag)
    return shot.referenceTags === undefined
      ? available
      : shot.referenceTags.filter((tag) => available.includes(tag))
  }
  const toggleReference = (shot: Shot, tag: string) => {
    const selected = selectedTags(shot)
    update(shot.id, {
      referenceTags: selected.includes(tag)
        ? selected.filter((value) => value !== tag)
        : [...selected, tag],
    })
  }

  let elapsed = 0
  return (
    <section className="ef-multishot-workspace" aria-label="Multi-shot sequence editor">
      <header className="ef-multishot-heading">
        <div>
          <span>MULTI-SHOT DIRECTION</span>
          <h2>Direct one connected sequence.</h2>
          <p>Every ordered shot and all attached material stay in context together.</p>
        </div>
        <div className="ef-multishot-summary" aria-label={`${shots.length} shots, ${total} seconds`}>
          <span className="ef-multishot-stat"><strong>{String(shots.length).padStart(2, '0')}</strong><small>shots</small></span>
          <i aria-hidden="true" />
          <span className="ef-multishot-stat"><strong>{total}s</strong><small>total</small></span>
        </div>
      </header>

      <div className="ef-multishot-context-note" role="note">
        <span aria-hidden="true">◎</span>
        <p><strong>Shared context is active.</strong> Every shot, image and sampled video frame guides AI improvement; EasyField maintains continuity across the generated sequence.</p>
      </div>

      <div className="ef-multishot-plan">
        <div className="ef-multishot-scenes">
          {shots.map((shot, index) => {
            const start = elapsed
            const end = start + (Number(shot.duration) || 0)
            elapsed = end
            const shotContext = buildMultiShotEnhancementContext(contextInput, shot.id)
            const tags = selectedTags(shot)
            const providerScaffold = index === 0
              ? `Sequence brief: ${continuityDirection.trim()}\nShot 1/${shots.length}: `
              : `Continue the same sequence with consistent subjects, world and visual continuity. Shot ${index + 1}/${shots.length}: `
            const providerBudget = Math.max(1, rules.promptMax - weightedMultiShotPromptLength([providerScaffold, ...tags].join(' ')))
            return (
              <article className="ef-multishot-scene" key={shot.id} aria-label={`Shot ${index + 1}`}>
                <header className="ef-multishot-scene-head">
                  <span className="ef-multishot-scene-number">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <small>SHOT {String(index + 1).padStart(2, '0')}</small>
                    <strong>{start}s – {end}s · {shot.duration}s</strong>
                  </div>
                  <div className="ef-multishot-scene-order" aria-label={`Reorder shot ${index + 1}`}>
                    <button type="button" disabled={index === 0} onClick={() => onChange(moveMultiShotScene(shots, shot.id, -1))} aria-label={`Move shot ${index + 1} up`}>↑</button>
                    <button type="button" disabled={index === shots.length - 1} onClick={() => onChange(moveMultiShotScene(shots, shot.id, 1))} aria-label={`Move shot ${index + 1} down`}>↓</button>
                    <button type="button" className="is-remove" disabled={shots.length <= rules.minShots} onClick={() => onChange(removeMultiShotScene(shots, shot.id, rules, makeId))} aria-label={`Remove shot ${index + 1}`}>×</button>
                  </div>
                </header>

                <div className="ef-multishot-scene-body">
                  <div className="ef-multishot-scene-prompt">
                    <label>WHAT HAPPENS IN THIS SHOT?</label>
                    <PromptCard
                      prompt={shot.prompt}
                      onPromptChange={(prompt) => update(shot.id, { prompt })}
                      maxLength={providerBudget}
                      enhancerKey={enhancerKey}
                      targetModel={targetModel}
                      mediaKind="video"
                      purpose="multi-shot-scene"
                      ariaLabel={`Prompt for shot ${index + 1}`}
                      placeholder="Framing, subject, action, camera movement and the visual beat for this shot…"
                      references={references}
                      supportingContext={{
                        label: 'complete multi-shot sequence context',
                        text: shotContext,
                        instruction: CONTEXT_INSTRUCTION,
                      }}
                      contextKey={`shot|${shot.id}|${contextVersion}|${shotContext}`}
                      onSpend={onSpend}
                    />
                    <small className={shot.prompt.length > providerBudget ? 'ef-multishot-budget is-over' : 'ef-multishot-budget'}>
                      {providerBudget} characters available after shared direction and selected references
                    </small>
                  </div>

                  <div className="ef-multishot-scene-controls">
                    {(referenceOptions.length > 0 || onAddElement) && (
                      <div className="ef-multishot-reference-use ef-kling-shot-elements">
                        <div className="ef-kling-shot-elements-head">
                          <span>ELEMENTS IN THIS SHOT</span>
                          {onAddElement && (
                            <button
                              type="button"
                              className="ef-kling-shot-element-add"
                              disabled={elementLimitReached}
                              onClick={() => onAddElement(shot.id)}
                              title={elementLimitReached ? 'Kling supports up to 3 shared elements' : 'Define a new shared element'}
                            >
                              ＋ New element
                            </button>
                          )}
                        </div>
                        {referenceOptions.length > 0 ? (
                          <div className="ef-kling-shot-element-list">
                            {referenceOptions.map((option) => (
                              <div className={'ef-kling-shot-element' + (tags.includes(option.tag) ? ' is-selected' : '')} key={option.tag}>
                                <button
                                  type="button"
                                  className="ef-kling-shot-element-toggle"
                                  aria-pressed={tags.includes(option.tag)}
                                  onClick={() => toggleReference(shot, option.tag)}
                                  title={`${option.tag}${option.description ? ` · ${option.description}` : ''}`}
                                >
                                  <span aria-hidden="true">{tags.includes(option.tag) ? '●' : '○'}</span>
                                  <strong>{option.label}</strong>
                                  <small>{option.mediaKind === 'video' ? 'VIDEO' : option.mediaKind === 'images' ? 'IMAGES' : 'MEDIA'}</small>
                                </button>
                                {option.elementId && onEditElement && (
                                  <button type="button" className="ef-kling-shot-element-action" onClick={() => onEditElement(shot.id, option.elementId!)} aria-label={`Edit ${option.label}`}>Edit</button>
                                )}
                                {option.elementId && onDeleteElement && (
                                  <button type="button" className="ef-kling-shot-element-action is-remove" onClick={() => onDeleteElement(option.elementId!)} aria-label={`Delete ${option.label}`}>×</button>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="ef-kling-shot-elements-empty">Define a character or recurring subject, then choose which shots invoke it.</p>
                        )}
                      </div>
                    )}
                    <DurationSlider
                      className="ef-shot-duration"
                      options={durationOptions}
                      value={shot.duration}
                      onChange={(value) => onChange(updateMultiShotSceneDuration(shots, shot.id, value, rules, makeId))}
                      label="SHOT DURATION"
                      compact
                    />
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        <div className="ef-multishot-plan-summary">
          <div className="ef-multishot-section-head ef-multishot-plan-head">
            <span>01 · ORDERED SHOT PLAN</span>
            <small>{shots.length} / {rules.maxShots} shots · {rules.totalMin}–{rules.totalMax}s</small>
          </div>

          <div className="ef-multishot-pacing" aria-label="Sequence pacing">
            <div className="ef-story-pacing-track" aria-hidden="true">
              {shots.map((shot, index) => (
                <div
                  key={shot.id}
                  className="ef-story-pacing-segment"
                  style={{ '--ef-story-segment-weight': Math.max(1, Number(shot.duration) || 1) } as React.CSSProperties}
                >
                  <span>{String(index + 1).padStart(2, '0')} · {shot.duration}s</span>
                </div>
              ))}
            </div>
            <div className="ef-story-pacing-scale"><span>0s</span><strong>One continuous sequence</strong><span>{total}s</span></div>
          </div>
        </div>

        {shots.length < rules.maxShots && (
          <button type="button" className="ef-multishot-add" onClick={() => onChange(appendMultiShotScene(shots, rules, makeId))}>
            <span>＋</span>
            <strong>Add another shot</strong>
            <small>The new shot joins the same story and reference context</small>
          </button>
        )}
      </div>
    </section>
  )
}
