import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CHARACTER_BASIC_GROUPS,
  CHARACTER_TATTOO_REGIONS,
  compileCharacterPrompt,
  compileCharacterSelectionContext,
  createDefaultCharacterDraft,
  normalizeCharacterDraft,
  sanitizeCharacterSkinColor,
  toggleCharacterSelection,
  type CharacterBasicField,
  type CharacterBuilderMode,
  type CharacterDraft,
  type CharacterTattooRegion,
  type CharacterTraitGroup,
  type CharacterTraitOption,
} from '../data/characterBuilder'
import { getCharacterTraitVisual, type CharacterTraitVisual } from '../data/characterVisuals'
import type { ReferenceImage } from '../data/referenceImage'
import type { EnhanceReference } from '../services/chat'
import { promptCharacterCount } from '../data/promptLimits'
import { PromptCard } from './PromptCard'
import { ReferenceImageGrid } from './ReferenceImageGrid'

export interface CharacterBuilderPanelProps {
  draft: CharacterDraft
  onChange: (next: CharacterDraft) => void
  referenceImages: ReferenceImage[]
  maxReferences: number
  onAddReferenceFiles: (files: File[]) => void
  onRemoveReference: (id: string) => void
  onGrabReference?: () => void | Promise<void>
  targetModel: string
  promptMax: number
  onSpend?: (credits: number) => void
  toast: (message: string) => void
}

function referenceName(reference: ReferenceImage | undefined) {
  if (!reference) return ''
  return reference.kind === 'upload' ? reference.name : `Timeline frame · ${reference.timecode}`
}

function optionStyle(
  group: CharacterTraitGroup,
  option: CharacterTraitOption,
  visual: CharacterTraitVisual | null,
  colorOverride?: string,
): CSSProperties {
  const previewColor = colorOverride ?? option.color ?? group.color
  const column = visual ? visual.index % visual.columns : 0
  const row = visual ? Math.floor(visual.index / visual.columns) : 0
  return {
    '--ef-character-accent': group.color,
    '--ef-character-option-tone': previewColor,
    ...(visual ? {
      '--ef-character-option-image-width': `${visual.columns * 100}%`,
      '--ef-character-option-image-x': `${-((column + .5) / visual.columns) * 100}%`,
      '--ef-character-option-image-y': `${-((row + .5) / visual.rows) * 100}%`,
    } : {}),
  } as CSSProperties
}

interface TraitGroupProps {
  group: CharacterTraitGroup
  value: string
  customAge?: number | null
  customSkinColor?: string
  tattooRegions?: CharacterTattooRegion[]
  open: boolean
  panelId: string
  onToggle: () => void
  onSelect: (value: string) => void
  onCustomAgeChange?: (value: number | null) => void
  onCustomSkinColorChange?: (value: string) => void
  onToggleTattooRegion?: (value: CharacterTattooRegion) => void
}

function TraitOption({
  group,
  option,
  selected,
  customSkinColor,
  onSelect,
}: {
  group: CharacterTraitGroup
  option: CharacterTraitOption
  selected: boolean
  customSkinColor?: string
  onSelect: () => void
}) {
  const visual = getCharacterTraitVisual(group.id, option.id)
  const isSkinTone = group.id === 'skinTone'
  const style = optionStyle(group, option, visual, isSkinTone && option.id === 'custom' ? customSkinColor : undefined)
  const commonProps = {
    type: 'button' as const,
    'aria-pressed': selected,
    'aria-label': option.description ? `${option.label}. ${option.description}` : option.label,
    className: `ef-character-option ef-character-option--${group.layout}${visual ? ' has-visual' : ''}${selected ? ' is-selected' : ''}`,
    style,
    onClick: onSelect,
    title: option.description,
  }

  if (group.layout === 'swatches') {
    return (
      <button {...commonProps}>
        <span className="ef-character-swatch" aria-hidden="true" />
        <span>{option.label}</span>
      </button>
    )
  }

  if (group.layout === 'chips') {
    return (
      <button {...commonProps}>
        {option.symbol && <span className="ef-character-option-symbol" aria-hidden="true">{option.symbol}</span>}
        <span>{option.label}</span>
      </button>
    )
  }

  return (
    <button {...commonProps} data-trait={group.id} data-option={option.id} data-tone-kind={option.tone}>
      <span className="ef-character-option-visual" aria-hidden="true">
        {visual ? (
          <>
            <img className="ef-character-option-image" src={visual.atlas} alt="" loading="lazy" draggable={false} />
            {isSkinTone && <span className="ef-character-skin-tint" />}
            <span className="ef-character-option-image-shade" />
          </>
        ) : option.symbol ? <span>{option.symbol}</span> : <span className="ef-character-option-orb" />}
      </span>
      <span className="ef-character-option-copy">
        <strong>{option.label}</strong>
        {option.description && <small>{option.description}</small>}
      </span>
    </button>
  )
}

function TraitGroup({
  group,
  value,
  customAge,
  customSkinColor,
  tattooRegions = [],
  open,
  panelId,
  onToggle,
  onSelect,
  onCustomAgeChange,
  onCustomSkinColorChange,
  onToggleTattooRegion,
}: TraitGroupProps) {
  const headingId = `${panelId}-heading`
  const selectedLabel = group.id === 'age' && value === 'custom' && customAge !== null
    ? `${customAge} years`
    : group.options.find((option) => option.id === value)?.label ?? 'Not selected'

  return (
    <section className={`ef-character-trait${open ? ' is-open' : ''}`} style={{ '--ef-character-accent': group.color } as CSSProperties}>
      <h3 id={headingId}>
        <button
          type="button"
          className="ef-character-trait-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className="ef-character-trait-icon" aria-hidden="true">{group.icon}</span>
          <span className="ef-character-trait-heading">
            <strong>{group.label}</strong>
            {!open && <small>{selectedLabel}</small>}
          </span>
          <span className="ef-character-trait-chevron" aria-hidden="true">⌄</span>
        </button>
      </h3>

      {open && (
        <div id={panelId} className="ef-character-trait-panel" role="region" aria-labelledby={headingId}>
          {group.description && <p className="ef-character-trait-description">{group.description}</p>}
          <div
            className={`ef-character-options ef-character-options--${group.layout}`}
            role="group"
            aria-label={group.label}
          >
            {group.options.filter((option) => !option.hidden).map((option) => (
              <TraitOption
                key={option.id}
                group={group}
                option={option}
                selected={option.id === value}
                customSkinColor={customSkinColor}
                onSelect={() => onSelect(option.id)}
              />
            ))}
          </div>
          {group.id === 'age' && onCustomAgeChange && (
            <label className={`ef-character-age-custom${value === 'custom' ? ' is-active' : ''}`}>
              <span>
                <strong>Exact age</strong>
                <small>Enter any age from 1 to 120</small>
              </span>
              <span className="ef-character-age-input">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={120}
                  step={1}
                  value={value === 'custom' && customAge !== null ? customAge : ''}
                  placeholder="27"
                  aria-label="Exact character age"
                  onChange={(event) => {
                    const next = event.currentTarget.valueAsNumber
                    onCustomAgeChange(Number.isFinite(next) ? Math.round(Math.min(120, Math.max(1, next))) : null)
                  }}
                />
                <span>years</span>
              </span>
            </label>
          )}
          {group.id === 'skinTone' && value === 'custom' && customSkinColor && onCustomSkinColorChange && (
            <div className="ef-character-custom-skin" role="group" aria-label="Custom skin color">
              <label>
                <span className="ef-character-custom-skin-preview" style={{ '--ef-character-custom-skin': customSkinColor } as CSSProperties} aria-hidden="true" />
                <span>
                  <strong>Custom skin color</strong>
                  <small>Open the color picker to choose an exact tone.</small>
                </span>
                <input
                  type="color"
                  value={customSkinColor}
                  aria-label="Choose custom skin color"
                  onChange={(event) => onCustomSkinColorChange(event.currentTarget.value)}
                />
              </label>
              <output>{customSkinColor}</output>
            </div>
          )}
          {group.id === 'tattoos' && value === 'tattoos' && onToggleTattooRegion && (
            <fieldset className="ef-character-tattoo-regions">
              <legend>Choose tattoo placement <span>· optional</span></legend>
              <div>
                {CHARACTER_TATTOO_REGIONS.map((region) => {
                  const selected = tattooRegions.includes(region.id)
                  return (
                    <button
                      key={region.id}
                      type="button"
                      aria-pressed={selected}
                      className={selected ? 'is-selected' : ''}
                      onClick={() => onToggleTattooRegion(region.id)}
                    >
                      <span aria-hidden="true">{region.symbol}</span>
                      {region.label}
                    </button>
                  )
                })}
              </div>
              <p>Select one or several areas. Leave all clear for automatic placement.</p>
            </fieldset>
          )}
        </div>
      )}
    </section>
  )
}

export function CharacterBuilderPanel({
  draft,
  onChange,
  referenceImages,
  maxReferences,
  onAddReferenceFiles,
  onRemoveReference,
  onGrabReference,
  targetModel,
  promptMax,
  onSpend,
  toast,
}: CharacterBuilderPanelProps) {
  const rawId = useId().replace(/:/g, '')
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(
    CHARACTER_BASIC_GROUPS.slice(0, 2).map((group) => group.id),
  ))
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)

  const normalizedDraft = useMemo(() => normalizeCharacterDraft(draft), [draft])
  const promptSummary = useMemo(() => compileCharacterPrompt(normalizedDraft), [normalizedDraft])
  const directionPromptMax = useMemo(() => {
    const withoutDirection = compileCharacterPrompt({ ...normalizedDraft, customNotes: '' })
    const withMarker = compileCharacterPrompt({ ...normalizedDraft, customNotes: 'x' })
    const scaffoldOverhead = Math.max(
      0,
      promptCharacterCount(withMarker) - promptCharacterCount(withoutDirection) - 1,
    )
    return Math.max(1, promptMax - promptCharacterCount(withoutDirection) - scaffoldOverhead)
  }, [normalizedDraft, promptMax])
  const selectionContext = useMemo(() => compileCharacterSelectionContext(normalizedDraft), [normalizedDraft])
  const activeReference = referenceImages.find((reference) => reference.id === draft.referenceAssetId) ?? referenceImages[0]
  const activeReferenceName = referenceName(activeReference)
  const enhanceReferences = useMemo<EnhanceReference[]>(() => (
    draft.mode === 'reference'
      ? referenceImages.map((reference) => reference.kind === 'upload'
        ? { role: 'character sample', label: reference.name, imageUrl: reference.url }
        : { role: 'character sample', note: `timeline frame at ${reference.timecode}` })
      : []
  ), [draft.mode, referenceImages])
  const enhanceContextKey = useMemo(() => JSON.stringify({
    selectionContext,
    mode: normalizedDraft.mode,
    referenceAssetId: normalizedDraft.referenceAssetId,
    references: referenceImages.map((reference) => reference.id),
  }), [normalizedDraft.mode, normalizedDraft.referenceAssetId, referenceImages, selectionContext])

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
  }, [])

  useEffect(() => {
    if (draft.mode !== 'reference') return
    const nextId = activeReference?.id ?? null
    const nextName = activeReferenceName
    if (draft.referenceAssetId === nextId && draft.referenceName === nextName) return
    onChange({ ...draft, referenceAssetId: nextId, referenceName: nextName })
  }, [activeReference?.id, activeReferenceName, draft, onChange])

  const updateMode = (mode: CharacterBuilderMode) => {
    if (draft.mode === mode) return
    onChange({
      ...draft,
      mode,
      referenceAssetId: mode === 'reference' ? activeReference?.id ?? null : draft.referenceAssetId,
      referenceName: mode === 'reference' ? activeReferenceName : draft.referenceName,
    })
  }

  const updateTrait = (group: CharacterTraitGroup, value: string) => {
    const field = group.id as CharacterBasicField
    const nextValue = toggleCharacterSelection(draft.basics[field], value)
    onChange({
      ...draft,
      customAge: field === 'age' ? null : draft.customAge,
      tattooRegions: field === 'tattoos' && nextValue !== 'tattoos' ? [] : draft.tattooRegions,
      basics: { ...draft.basics, [field]: nextValue },
    })
  }

  const updateCustomAge = (customAge: number | null) => {
    onChange({
      ...draft,
      customAge,
      basics: { ...draft.basics, age: customAge === null ? '' : 'custom' },
    })
  }

  const updateCustomSkinColor = (customSkinColor: string) => {
    onChange({
      ...draft,
      customSkinColor: sanitizeCharacterSkinColor(customSkinColor),
      basics: { ...draft.basics, skinTone: 'custom' },
    })
  }

  const toggleTattooRegion = (region: CharacterTattooRegion) => {
    if (draft.basics.tattoos !== 'tattoos') return
    const selected = draft.tattooRegions.includes(region)
    onChange({
      ...draft,
      tattooRegions: selected
        ? draft.tattooRegions.filter((candidate) => candidate !== region)
        : [...draft.tattooRegions, region],
    })
  }

  const toggleGroup = (groupId: string) => {
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const resetDesign = () => {
    const clean = createDefaultCharacterDraft()
    onChange({
      ...clean,
      mode: draft.mode,
      referenceAssetId: draft.referenceAssetId,
      referenceName: draft.referenceName,
    })
    toast('Character design reset')
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptSummary)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = promptSummary
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const copiedWithFallback = document.execCommand('copy')
      textarea.remove()
      if (!copiedWithFallback) {
        toast('Could not copy the prompt')
        return
      }
    }
    setCopied(true)
    toast('Character prompt copied')
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="ef-character-builder">
      <div className="ef-character-builder-toolbar">
        <div className="ef-character-mode-tabs" role="tablist" aria-label="Character creation method">
          <button
            type="button"
            role="tab"
            aria-selected={draft.mode === 'custom'}
            className={draft.mode === 'custom' ? 'is-selected' : ''}
            onClick={() => updateMode('custom')}
          >
            <span aria-hidden="true">✦</span>
            Design a character
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={draft.mode === 'reference'}
            className={draft.mode === 'reference' ? 'is-selected' : ''}
            onClick={() => updateMode('reference')}
          >
            <span aria-hidden="true">▣</span>
            Start from a sample
          </button>
        </div>
        <button type="button" className="ef-character-reset" onClick={resetDesign}>Reset</button>
      </div>

      {draft.mode === 'reference' && (
        <section className="ef-character-reference" aria-labelledby={`${rawId}-reference-title`}>
          <div className="ef-character-section-heading">
            <div>
              <span className="ef-character-step">01 · SAMPLE</span>
              <h2 id={`${rawId}-reference-title`}>Choose the character to preserve</h2>
              <p>Use a clear face or full-body image, then reshape it with the same controls below.</p>
            </div>
            {activeReferenceName && <span className="ef-character-reference-active">Using · {activeReferenceName}</span>}
          </div>
          {maxReferences > 0 ? (
            <ReferenceImageGrid
              images={referenceImages}
              max={maxReferences}
              onAddFiles={onAddReferenceFiles}
              onRemove={onRemoveReference}
              onGrabPlayhead={onGrabReference ? () => { void onGrabReference() } : undefined}
              label="CHARACTER SAMPLE"
            />
          ) : (
            <div className="ef-character-reference-unavailable" role="status">
              This model cannot read character samples. Choose a reference-capable image model above, or switch to Design a character.
            </div>
          )}
          {referenceImages.length > 1 && (
            <div className="ef-character-reference-choices" role="radiogroup" aria-label="Primary character sample">
              {referenceImages.map((reference, index) => (
                <button
                  key={reference.id}
                  type="button"
                  role="radio"
                  aria-checked={reference.id === activeReference?.id}
                  className={reference.id === activeReference?.id ? 'is-selected' : ''}
                  onClick={() => onChange({
                    ...draft,
                    referenceAssetId: reference.id,
                    referenceName: referenceName(reference),
                  })}
                >
                  Sample {index + 1}
                </button>
              ))}
            </div>
          )}
          <div className="ef-character-reference-controls">
            <fieldset>
              <legend>Sample influence</legend>
              <div className="ef-character-strength-options">
                {([
                  { value: 35, label: 'Subtle' },
                  { value: 72, label: 'Balanced' },
                  { value: 92, label: 'Strong' },
                ] as const).map((strength) => (
                  <button
                    key={strength.value}
                    type="button"
                    className={Math.abs(draft.referenceStrength - strength.value) <= 8 ? 'is-selected' : ''}
                    aria-pressed={Math.abs(draft.referenceStrength - strength.value) <= 8}
                    onClick={() => onChange({ ...draft, referenceStrength: strength.value })}
                  >
                    {strength.label}
                  </button>
                ))}
              </div>
              <label className="ef-character-strength-slider">
                <span>Exact influence</span>
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={1}
                  value={draft.referenceStrength}
                  onChange={(event) => onChange({ ...draft, referenceStrength: Number(event.target.value) })}
                />
                <output>{draft.referenceStrength}%</output>
              </label>
            </fieldset>
            <label className="ef-character-identity-toggle">
              <span>
                <strong>Preserve identity</strong>
                <small>Keep recognizable facial structure while restyling.</small>
              </span>
              <input
                type="checkbox"
                checked={draft.preserveIdentity}
                onChange={(event) => onChange({ ...draft, preserveIdentity: event.target.checked })}
              />
              <span className="ef-character-switch" aria-hidden="true" />
            </label>
          </div>
        </section>
      )}

      <section className="ef-character-basics" aria-labelledby={`${rawId}-basics-title`}>
        <div className="ef-character-section-heading ef-character-section-heading--compact">
          <div>
            {draft.mode !== 'reference' && <span className="ef-character-step">01 · FOUNDATION</span>}
            <h2 id={`${rawId}-basics-title`}>Design your character</h2>
            <p>Every choice is optional. Click a selected choice again to clear it.</p>
          </div>
        </div>
        <div className="ef-character-accordion">
          {CHARACTER_BASIC_GROUPS.map((group) => (
            <TraitGroup
              key={group.id}
              group={group}
              value={draft.basics[group.id as CharacterBasicField]}
              customAge={group.id === 'age' ? draft.customAge : undefined}
              customSkinColor={group.id === 'skinTone' ? draft.customSkinColor : undefined}
              tattooRegions={group.id === 'tattoos' ? draft.tattooRegions : undefined}
              open={openGroups.has(group.id)}
              panelId={`${rawId}-trait-${group.id}`}
              onToggle={() => toggleGroup(group.id)}
              onSelect={(value) => updateTrait(group, value)}
              onCustomAgeChange={group.id === 'age' ? updateCustomAge : undefined}
              onCustomSkinColorChange={group.id === 'skinTone' ? updateCustomSkinColor : undefined}
              onToggleTattooRegion={group.id === 'tattoos' ? toggleTattooRegion : undefined}
            />
          ))}
        </div>
      </section>

      <section className="ef-character-direction" aria-labelledby={`${rawId}-direction-title`}>
        <div className="ef-character-section-heading ef-character-section-heading--compact">
          <div>
            <span className="ef-character-step">DIRECTION · OPTIONAL</span>
            <h2 id={`${rawId}-direction-title`}>Anything else?</h2>
            <p>Add details that are not covered above. Prompt enhancement keeps every selected trait and sample in context.</p>
          </div>
        </div>
        <PromptCard
          prompt={draft.customNotes}
          onPromptChange={(customNotes) => onChange({ ...draft, customNotes })}
          maxLength={directionPromptMax}
          enhancerKey="enhancer-character"
          targetModel={targetModel}
          mediaKind="image"
          purpose="character-notes"
          style="Character design"
          references={enhanceReferences}
          supportingContext={selectionContext ? {
            label: 'Locked character selections',
            text: selectionContext,
            instruction: 'Preserve these structured character choices exactly. Improve only the user’s additional direction. Do not infer or fill any trait, placement or design choice that was not selected or written.',
          } : undefined}
          contextKey={enhanceContextKey}
          onSpend={onSpend}
          placeholder="Wardrobe, personality, scars, accessories, lighting, camera direction…"
        />
      </section>

      <section className="ef-character-prompt-summary" aria-labelledby={`${rawId}-prompt-title`}>
        <div className="ef-character-prompt-heading">
          <div>
            <span className="ef-character-step">READY · GENERATED BRIEF</span>
            <h2 id={`${rawId}-prompt-title`}>Character prompt</h2>
          </div>
          <button type="button" className="ef-character-copy" onClick={() => { void copyPrompt() }}>
            {copied ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
        <p>{promptSummary}</p>
      </section>
    </div>
  )
}
