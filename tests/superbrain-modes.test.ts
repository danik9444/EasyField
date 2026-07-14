import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRAIN_MODES,
  DEFAULT_BRAIN_MODE,
  LEGACY_BRAIN_MODE,
  brainModePlannerInstruction,
  brainQuestionLimitForTurn,
  getBrainMode,
  isBrainModeId,
} from '../src/data/superBrainModes.ts'
import { validateBrainPlan } from '../src/services/chat.ts'

const plan = (questions: number, blockers: string[] = []) => ({
  summary: 'A safe workflow plan',
  questions: Array.from({ length: questions }, (_, index) => ({ id: `q-${index}`, question: `Decision ${index + 1}?`, reason: 'Needed for the plan' })),
  steps: [{
    id: 'step-1',
    toolId: 'create-video',
    title: 'Create shot',
    purpose: 'Build the approved shot',
    modelPreference: null,
    source: 'Editor brief',
    output: 'Video clip',
    placement: 'media-pool',
    dependsOn: [],
    destructive: false,
    maxCredits: null,
  }],
  assumptions: [],
  executionBlockers: blockers,
  maxCredits: null,
})

test('SuperBrain exposes four distinct workflow modes with a safe legacy migration', () => {
  assert.equal(BRAIN_MODES.length, 4)
  assert.equal(new Set(BRAIN_MODES.map((mode) => mode.id)).size, 4)
  assert.equal(DEFAULT_BRAIN_MODE, 'review-run')
  assert.equal(LEGACY_BRAIN_MODE, 'plan-only')
  assert.equal(getBrainMode('plan-only').runPolicy, 'none')
  assert.equal(getBrainMode('review-run').runPolicy, 'approval')
})

test('Quick and Guided question budgets are cumulative across planning turns', () => {
  assert.equal(brainQuestionLimitForTurn('quick-run', 0), 3)
  assert.equal(brainQuestionLimitForTurn('quick-run', 2), 1)
  assert.equal(brainQuestionLimitForTurn('quick-run', 3), 0)
  assert.equal(brainQuestionLimitForTurn('quick-run', 30), 0)
  assert.equal(brainQuestionLimitForTurn('guided-run', 0), 10)
  assert.equal(brainQuestionLimitForTurn('guided-run', 7), 3)
  assert.equal(brainQuestionLimitForTurn('plan-only', 99), 12)
})

test('mode guards reject unknown persisted values', () => {
  assert.equal(isBrainModeId('quick-run'), true)
  assert.equal(isBrainModeId('run-everything'), false)
  assert.equal(isBrainModeId(null), false)
})

test('automatic mode instructions preserve mandatory safety preflight', () => {
  const prompt = brainModePlannerInstruction('quick-run', 3)
  assert.match(prompt, /question budget is exhausted/i)
  assert.match(prompt, /empty questions array/i)
  assert.match(prompt, /identity rights/i)
  assert.match(prompt, /executionBlockers/i)
})

test('plans above a mode question limit are blocked instead of silently truncated', () => {
  assert.throws(() => validateBrainPlan(plan(4), 3), /above this mode's limit of 3/i)
  assert.equal(validateBrainPlan(plan(3), 3).questions.length, 3)
  assert.throws(() => validateBrainPlan(plan(1), 0), /limit of 0/i)
})

test('execution readiness is computed locally from questions and blockers', () => {
  assert.equal(validateBrainPlan(plan(0), 3).readyForExecution, true)
  assert.equal(validateBrainPlan(plan(1), 3).readyForExecution, false)
  assert.equal(validateBrainPlan(plan(0, ['Rights confirmation required']), 3).readyForExecution, false)
})
