import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../icons'
import { Dropdown } from '../components/Dropdown'
import { BrainModePicker } from '../components/BrainModePicker'
import { resolve } from '../services/resolve'
import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from '../data/models'
import { AGENT_MODEL_META } from '../data/modelPresentation'
import { loadValue, saveValue } from '../data/prefs'
import { planTimelineWorkflow, type BrainPlanResult } from '../services/chat'
import { TOOL_BY_ID } from '../data/toolDefinitions'
import { host } from '../services/host'
import { isConnected } from '../services/run'
import {
  DEFAULT_BRAIN_MODE,
  LEGACY_BRAIN_MODE,
  brainQuestionBudgetLabel,
  getBrainMode,
  isBrainModeId,
  type BrainModeId,
} from '../data/superBrainModes'

const SUGGESTIONS = ['Cut my selected montage to the beat', 'Create premium captions for this interview', 'Build a trailer workflow']

interface SuperBrainProps {
  onBack: () => void
  toast: (msg: string) => void
  onSpend: (credits: number) => void
}

interface BrainDraftV2 {
  schemaVersion: 2
  mode: BrainModeId
  conversation: string[]
  plan: BrainPlanResult | null
  answers: Record<string, string>
  questionsAsked: number
  frozen: boolean
}

export function SuperBrain({ onBack, toast, onSpend }: SuperBrainProps) {
  const [model, setModel] = useState(() => {
    const value = loadValue('brain-model')
    return value && AGENT_MODELS.includes(value) ? value : DEFAULT_AGENT_MODEL
  })
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<BrainModeId>(() => {
    const value = loadValue('brain-mode')
    return isBrainModeId(value) ? value : DEFAULT_BRAIN_MODE
  })
  const [conversation, setConversation] = useState<string[]>([])
  const [plan, setPlan] = useState<BrainPlanResult | null>(null)
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState('')
  const [frozen, setFrozen] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [questionsAsked, setQuestionsAsked] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleTab, setConsoleTab] = useState<'plan' | 'context' | 'history'>('plan')
  const controllerRef = useRef<AbortController | null>(null)
  const bridge = useSyncExternalStore(resolve.subscribe, resolve.getStatus)

  useEffect(() => {
    let mounted = true
    void host.getState<Partial<BrainDraftV2> & { conversation?: string[]; plan?: BrainPlanResult | null; answers?: Record<string, string> }>('drafts', 'default:brain')
      .then((saved) => {
        if (!mounted || !saved) return
        const restoredMode = isBrainModeId(saved.mode) ? saved.mode : LEGACY_BRAIN_MODE
        setMode(restoredMode)
        saveValue('brain-mode', restoredMode)
        setConversation(saved.conversation ?? [])
        setPlan(saved.plan ?? null)
        setAnswers(saved.answers ?? {})
        setQuestionsAsked(typeof saved.questionsAsked === 'number' && saved.questionsAsked >= 0 ? Math.floor(saved.questionsAsked) : 0)
        setFrozen(saved.frozen === true)
      })
      .finally(() => { if (mounted) setHydrated(true) })
    return () => {
      mounted = false
      controllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const draft: BrainDraftV2 = { schemaVersion: 2, mode, conversation, plan, answers, questionsAsked, frozen }
    const timer = window.setTimeout(() => void host.setState('drafts', 'default:brain', draft), 180)
    return () => window.clearTimeout(timer)
  }, [answers, conversation, frozen, hydrated, mode, plan, questionsAsked])

  const pickModel = (next: string) => {
    setModel(next)
    saveValue('brain-model', next)
  }

  const modeLocked = planning || frozen || conversation.length > 0 || !!plan
  const pickMode = (next: BrainModeId) => {
    if (modeLocked) return
    setMode(next)
    saveValue('brain-mode', next)
  }

  const submit = async (text = input, clearAnswersOnSuccess = false) => {
    const request = text.trim()
    if (!request || planning || frozen) return
    setInput('')
    setPlanning(true)
    setError('')
    const nextConversation = [...conversation, `Editor: ${request}`]
    setConversation(nextConversation)
    const controller = new AbortController()
    controllerRef.current = controller
    const modeAtStart = mode
    const questionsAskedAtStart = questionsAsked
    try {
      const result = await planTimelineWorkflow({
        request,
        conversation: nextConversation,
        chatModel: model,
        mode: modeAtStart,
        questionsAsked: questionsAskedAtStart,
        timelineContext: bridge.connected
          ? `${bridge.project ?? 'Project'} / ${bridge.timeline ?? 'Timeline'} at ${bridge.timecode ?? 'unknown timecode'}, ${bridge.width ?? '?'}×${bridge.height ?? '?'} ${bridge.fps ?? '?'}fps`
          : 'Resolve disconnected; planning only, no placement is currently possible',
        signal: controller.signal,
      })
      setPlan(result)
      setQuestionsAsked((current) => current + result.questions.length)
      if (result.chatCredits != null) onSpend(result.chatCredits)
      if (clearAnswersOnSuccess) setAnswers({})
      setConversation((current) => [...current, `SuperBrain: ${result.summary}`, ...result.questions.map((question) => `Question: ${question.question}`)])
      if (result.questions.length === 0 && getBrainMode(modeAtStart).runPolicy !== 'none') setConsoleOpen(true)
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      setPlanning(false)
    }
  }

  const reset = () => {
    controllerRef.current?.abort()
    setConversation([])
    setPlan(null)
    setAnswers({})
    setQuestionsAsked(0)
    setFrozen(false)
    setError('')
    void host.deleteState('drafts', 'default:brain')
    toast('Brain draft cleared — no timeline changes were made')
  }

  const canFreeze = !!plan?.steps.length && plan.questions.length === 0
  const connected = isConnected()
  const selectedMode = getBrainMode(mode)
  const executionUnavailable = !!plan && plan.questions.length === 0 && selectedMode.runPolicy !== 'none'
  const brainStatus = frozen
    ? selectedMode.runPolicy === 'none' ? 'PLAN FINALIZED · NOT RUN' : 'PLAN SAVED · RUN ADAPTER REQUIRED'
    : planning
      ? `PLANNING · ${selectedMode.title.toUpperCase()}`
      : !connected
        ? 'CONNECT KIE.AI TO PLAN'
        : executionUnavailable
          ? 'PLAN READY · RUN ADAPTER REQUIRED'
          : selectedMode.status
  const answeredCount = plan?.questions.filter((question) => answers[question.id]?.trim()).length ?? 0
  const allQuestionsAnswered = !!plan?.questions.length && answeredCount === plan.questions.length
  const submitAnswers = () => {
    if (!plan || !allQuestionsAnswered || planning) return
    const response = plan.questions.map((question) => `${question.question}\nAnswer: ${answers[question.id].trim()}`).join('\n\n')
    void submit(`Answers to your open decisions:\n\n${response}`, true)
  }
  const explainExecutionUnavailable = () => {
    toast('Execution is not available yet · tool dispatch, approval snapshots and Resolve rollback adapters are still required')
  }

  return (
    <div className="ef-screen ef-brain-real">
      <div className="ef-sub-header ef-sub-header--brain">
        <button type="button" className="ef-back" onClick={onBack} aria-label="Back to tools">‹</button>
        <span className="ef-orb" />
        <span className="ef-brain-titles"><span className="ef-brain-title">SuperBrain</span><span className="ef-brain-status">{brainStatus}</span></span>
        <span className="ef-spacer" />
        <Dropdown options={AGENT_MODELS} selected={model} onSelect={pickModel} label="Agent model" optionMeta={AGENT_MODEL_META} />
      </div>

      <BrainModePicker value={mode} onChange={pickMode} locked={modeLocked} onReset={reset} />

      <div className="ef-brain-workspace">
        <main className="ef-brain-chat">
          <div className="ef-scroll ef-brain-scroll">
            {!conversation.length && (
              <section className="ef-brain-welcome">
                <span className="ef-brain-welcome-orb" aria-hidden="true"><Icon glyph="spark" size={22} /></span>
                <span className="ef-brain-welcome-kicker">{selectedMode.title.toUpperCase()} · TIMELINE STRATEGIST</span>
                <h1>Describe the outcome.<br />I’ll build the workflow.</h1>
                <p>{selectedMode.description}</p>
                <div className="ef-chip-row">{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} className="ef-suggestion" onClick={() => setInput(suggestion)}>{suggestion}<span aria-hidden="true">↗</span></button>)}</div>
              </section>
            )}

            {conversation.map((message, index) => (
              <div key={`${index}-${message}`} className={message.startsWith('Editor:') ? 'ef-user-bubble' : 'ef-agent-bubble ef-brain-message'}>{message.replace(/^(Editor|SuperBrain|Question):\s*/, '')}</div>
            ))}

            {planning && <div className="ef-agent-bubble ef-brain-thinking"><span className="ef-job-trigger-dot is-active" />Building a {selectedMode.title} workflow and checking the remaining question budget…</div>}
            {error && <div className="ef-inline-warning" role="alert">{error}</div>}
          </div>

          {plan && (
            <button type="button" className="ef-brain-plan-summary" onClick={() => setConsoleOpen(true)}>
              <span>{plan.questions.length ? `${answeredCount}/${plan.questions.length} decisions answered` : `${plan.steps.length} steps ready`} · {brainQuestionBudgetLabel(mode, questionsAsked)}</span>
              <strong>{plan.maxCredits == null ? 'Price at execution' : `Est. ${plan.maxCredits} credits`} · View plan</strong>
            </button>
          )}

          <form className="ef-brain-input" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <span className="ef-brain-input-spark"><Icon glyph="spark" size={13} /></span>
            <input aria-label="Describe an edit or answer SuperBrain" aria-describedby="ef-brain-call-preflight" placeholder="Describe the result you want…" value={input} maxLength={2400} disabled={planning || frozen} onChange={(event) => setInput(event.target.value)} />
            <span id="ef-brain-call-preflight" className="ef-brain-call-cost" title="Live token billing with no EasyField spend cap">LIVE BILLING</span>
            <button type="submit" className="ef-brain-send" aria-label={!connected ? 'Connect Kie.ai before sending to SuperBrain' : 'Send to SuperBrain; live token billing with no EasyField spend cap'} disabled={!input.trim() || planning || frozen || !connected}>→</button>
          </form>
        </main>

        <aside className={'ef-brain-console' + (consoleOpen ? ' is-open' : '')} aria-label="Plan Console">
          <header className="ef-brain-console-head">
            <div><span>PLAN CONSOLE · {selectedMode.title.toUpperCase()}</span><strong>{plan ? plan.questions.length ? 'Decisions required' : selectedMode.runPolicy === 'none' ? 'Plan ready' : 'Ready for execution preflight' : 'Waiting for a brief'}</strong></div>
            <button type="button" className="ef-brain-console-close" aria-label="Close Plan Console" onClick={() => setConsoleOpen(false)}>×</button>
          </header>
          <nav className="ef-brain-console-tabs" aria-label="Plan Console views">
            {(['plan', 'context', 'history'] as const).map((tab) => <button type="button" key={tab} className={consoleTab === tab ? 'is-active' : ''} aria-pressed={consoleTab === tab} onClick={() => setConsoleTab(tab)}>{tab}</button>)}
          </nav>

          <div className="ef-scroll ef-brain-console-scroll">
            {consoleTab === 'context' ? (
              <section className="ef-brain-context-panel">
                <span className="ef-brain-console-kicker">RESOLVE CONTEXT</span>
                <dl>
                  <div><dt>Workflow mode</dt><dd>{selectedMode.title}</dd></div>
                  <div><dt>Question budget</dt><dd>{brainQuestionBudgetLabel(mode, questionsAsked)}</dd></div>
                  <div><dt>Connection</dt><dd>{bridge.connected ? 'Connected' : 'Planning only'}</dd></div>
                  <div><dt>Project</dt><dd>{bridge.project ?? 'No active project'}</dd></div>
                  <div><dt>Timeline</dt><dd>{bridge.timeline ?? 'No active timeline'}</dd></div>
                  <div><dt>Playhead</dt><dd>{bridge.timecode ?? '—'}</dd></div>
                  <div><dt>Format</dt><dd>{bridge.width ? `${bridge.width}×${bridge.height} · ${bridge.fps}fps` : 'Read at preflight'}</dd></div>
                </dl>
                <p>Context is revalidated before Apply. Auto-run never bypasses price, upload, privacy, placement or destructive-action confirmation.</p>
              </section>
            ) : consoleTab === 'history' ? (
              <section className="ef-brain-history-panel">
                <span className="ef-brain-console-kicker">DRAFT HISTORY</span>
                <strong>{conversation.length} saved message{conversation.length === 1 ? '' : 's'}</strong>
                <p>This {selectedMode.title} conversation, its question budget and every open answer are auto-saved locally. Nothing is applied by leaving or resizing this screen.</p>
                <button type="button" className="ef-undo-btn" onClick={reset}>Clear draft</button>
              </section>
            ) : !plan ? (
              <div className="ef-brain-console-empty">
                <span aria-hidden="true"><Icon glyph="board" size={22} /></span>
                <strong>Your plan will appear here</strong>
                <p>{selectedMode.description} Steps, decisions, placement, privacy and maximum cost remain visible.</p>
              </div>
            ) : (
              <section className="ef-brain-plan" aria-label="Timeline plan preview">
                <header><span>{selectedMode.title.toUpperCase()} · PLAN PREVIEW</span><strong>{plan.questions.length ? `${answeredCount}/${plan.questions.length} answered` : `${plan.steps.length} steps ready`}</strong></header>
                <p>{plan.summary}</p>
                {!!plan.questions.length && (
                  <div className="ef-brain-questions">
                    <div className="ef-brain-decision-progress"><span style={{ width: `${Math.round((answeredCount / plan.questions.length) * 100)}%` }} /></div>
                    {plan.questions.map((question, index) => (
                      <article key={question.id}>
                        <span className="ef-brain-question-number">
                          DECISION {String(Math.max(0, questionsAsked - plan.questions.length) + index + 1).padStart(2, '0')}
                          {selectedMode.maxQuestions != null ? ` · ${selectedMode.maxQuestions} MAX` : ''}
                        </span>
                        <strong>{question.question}</strong>
                        <span>{question.reason}</span>
                        <textarea
                          aria-label={`Answer: ${question.question}`}
                          placeholder="Type your decision…"
                          value={answers[question.id] ?? ''}
                          maxLength={2000}
                          onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                        />
                      </article>
                    ))}
                    <button type="button" className="ef-run-btn ef-submit-decisions" disabled={!allQuestionsAnswered || planning} onClick={submitAnswers}>
                      {allQuestionsAnswered ? 'Submit answers' : `Answer ${plan.questions.length - answeredCount} more`}
                    </button>
                    <small className="ef-brain-persistence-note">Answers remain here until you press Submit answers.</small>
                  </div>
                )}
                {!!(plan.assumptions ?? []).length && (
                  <div className="ef-brain-plan-notes is-assumption">
                    <span>VISIBLE ASSUMPTIONS</span>
                    {(plan.assumptions ?? []).map((assumption) => <p key={assumption}>{assumption}</p>)}
                  </div>
                )}
                {!!(plan.executionBlockers ?? []).length && (
                  <div className="ef-brain-plan-notes is-blocker">
                    <span>EXECUTION BLOCKERS</span>
                    {(plan.executionBlockers ?? []).map((blocker) => <p key={blocker}>{blocker}</p>)}
                  </div>
                )}
                {!!plan.steps.length && <div className="ef-steps">{plan.steps.map((step, index) => {
                  const tool = TOOL_BY_ID[step.toolId]
                  return <div className="ef-step-row queued" key={step.id}><span className="ef-step-mark queued">{index + 1}</span><span className="ef-step-name">{step.title}</span><span className="ef-step-cat" style={{ color: tool.accent, borderColor: `color-mix(in srgb, ${tool.accent} 40%, transparent)` }}>{tool.name}</span><span className="ef-spacer" /><span className="ef-step-meta">{step.destructive ? 'BACKUP + APPROVAL' : step.placement?.toUpperCase() || 'NO APPLY'}</span></div>
                })}</div>}
                <div className="ef-brain-cost-summary"><span>ESTIMATED WORKFLOW COST</span><strong>{plan.maxCredits == null ? 'Calculated before execution' : `${plan.maxCredits} credits`}</strong><small>Informational only · EasyField does not cap generations.</small></div>
                {selectedMode.runPolicy !== 'none' && !plan.questions.length && (
                  <div className="ef-brain-execution-gate" role="status">
                    <span>EXECUTION STATUS</span>
                    <strong>Run adapter required</strong>
                    <p>The mode and preflight intent are saved, but EasyField cannot execute this plan until tool dispatch, approval snapshots and Resolve rollback adapters are connected.</p>
                  </div>
                )}
                <div className="ef-brain-plan-actions">
                  <button type="button" className="ef-undo-btn" onClick={reset}>Reset</button>
                  <button type="button" className="ef-run-btn" disabled={!canFreeze || frozen} onClick={() => setFrozen(true)}>
                    {frozen ? 'Plan saved' : plan.questions.length ? 'Open decisions remain' : selectedMode.runPolicy === 'none' ? 'Finalize plan' : selectedMode.runPolicy === 'approval' ? 'Freeze for review' : 'Save plan'}
                  </button>
                  {selectedMode.runPolicy !== 'none' && (
                    <button type="button" className="ef-run-btn is-unavailable" disabled={!canFreeze} onClick={explainExecutionUnavailable}>
                      {selectedMode.runPolicy === 'approval' ? 'Why Run is unavailable' : 'Why Auto-run is unavailable'}
                    </button>
                  )}
                </div>
                {frozen && <div className="ef-result-strip"><span className="ef-result-strip-text">Plan saved for <b>{bridge.timeline ?? 'Library-only work'}</b>. {selectedMode.runPolicy === 'none' ? 'No execution was requested.' : 'Execution remains blocked until the run adapter and every required preflight are available.'}</span></div>}
              </section>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
