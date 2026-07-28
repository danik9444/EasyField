import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatError,
  resolveStoryboardAutoTiming,
  validateStoryboardAutoTiming,
  validateStoryboardPlan,
} from '../src/services/chat.ts'

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
      { ...untimedPlan.scenes[0], durationSeconds: 4 },
      { ...untimedPlan.scenes[1], durationSeconds: 5 },
    ],
  }, 'manual', 9)

  assert.equal(result.totalDurationSeconds, 9)
  assert.deepEqual(result.scenes.map((scene) => scene.durationSeconds), [4, 5])
  assert.throws(
    () => validateStoryboardPlan({
      ...untimedPlan,
      scenes: untimedPlan.scenes.map((scene) => ({ ...scene, durationSeconds: 4 })),
    }, 'manual', 9),
    (error: unknown) => error instanceof ChatError && /requested total/i.test(error.message),
  )
})

test('automatic storyboard plans derive and validate their own exact total', () => {
  const result = validateStoryboardPlan({
    ...untimedPlan,
    totalDurationSeconds: 8,
    scenes: [
      { ...untimedPlan.scenes[0], durationSeconds: 3 },
      { ...untimedPlan.scenes[1], durationSeconds: 5 },
    ],
  }, 'auto')

  assert.equal(result.totalDurationSeconds, 8)
  assert.deepEqual(result.scenes.map((scene) => scene.durationSeconds), [3, 5])
  assert.throws(
    () => validateStoryboardPlan({
      ...untimedPlan,
      totalDurationSeconds: 9,
      scenes: [
        { ...untimedPlan.scenes[0], durationSeconds: 3 },
        { ...untimedPlan.scenes[1], durationSeconds: 5 },
      ],
    }, 'auto'),
    (error: unknown) => error instanceof ChatError && /mismatched automatic timing/i.test(error.message),
  )
})

test('timed plans reject missing, fractional, out-of-range, and non-positive durations', () => {
  for (const durationSeconds of [undefined, 0, -2, 1.5, 6, Number.NaN]) {
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

test('planner validation rejects a sixteenth scene instead of dropping the ending', () => {
  assert.throws(
    () => validateStoryboardPlan({
      summary: 'One complete arc.',
      scenes: Array.from({ length: 16 }, (_, index) => ({
        title: `Scene ${index + 1}`,
        prompt: `Frame ${index + 1}`,
        explanation: `Beat ${index + 1}`,
      })),
    }, 'none'),
    (error: unknown) => error instanceof ChatError && /more than 15 scenes/i.test(error.message),
  )
})

const authoredTimingScenes = [
  {
    id: 'opening',
    title: 'Opening',
    prompt: 'A quiet station at dawn.',
    explanation: 'Establishes the world.',
    durationMode: 'auto' as const,
    durationSeconds: 5,
  },
  {
    id: 'decision',
    title: 'Decision',
    prompt: 'The courier makes the final choice.',
    explanation: 'Resolves the journey.',
    durationMode: 'manual' as const,
    durationSeconds: 2,
  },
]

test('generation-time Auto timing accepts one exact 1–5 second result per authored scene', () => {
  const result = validateStoryboardAutoTiming({
    totalDurationSeconds: 6,
    scenes: [
      { sceneId: 'opening', durationSeconds: 4 },
      { sceneId: 'decision', durationSeconds: 2 },
    ],
  }, authoredTimingScenes)

  assert.equal(result.totalDurationSeconds, 6)
  assert.deepEqual(result.scenes, [
    { sceneId: 'opening', durationSeconds: 4 },
    { sceneId: 'decision', durationSeconds: 2 },
  ])
})

test('generation-time Auto timing preserves a locked half-second Manual row', () => {
  const scenes = authoredTimingScenes.map((scene) => scene.id === 'decision'
    ? { ...scene, durationSeconds: 2.5 }
    : scene)
  const result = validateStoryboardAutoTiming({
    totalDurationSeconds: 6.5,
    scenes: [
      { sceneId: 'opening', durationSeconds: 4 },
      { sceneId: 'decision', durationSeconds: 2.5 },
    ],
  }, scenes)

  assert.equal(result.totalDurationSeconds, 6.5)
  assert.deepEqual(result.scenes.map((scene) => scene.durationSeconds), [4, 2.5])
})

test('generation-time Auto timing rejects reordered, missing, invalid or changed Manual rows', () => {
  const invalidResponses = [
    {
      totalDurationSeconds: 6,
      scenes: [
        { sceneId: 'decision', durationSeconds: 2 },
        { sceneId: 'opening', durationSeconds: 4 },
      ],
    },
    {
      totalDurationSeconds: 4,
      scenes: [{ sceneId: 'opening', durationSeconds: 4 }],
    },
    {
      totalDurationSeconds: 8,
      scenes: [
        { sceneId: 'opening', durationSeconds: 6 },
        { sceneId: 'decision', durationSeconds: 2 },
      ],
    },
    {
      totalDurationSeconds: 7,
      scenes: [
        { sceneId: 'opening', durationSeconds: 4 },
        { sceneId: 'decision', durationSeconds: 3 },
      ],
    },
    {
      totalDurationSeconds: 9,
      scenes: [
        { sceneId: 'opening', durationSeconds: 4 },
        { sceneId: 'decision', durationSeconds: 2 },
      ],
    },
  ]

  invalidResponses.forEach((response) => {
    assert.throws(
      () => validateStoryboardAutoTiming(response, authoredTimingScenes),
      (error: unknown) => error instanceof ChatError,
    )
  })
})

test('an all-Manual scene list resolves locally without requiring a cloud connection', async () => {
  const scenes = authoredTimingScenes.map((scene, index) => ({
    ...scene,
    durationMode: 'manual' as const,
    durationSeconds: index + 2,
  }))
  const result = await resolveStoryboardAutoTiming({
    completeStory: 'A locked two-scene story.',
    scenes,
    chatModel: 'unused',
  })

  assert.equal(result.chatCredits, 0)
  assert.equal(result.totalDurationSeconds, 5)
  assert.deepEqual(result.scenes.map((scene) => scene.durationSeconds), [2, 3])
})
