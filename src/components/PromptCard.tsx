import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../icons'
import { Dropdown } from './Dropdown'
import { enhancePrompt, type EnhanceMediaKind, type EnhanceReference, type EnhanceSupportingContext } from '../services/chat'
import { isConnected } from '../services/run'
import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from '../data/models'
import { AGENT_MODEL_META } from '../data/modelPresentation'
import { loadValue, saveValue } from '../data/prefs'
import { promptCharacterCount } from '../data/promptLimits'

interface PromptCardProps {
  prompt: string
  onPromptChange: (value: string) => void
  maxLength: number
  // Storage key so each screen remembers its own last-used enhancer model.
  enhancerKey?: string
  // The generation model + modality the enhanced prompt is being written FOR, so
  // the enhancer can tailor its output to it.
  targetModel: string
  mediaKind: EnhanceMediaKind
  ariaLabel?: string
  placeholder?: string
  // The selected style chip (Create Image) so the enhancer builds around it.
  style?: string
  // Attachments (reference images, frames, video/audio) the enhancer should
  // factor in — images are shown to the vision model, all contribute their tag.
  references?: EnhanceReference[]
  /** Read-only sibling/story context supplied to the enhancer for coordinated workflows. */
  supportingContext?: EnhanceSupportingContext
  onSpend?: (credits: number) => void
  /** Changes whenever an attached primary source changes; stale enhancement is cancelled. */
  contextKey?: string
  onEnhanced?: (result: { text: string; enhancerModel: string }) => void
}

export function PromptCard({ prompt, onPromptChange, maxLength, enhancerKey = 'enhancer-model', targetModel, mediaKind, ariaLabel, placeholder, style, references, supportingContext, onSpend, contextKey = '', onEnhanced }: PromptCardProps) {
  const [enhanceModel, setEnhanceModel] = useState(() => {
    const v = loadValue(enhancerKey)
    return v && AGENT_MODELS.includes(v) ? v : DEFAULT_AGENT_MODEL
  })
  const [enhancing, setEnhancing] = useState(false)
  const [cost, setCost] = useState<number | 'unknown' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const promptId = useId()
  const promptStatusId = useId()

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    requestIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setEnhancing(false)
    setCost(null)
    setError(null)
  }, [contextKey, targetModel])

  const pickEnhanceModel = (m: string) => {
    requestIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setEnhancing(false)
    setCost(null)
    setEnhanceModel(m)
    saveValue(enhancerKey, m)
  }

  const handleChange = (value: string) => {
    onPromptChange(value)
    if (cost != null) setCost(null) // editing invalidates the last enhancement note
    if (error) setError(null)
  }

  const enhance = async () => {
    if (enhancing || !prompt.trim()) return
    setError(null)
    setEnhancing(true)
    const controller = new AbortController()
    const requestId = ++requestIdRef.current
    abortRef.current = controller
    try {
      const res = await enhancePrompt({ rough: prompt, targetModel, mediaKind, chatModel: enhanceModel, maxLength, style, references, supportingContext, signal: controller.signal })
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      onPromptChange(res.text)
      onEnhanced?.({ text: res.text, enhancerModel: enhanceModel })
      setCost(res.credits ?? 'unknown')
      if (res.credits != null) onSpend?.(res.credits)
    } catch (e) {
      if (controller.signal.aborted || requestId !== requestIdRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!controller.signal.aborted && requestId === requestIdRef.current) {
        setEnhancing(false)
        abortRef.current = null
      }
    }
  }

  const connected = isConnected()
  const fmtCost = (c: number) => (Number.isInteger(c) ? String(c) : c.toFixed(2))
  const enhanced = cost != null
  const promptLabel = ariaLabel ?? (mediaKind === 'video' ? 'Video generation prompt' : mediaKind === 'image' ? 'Image generation prompt' : mediaKind === 'audio' ? 'Audio direction prompt' : 'Workflow direction prompt')
  const characterCount = promptCharacterCount(prompt)
  const overLimit = characterCount > maxLength
  const nearLimit = !overLimit && characterCount > maxLength * 0.9

  return (
    <div className="ef-prompt-card">
      <textarea
        id={promptId}
        name="prompt"
        aria-label={promptLabel}
        aria-describedby={promptStatusId}
        aria-busy={enhancing}
        className={'ef-prompt-textarea' + (expanded ? ' expanded' : '')}
        rows={expanded ? 13 : 3}
        placeholder={placeholder}
        value={prompt}
        aria-invalid={overLimit}
        onChange={(e) => handleChange(e.target.value)}
      />
      <div className="ef-prompt-footer">
        <button
          type="button"
          className={'ef-enhance-btn' + (enhancing ? ' loading' : '')}
          aria-label={!connected ? 'Connect your kie.ai key to enhance' : `Enhance prompt for ${targetModel} with ${enhanceModel}; token billed with no EasyField spend cap`}
          title={!connected ? 'Connect your kie.ai key (credits badge on Home) to enhance' : `Rewrite for ${targetModel} · live token billing, no EasyField spend cap`}
          disabled={enhancing || !prompt.trim() || overLimit || !connected}
          onClick={enhance}
        >
          <Icon glyph="spark" size={12} />
        </button>
        <Dropdown options={AGENT_MODELS} selected={enhanceModel} onSelect={pickEnhanceModel} label="Prompt enhancer model" align="left" optionMeta={AGENT_MODEL_META} />
        <span className="ef-spacer" />
        {error ? (
          <span id={promptStatusId} className="ef-enhance-note error" title={error} role="alert">✕ enhancement failed</span>
        ) : enhancing ? (
          <span id={promptStatusId} className="ef-enhance-note" role="status" aria-live="polite">✨ directing…</span>
        ) : enhanced ? (
          <span id={promptStatusId} className="ef-enhance-note" role="status" aria-live="polite">
            {cost === 'unknown' ? '✨ billed · cost unavailable' : `✨ +${fmtCost(cost!)} cr`}
            <button type="button" className="ef-reenhance-btn" title="Enhance again" aria-label="Enhance again" onClick={enhance} disabled={!connected}>↻</button>
          </span>
        ) : (
          <span
            id={promptStatusId}
            className={`ef-char-count${overLimit ? ' is-over-limit' : nearLimit ? ' is-near-limit' : ''}`}
            role={overLimit ? 'alert' : undefined}
          >
            <span className="ef-billing-copy">Live token billing · </span>{characterCount.toLocaleString()} / {maxLength.toLocaleString()}
            {overLimit && <span className="ef-char-over-label"> · shorten by {(characterCount - maxLength).toLocaleString()}</span>}
          </span>
        )}
        <button
          type="button"
          className="ef-prompt-expand"
          title={expanded ? 'Collapse prompt' : 'Expand prompt'}
          aria-label={expanded ? 'Collapse prompt' : 'Expand prompt'}
          aria-controls={promptId}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '⤡' : '⤢'}
        </button>
      </div>
    </div>
  )
}
