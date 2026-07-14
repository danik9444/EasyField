import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STORYBOARD_DEFAULT_ASPECT,
  STORYBOARD_DEFAULT_MODEL,
  STORYBOARD_DEFAULT_RESOLUTION,
  STORYBOARD_DEFAULT_SCENE_COUNT,
  STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS,
  STORYBOARD_MAX_EXPLANATION_LENGTH,
  STORYBOARD_MAX_PROMPT_LENGTH,
  STORYBOARD_MAX_SCENES,
  STORYBOARD_MAX_STORY_BRIEF_LENGTH,
  STORYBOARD_MAX_STORY_SUMMARY_LENGTH,
  STORYBOARD_MAX_TITLE_LENGTH,
  STORYBOARD_SCHEMA_VERSION,
  adjustStoryboardSceneDuration,
  appendStoryboardSceneWithTiming,
  autoStoryboardTiming,
  buildStoryboardEnhancementContext,
  createDefaultStoryboardDraft,
  createStoryboardScene,
  distributeStoryboardDurations,
  isStoryboardApprovalStale,
  normalizeStoryboardDraft,
  removeStoryboardSceneWithTiming,
  reorderStoryboardScenes,
  resizeStoryboardScenes,
  scaleStoryboardDurations,
  selectPendingStoryboardScenes,
  storyboardCompleteStory,
  storyboardSceneTimings,
  storyboardSceneHasContent,
} from '../src/data/storyboard.ts'

test('new storyboard drafts use schema v4 and leave timing optional by default', () => {
  const draft = createDefaultStoryboardDraft()

  assert.equal(STORYBOARD_SCHEMA_VERSION, 4)
  assert.equal(STORYBOARD_DEFAULT_SCENE_COUNT, 1)
  assert.equal(draft.schemaVersion, 4)
  assert.equal(draft.workflowMode, 'full')
  assert.equal(draft.timingMode, 'none')
  assert.deepEqual(draft.referenceCreationIds, [])
  assert.equal(draft.title, '')
  assert.equal(draft.storyBrief, '')
  assert.equal(draft.storySummary, '')
  assert.equal(draft.totalDurationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
  assert.equal(draft.scenes.length, 1)
  assert.equal(draft.scenes[0].title, '')
  assert.equal(draft.scenes[0].prompt, '')
  assert.equal(draft.scenes[0].explanation, '')
  assert.equal(draft.scenes[0].durationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
})

test('schema v1 drafts migrate without losing scenes, generations, or approvals', () => {
  const migrated = normalizeStoryboardDraft({
    schemaVersion: 1,
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    style: 'Cinematic',
    scenes: [
      {
        id: 'legacy-opening',
        prompt: 'A courier enters the empty station.',
        candidates: [{
          creationId: 'legacy-frame-1',
          promptSnapshot: 'A courier enters the empty station.',
          model: STORYBOARD_DEFAULT_MODEL,
          aspect: STORYBOARD_DEFAULT_ASPECT,
          resolution: STORYBOARD_DEFAULT_RESOLUTION,
          extras: { format: 'PNG' },
          createdAt: 123,
        }],
        approvedCreationId: 'legacy-frame-1',
        approvedPromptSnapshot: 'A courier enters the empty station.',
      },
      {
        id: 'legacy-ending',
        prompt: 'The train disappears into morning fog.',
        candidates: [],
        approvedCreationId: null,
        approvedPromptSnapshot: null,
      },
    ],
  })

  assert.equal(migrated.schemaVersion, STORYBOARD_SCHEMA_VERSION)
  assert.equal(migrated.workflowMode, 'full')
  assert.equal(migrated.timingMode, 'none')
  assert.deepEqual(migrated.referenceCreationIds, [])
  assert.equal(migrated.title, '')
  assert.equal(migrated.storyBrief, '')
  assert.equal(migrated.storySummary, '')
  assert.equal(migrated.style, 'Cinematic')
  assert.equal(migrated.totalDurationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
  assert.equal(migrated.scenes.length, 2)
  assert.deepEqual(migrated.scenes.map((scene) => scene.durationSeconds), [15, 15])
  assert.deepEqual(migrated.scenes.map((scene) => scene.id), ['legacy-opening', 'legacy-ending'])
  assert.equal(migrated.scenes[0].title, '')
  assert.equal(migrated.scenes[0].explanation, '')
  assert.equal(migrated.scenes[0].candidates[0].creationId, 'legacy-frame-1')
  assert.equal(migrated.scenes[0].approvedCreationId, 'legacy-frame-1')
  assert.equal(migrated.scenes[0].approvedPromptSnapshot, 'A courier enters the empty station.')
})

test('schema v2 drafts gain a safe timing plan without losing approved work', () => {
  const migrated = normalizeStoryboardDraft({
    schemaVersion: 2,
    totalDurationSeconds: 40,
    scenes: [
      {
        id: 'approved-scene',
        prompt: 'Approved opening',
        candidates: [{ creationId: 'approved-frame', promptSnapshot: 'Approved opening' }],
        approvedCreationId: 'approved-frame',
        approvedPromptSnapshot: 'Approved opening',
      },
      { id: 'ending', prompt: 'Quiet ending' },
    ],
  })

  assert.equal(migrated.schemaVersion, STORYBOARD_SCHEMA_VERSION)
  assert.equal(migrated.timingMode, 'none')
  assert.equal(migrated.totalDurationSeconds, 40)
  assert.equal(migrated.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 40)
  assert.equal(migrated.scenes[0].approvedCreationId, 'approved-frame')
  assert.equal(migrated.scenes[0].approvedPromptSnapshot, 'Approved opening')
})

test('schema v3 timed drafts migrate to Manual and preserve their visible timing intent', () => {
  const migrated = normalizeStoryboardDraft({
    schemaVersion: 3,
    totalDurationSeconds: 24,
    scenes: [
      { id: 'opening', durationSeconds: 9 },
      { id: 'ending', durationSeconds: 15 },
    ],
  })

  assert.equal(migrated.timingMode, 'manual')
  assert.equal(migrated.totalDurationSeconds, 24)
  assert.deepEqual(migrated.scenes.map((scene) => scene.durationSeconds), [9, 15])
})

test('timing mode normalization accepts the three modes and safely falls back to no timing', () => {
  for (const timingMode of ['none', 'auto', 'manual'] as const) {
    assert.equal(normalizeStoryboardDraft({ schemaVersion: 4, timingMode }).timingMode, timingMode)
  }
  for (const timingMode of ['', 'automatic', 'MANUAL', 2, null, {}]) {
    assert.equal(normalizeStoryboardDraft({ schemaVersion: 4, timingMode }).timingMode, 'none')
  }
})

test('storyboard workflow mode normalization preserves scenes and rejects unknown values', () => {
  const scenesMode = normalizeStoryboardDraft({ workflowMode: 'scenes' })
  assert.equal(scenesMode.workflowMode, 'scenes')

  for (const invalidMode of ['scene', 'FULL', '', 1, null, { mode: 'scenes' }]) {
    assert.equal(normalizeStoryboardDraft({ workflowMode: invalidMode }).workflowMode, 'full')
  }
})

test('complete story source is strict to the selected workflow mode', () => {
  const base = createDefaultStoryboardDraft()
  const draft = {
    ...base,
    storyBrief: 'FULL MODE STORY BRIEF',
    storySummary: 'BY-SCENES STORY SUMMARY',
  }

  assert.equal(storyboardCompleteStory({ ...draft, workflowMode: 'full' }), 'FULL MODE STORY BRIEF')
  assert.equal(storyboardCompleteStory({ ...draft, workflowMode: 'scenes' }), 'BY-SCENES STORY SUMMARY')
})

test('scene enhancement context contains the complete story and every ordered scene row', () => {
  const base = createDefaultStoryboardDraft()
  const scenes = [
    { ...createStoryboardScene('opening'), title: 'פתיחה', prompt: 'OPENING_PROMPT', explanation: 'OPENING_REASON' },
    { ...createStoryboardScene('turn'), title: 'TURN_TITLE', prompt: 'TURN_PROMPT', explanation: 'TURN_REASON' },
    { ...createStoryboardScene('ending'), title: 'ENDING_TITLE', prompt: 'ENDING_PROMPT', explanation: 'ENDING_REASON' },
  ]
  const context = buildStoryboardEnhancementContext({
    ...base,
    workflowMode: 'scenes',
    timingMode: 'manual',
    title: 'CONTEXT_BOARD',
    storyBrief: 'HIDDEN_FULL_BRIEF',
    storySummary: 'COMPLETE_STORY_SENTINEL',
    style: 'Cinematic',
    scenes,
  }, 'turn')

  assert.match(context, /COMPLETE_STORY_SENTINEL/)
  assert.doesNotMatch(context, /HIDDEN_FULL_BRIEF/)
  for (const sentinel of ['פתיחה', 'OPENING_PROMPT', 'OPENING_REASON', 'TURN_TITLE', 'TURN_PROMPT', 'TURN_REASON', 'ENDING_TITLE', 'ENDING_PROMPT', 'ENDING_REASON']) {
    assert.match(context, new RegExp(sentinel))
  }
  assert.match(context, /SCENE 02 · CURRENT SCENE/)
  assert.match(context, /Total story duration: 30 seconds/)
  assert.match(context, /Timing: 10s–20s · 10s/)
  assert(context.indexOf('OPENING_PROMPT') < context.indexOf('TURN_PROMPT'))
  assert(context.indexOf('TURN_PROMPT') < context.indexOf('ENDING_PROMPT'))
})

test('no-timing enhancement context does not leak hidden duration values', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.timingMode = 'none'
  draft.totalDurationSeconds = 777
  draft.scenes[0].durationSeconds = 111
  draft.scenes[1].durationSeconds = 666
  draft.scenes[0].prompt = 'Opening image'
  draft.scenes[1].prompt = 'Closing image'

  const context = buildStoryboardEnhancementContext(draft)
  assert.doesNotMatch(context, /Timing mode|Total story duration|Timing:|777|666|111/)
  assert.match(context, /Opening image/)
  assert.match(context, /Closing image/)
})

test('enhancement context keeps the final row of a maximum-size scene plan', () => {
  const base = createDefaultStoryboardDraft()
  const scenes = Array.from({ length: STORYBOARD_MAX_SCENES }, (_, index) => ({
    ...createStoryboardScene(`scene-${index + 1}`),
    title: `Title ${index + 1}`,
    prompt: `Prompt ${index + 1}`,
    explanation: index === STORYBOARD_MAX_SCENES - 1 ? 'FINAL_SCENE_EXPLANATION_SENTINEL' : `Reason ${index + 1}`,
  }))
  const context = buildStoryboardEnhancementContext({
    ...base,
    workflowMode: 'scenes',
    timingMode: 'manual',
    storySummary: 'Complete arc',
    scenes,
  }, scenes[0].id)

  assert.match(context, /SCENE 20/)
  assert.match(context, /FINAL_SCENE_EXPLANATION_SENTINEL/)
})

test('storyboard style normalization removes the legacy Storyboard preset', () => {
  assert.equal(normalizeStoryboardDraft({ style: 'Cinematic' }).style, 'Cinematic')
  assert.equal(normalizeStoryboardDraft({ style: 'Storyboard' }).style, '')
  assert.equal(normalizeStoryboardDraft({ style: 'None' }).style, '')
  assert.equal(normalizeStoryboardDraft({ style: 'Unknown visual style' }).style, '')
})

test('storyboard reference IDs are deduplicated and capped by the selected model', () => {
  const seedream = normalizeStoryboardDraft({
    model: 'Seedream 5 Pro',
    referenceCreationIds: ['ref-a', 'ref-a', '', 42, 'ref-b'],
  })
  assert.deepEqual(seedream.referenceCreationIds, ['ref-a', 'ref-b'])

  const qwen = normalizeStoryboardDraft({
    model: 'Qwen2 Image',
    referenceCreationIds: ['ref-a', 'ref-b', 'ref-c'],
  })
  assert.deepEqual(qwen.referenceCreationIds, ['ref-a'])
})

test('corrupt storyboard hydration is bounded, sanitized, and gets unique stable scene IDs', () => {
  const fallback = normalizeStoryboardDraft(null)
  assert.equal(fallback.model, STORYBOARD_DEFAULT_MODEL)
  assert.equal(fallback.aspect, STORYBOARD_DEFAULT_ASPECT)
  assert.equal(fallback.resolution, STORYBOARD_DEFAULT_RESOLUTION)
  assert.equal(fallback.scenes.length, STORYBOARD_DEFAULT_SCENE_COUNT)

  const hydrated = normalizeStoryboardDraft({
    schemaVersion: 999,
    model: '../../not-a-model',
    aspect: 'broken',
    resolution: '32K',
    extras: { format: 'EXE', injected: 'yes' },
    title: `Board\u0000${'t'.repeat(STORYBOARD_MAX_TITLE_LENGTH + 80)}`,
    storyBrief: `Brief\u0000${'b'.repeat(STORYBOARD_MAX_STORY_BRIEF_LENGTH + 80)}`,
    storySummary: `Summary\u0000${'s'.repeat(STORYBOARD_MAX_STORY_SUMMARY_LENGTH + 80)}`,
    style: ` cinematic\u0000${'x'.repeat(900)}`,
    scenes: Array.from({ length: STORYBOARD_MAX_SCENES + 8 }, (_, index) => ({
      id: index < 2 ? 'duplicate' : '',
      title: index === 0 ? `Opening\u0000${'t'.repeat(STORYBOARD_MAX_TITLE_LENGTH + 80)}` : 42,
      prompt: index === 0 ? 'Opening\u0000 frame' : 42,
      explanation: index === 0 ? `Meaning\u0000${'e'.repeat(STORYBOARD_MAX_EXPLANATION_LENGTH + 80)}` : 42,
      candidates: index === 0 ? [
        { creationId: 'creation-1', promptSnapshot: 'Opening frame', model: 'bad', createdAt: -4 },
        { creationId: 'creation-1', promptSnapshot: 'duplicate' },
        { creationId: '' },
      ] : 'bad',
      approvedCreationId: index === 0 ? 'creation-1' : 7,
      approvedPromptSnapshot: index === 0 ? 'Opening frame' : 'orphan',
    })),
  })

  assert.equal(hydrated.model, STORYBOARD_DEFAULT_MODEL)
  assert.equal(hydrated.aspect, STORYBOARD_DEFAULT_ASPECT)
  assert.equal(hydrated.resolution, STORYBOARD_DEFAULT_RESOLUTION)
  assert.deepEqual(hydrated.extras, { format: 'PNG' })
  assert.equal(hydrated.title.includes('\u0000'), false)
  assert.equal(hydrated.title.length, STORYBOARD_MAX_TITLE_LENGTH)
  assert.equal(hydrated.storyBrief.includes('\u0000'), false)
  assert.equal(hydrated.storyBrief.length, STORYBOARD_MAX_STORY_BRIEF_LENGTH)
  assert.equal(hydrated.storySummary.includes('\u0000'), false)
  assert.equal(hydrated.storySummary.length, STORYBOARD_MAX_STORY_SUMMARY_LENGTH)
  assert.equal(hydrated.style, '')
  assert.equal(hydrated.scenes.length, STORYBOARD_MAX_SCENES)
  assert.equal(new Set(hydrated.scenes.map((scene) => scene.id)).size, STORYBOARD_MAX_SCENES)
  assert.equal(hydrated.scenes[0].id, 'duplicate')
  assert.notEqual(hydrated.scenes[1].id, 'duplicate')
  assert.equal(hydrated.scenes[0].title.includes('\u0000'), false)
  assert.equal(hydrated.scenes[0].title.length, STORYBOARD_MAX_TITLE_LENGTH)
  assert.equal(hydrated.scenes[0].prompt, 'Opening frame')
  assert.equal(hydrated.scenes[0].prompt.length <= STORYBOARD_MAX_PROMPT_LENGTH, true)
  assert.equal(hydrated.scenes[0].explanation.includes('\u0000'), false)
  assert.equal(hydrated.scenes[0].explanation.length, STORYBOARD_MAX_EXPLANATION_LENGTH)
  assert.equal(hydrated.scenes[0].candidates.length, 1)
  assert.equal(hydrated.scenes[0].candidates[0].model, STORYBOARD_DEFAULT_MODEL)
  assert.equal(hydrated.scenes[0].candidates[0].createdAt, 0)
  assert.equal(hydrated.scenes[1].approvedPromptSnapshot, null)
})

test('resizing up preserves existing scene IDs and adds distinct blank scenes', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.scenes[0].prompt = 'First'
  const originalIds = draft.scenes.map((scene) => scene.id)
  const resized = resizeStoryboardScenes(draft.scenes, 5)

  assert.equal(resized.changed, true)
  assert.equal(resized.blocked, false)
  assert.equal(resized.scenes.length, 5)
  assert.deepEqual(resized.scenes.slice(0, 2).map((scene) => scene.id), originalIds)
  assert.equal(new Set(resized.scenes.map((scene) => scene.id)).size, 5)
  assert.deepEqual(resized.scenes.slice(2).map((scene) => scene.prompt), ['', '', ''])
})

test('reducing protects non-empty trailing scenes until discard is explicitly allowed', () => {
  const draft = createDefaultStoryboardDraft(4)
  draft.scenes[3].candidates.push({
    creationId: 'candidate-kept',
    promptSnapshot: 'A generated ending',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: 10,
  })

  const protectedResize = resizeStoryboardScenes(draft.scenes, 2)
  assert.equal(protectedResize.blocked, true)
  assert.equal(protectedResize.wouldDiscardContent, true)
  assert.equal(protectedResize.changed, false)
  assert.equal(protectedResize.scenes.length, 4)
  assert.deepEqual(protectedResize.affectedSceneIds, draft.scenes.slice(2).map((scene) => scene.id))

  const confirmedResize = resizeStoryboardScenes(draft.scenes, 2, { allowDiscard: true })
  assert.equal(confirmedResize.blocked, false)
  assert.equal(confirmedResize.wouldDiscardContent, true)
  assert.equal(confirmedResize.changed, true)
  assert.deepEqual(confirmedResize.scenes.map((scene) => scene.id), draft.scenes.slice(0, 2).map((scene) => scene.id))
})

test('scene titles and explanations count as protected content when removing scenes', () => {
  const titleScenes = [createStoryboardScene('title-head'), createStoryboardScene('title-tail')]
  titleScenes[1].title = 'The encounter'
  assert.equal(storyboardSceneHasContent(titleScenes[1]), true)
  const titleResize = resizeStoryboardScenes(titleScenes, 1)
  assert.equal(titleResize.blocked, true)
  assert.equal(titleResize.wouldDiscardContent, true)

  const explanationScenes = [createStoryboardScene('explanation-head'), createStoryboardScene('explanation-tail')]
  explanationScenes[1].explanation = 'This reversal explains why the courier abandons the package.'
  assert.equal(storyboardSceneHasContent(explanationScenes[1]), true)
  const explanationResize = resizeStoryboardScenes(explanationScenes, 1)
  assert.equal(explanationResize.blocked, true)
  assert.equal(explanationResize.wouldDiscardContent, true)
})

test('storyboard timing always sums exactly to the authoritative total', () => {
  const draft = createDefaultStoryboardDraft(3)
  assert.deepEqual(draft.scenes.map((scene) => scene.durationSeconds), [10, 10, 10])

  const weighted = draft.scenes.map((scene, index) => ({
    ...scene,
    durationSeconds: [20, 5, 5][index],
  }))
  const scaled = scaleStoryboardDurations(weighted, 60)
  assert.deepEqual(scaled.map((scene) => scene.durationSeconds), [40, 10, 10])
  assert.equal(scaled.reduce((sum, scene) => sum + scene.durationSeconds, 0), 60)

  const even = distributeStoryboardDurations(scaled, 31)
  assert.deepEqual(even.map((scene) => scene.durationSeconds), [11, 10, 10])
  assert.equal(even.reduce((sum, scene) => sum + scene.durationSeconds, 0), 31)
})

test('automatic timing derives a complete pace from story and scene density', () => {
  const scenes = [
    { ...createStoryboardScene('quiet'), title: 'Quiet opening', prompt: 'A still empty room before dawn.' },
    { ...createStoryboardScene('dense'), title: 'Climax', prompt: 'The courier races through the station, confronts the guard, loses the package, turns back, and makes a final choice under flashing emergency lights.' },
  ]
  const automatic = autoStoryboardTiming(scenes, 'A courier must decide whether delivering the package matters more than saving a stranger.')

  assert(automatic.totalDurationSeconds >= 5)
  assert.equal(automatic.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), automatic.totalDurationSeconds)
  assert(automatic.scenes[1].durationSeconds > automatic.scenes[0].durationSeconds)
})

test('changing one scene duration compensates the next scene and never changes the total', () => {
  const scenes = createDefaultStoryboardDraft(3).scenes
  const extended = adjustStoryboardSceneDuration(scenes, scenes[0].id, 15, 30)
  assert.deepEqual(extended.map((scene) => scene.durationSeconds), [15, 5, 10])

  const shortened = adjustStoryboardSceneDuration(scenes, scenes[0].id, 5, 30)
  assert.deepEqual(shortened.map((scene) => scene.durationSeconds), [5, 15, 10])
  assert.equal(shortened.reduce((sum, scene) => sum + scene.durationSeconds, 0), 30)
})

test('adding splits the longest scene and removing transfers its time to an adjacent scene', () => {
  const initial = createDefaultStoryboardDraft(2)
  initial.scenes[0].durationSeconds = 20
  initial.scenes[1].durationSeconds = 10

  const appended = appendStoryboardSceneWithTiming(initial.scenes, 30, createStoryboardScene('new-scene'))
  assert.equal(appended.totalDurationSeconds, 30)
  assert.deepEqual(appended.scenes.map((scene) => scene.durationSeconds), [10, 10, 10])
  assert.equal(appended.scenes.at(-1)?.id, 'new-scene')

  const withCustomTiming = appended.scenes.map((scene, index) => ({ ...scene, durationSeconds: [10, 8, 12][index] }))
  const removed = removeStoryboardSceneWithTiming(withCustomTiming, withCustomTiming[1].id, 30)
  assert.equal(removed.totalDurationSeconds, 30)
  assert.deepEqual(removed.scenes.map((scene) => scene.durationSeconds), [10, 20])
  assert.equal(removed.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 30)
})

test('derived timing follows scene order while duration stays attached to each scene', () => {
  const scenes = ['a', 'b', 'c'].map((id, index) => ({
    ...createStoryboardScene(id),
    durationSeconds: [4, 7, 9][index],
  }))
  const reordered = reorderStoryboardScenes(scenes, 'a', 2)
  assert.deepEqual(reordered.map((scene) => [scene.id, scene.durationSeconds]), [['b', 7], ['c', 9], ['a', 4]])
  assert.deepEqual(
    storyboardSceneTimings(reordered).map((timing) => [timing.sceneId, timing.startSeconds, timing.endSeconds]),
    [['b', 0, 7], ['c', 7, 16], ['a', 16, 20]],
  )
})

test('invalid timing hydrates safely and does not make a blank scene count as content', () => {
  const hydrated = normalizeStoryboardDraft({
    totalDurationSeconds: Number.POSITIVE_INFINITY,
    scenes: [
      { id: 'negative', durationSeconds: -12 },
      { id: 'nan', durationSeconds: Number.NaN },
      { id: 'huge', durationSeconds: 999_999 },
    ],
  })
  assert.equal(hydrated.totalDurationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
  assert.equal(hydrated.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), hydrated.totalDurationSeconds)
  assert(hydrated.scenes.every((scene) => scene.durationSeconds >= 1))
  assert.equal(storyboardSceneHasContent(hydrated.scenes[0]), false)
})

test('pending selection skips blank, approved, and in-flight scenes, including stale approvals', () => {
  const scenes = ['ready', 'stale', 'pending', 'flight', 'blank'].map((id) => createStoryboardScene(id))
  scenes[0].prompt = 'Ready scene'
  scenes[0].approvedCreationId = 'creation-ready'
  scenes[0].approvedPromptSnapshot = 'Ready scene'
  scenes[1].prompt = 'Edited after approval'
  scenes[1].approvedCreationId = 'creation-stale'
  scenes[1].approvedPromptSnapshot = 'Old approved prompt'
  scenes[2].prompt = 'Generate me'
  scenes[3].prompt = 'Already generating'

  assert.equal(isStoryboardApprovalStale(scenes[0]), false)
  assert.equal(isStoryboardApprovalStale(scenes[1]), true)
  assert.deepEqual(
    selectPendingStoryboardScenes(scenes, new Set(['flight'])).map((scene) => scene.id),
    ['pending'],
  )
})

test('reordering moves a scene without changing IDs or scene content', () => {
  const scenes = ['a', 'b', 'c', 'd'].map((id) => {
    const scene = createStoryboardScene(id)
    scene.prompt = `Prompt ${id}`
    return scene
  })

  const reordered = reorderStoryboardScenes(scenes, 'b', 3)
  assert.deepEqual(reordered.map((scene) => scene.id), ['a', 'c', 'd', 'b'])
  assert.deepEqual(reordered.map((scene) => scene.prompt), ['Prompt a', 'Prompt c', 'Prompt d', 'Prompt b'])
  assert.deepEqual(reorderStoryboardScenes(reordered, 'missing', 0).map((scene) => scene.id), ['a', 'c', 'd', 'b'])
})
