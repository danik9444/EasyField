import assert from 'node:assert/strict'
import test from 'node:test'
import {
  makeFoleyEventStates,
  normalizeSoundEffectsPreferences,
  FOLEY_GUIDANCE_MODES,
  SOUND_EFFECT_MODES,
  foleyRecordFrame,
  resolveFoleyDirection,
} from '../src/data/soundEffects.ts'
import { TOOL_BY_ID } from '../src/data/toolDefinitions.ts'
import { soundEffectsRunEstimate } from '../src/data/pricing.ts'
import { validateFoleyPlan } from '../src/services/chat.ts'
import { orderedVideoSampleTimes } from '../src/services/videoContext.ts'

test('Sound Effects exposes two workflows and preserves legacy preferences safely', () => {
  const prompt = normalizeSoundEffectsPreferences({ workflow: 'Prompt effect', prompt: 'Door slam', model: 'V5' })
  const foley = normalizeSoundEffectsPreferences({ workflow: 'Auto Foley' })
  const picture = normalizeSoundEffectsPreferences({ mode: 'picture', picturePrompt: 'Prioritize the metal latch and omit room tone' })
  const automatic = normalizeSoundEffectsPreferences({ mode: 'foley', foleyGuidance: 'auto', foleyDirection: 'Keep this draft' })
  const invalidGuidance = normalizeSoundEffectsPreferences({ mode: 'foley', foleyGuidance: 'unknown' })

  assert.deepEqual(SOUND_EFFECT_MODES.map((mode) => mode.id), ['single', 'foley'])
  assert.deepEqual(FOLEY_GUIDANCE_MODES.map((mode) => mode.id), ['guided', 'auto'])
  assert.equal(prompt.mode, 'single')
  assert.equal(prompt.singlePrompt, 'Door slam')
  assert.equal(prompt.model, 'V5')
  assert.equal(foley.mode, 'foley')
  assert.equal(foley.foleyGuidance, 'guided')
  assert.equal(picture.mode, 'foley')
  assert.equal(picture.foleyGuidance, 'guided')
  assert.equal(picture.foleyDirection, 'Prioritize the metal latch and omit room tone')
  assert.equal(automatic.foleyGuidance, 'auto')
  assert.equal(automatic.foleyDirection, 'Keep this draft')
  assert.equal(invalidGuidance.foleyGuidance, 'guided')
})

test('Foley guidance can never leak a hidden prompt into Full auto', () => {
  assert.equal(resolveFoleyDirection('guided', '  Prioritize footsteps  '), 'Prioritize footsteps')
  assert.equal(resolveFoleyDirection('auto', 'A saved prompt remains available when switching back'), '')
})

test('Sound Effects catalog contains only standalone sound and reviewed Auto Foley', () => {
  const tool = TOOL_BY_ID.sfx
  assert.deepEqual(tool.recipes.map((recipe) => recipe.id), ['single', 'foley'])
  assert.equal(tool.description.toLowerCase().includes('picture'), false)
  assert.deepEqual(tool.sourceKinds, ['video'])
})

test('video frame sampling is chronological, bounded and avoids the exact media end', () => {
  const samples = orderedVideoSampleTimes(12, 8)
  assert.equal(samples.length, 8)
  assert.equal(samples.every((time, index) => time >= 0 && time < 12 && (index === 0 || time > samples[index - 1])), true)
  assert.deepEqual(orderedVideoSampleTimes(0, 8), [])
  assert.equal(orderedVideoSampleTimes(2, 50).length, 3)
})

test('Auto Foley plans are validated, ordered and bounded by the source clip', () => {
  const plan = validateFoleyPlan({
    summary: 'Two visible contacts.',
    events: [
      { startSeconds: 3.2, endSeconds: 3.8, title: 'Door close', prompt: 'A solid wooden door closing.', reason: 'The door visibly meets the frame.', confidence: 'high' },
      { startSeconds: 0.4, endSeconds: 0.9, title: 'Footstep', prompt: 'One leather shoe step on concrete.', reason: 'The shoe visibly contacts the floor.', confidence: 'medium' },
    ],
  }, 5)
  assert.deepEqual(plan.events.map((event) => event.title), ['Footstep', 'Door close'])
  const states = makeFoleyEventStates(plan.events, 'test')
  assert.equal(states.every((event) => event.approved && event.status === 'ready' && event.urls.length === 0), true)

  assert.throws(() => validateFoleyPlan({
    summary: 'Invalid',
    events: [{ startSeconds: 4.8, endSeconds: 5.5, title: 'Late', prompt: 'Late sound', reason: 'Outside', confidence: 'low' }],
  }, 5), /outside the source clip/)
})

test('counted Foley pricing scales once per approved provider request', () => {
  const one = soundEffectsRunEstimate(1)
  const four = soundEffectsRunEstimate(4)
  assert.equal(four.count, 4)
  assert.equal(four.credits, (one.credits ?? 0) * 4)
})

test('timed Foley placement derives an exact frame inside the frozen source item', () => {
  const anchor = {
    fps: 24,
    itemId: 'clip-1',
    itemStartFrame: 100,
    itemEndFrame: 220,
    projectId: 'project-1',
    timelineId: 'timeline-1',
  }
  assert.equal(foleyRecordFrame(anchor.itemStartFrame, anchor.itemEndFrame, anchor.fps, 2.5), 160)
  assert.equal(foleyRecordFrame(anchor.itemStartFrame, anchor.itemEndFrame, anchor.fps, 5), null, 'the exclusive clip end is not a valid placement anchor')
  assert.equal(foleyRecordFrame(anchor.itemStartFrame, anchor.itemEndFrame, anchor.fps, -1), null)
})
