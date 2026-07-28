import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGeneratedStoryboardBoardPrompt,
  collectStoryboardBoardReferences,
  compileGeneratedStoryboardBoard,
  compileStoryboardSceneReferenceManifest,
  findStoryboardContinuityReferenceConflict,
} from '../src/data/storyboardBoard.ts'
import { promptCharacterCount } from '../src/data/promptLimits.ts'
import { createDefaultStoryboardDraft } from '../src/data/storyboard.ts'

test('full storyboard references stay global, ordered and unique', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'full'
  draft.referenceCreationIds = ['global-b', 'global-a', 'global-b', '', '  global-c  ']
  draft.scenes[0].referenceCreationIds = ['ignored-scene-reference']

  assert.deepEqual(collectStoryboardBoardReferences(draft), [
    { creationId: 'global-b', referenceIndex: 1, scope: 'global', sceneOrdinals: [] },
    { creationId: 'global-a', referenceIndex: 2, scope: 'global', sceneOrdinals: [] },
    { creationId: 'global-c', referenceIndex: 3, scope: 'global', sceneOrdinals: [] },
  ])
})

test('by-scenes references place global context before scene rows and retain every shared scene mapping', () => {
  const draft = createDefaultStoryboardDraft(3)
  draft.workflowMode = 'scenes'
  draft.referenceCreationIds = ['global-reference', 'ref-b']
  draft.scenes[0].referenceCreationIds = ['ref-a', 'ref-b', 'ref-a']
  draft.scenes[1].referenceCreationIds = ['ref-b', 'ref-c']
  draft.scenes[2].referenceCreationIds = ['ref-c', 'ref-d']

  assert.deepEqual(collectStoryboardBoardReferences(draft), [
    { creationId: 'global-reference', referenceIndex: 1, scope: 'global', sceneOrdinals: [] },
    { creationId: 'ref-b', referenceIndex: 2, scope: 'global', sceneOrdinals: [] },
    { creationId: 'ref-a', referenceIndex: 3, scope: 'scenes', sceneOrdinals: [1] },
    { creationId: 'ref-c', referenceIndex: 4, scope: 'scenes', sceneOrdinals: [2, 3] },
    { creationId: 'ref-d', referenceIndex: 5, scope: 'scenes', sceneOrdinals: [3] },
  ])
})

test('adjacent storyboard context wraps current references in narrative order for Full and By Scenes', () => {
  const full = createDefaultStoryboardDraft()
  full.workflowMode = 'full'
  full.previousStoryboardCreationId = 'previous-board'
  full.referenceCreationIds = ['current-a', 'current-b']
  full.nextStoryboardCreationId = 'next-board'

  assert.deepEqual(collectStoryboardBoardReferences(full), [
    { creationId: 'previous-board', referenceIndex: 1, scope: 'previous-storyboard', sceneOrdinals: [] },
    { creationId: 'current-a', referenceIndex: 2, scope: 'global', sceneOrdinals: [] },
    { creationId: 'current-b', referenceIndex: 3, scope: 'global', sceneOrdinals: [] },
    { creationId: 'next-board', referenceIndex: 4, scope: 'next-storyboard', sceneOrdinals: [] },
  ])

  const byScenes = createDefaultStoryboardDraft(2)
  byScenes.workflowMode = 'scenes'
  byScenes.previousStoryboardCreationId = 'previous-board'
  byScenes.referenceCreationIds = ['global-board']
  byScenes.scenes[0].referenceCreationIds = ['scene-a', 'shared']
  byScenes.scenes[1].referenceCreationIds = ['shared', 'scene-b']
  byScenes.nextStoryboardCreationId = 'next-board'

  assert.deepEqual(collectStoryboardBoardReferences(byScenes), [
    { creationId: 'previous-board', referenceIndex: 1, scope: 'previous-storyboard', sceneOrdinals: [] },
    { creationId: 'global-board', referenceIndex: 2, scope: 'global', sceneOrdinals: [] },
    { creationId: 'scene-a', referenceIndex: 3, scope: 'scenes', sceneOrdinals: [1] },
    { creationId: 'shared', referenceIndex: 4, scope: 'scenes', sceneOrdinals: [1, 2] },
    { creationId: 'scene-b', referenceIndex: 5, scope: 'scenes', sceneOrdinals: [2] },
    { creationId: 'next-board', referenceIndex: 6, scope: 'next-storyboard', sceneOrdinals: [] },
  ])
})

test('scene reference preflight returns one validated no-slice provider manifest in narrative order', () => {
  const draft = createDefaultStoryboardDraft(3)
  draft.workflowMode = 'scenes'
  draft.model = 'Nano Banana 2'
  draft.previousStoryboardCreationId = 'previous-board'
  draft.referenceCreationIds = ['global-a', 'current-a']
  draft.nextStoryboardCreationId = 'next-board'

  const compiled = compileStoryboardSceneReferenceManifest(
    draft,
    ['current-a', 'current-a', 'current-b'],
    2,
  )

  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert.deepEqual(compiled.referenceCreationIds, [
    'previous-board',
    'global-a',
    'current-a',
    'current-b',
    'next-board',
  ])
  assert.deepEqual(compiled.referenceManifest, [
    { creationId: 'previous-board', referenceIndex: 1, scope: 'previous-storyboard', sceneOrdinals: [] },
    { creationId: 'global-a', referenceIndex: 2, scope: 'global', sceneOrdinals: [] },
    { creationId: 'current-a', referenceIndex: 3, scope: 'global', sceneOrdinals: [] },
    { creationId: 'current-b', referenceIndex: 4, scope: 'scenes', sceneOrdinals: [2] },
    { creationId: 'next-board', referenceIndex: 5, scope: 'next-storyboard', sceneOrdinals: [] },
  ])
  assert.equal(compiled.previousStoryboardAttached, true)
  assert.equal(compiled.nextStoryboardAttached, true)
})

test('scene reference preflight blocks max-one previous plus next context instead of silently slicing it', () => {
  const draft = createDefaultStoryboardDraft()
  draft.workflowMode = 'scenes'
  draft.model = 'Qwen2 Image'
  draft.previousStoryboardCreationId = 'previous-board'
  draft.nextStoryboardCreationId = 'next-board'

  const compiled = compileStoryboardSceneReferenceManifest(draft, [], 1)

  assert.equal(compiled.ok, false)
  if (compiled.ok) return
  assert.equal(compiled.code, 'too-many-references')
  assert.equal(compiled.referenceCount, 2)
  assert.equal(compiled.maxReferenceImages, 1)
  assert.equal(compiled.sceneOrdinal, 1)
  assert.match(compiled.error, /Remove a current-scene or continuity reference before generating/)
  assert.equal('referenceCreationIds' in compiled, false)
  assert.equal('previousStoryboardAttached' in compiled, false)
  assert.equal('nextStoryboardAttached' in compiled, false)
})

test('scene reference preflight enforces the model limit across global and scene references', () => {
  const draft = createDefaultStoryboardDraft()
  draft.workflowMode = 'scenes'
  draft.model = 'Qwen2 Image'
  draft.referenceCreationIds = ['global-reference']

  const compiled = compileStoryboardSceneReferenceManifest(draft, ['scene-reference'], 3)

  assert.equal(compiled.ok, false)
  if (compiled.ok) return
  assert.equal(compiled.code, 'too-many-references')
  assert.equal(compiled.referenceCount, 2)
  assert.equal(compiled.maxReferenceImages, 1)
  assert.equal(compiled.sceneOrdinal, 3)
  assert.equal('referenceCreationIds' in compiled, false)
})

test('scene reference preflight rejects one image reused across semantic roles', () => {
  const draft = createDefaultStoryboardDraft()
  draft.workflowMode = 'scenes'
  draft.previousStoryboardCreationId = 'same-board'

  const compiled = compileStoryboardSceneReferenceManifest(draft, ['same-board'])

  assert.equal(compiled.ok, false)
  if (compiled.ok) return
  assert.equal(compiled.code, 'conflicting-references')
  assert.match(compiled.error, /previous storyboard and current storyboard/)
})

test('By Scenes continuity conflicts include both global and scene-level current references', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'scenes'
  draft.previousStoryboardCreationId = 'global-conflict'
  draft.referenceCreationIds = ['global-conflict']
  draft.scenes[0].referenceCreationIds = ['scene-conflict']
  draft.nextStoryboardCreationId = 'scene-conflict'

  assert.deepEqual(findStoryboardContinuityReferenceConflict(draft), {
    creationId: 'global-conflict',
    roles: ['previous storyboard', 'current storyboard'],
  })

  const globalCompile = compileStoryboardSceneReferenceManifest(draft, ['other-scene-reference'])
  assert.equal(globalCompile.ok, false)
  if (!globalCompile.ok) {
    assert.equal(globalCompile.code, 'conflicting-references')
    assert.match(globalCompile.error, /previous storyboard and current storyboard/)
  }

  const sceneCompile = compileStoryboardSceneReferenceManifest({
    ...draft,
    previousStoryboardCreationId: null,
    referenceCreationIds: [],
  }, ['scene-conflict'])
  assert.equal(sceneCompile.ok, false)
  if (!sceneCompile.ok) {
    assert.equal(sceneCompile.code, 'conflicting-references')
    assert.match(sceneCompile.error, /current storyboard and next storyboard/)
  }
})

test('one Library image cannot silently occupy conflicting storyboard roles', () => {
  const draft = createDefaultStoryboardDraft()
  draft.storyBrief = 'A current storyboard.'
  draft.previousStoryboardCreationId = 'shared-board'
  draft.referenceCreationIds = ['shared-board']
  draft.nextStoryboardCreationId = 'shared-board'

  assert.deepEqual(findStoryboardContinuityReferenceConflict(draft), {
    creationId: 'shared-board',
    roles: ['previous storyboard', 'current storyboard', 'next storyboard'],
  })
  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, false)
  if (compiled.ok) return
  assert.equal(compiled.code, 'conflicting-references')
  assert.match(compiled.error, /cannot be used as previous storyboard and current storyboard and next storyboard context/)
})

test('adjacent boards are compiled as continuity context only and participate in limits and fingerprints', () => {
  const draft = createDefaultStoryboardDraft()
  draft.workflowMode = 'full'
  draft.model = 'Nano Banana 2'
  draft.storyBrief = 'A courier crosses the current station concourse and reaches the waiting train.'

  const baseline = compileGeneratedStoryboardBoard(draft)
  const withPrevious = compileGeneratedStoryboardBoard({
    ...draft,
    previousStoryboardCreationId: 'previous-board',
  })
  const withBoth = compileGeneratedStoryboardBoard({
    ...draft,
    previousStoryboardCreationId: 'previous-board',
    nextStoryboardCreationId: 'next-board',
  })
  assert.equal(baseline.ok, true)
  assert.equal(withPrevious.ok, true)
  assert.equal(withBoth.ok, true)
  if (!baseline.ok || !withPrevious.ok || !withBoth.ok) return
  assert.deepEqual(withBoth.referenceCreationIds, ['previous-board', 'next-board'])
  assert.match(withBoth.prompt, /PREVIOUS STORYBOARD — incoming continuity context immediately before this board/)
  assert.match(withBoth.prompt, /NEXT STORYBOARD — outgoing continuity context immediately after this board/)
  assert.match(withBoth.prompt, /Generate only the current storyboard; never reproduce either adjacent board/)
  assert.notEqual(withPrevious.inputFingerprint, baseline.inputFingerprint)
  assert.notEqual(withBoth.inputFingerprint, withPrevious.inputFingerprint)

  const limited = compileGeneratedStoryboardBoard({
    ...draft,
    model: 'Qwen2 Image',
    previousStoryboardCreationId: 'previous-board',
    nextStoryboardCreationId: 'next-board',
  })
  assert.equal(limited.ok, false)
  if (limited.ok) return
  assert.equal(limited.code, 'too-many-references')
  assert.equal(limited.referenceCount, 2)
  assert.equal(limited.maxReferenceImages, 1)

  const byScenes = createDefaultStoryboardDraft(2)
  byScenes.workflowMode = 'scenes'
  byScenes.model = 'Nano Banana 2'
  byScenes.storySummary = 'The current section connects the adjacent boards.'
  byScenes.previousStoryboardCreationId = 'previous-board'
  byScenes.scenes[0].prompt = 'The courier enters the current concourse.'
  byScenes.scenes[1].prompt = 'The courier reaches the current platform.'
  byScenes.nextStoryboardCreationId = 'next-board'
  const compiledScenes = compileGeneratedStoryboardBoard(byScenes)
  assert.equal(compiledScenes.ok, true)
  if (!compiledScenes.ok) return
  assert.deepEqual(compiledScenes.referenceCreationIds, ['previous-board', 'next-board'])
  assert.match(compiledScenes.prompt, /PREVIOUS STORYBOARD — incoming continuity context/)
  assert.match(compiledScenes.prompt, /NEXT STORYBOARD — outgoing continuity context/)
  assert.match(compiledScenes.prompt, /Generate only the current storyboard/)
  assert.match(compiledScenes.prompt, /Current-scene references constrain only their mapped scenes/)
  assert.doesNotMatch(compiledScenes.prompt, /Maintain visual continuity\. References constrain only their mapped scenes/)
  assert.match(compiledScenes.prompt, /EXACT ORDERED SCENES/)
})

test('by-scenes prompt derives timing from its rows without leaking hidden Full timing values', () => {
  const draft = createDefaultStoryboardDraft(3)
  draft.workflowMode = 'scenes'
  draft.timingMode = 'none'
  draft.title = 'Night Courier'
  draft.storyBrief = 'HIDDEN_FULL_MODE_STORY'
  draft.storySummary = 'A courier chooses compassion over the delivery.'
  draft.style = 'Cinematic'
  draft.totalDurationSeconds = 777
  draft.scenes[0] = {
    ...draft.scenes[0],
    title: 'Arrival',
    prompt: 'OPENING_VISUAL_SENTINEL',
    explanation: 'The courier enters the station.',
    durationSeconds: 111,
    referenceCreationIds: ['opening-ref'],
  }
  draft.scenes[1] = {
    ...draft.scenes[1],
    title: 'Choice',
    prompt: 'MIDDLE_VISUAL_SENTINEL',
    explanation: 'The courier sees someone in danger.',
    durationSeconds: 222,
  }
  draft.scenes[2] = {
    ...draft.scenes[2],
    title: 'Rescue',
    prompt: 'FINAL_SCENE_VISUAL_SENTINEL',
    explanation: 'The complete story ends with the rescue.',
    durationSeconds: 444,
    referenceCreationIds: ['ending-ref'],
  }

  const prompt = buildGeneratedStoryboardBoardPrompt(draft)

  assert.match(prompt, /Night Courier/)
  assert.match(prompt, /A courier chooses compassion over the delivery/)
  assert.doesNotMatch(prompt, /HIDDEN_FULL_MODE_STORY/)
  assert.match(prompt, /Visual style: Cinematic/)
  assert.match(prompt, /SCENE 03 OF 03/)
  assert.match(prompt, /FINAL_SCENE_VISUAL_SENTINEL/)
  assert.match(prompt, /REFERENCE IMAGE 01: authoritative visual reference for Scene 01 only/)
  assert.match(prompt, /REFERENCE IMAGE 02: authoritative visual reference for Scene 03 only/)
  assert(prompt.indexOf('OPENING_VISUAL_SENTINEL') < prompt.indexOf('MIDDLE_VISUAL_SENTINEL'))
  assert(prompt.indexOf('MIDDLE_VISUAL_SENTINEL') < prompt.indexOf('FINAL_SCENE_VISUAL_SENTINEL'))
  assert.match(prompt, /Timing mode: automatic pacing/)
  assert.match(prompt, /Total runtime:/)
  assert.match(prompt, /Timing: 00:00/)
  assert.doesNotMatch(prompt, /777|444|222|111/)
})

test('one-second manual By Scenes output compiles below the Full Storyboard duration floor', () => {
  const draft = createDefaultStoryboardDraft(1)
  draft.workflowMode = 'scenes'
  draft.timingMode = 'none'
  draft.totalDurationSeconds = 5
  draft.storySummary = 'A single quick insert.'
  draft.scenes[0] = {
    ...draft.scenes[0],
    prompt: 'A key turns once in a lock.',
    durationMode: 'manual',
    durationSeconds: 1,
  }

  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert.match(compiled.prompt, /Timing mode: manual exact timing/)
  assert.match(compiled.prompt, /Total runtime: 1s/)
  assert.match(compiled.prompt, /Timing: 00:00–00:01 · 1s/)
})

test('Full Storyboard compiles directly from one brief at 5–90 seconds and ignores hidden rows', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'full'
  draft.timingMode = 'manual'
  draft.totalDurationSeconds = 90
  draft.storyBrief = 'A courier enters an empty station, abandons the delivery to rescue a stranger, and watches the train leave without them.'
  draft.scenes[0] = { ...draft.scenes[0], prompt: 'HIDDEN_FIRST_BEAT', durationSeconds: 5 }
  draft.scenes[1] = { ...draft.scenes[1], prompt: 'HIDDEN_SECOND_BEAT', durationSeconds: 5 }

  const compiled = compileGeneratedStoryboardBoard({ ...draft, scenes: [] })
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert.match(compiled.prompt, /Story Brief as the only narrative plan/)
  assert.match(compiled.prompt, /Total story duration: 1m 30s/)
  assert.match(compiled.prompt, /courier enters an empty station/)
  assert.doesNotMatch(compiled.prompt, /HIDDEN_FIRST_BEAT|HIDDEN_SECOND_BEAT|EXACT ORDERED SCENES|Timing:/)

  const invalid = compileGeneratedStoryboardBoard({ ...draft, totalDurationSeconds: 91, scenes: [] })
  assert.equal(invalid.ok, false)
  if (invalid.ok) return
  assert.equal(invalid.code, 'invalid-timing')
})

test('By Scenes still emits exact ordered ranges from its independent rows', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'scenes'
  draft.storySummary = 'A two-beat sequence.'
  draft.scenes[0] = { ...draft.scenes[0], prompt: 'First beat', durationMode: 'manual', durationSeconds: 5 }
  draft.scenes[1] = { ...draft.scenes[1], prompt: 'Second beat', durationMode: 'manual', durationSeconds: 5 }

  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert.match(compiled.prompt, /Timing mode: manual exact timing/)
  assert.match(compiled.prompt, /Total runtime: 10s/)
  assert.match(compiled.prompt, /Timing: 00:00–00:05 · 5s/)
  assert.match(compiled.prompt, /Timing: 00:05–00:10 · 5s/)
})

test('By Scenes complete-board prompts preserve half-second manual ranges', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'scenes'
  draft.storySummary = 'A fast two-beat sequence.'
  draft.scenes[0] = { ...draft.scenes[0], prompt: 'First beat', durationMode: 'manual', durationSeconds: 1.5 }
  draft.scenes[1] = { ...draft.scenes[1], prompt: 'Second beat', durationMode: 'manual', durationSeconds: 2.5 }

  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert.match(compiled.prompt, /Total runtime: 4s/)
  assert.match(compiled.prompt, /Timing: 00:00–00:01\.5 · 1\.5s/)
  assert.match(compiled.prompt, /Timing: 00:01\.5–00:04 · 2\.5s/)
})

test('single-board compilation rejects a sixteenth scene before building provider input', () => {
  const draft = createDefaultStoryboardDraft(15)
  draft.workflowMode = 'scenes'
  draft.storySummary = 'An ordered scene plan.'
  draft.scenes.forEach((scene, index) => { scene.prompt = `Scene ${index + 1}` })
  draft.scenes.push({ ...draft.scenes[0], id: 'scene-16', prompt: 'Scene 16' })

  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, false)
  if (!compiled.ok) assert.equal(compiled.code, 'too-many-scenes')
})

test('aggregate per-scene references over the selected model limit fail before runnable input is returned', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'scenes'
  draft.model = 'Qwen2 Image'
  draft.scenes[0].prompt = 'Opening panel'
  draft.scenes[0].referenceCreationIds = ['ref-one']
  draft.scenes[1].prompt = 'Closing panel'
  draft.scenes[1].referenceCreationIds = ['ref-two']

  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, false)
  if (compiled.ok) return
  assert.equal(compiled.code, 'too-many-references')
  assert.equal(compiled.referenceCount, 2)
  assert.equal(compiled.maxReferenceImages, 1)
  assert.match(compiled.error, /Remove references or use the exact scene-by-scene board option/)
  assert.equal('prompt' in compiled, false)
})

test('compact one-scene boards remain usable on the smallest verified prompt budget', () => {
  const draft = createDefaultStoryboardDraft(1)
  draft.workflowMode = 'full'
  draft.timingMode = 'none'
  draft.model = 'Qwen2 Image'
  draft.storyBrief = 'A quiet arrival.'
  draft.scenes[0].prompt = 'HIDDEN_SCENE_PROMPT'

  const compiled = compileGeneratedStoryboardBoard(draft)
  assert.equal(compiled.ok, true)
  if (!compiled.ok) return
  assert(compiled.promptCharacters <= compiled.promptMax)
  assert.match(compiled.prompt, /A quiet arrival/)
  assert.doesNotMatch(compiled.prompt, /HIDDEN_SCENE_PROMPT|EXACT ORDERED SCENES/)
})

test('over-limit complete prompts fail without truncating or dropping the final scene', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'scenes'
  draft.model = 'Qwen2 Image'
  draft.storySummary = 'A complete story that must stay intact.'
  draft.scenes[0].prompt = `OPENING ${'a'.repeat(520)}`
  draft.scenes[1].prompt = `FINAL_SCENE_MUST_SURVIVE ${'b'.repeat(520)}`

  const completePrompt = buildGeneratedStoryboardBoardPrompt(draft)
  const compiled = compileGeneratedStoryboardBoard(draft)

  assert.match(completePrompt, /FINAL_SCENE_MUST_SURVIVE/)
  assert.equal(compiled.ok, false)
  if (compiled.ok) return
  assert.equal(compiled.code, 'prompt-too-long')
  assert.equal(compiled.promptCharacters, promptCharacterCount(completePrompt))
  assert.equal(compiled.promptMax, 800)
  assert.match(compiled.error, /Nothing was truncated or generated/)
  assert.equal('prompt' in compiled, false)
})

test('successful compilation returns runImage reference order and a stable whole-input fingerprint', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'scenes'
  draft.model = 'Nano Banana 2'
  draft.storySummary = 'An ordered two-scene story.'
  draft.scenes[0].prompt = 'A wide establishing shot.'
  draft.scenes[0].referenceCreationIds = ['first-ref', 'shared-ref']
  draft.scenes[1].prompt = 'A close final portrait.'
  draft.scenes[1].referenceCreationIds = ['shared-ref', 'last-ref']

  const first = compileGeneratedStoryboardBoard(draft)
  const repeated = compileGeneratedStoryboardBoard(draft)
  assert.equal(first.ok, true)
  assert.equal(repeated.ok, true)
  if (!first.ok || !repeated.ok) return
  assert.deepEqual(first.referenceCreationIds, ['first-ref', 'shared-ref', 'last-ref'])
  assert.equal(first.referenceCount, 3)
  assert.equal(first.maxReferenceImages, 14)
  assert.equal(first.inputFingerprint, repeated.inputFingerprint)
  assert.equal(first.promptCharacters, promptCharacterCount(first.prompt))

  const changed = compileGeneratedStoryboardBoard({
    ...draft,
    scenes: draft.scenes.map((scene, index) => index === 1 ? { ...scene, prompt: `${scene.prompt} At sunrise.` } : scene),
  })
  assert.equal(changed.ok, true)
  if (!changed.ok) return
  assert.notEqual(changed.inputFingerprint, first.inputFingerprint)
})

test('Full Storyboard fingerprint follows its brief and total, not hidden scene content', () => {
  const draft = createDefaultStoryboardDraft(2)
  draft.workflowMode = 'full'
  draft.timingMode = 'manual'
  draft.totalDurationSeconds = 45
  draft.storyBrief = 'A child follows a paper boat through a flooded city and finds their family.'
  draft.scenes[0].prompt = 'HIDDEN_OLD_PLAN'

  const first = compileGeneratedStoryboardBoard(draft)
  const hiddenChanged = compileGeneratedStoryboardBoard({
    ...draft,
    scenes: draft.scenes.map((scene) => ({ ...scene, prompt: 'HIDDEN_NEW_PLAN' })),
  })
  const briefChanged = compileGeneratedStoryboardBoard({ ...draft, storyBrief: `${draft.storyBrief} At sunrise.` })
  const timingChanged = compileGeneratedStoryboardBoard({ ...draft, totalDurationSeconds: 46 })
  assert.equal(first.ok, true)
  assert.equal(hiddenChanged.ok, true)
  assert.equal(briefChanged.ok, true)
  assert.equal(timingChanged.ok, true)
  if (!first.ok || !hiddenChanged.ok || !briefChanged.ok || !timingChanged.ok) return
  assert.equal(hiddenChanged.inputFingerprint, first.inputFingerprint)
  assert.notEqual(briefChanged.inputFingerprint, first.inputFingerprint)
  assert.notEqual(timingChanged.inputFingerprint, first.inputFingerprint)
})

test('unknown models, missing briefs and empty By-Scenes plans return blocking validation errors', () => {
  const draft = createDefaultStoryboardDraft()
  draft.scenes[0].prompt = 'A frame.'

  const unknown = compileGeneratedStoryboardBoard({ ...draft, model: 'Unknown image model' })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.code, 'unsupported-model')

  const missingBrief = compileGeneratedStoryboardBoard({ ...draft, scenes: [] })
  assert.equal(missingBrief.ok, false)
  if (!missingBrief.ok) assert.equal(missingBrief.code, 'missing-story')

  const direct = compileGeneratedStoryboardBoard({ ...draft, storyBrief: 'A complete story.', scenes: [] })
  assert.equal(direct.ok, true)

  const empty = compileGeneratedStoryboardBoard({ ...draft, workflowMode: 'scenes', storySummary: 'Story', scenes: [] })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.code, 'missing-scenes')
})
