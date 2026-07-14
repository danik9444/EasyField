export const BRAIN_MODE_IDS = ['plan-only', 'review-run', 'quick-run', 'guided-run'] as const

export type BrainModeId = (typeof BRAIN_MODE_IDS)[number]
export type BrainRunPolicy = 'none' | 'approval' | 'automatic'

export interface BrainModeDefinition {
  id: BrainModeId
  title: string
  badge: string
  description: string
  status: string
  runPolicy: BrainRunPolicy
  maxQuestions: number | null
}

export const BRAIN_MODES: readonly BrainModeDefinition[] = [
  {
    id: 'plan-only',
    title: 'Plan Only',
    badge: 'NO EXECUTION',
    description: 'Build a complete workflow plan. Nothing runs or changes your timeline.',
    status: 'PLAN ONLY',
    runPolicy: 'none',
    maxQuestions: null,
  },
  {
    id: 'review-run',
    title: 'Review & Run',
    badge: 'RECOMMENDED',
    description: 'Build the plan, review every step and cost, then approve execution.',
    status: 'REVIEW BEFORE RUN',
    runPolicy: 'approval',
    maxQuestions: null,
  },
  {
    id: 'quick-run',
    title: 'Quick Run',
    badge: 'AUTO · 3 MAX',
    description: 'Ask up to 3 essential questions, then continue to execution preflight.',
    status: 'AUTO · 3 QUESTIONS MAX',
    runPolicy: 'automatic',
    maxQuestions: 3,
  },
  {
    id: 'guided-run',
    title: 'Guided Run',
    badge: 'AUTO · 10 MAX',
    description: 'Ask up to 10 questions for a more precise execution-ready plan.',
    status: 'AUTO · 10 QUESTIONS MAX',
    runPolicy: 'automatic',
    maxQuestions: 10,
  },
] as const

export const DEFAULT_BRAIN_MODE: BrainModeId = 'review-run'
export const LEGACY_BRAIN_MODE: BrainModeId = 'plan-only'
export const BRAIN_QUESTION_LIMIT_PER_TURN = 12

export function isBrainModeId(value: unknown): value is BrainModeId {
  return typeof value === 'string' && (BRAIN_MODE_IDS as readonly string[]).includes(value)
}

export function getBrainMode(modeId: BrainModeId): BrainModeDefinition {
  return BRAIN_MODES.find((mode) => mode.id === modeId) ?? BRAIN_MODES[0]
}

export function brainQuestionLimitForTurn(modeId: BrainModeId, questionsAsked: number): number {
  const maxQuestions = getBrainMode(modeId).maxQuestions
  if (maxQuestions == null) return BRAIN_QUESTION_LIMIT_PER_TURN
  return Math.max(0, maxQuestions - Math.max(0, Math.floor(questionsAsked)))
}

export function brainQuestionBudgetLabel(modeId: BrainModeId, questionsAsked: number): string {
  const maxQuestions = getBrainMode(modeId).maxQuestions
  return maxQuestions == null
    ? 'Questions as needed'
    : `${Math.min(maxQuestions, Math.max(0, questionsAsked))}/${maxQuestions} questions used`
}

export function brainModePlannerInstruction(modeId: BrainModeId, questionsAsked: number): string {
  const mode = getBrainMode(modeId)
  const remaining = brainQuestionLimitForTurn(modeId, questionsAsked)
  if (mode.runPolicy === 'none') {
    return `Workflow mode: Plan Only. Build a complete reviewable plan and never claim that execution was requested. Return at most ${remaining} questions in this turn.`
  }
  if (mode.runPolicy === 'approval') {
    return `Workflow mode: Review & Run. Build a complete plan that must stop for explicit plan approval before execution. Return at most ${remaining} questions in this turn.`
  }
  return [
    `Workflow mode: ${mode.title}. This draft may ask at most ${mode.maxQuestions} planning questions in total; ${questionsAsked} have already been asked and ${remaining} remain.`,
    remaining === 0
      ? 'The question budget is exhausted. Return an empty questions array and disclose every low-risk, reversible assumption in the summary.'
      : `Return no more than ${remaining} high-impact questions. Combine closely related choices into one concise question when possible.`,
    'Never assume identity rights, upload consent, spending authorization, destructive timeline approval, or another mandatory safety confirmation. Put unresolved mandatory gates in executionBlockers; they are handled by execution preflight and do not consume the creative-question budget.',
  ].join(' ')
}
