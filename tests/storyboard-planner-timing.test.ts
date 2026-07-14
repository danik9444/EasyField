import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatError, validateStoryboardPlan } from '../src/services/chat.ts'

const untimedPlan = {
  summary: 'A complete arc.',
  scenes: [
    { title: 'Opening', prompt: 'A quiet station at dawn.', explanation: 'Establishes the world.' },
    { title: 'Ending', prompt: 'The train disappears into fog.', explanation: 'Resolves the journey.' },
  ],
}

test('no-timing storyboard plans accept text-only scenes and discard hidden timing fields', () => {
  const result = validateStoryboardPlan({
    ...untimedPlan,
    totalDurationSeconds: 999,
    scenes: untimedPlan.scenes.map((scene) => ({ ...scene, durationSeconds: 499 })),
  }, 'none')

  assert.equal(result.totalDurationSeconds, undefined)
  assert(result.scenes.every((scene) => scene.durationSeconds === undefined))
})

test('manual storyboard plans require positive whole scene durations matching the exact total', () => {
  const result = validateStoryboardPlan({
    ...untimedPlan,
    scenes: [
      { ...untimedPlan.scenes[0], durationSeconds: 8 },
      { ...untimedPlan.scenes[1], durationSeconds: 12 },
    ],
  }, 'manual', 20)

  assert.equal(result.totalDurationSeconds, 20)
  assert.deepEqual(result.scenes.map((scene) => scene.durationSeconds), [8, 12])
  assert.throws(
    () => validateStoryboardPlan({
      ...untimedPlan,
      scenes: untimedPlan.scenes.map((scene) => ({ ...scene, durationSeconds: 8 })),
    }, 'manual', 20),
    (error: unknown) => error instanceof ChatError && /requested total/i.test(error.message),
  )
})

test('automatic storyboard plans derive and validate their own exact total', () => {
  const result = validateStoryboardPlan({
    ...untimedPlan,
    totalDurationSeconds: 17,
    scenes: [
      { ...untimedPlan.scenes[0], durationSeconds: 7 },
      { ...untimedPlan.scenes[1], durationSeconds: 10 },
    ],
  }, 'auto')

  assert.equal(result.totalDurationSeconds, 17)
  assert.deepEqual(result.scenes.map((scene) => scene.durationSeconds), [7, 10])
  assert.throws(
    () => validateStoryboardPlan({
      ...untimedPlan,
      totalDurationSeconds: 18,
      scenes: [
        { ...untimedPlan.scenes[0], durationSeconds: 7 },
        { ...untimedPlan.scenes[1], durationSeconds: 10 },
      ],
    }, 'auto'),
    (error: unknown) => error instanceof ChatError && /mismatched automatic timing/i.test(error.message),
  )
})

test('timed plans reject missing, fractional, and non-positive durations', () => {
  for (const durationSeconds of [undefined, 0, -2, 1.5, Number.NaN]) {
    assert.throws(
      () => validateStoryboardPlan({
        ...untimedPlan,
        scenes: untimedPlan.scenes.map((scene, index) => index === 0
          ? { ...scene, durationSeconds }
          : { ...scene, durationSeconds: 5 }),
      }, 'auto'),
      (error: unknown) => error instanceof ChatError && /invalid duration/i.test(error.message),
    )
  }
})
