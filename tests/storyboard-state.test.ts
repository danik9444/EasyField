import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STORYBOARD_DEFAULT_ASPECT,
  STORYBOARD_DEFAULT_MODEL,
  STORYBOARD_DEFAULT_RESOLUTION,
  STORYBOARD_DEFAULT_SCENE_COUNT,
  STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS,
  STORYBOARD_DEFAULT_VERSIONS,
  STORYBOARD_MAX_BOARD_CANDIDATES,
  STORYBOARD_MAX_CANDIDATES_PER_SCENE,
  STORYBOARD_MAX_EXPLANATION_LENGTH,
  STORYBOARD_MAX_PROMPT_LENGTH,
  STORYBOARD_MAX_SCENE_DURATION_SECONDS,
  STORYBOARD_MAX_SCENES,
  STORYBOARD_MAX_TOTAL_DURATION_SECONDS,
  STORYBOARD_MAX_STORY_BRIEF_LENGTH,
  STORYBOARD_MAX_STORY_SUMMARY_LENGTH,
  STORYBOARD_MAX_TITLE_LENGTH,
  STORYBOARD_MAX_VERSIONS,
  STORYBOARD_MIN_SCENE_DURATION_SECONDS,
  STORYBOARD_SCENE_DURATION_STEP_SECONDS,
  STORYBOARD_SCHEMA_VERSION,
  applyStoryboardSceneDurationResolution,
  adjustStoryboardSceneDuration,
  appendStoryboardBoardCandidates,
  appendStoryboardCandidates,
  appendStoryboardSceneWithTiming,
  autoStoryboardTiming,
  buildStoryboardEnhancementContext,
  clampFullStoryboardDuration,
  clampStoryboardSceneDuration,
  clampStoryboardTotalDuration,
  clampStoryboardVersionCount,
  countAvailableStoryboardSceneVersions,
  createDefaultStoryboardDraft,
  createStoryboardScene,
  distributeStoryboardDurations,
  effectiveStoryboardTiming,
  findMissingStoryboardReferenceIds,
  formatStoryboardDuration,
  formatStoryboardTimecode,
  isStoryboardApprovalStale,
  normalizeStoryboardOutputStrategy,
  normalizeStoryboardDraft,
  removeStoryboardSceneWithTiming,
  resolveStoryboardSceneDurations,
  reorderStoryboardScenes,
  resizeStoryboardScenes,
  scaleStoryboardDurations,
  selectPendingStoryboardScenes,
  storyboardCompleteStory,
  storyboardSceneCompletionAction,
  storyboardSceneVersionDeficit,
  storyboardSceneTimings,
  storyboardSceneHasContent,
  type StoryboardBoardCandidate,
} from '../src/data/storyboard.ts'

function boardCandidate(
  creationId: string,
  overrides: Partial<StoryboardBoardCandidate> = {},
): StoryboardBoardCandidate {
  return {
    creationId,
    strategy: 'single-generation',
    promptSnapshot: 'Complete storyboard prompt',
    inputFingerprint: `fingerprint-${creationId}`,
    sourceSceneCreationIds: [],
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: 1,
    ...overrides,
  }
}

test('new storyboard drafts use schema v9 and default to one complete-board generation', () => {
  const draft = createDefaultStoryboardDraft()

  assert.equal(STORYBOARD_SCHEMA_VERSION, 9)
  assert.equal(STORYBOARD_DEFAULT_SCENE_COUNT, 1)
  assert.equal(draft.schemaVersion, 9)
  assert.equal(draft.workflowMode, 'full')
  assert.equal(draft.outputStrategy, 'single-generation')
  assert.equal(draft.includeSeparateSceneFrames, false)
  assert.equal(draft.timingMode, 'none')
  assert.equal(draft.previousStoryboardCreationId, null)
  assert.equal(draft.nextStoryboardCreationId, null)
  assert.deepEqual(draft.referenceCreationIds, [])
  assert.equal(draft.title, '')
  assert.equal(draft.storyBrief, '')
  assert.equal(draft.storySummary, '')
  assert.equal(draft.versionCount, STORYBOARD_DEFAULT_VERSIONS)
  assert.deepEqual(draft.boardCandidates, [])
  assert.equal(draft.approvedBoardCreationId, null)
  assert.equal(draft.totalDurationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
  assert.equal(draft.scenes.length, 1)
  assert.equal(draft.scenes[0].title, '')
  assert.equal(draft.scenes[0].prompt, '')
  assert.equal(draft.scenes[0].explanation, '')
  assert.deepEqual(draft.scenes[0].referenceCreationIds, [])
  assert.equal(draft.scenes[0].versionCount, STORYBOARD_DEFAULT_VERSIONS)
  assert.equal(draft.scenes[0].durationMode, 'auto')
  assert.equal(draft.scenes[0].durationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
})

test('Full Storyboard owns 5–90 seconds while By Scenes keeps its five-second row cap', () => {
  assert.equal(STORYBOARD_MAX_SCENES, 15)
  assert.equal(STORYBOARD_MAX_SCENE_DURATION_SECONDS, 5)
  assert.equal(STORYBOARD_MAX_TOTAL_DURATION_SECONDS, 90)
  assert.equal(clampFullStoryboardDuration(4), 5)
  assert.equal(clampFullStoryboardDuration(5), 5)
  assert.equal(clampFullStoryboardDuration(90), 90)
  assert.equal(clampFullStoryboardDuration(91), 90)
  assert.equal(clampStoryboardTotalDuration(90, STORYBOARD_MAX_SCENES), 75)

  const full = normalizeStoryboardDraft({
    workflowMode: 'full',
    totalDurationSeconds: 90,
    scenes: Array.from({ length: 20 }, (_, index) => ({
      id: `legacy-${index + 1}`,
      durationSeconds: 90,
    })),
  })
  assert.equal(full.scenes.length, STORYBOARD_MAX_SCENES)
  assert.equal(full.totalDurationSeconds, 90)
  assert(full.scenes.every((scene) => scene.durationSeconds === STORYBOARD_MAX_SCENE_DURATION_SECONDS))
  const effectiveFull = effectiveStoryboardTiming(full)
  assert.equal(effectiveFull.totalDurationSeconds, 90)
  assert.equal(effectiveFull.scenes, full.scenes)

  const byScenes = normalizeStoryboardDraft({
    workflowMode: 'scenes',
    timingMode: 'manual',
    totalDurationSeconds: 90,
    scenes: Array.from({ length: STORYBOARD_MAX_SCENES }, (_, index) => ({
      id: `scene-${index + 1}`,
      durationMode: 'manual',
      durationSeconds: 5,
    })),
  })
  assert.equal(byScenes.totalDurationSeconds, 75)
  assert.equal(effectiveStoryboardTiming(byScenes).totalDurationSeconds, 75)
})

test('By Scenes preserves half-second manual duration steps from draft through timing labels', () => {
  assert.equal(STORYBOARD_MIN_SCENE_DURATION_SECONDS, 1)
  assert.equal(STORYBOARD_SCENE_DURATION_STEP_SECONDS, 0.5)
  assert.equal(clampStoryboardSceneDuration(0.5), 1)
  assert.equal(clampStoryboardSceneDuration(1.24), 1)
  assert.equal(clampStoryboardSceneDuration(1.25), 1.5)
  assert.equal(clampStoryboardSceneDuration(5.5), 5)

  const hydrated = normalizeStoryboardDraft({
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    workflowMode: 'scenes',
    timingMode: 'manual',
    totalDurationSeconds: 22,
    scenes: [
      { id: 'opening-half', durationMode: 'manual', durationSeconds: 1.5 },
      { id: 'ending-half', durationMode: 'manual', durationSeconds: 2.5 },
    ],
  })
  assert.deepEqual(hydrated.scenes.map((scene) => scene.durationSeconds), [1.5, 2.5])

  const effective = effectiveStoryboardTiming(hydrated)
  assert.equal(effective.totalDurationSeconds, 4)
  assert.deepEqual(storyboardSceneTimings(effective.scenes), [
    { sceneId: 'opening-half', durationSeconds: 1.5, startSeconds: 0, endSeconds: 1.5 },
    { sceneId: 'ending-half', durationSeconds: 2.5, startSeconds: 1.5, endSeconds: 4 },
  ])
  assert.equal(formatStoryboardDuration(1.5), '1.5s')
  assert.equal(formatStoryboardDuration(61.5), '1m 1.5s')
  assert.equal(formatStoryboardTimecode(1.5), '00:01.5')
  assert.equal(formatStoryboardTimecode(61.5), '01:01.5')
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
  assert.equal(migrated.outputStrategy, 'single-generation')
  assert.equal(migrated.includeSeparateSceneFrames, false)
  assert.equal(migrated.timingMode, 'none')
  assert.deepEqual(migrated.referenceCreationIds, [])
  assert.equal(migrated.title, '')
  assert.equal(migrated.storyBrief, '')
  assert.equal(migrated.storySummary, '')
  assert.equal(migrated.versionCount, STORYBOARD_DEFAULT_VERSIONS)
  assert.deepEqual(migrated.boardCandidates, [])
  assert.equal(migrated.approvedBoardCreationId, null)
  assert.equal(migrated.style, 'Cinematic')
  assert.equal(migrated.totalDurationSeconds, STORYBOARD_DEFAULT_TOTAL_DURATION_SECONDS)
  assert.equal(migrated.scenes.length, 2)
  assert.deepEqual(migrated.scenes.map((scene) => scene.durationSeconds), [1, 1])
  assert.deepEqual(migrated.scenes.map((scene) => scene.id), ['legacy-opening', 'legacy-ending'])
  assert.equal(migrated.scenes[0].title, '')
  assert.equal(migrated.scenes[0].explanation, '')
  assert.equal(migrated.scenes[0].candidates[0].creationId, 'legacy-frame-1')
  assert.equal(migrated.scenes[0].approvedCreationId, 'legacy-frame-1')
  assert.equal(migrated.scenes[0].approvedPromptSnapshot, 'A courier enters the empty station.')
  assert.equal(migrated.scenes[0].versionCount, STORYBOARD_DEFAULT_VERSIONS)
})

test('scene candidate input fingerprints persist safely while legacy candidates remain valid', () => {
  const hydrated = normalizeStoryboardDraft({
    scenes: [{
      id: 'fingerprinted-scene',
      candidates: [
        {
          creationId: 'fingerprinted-frame',
          promptSnapshot: 'Opening frame',
          inputFingerprint: '  input-v2\u0000  ',
        },
        {
          creationId: 'legacy-frame',
          promptSnapshot: 'Legacy frame',
          inputFingerprint: '   ',
        },
      ],
    }],
  })

  assert.equal(hydrated.scenes[0].candidates[0].inputFingerprint, 'input-v2')
  assert.equal('inputFingerprint' in hydrated.scenes[0].candidates[1], false)
})

test('storyboard version counts normalize to an integer between one and four', () => {
  assert.equal(clampStoryboardVersionCount(undefined), STORYBOARD_DEFAULT_VERSIONS)
  assert.equal(clampStoryboardVersionCount(0), 1)
  assert.equal(clampStoryboardVersionCount(-12), 1)
  assert.equal(clampStoryboardVersionCount(2.6), 3)
  assert.equal(clampStoryboardVersionCount('3'), 3)
  assert.equal(clampStoryboardVersionCount(99), STORYBOARD_MAX_VERSIONS)
  assert.equal(clampStoryboardVersionCount(Number.POSITIVE_INFINITY), STORYBOARD_DEFAULT_VERSIONS)

  const hydrated = normalizeStoryboardDraft({
    schemaVersion: 5,
    versionCount: 4,
    scenes: [{ id: 'scene', versionCount: '3' }],
  })
  assert.equal(hydrated.versionCount, 4)
  assert.equal(hydrated.scenes[0].versionCount, 3)
})

test('schema v2 Full drafts keep their story-level duration without losing approved work', () => {
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
  assert.equal(migrated.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 2)
  assert.equal(migrated.scenes[0].approvedCreationId, 'approved-frame')
  assert.equal(migrated.scenes[0].approvedPromptSnapshot, 'Approved opening')
})

test('schema v3 timed Full drafts migrate to Manual without deriving total time from rows', () => {
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
  assert.deepEqual(migrated.scenes.map((scene) => scene.durationSeconds), [5, 5])
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

test('storyboard candidate strategy normalization keeps both provenance values', () => {
  assert.equal(normalizeStoryboardOutputStrategy('single-generation'), 'single-generation')
  assert.equal(normalizeStoryboardOutputStrategy('scene-composite'), 'scene-composite')

  for (const invalidStrategy of [undefined, null, '', 'single', 'SCENE-COMPOSITE', 1, {}]) {
    assert.equal(normalizeStoryboardOutputStrategy(invalidStrategy), 'scene-composite')
  }
})

test('schema v8 hydration derives a workflow-safe execution strategy and persists the separate-frame choice', () => {
  const fullWithSeparateFrames = normalizeStoryboardDraft({
    schemaVersion: 8,
    workflowMode: 'full',
    outputStrategy: 'scene-composite',
    includeSeparateSceneFrames: true,
  })
  assert.equal(fullWithSeparateFrames.outputStrategy, 'single-generation')
  assert.equal(fullWithSeparateFrames.includeSeparateSceneFrames, true)

  const fullWithoutSeparateFrames = normalizeStoryboardDraft({
    schemaVersion: 8,
    workflowMode: 'full',
    outputStrategy: 'scene-composite',
    includeSeparateSceneFrames: false,
  })
  assert.equal(fullWithoutSeparateFrames.outputStrategy, 'single-generation')
  assert.equal(fullWithoutSeparateFrames.includeSeparateSceneFrames, false)

  const byScenes = normalizeStoryboardDraft({
    schemaVersion: 8,
    workflowMode: 'scenes',
    outputStrategy: 'single-generation',
    includeSeparateSceneFrames: true,
    scenes: [{ id: 'kept', prompt: 'Keep this scene' }],
  })
  assert.equal(byScenes.workflowMode, 'scenes')
  assert.equal(byScenes.outputStrategy, 'scene-composite')
  assert.equal(byScenes.includeSeparateSceneFrames, false)
  assert.equal(byScenes.scenes[0].id, 'kept')
  assert.equal(byScenes.scenes[0].prompt, 'Keep this scene')
  assert.equal(byScenes.scenes[0].durationMode, 'auto')

  const invalidBoolean = normalizeStoryboardDraft({
    schemaVersion: 8,
    workflowMode: 'full',
    includeSeparateSceneFrames: 'true',
  })
  assert.equal(invalidBoolean.includeSeparateSceneFrames, false)
})

test('schema v8 drafts migrate adjacent storyboard continuity safely and v9 sanitizes both slots', () => {
  const migrated = normalizeStoryboardDraft({
    schemaVersion: 8,
    workflowMode: 'scenes',
    storySummary: 'Keep the existing story.',
    scenes: [{ id: 'kept', prompt: 'Keep the authored scene.' }],
  })
  assert.equal(migrated.schemaVersion, STORYBOARD_SCHEMA_VERSION)
  assert.equal(migrated.previousStoryboardCreationId, null)
  assert.equal(migrated.nextStoryboardCreationId, null)
  assert.equal(migrated.scenes[0].prompt, 'Keep the authored scene.')

  const hydrated = normalizeStoryboardDraft({
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    previousStoryboardCreationId: '  prior-board  ',
    nextStoryboardCreationId: 'next-board\u0000',
  })
  assert.equal(hydrated.previousStoryboardCreationId, 'prior-board')
  assert.equal(hydrated.nextStoryboardCreationId, 'next-board')

  const invalid = normalizeStoryboardDraft({
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    previousStoryboardCreationId: ['not-an-id'],
    nextStoryboardCreationId: 42,
  })
  assert.equal(invalid.previousStoryboardCreationId, null)
  assert.equal(invalid.nextStoryboardCreationId, null)
})

test('schema v7 migrates only the former Full Storyboard scene-composite choice to separate frames', () => {
  const formerExactChoice = normalizeStoryboardDraft({
    schemaVersion: 7,
    workflowMode: 'full',
    outputStrategy: 'scene-composite',
  })
  assert.equal(formerExactChoice.outputStrategy, 'single-generation')
  assert.equal(formerExactChoice.includeSeparateSceneFrames, true)

  const formerDirectChoice = normalizeStoryboardDraft({
    schemaVersion: 7,
    workflowMode: 'full',
    outputStrategy: 'single-generation',
  })
  assert.equal(formerDirectChoice.outputStrategy, 'single-generation')
  assert.equal(formerDirectChoice.includeSeparateSceneFrames, false)

  for (const outputStrategy of ['single-generation', 'scene-composite'] as const) {
    const byScenes = normalizeStoryboardDraft({
      schemaVersion: 7,
      workflowMode: 'scenes',
      outputStrategy,
    })
    assert.equal(byScenes.outputStrategy, 'scene-composite')
    assert.equal(byScenes.includeSeparateSceneFrames, false)
  }
})

test('pre-v7, future-version, and unversioned drafts do not infer separate scene frames', () => {
  const legacy = normalizeStoryboardDraft({
    schemaVersion: 6,
    workflowMode: 'full',
    outputStrategy: 'scene-composite',
    includeSeparateSceneFrames: true,
    scenes: [{ id: 'legacy', prompt: 'Legacy scene', approvedCreationId: 'legacy-frame' }],
  })
  assert.equal(legacy.outputStrategy, 'single-generation')
  assert.equal(legacy.includeSeparateSceneFrames, false)
  assert.equal(legacy.scenes[0].approvedCreationId, 'legacy-frame')

  const futureVersion = normalizeStoryboardDraft({
    schemaVersion: 999,
    workflowMode: 'full',
    includeSeparateSceneFrames: true,
  })
  assert.equal(futureVersion.outputStrategy, 'single-generation')
  assert.equal(futureVersion.includeSeparateSceneFrames, false)

  const unversioned = normalizeStoryboardDraft({
    workflowMode: 'full',
    includeSeparateSceneFrames: true,
  })
  assert.equal(unversioned.outputStrategy, 'single-generation')
  assert.equal(unversioned.includeSeparateSceneFrames, false)
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
    { ...createStoryboardScene('opening'), title: 'פתיחה', prompt: 'OPENING_PROMPT', explanation: 'OPENING_REASON', durationMode: 'manual' as const, durationSeconds: 3 },
    { ...createStoryboardScene('turn'), title: 'TURN_TITLE', prompt: 'TURN_PROMPT', explanation: 'TURN_REASON', durationMode: 'manual' as const, durationSeconds: 2 },
    { ...createStoryboardScene('ending'), title: 'ENDING_TITLE', prompt: 'ENDING_PROMPT', explanation: 'ENDING_REASON', durationMode: 'manual' as const, durationSeconds: 2 },
  ]
  const context = buildStoryboardEnhancementContext({
    ...base,
    workflowMode: 'scenes',
    timingMode: 'manual',
    title: 'CONTEXT_BOARD',
    storyBrief: 'HIDDEN_FULL_BRIEF',
    storySummary: 'COMPLETE_STORY_SENTINEL',
    referenceCreationIds: ['GLOBAL_REFERENCE_ONE', 'GLOBAL_REFERENCE_TWO'],
    style: 'Cinematic',
    scenes,
  }, 'turn')

  assert.match(context, /COMPLETE_STORY_SENTINEL/)
  assert.doesNotMatch(context, /HIDDEN_FULL_BRIEF/)
  for (const sentinel of ['פתיחה', 'OPENING_PROMPT', 'OPENING_REASON', 'TURN_TITLE', 'TURN_PROMPT', 'TURN_REASON', 'ENDING_TITLE', 'ENDING_PROMPT', 'ENDING_REASON']) {
    assert.match(context, new RegExp(sentinel))
  }
  assert.match(context, /SCENE 02 · CURRENT SCENE/)
  assert.match(context, /Global visual references: 2 attached to every scene and the complete board/)
  assert.match(context, /Total story duration: 7 seconds/)
  assert.match(context, /Timing: 3s–5s · 2s/)
  assert(context.indexOf('OPENING_PROMPT') < context.indexOf('TURN_PROMPT'))
  assert(context.indexOf('TURN_PROMPT') < context.indexOf('ENDING_PROMPT'))
})

test('Full Storyboard enhancement context uses only the Story Brief, never hidden scene rows', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.timingMode = 'none'
  draft.totalDurationSeconds = 777
  draft.storyBrief = 'THE_ONLY_FULL_STORY_PLAN'
  draft.scenes[0].durationSeconds = 111
  draft.scenes[1].durationSeconds = 666
  draft.scenes[0].prompt = 'HIDDEN_OPENING_IMAGE'
  draft.scenes[1].prompt = 'HIDDEN_CLOSING_IMAGE'

  const context = buildStoryboardEnhancementContext(draft)
  assert.doesNotMatch(context, /Timing mode|Total story duration|Timing:|777|666|111/)
  assert.match(context, /THE_ONLY_FULL_STORY_PLAN/)
  assert.doesNotMatch(context, /HIDDEN_OPENING_IMAGE|HIDDEN_CLOSING_IMAGE|ORDERED SCENE ROWS/)

  const timedContext = buildStoryboardEnhancementContext({
    ...draft,
    timingMode: 'manual',
    totalDurationSeconds: 90,
  })
  assert.match(timedContext, /Total story duration: 90 seconds/)
})

test('storyboard enhancement context gives adjacent boards explicit read-only continuity roles', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.storyBrief = 'The current story happens between two existing boards.'
  draft.previousStoryboardCreationId = 'previous-board'
  draft.nextStoryboardCreationId = 'next-board'

  const fullContext = buildStoryboardEnhancementContext(draft)
  assert.match(fullContext, /Previous storyboard: attached as incoming continuity context only/)
  assert.match(fullContext, /do not repeat its events or treat it as output to recreate/)
  assert.match(fullContext, /Next storyboard: attached as outgoing continuity context only/)
  assert.match(fullContext, /without depicting its future events early/)

  const scenesContext = buildStoryboardEnhancementContext({
    ...draft,
    workflowMode: 'scenes',
    storySummary: 'The current two-scene section.',
  })
  assert.match(scenesContext, /incoming continuity context only/)
  assert.match(scenesContext, /outgoing continuity context only/)
  assert.match(scenesContext, /ORDERED SCENE ROWS/)
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

  assert.match(context, new RegExp(`SCENE ${STORYBOARD_MAX_SCENES}`))
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

test('by-scenes normalization keeps global references global and removes copied duplicates from scene rows', () => {
  const migrated = normalizeStoryboardDraft({
    schemaVersion: 4,
    workflowMode: 'scenes',
    model: 'Seedream 5 Pro',
    referenceCreationIds: ['shared-a', 'shared-a', 'shared-b'],
    scenes: [
      { id: 'one', referenceCreationIds: ['shared-a', 'own-one'] },
      { id: 'two', referenceCreationIds: ['own-two', 'shared-b', 'shared-a'] },
    ],
  })

  assert.equal(migrated.schemaVersion, STORYBOARD_SCHEMA_VERSION)
  assert.deepEqual(migrated.referenceCreationIds, ['shared-a', 'shared-b'])
  assert.deepEqual(migrated.scenes[0].referenceCreationIds, ['own-one'])
  assert.deepEqual(migrated.scenes[1].referenceCreationIds, ['own-two'])
})

test('Full Storyboard normalization preserves hidden scene references', () => {
  const migrated = normalizeStoryboardDraft({
    workflowMode: 'full',
    model: 'Seedream 5 Pro',
    referenceCreationIds: ['shared-a'],
    scenes: [{ id: 'hidden', referenceCreationIds: ['shared-a', 'hidden-only'] }],
  })

  assert.deepEqual(migrated.referenceCreationIds, ['shared-a'])
  assert.deepEqual(migrated.scenes[0].referenceCreationIds, ['shared-a', 'hidden-only'])
})

test('per-scene reference IDs are deduplicated and capped by the selected model', () => {
  const migrated = normalizeStoryboardDraft({
    schemaVersion: 5,
    workflowMode: 'scenes',
    model: 'Qwen2 Image',
    scenes: [{ id: 'scene', referenceCreationIds: ['ref-a', 'ref-a', 'ref-b'] }],
  })

  assert.deepEqual(migrated.scenes[0].referenceCreationIds, ['ref-a'])
})

test('candidate batches stay bounded without evicting the approved frame', () => {
  const scene = createStoryboardScene('variants')
  scene.candidates = Array.from({ length: STORYBOARD_MAX_CANDIDATES_PER_SCENE }, (_, index) => ({
    creationId: `old-${index}`,
    promptSnapshot: `Old ${index}`,
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: index,
  }))
  scene.approvedCreationId = 'old-0'
  const incoming = Array.from({ length: STORYBOARD_MAX_VERSIONS }, (_, index) => ({
    creationId: `new-${index}`,
    promptSnapshot: 'New batch',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: 100 + index,
  }))

  const appended = appendStoryboardCandidates(scene, incoming)
  assert.equal(appended.length, STORYBOARD_MAX_CANDIDATES_PER_SCENE)
  assert.equal(appended.some((candidate) => candidate.creationId === 'old-0'), true)
  assert.equal(appended.some((candidate) => candidate.creationId === 'old-1'), false)
  assert.deepEqual(appended.slice(-4).map((candidate) => candidate.creationId), ['new-0', 'new-1', 'new-2', 'new-3'])

  const hydrated = normalizeStoryboardDraft({
    schemaVersion: 5,
    scenes: [{ ...scene, candidates: [...scene.candidates, ...incoming] }],
  })
  assert.equal(hydrated.scenes[0].candidates.length, STORYBOARD_MAX_CANDIDATES_PER_SCENE)
  assert.equal(hydrated.scenes[0].candidates.some((candidate) => candidate.creationId === 'old-0'), true)
})

test('standalone scene version deficits count only durable Library images and top up exactly', () => {
  const scene = createStoryboardScene('version-top-up')
  scene.candidates = ['available-a', 'missing-b', 'available-c'].map((creationId, index) => ({
    creationId,
    promptSnapshot: 'Scene prompt',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: index + 1,
  }))
  scene.approvedCreationId = 'legacy-approved'

  const available = ['available-a', 'available-c', 'legacy-approved']
  assert.equal(countAvailableStoryboardSceneVersions(scene, available), 3)
  assert.equal(storyboardSceneVersionDeficit(scene, 4, available), 1)
  assert.equal(storyboardSceneVersionDeficit(scene, 2, available), 0)

  scene.candidates.push({ ...scene.candidates[0], creationId: 'available-a' })
  assert.equal(countAvailableStoryboardSceneVersions(scene, available), 3)
})

test('complete-board candidates normalize strictly, deduplicate by Library ID, and validate approval', () => {
  const manySourceIds = Array.from({ length: STORYBOARD_MAX_SCENES + 4 }, (_, index) => `source-${index}`)
  const hydrated = normalizeStoryboardDraft({
    schemaVersion: 7,
    outputStrategy: 'single-generation',
    approvedBoardCreationId: 'board-a',
    boardCandidates: [
      {
        ...boardCandidate('board-a', {
          strategy: 'scene-composite',
          sourceSceneCreationIds: ['source-0', 'source-0', ...manySourceIds],
        }),
        promptSnapshot: 'Old prompt',
      },
      boardCandidate('board-b', {
        jobId: 'job-storyboard-board-b',
        strategy: 'single-generation',
        sourceSceneCreationIds: ['raw-contact-sheet', 'extra-id-is-rejected'],
        createdAt: -50,
      }),
      {
        ...boardCandidate('board-a', {
          strategy: 'scene-composite',
          sourceSceneCreationIds: manySourceIds,
        }),
        promptSnapshot: 'Newest prompt',
      },
      { ...boardCandidate('invalid-strategy'), strategy: 'automatic' },
      { ...boardCandidate('missing-fingerprint'), inputFingerprint: '' },
      { ...boardCandidate('missing-id'), creationId: '' },
    ],
  })

  assert.equal(hydrated.outputStrategy, 'single-generation')
  assert.deepEqual(hydrated.boardCandidates.map((candidate) => candidate.creationId), ['board-a', 'board-b'])
  assert.equal(hydrated.boardCandidates[0].promptSnapshot, 'Newest prompt')
  assert.deepEqual(hydrated.boardCandidates[0].sourceSceneCreationIds, manySourceIds.slice(0, STORYBOARD_MAX_SCENES))
  assert.deepEqual(hydrated.boardCandidates[1].sourceSceneCreationIds, ['raw-contact-sheet'])
  assert.equal(hydrated.boardCandidates[1].jobId, 'job-storyboard-board-b')
  assert.equal(hydrated.boardCandidates[1].createdAt, 0)
  assert.equal(hydrated.approvedBoardCreationId, 'board-a')

  const orphaned = normalizeStoryboardDraft({
    schemaVersion: 7,
    approvedBoardCreationId: 'not-in-candidates',
    boardCandidates: [boardCandidate('available')],
  })
  assert.equal(orphaned.approvedBoardCreationId, null)
})

test('complete-board candidate history stays bounded without evicting the approved result', () => {
  const existing = Array.from({ length: STORYBOARD_MAX_BOARD_CANDIDATES }, (_, index) => boardCandidate(`old-board-${index}`))
  const incoming = Array.from({ length: STORYBOARD_MAX_VERSIONS }, (_, index) => boardCandidate(`new-board-${index}`, { createdAt: 100 + index }))
  const merged = appendStoryboardBoardCandidates({
    boardCandidates: existing,
    approvedBoardCreationId: 'old-board-0',
  }, incoming)

  assert.equal(merged.length, STORYBOARD_MAX_BOARD_CANDIDATES)
  assert.equal(merged.some((candidate) => candidate.creationId === 'old-board-0'), true)
  assert.equal(merged.some((candidate) => candidate.creationId === 'old-board-1'), false)
  assert.deepEqual(merged.slice(-4).map((candidate) => candidate.creationId), [
    'new-board-0',
    'new-board-1',
    'new-board-2',
    'new-board-3',
  ])

  const duplicate = appendStoryboardBoardCandidates({
    boardCandidates: [boardCandidate('same', { promptSnapshot: 'Old' })],
    approvedBoardCreationId: 'same',
  }, [boardCandidate('same', { promptSnapshot: 'New' })])
  assert.equal(duplicate.length, 1)
  assert.equal(duplicate[0].promptSnapshot, 'New')
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

test('scene references count as protected content when removing scenes', () => {
  const scenes = [createStoryboardScene('head'), createStoryboardScene('referenced-tail')]
  scenes[1].referenceCreationIds = ['library-image']

  assert.equal(storyboardSceneHasContent(scenes[1]), true)
  assert.equal(resizeStoryboardScenes(scenes, 1).blocked, true)
})

test('storyboard timing sums exactly while enforcing the five-second scene cap', () => {
  const draft = createDefaultStoryboardDraft(3)
  assert.deepEqual(draft.scenes.map((scene) => scene.durationSeconds), [2, 2, 1])

  const weighted = draft.scenes.map((scene, index) => ({
    ...scene,
    durationSeconds: [5, 2, 1][index],
  }))
  const scaled = scaleStoryboardDurations(weighted, 12)
  assert.deepEqual(scaled.map((scene) => scene.durationSeconds), [5, 4, 3])
  assert.equal(scaled.reduce((sum, scene) => sum + scene.durationSeconds, 0), 12)

  const even = distributeStoryboardDurations(scaled, 14)
  assert.deepEqual(even.map((scene) => scene.durationSeconds), [5, 5, 4])
  assert.equal(even.reduce((sum, scene) => sum + scene.durationSeconds, 0), 14)
  assert(even.every((scene) => scene.durationSeconds <= STORYBOARD_MAX_SCENE_DURATION_SECONDS))
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

test('by-scenes editing keeps Auto rows unresolved while preserving manual durations and Full preferences', () => {
  const draft = createDefaultStoryboardDraft(3)
  draft.workflowMode = 'scenes'
  draft.timingMode = 'manual'
  draft.totalDurationSeconds = 12
  draft.storySummary = 'A calm opening leads into a fast pursuit and a final choice.'
  draft.scenes[0] = {
    ...draft.scenes[0],
    prompt: 'A quiet empty platform before dawn.',
    durationMode: 'auto',
  }
  draft.scenes[1] = {
    ...draft.scenes[1],
    prompt: 'A brief close-up of the key.',
    durationMode: 'manual',
    durationSeconds: 1,
  }
  draft.scenes[2] = {
    ...draft.scenes[2],
    prompt: 'The courier runs through the station, dodges the guards, returns for the stranger and makes the final choice beneath flashing lights.',
    durationMode: 'auto',
  }

  const effective = effectiveStoryboardTiming(draft)
  assert.equal(effective.timingMode, 'auto')
  assert.equal(effective.scenes[1].durationSeconds, 1)
  assert.equal(effective.totalDurationSeconds, effective.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0))
  assert.equal(effective.scenes[0].durationSeconds, draft.scenes[0].durationSeconds)
  assert.equal(effective.scenes[2].durationSeconds, draft.scenes[2].durationSeconds)

  // By-scenes calculations must not overwrite the hidden Full Storyboard choice.
  assert.equal(draft.timingMode, 'manual')
  assert.equal(draft.totalDurationSeconds, 12)
  const restoredFull = effectiveStoryboardTiming({ ...draft, workflowMode: 'full' })
  assert.equal(restoredFull.timingMode, 'manual')
  assert.equal(restoredFull.totalDurationSeconds, 12)
})

test('by-scenes timing has an exact row sum even below the Full Storyboard five-second floor', () => {
  const scenes = [
    { ...createStoryboardScene('one'), durationMode: 'manual' as const, durationSeconds: 1 },
    { ...createStoryboardScene('two'), durationMode: 'manual' as const, durationSeconds: 1 },
  ]
  const timing = resolveStoryboardSceneDurations(scenes, 'Two very short inserts.')
  assert.equal(timing.totalDurationSeconds, 2)
  assert.deepEqual(timing.scenes.map((scene) => scene.durationSeconds), [1, 1])
})

test('generation-time timing applies Auto rows while preserving every Manual duration exactly', () => {
  const scenes = [
    { ...createStoryboardScene('auto-one'), durationMode: 'auto' as const, durationSeconds: 5 },
    { ...createStoryboardScene('manual'), durationMode: 'manual' as const, durationSeconds: 2 },
    { ...createStoryboardScene('auto-two'), durationMode: 'auto' as const, durationSeconds: 5 },
  ]
  const timing = applyStoryboardSceneDurationResolution(scenes, [
    { sceneId: 'auto-one', durationSeconds: 1 },
    // A returned Manual value is intentionally ignored; the authored 2s stays exact.
    { sceneId: 'manual', durationSeconds: 5 },
    { sceneId: 'auto-two', durationSeconds: 4 },
  ])

  assert.deepEqual(timing.scenes.map((scene) => scene.durationSeconds), [1, 2, 4])
  assert.equal(timing.totalDurationSeconds, 7)
  assert.throws(
    () => applyStoryboardSceneDurationResolution(scenes, [{ sceneId: 'auto-one', durationSeconds: 3 }]),
    /missing storyboard timing/i,
  )
  assert.throws(
    () => applyStoryboardSceneDurationResolution(scenes, [
      { sceneId: 'auto-one', durationSeconds: 3 },
      { sceneId: 'auto-one', durationSeconds: 4 },
      { sceneId: 'auto-two', durationSeconds: 2 },
    ]),
    /duplicate storyboard timing/i,
  )
})

test('by-scenes Auto and Manual row choices survive draft normalization', () => {
  const hydrated = normalizeStoryboardDraft({
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    workflowMode: 'scenes',
    timingMode: 'none',
    totalDurationSeconds: 10,
    storySummary: 'A short opening and an exact two-second ending.',
    scenes: [
      { id: 'auto-row', prompt: 'The door opens.', durationMode: 'auto', durationSeconds: 5 },
      { id: 'manual-row', prompt: 'The light cuts out.', durationMode: 'manual', durationSeconds: 2 },
    ],
  })

  assert.deepEqual(hydrated.scenes.map((scene) => scene.durationMode), ['auto', 'manual'])
  assert.equal(hydrated.scenes[1].durationSeconds, 2)
  assert.equal(hydrated.timingMode, 'none')
  assert.equal(hydrated.totalDurationSeconds, 10)
  const effective = effectiveStoryboardTiming(hydrated)
  assert.equal(effective.totalDurationSeconds, effective.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0))
})

test('changing one scene duration redistributes the remainder without breaking either cap', () => {
  const scenes = distributeStoryboardDurations(createDefaultStoryboardDraft(3).scenes, 12)
  const extended = adjustStoryboardSceneDuration(scenes, scenes[0].id, 5, 12)
  assert.deepEqual(extended.map((scene) => scene.durationSeconds), [5, 4, 3])

  const shortened = adjustStoryboardSceneDuration(scenes, scenes[0].id, 1, 12)
  assert.deepEqual(shortened.map((scene) => scene.durationSeconds), [2, 5, 5])
  assert.equal(shortened.reduce((sum, scene) => sum + scene.durationSeconds, 0), 12)
})

test('adding and removing scenes preserve valid bounded timing', () => {
  const initial = createDefaultStoryboardDraft(2)
  initial.scenes[0].durationSeconds = 5
  initial.scenes[1].durationSeconds = 5

  const appended = appendStoryboardSceneWithTiming(initial.scenes, 15, createStoryboardScene('new-scene'))
  assert.equal(appended.totalDurationSeconds, 15)
  assert.deepEqual(appended.scenes.map((scene) => scene.durationSeconds), [5, 5, 5])
  assert.equal(appended.scenes.at(-1)?.id, 'new-scene')

  const removed = removeStoryboardSceneWithTiming(appended.scenes, appended.scenes[1].id, 15)
  assert.equal(removed.totalDurationSeconds, 10)
  assert.deepEqual(removed.scenes.map((scene) => scene.durationSeconds), [5, 5])
  assert.equal(removed.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 10)
})

test('derived timing follows scene order while duration stays attached to each scene', () => {
  const scenes = ['a', 'b', 'c'].map((id, index) => ({
    ...createStoryboardScene(id),
    durationSeconds: [4, 5, 5][index],
  }))
  const reordered = reorderStoryboardScenes(scenes, 'a', 2)
  assert.deepEqual(reordered.map((scene) => [scene.id, scene.durationSeconds]), [['b', 5], ['c', 5], ['a', 4]])
  assert.deepEqual(
    storyboardSceneTimings(reordered).map((timing) => [timing.sceneId, timing.startSeconds, timing.endSeconds]),
    [['b', 0, 5], ['c', 5, 10], ['a', 10, 14]],
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
  assert.deepEqual(hydrated.scenes.map((scene) => scene.durationSeconds), [1, 1, 5])
  assert(hydrated.scenes.every((scene) => scene.durationSeconds >= 1 && scene.durationSeconds <= 5))
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

test('approval freshness compares the approved candidate input fingerprint when requested', () => {
  const scene = createStoryboardScene('continuity-aware')
  scene.prompt = 'Continue the courier through the station.'
  scene.approvedCreationId = 'approved-frame'
  scene.approvedPromptSnapshot = scene.prompt
  scene.candidates = [{
    creationId: 'approved-frame',
    promptSnapshot: scene.prompt,
    inputFingerprint: 'previous-a:scene-a:next-a',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: 1,
  }]

  assert.equal(isStoryboardApprovalStale(scene), false)
  assert.equal(isStoryboardApprovalStale(scene, 'previous-a:scene-a:next-a'), false)
  assert.equal(isStoryboardApprovalStale(scene, 'previous-b:scene-a:next-a'), true)

  delete scene.candidates[0].inputFingerprint
  assert.equal(isStoryboardApprovalStale(scene), false)
  assert.equal(isStoryboardApprovalStale(scene, 'previous-a:scene-a:next-a'), true)
})

test('scene completion preserves approved work, reuses one exact reference, and only generates prompts', () => {
  const approved = createStoryboardScene('approved')
  approved.prompt = 'Edited later'
  approved.approvedCreationId = 'generated-frame'
  const exact = createStoryboardScene('exact')
  exact.referenceCreationIds = ['reference-frame']
  const prompted = createStoryboardScene('prompted')
  prompted.prompt = 'A wide establishing shot'
  prompted.referenceCreationIds = ['look-reference']
  const empty = createStoryboardScene('empty')
  const ambiguous = createStoryboardScene('ambiguous')
  ambiguous.referenceCreationIds = ['one', 'two']

  assert.equal(storyboardSceneCompletionAction(approved), 'preserve')
  assert.equal(storyboardSceneCompletionAction(exact), 'use-reference')
  assert.equal(storyboardSceneCompletionAction(prompted), 'generate')
  assert.equal(storyboardSceneCompletionAction(empty), 'missing')
  assert.equal(storyboardSceneCompletionAction(ambiguous), 'ambiguous-references')
  assert.equal(storyboardSceneCompletionAction(exact, false), 'missing')
  assert.equal(storyboardSceneCompletionAction(ambiguous, false), 'missing')
})

test('scene completion regenerates an approval when its expected input fingerprint changes', () => {
  const approved = createStoryboardScene('approved-with-inputs')
  approved.prompt = 'A close shot of the same courier.'
  approved.approvedCreationId = 'approved-frame'
  approved.approvedPromptSnapshot = approved.prompt
  approved.candidates = [{
    creationId: 'approved-frame',
    promptSnapshot: approved.prompt,
    inputFingerprint: 'inputs-a',
    model: STORYBOARD_DEFAULT_MODEL,
    aspect: STORYBOARD_DEFAULT_ASPECT,
    resolution: STORYBOARD_DEFAULT_RESOLUTION,
    extras: { format: 'PNG' },
    createdAt: 1,
  }]

  assert.equal(storyboardSceneCompletionAction(approved), 'preserve')
  assert.equal(storyboardSceneCompletionAction(approved, true, 'inputs-a'), 'preserve')
  assert.equal(storyboardSceneCompletionAction(approved, true, 'inputs-b'), 'generate')

  approved.prompt = 'The courier now exits through a different door.'
  assert.equal(storyboardSceneCompletionAction(approved, true, 'inputs-a'), 'generate')
  approved.prompt = approved.approvedPromptSnapshot

  delete approved.candidates[0].inputFingerprint
  assert.equal(storyboardSceneCompletionAction(approved), 'preserve')
  assert.equal(storyboardSceneCompletionAction(approved, true, 'inputs-a'), 'generate')
})

test('missing storyboard references are detected without dropping requested order', () => {
  assert.deepEqual(
    findMissingStoryboardReferenceIds(['available-a', 'missing-b', 'available-c', 'missing-d'], ['available-a', 'available-c']),
    ['missing-b', 'missing-d'],
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
