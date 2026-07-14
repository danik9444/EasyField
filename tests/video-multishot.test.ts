import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MULTI_SHOT_RULES,
  MULTI_SHOT_CONTINUITY_DIRECTION,
  appendMultiShotScene,
  buildMultiShotEnhancementContext,
  compileMultiShotProviderScenes,
  moveMultiShotScene,
  normalizeMultiShotScenes,
  removeMultiShotScene,
  totalMultiShotDuration,
  updateMultiShotSceneDuration,
  validateMultiShotDraft,
} from '../src/data/videoMultiShot.ts'

const rules = { ...DEFAULT_MULTI_SHOT_RULES }

const idFactory = (prefix = 'scene') => {
  let index = 0
  return () => `${prefix}-${++index}`
}

const validScenes = () => [
  { id: 'opening', prompt: 'A courier enters the abandoned station.', duration: '3' },
  { id: 'ending', prompt: 'The courier opens the case as the lights return.', duration: '4' },
]

test('default multi-shot rules match the verified Kling sequence contract', () => {
  assert.deepEqual(DEFAULT_MULTI_SHOT_RULES, {
    minShots: 2,
    maxShots: 5,
    shotMin: 1,
    shotMax: 12,
    totalMin: 3,
    totalMax: 15,
    promptMax: 500,
    briefMax: 260,
  })
})

test('the hidden provider direction is fixed, valid and never depends on a removed user brief', () => {
  assert(MULTI_SHOT_CONTINUITY_DIRECTION.length > 0)
  assert(MULTI_SHOT_CONTINUITY_DIRECTION.length <= rules.briefMax)
  assert.equal(validateMultiShotDraft({
    brief: MULTI_SHOT_CONTINUITY_DIRECTION,
    scenes: validScenes(),
    elementTags: [],
    rules,
  }), null)
  const compiled = compileMultiShotProviderScenes({
    brief: MULTI_SHOT_CONTINUITY_DIRECTION,
    scenes: validScenes(),
    elementTags: [],
    rules,
  })
  assert.match(compiled[0].prompt, new RegExp(MULTI_SHOT_CONTINUITY_DIRECTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(compiled.map((shot) => shot.duration), [3, 4])
})

test('legacy multi-shot scenes hydrate into a bounded, unique and valid sequence', () => {
  const raw = [
    { id: 'legacy', prompt: '  Opening\u0000 shot  ', duration: '2.4', referenceTags: ['@hero', '@hero', ''] },
    { id: 'legacy', prompt: 'Middle shot', duration: 'not-a-number' },
    { id: '', prompt: 42, duration: '999' },
    { id: 42, prompt: 'Low point', duration: '-9' },
    { id: 'tail', prompt: 'Final shot', duration: 4 },
    { id: 'must-be-truncated', prompt: 'Outside the provider maximum', duration: 3 },
  ]
  const untouched = structuredClone(raw)

  const normalized = normalizeMultiShotScenes(raw, rules, idFactory('migrated'))

  assert.deepEqual(raw, untouched, 'draft migration must not mutate persisted input')
  assert.equal(normalized.length, rules.maxShots)
  assert.equal(new Set(normalized.map((scene) => scene.id)).size, normalized.length)
  assert.equal(normalized[0].id, 'legacy', 'the first valid stable ID should survive migration')
  assert.notEqual(normalized[1].id, 'legacy', 'a duplicate legacy ID must be regenerated')
  assert.equal(normalized.some((scene) => scene.id === 'must-be-truncated'), false)
  assert.equal(normalized[0].prompt, 'Opening shot')
  assert.deepEqual(normalized[0].referenceTags, ['@hero'])
  assert(normalized.every((scene) => Number.isInteger(Number(scene.duration))))
  assert(normalized.every((scene) => Number(scene.duration) >= rules.shotMin && Number(scene.duration) <= rules.shotMax))
  assert.equal(totalMultiShotDuration(normalized), rules.totalMax)
})

test('missing or unusable legacy scene data receives a safe minimum draft', () => {
  const normalized = normalizeMultiShotScenes({ scenes: 'corrupt' }, rules, idFactory('fresh'))

  assert.equal(normalized.length, rules.minShots)
  assert.deepEqual(normalized.map((scene) => scene.prompt), ['', ''])
  assert.equal(new Set(normalized.map((scene) => scene.id)).size, normalized.length)
  assert(totalMultiShotDuration(normalized) >= rules.totalMin)
  assert(totalMultiShotDuration(normalized) <= rules.totalMax)
})

test('scene helpers add, remove and reorder without mutating the current draft', () => {
  const original = validScenes()
  const originalSnapshot = structuredClone(original)
  const added = appendMultiShotScene(original, rules, idFactory('added'))

  assert.deepEqual(original, originalSnapshot)
  assert.equal(added.length, 3)
  assert.equal(added[2].id, 'added-1')
  assert.equal(added[2].prompt, '')
  assert(totalMultiShotDuration(added) <= rules.totalMax)

  const movedUp = moveMultiShotScene(added, added[2].id, -1)
  assert.deepEqual(movedUp.map((scene) => scene.id), ['opening', 'added-1', 'ending'])
  const movedBackDown = moveMultiShotScene(movedUp, added[2].id, 1)
  assert.deepEqual(movedBackDown.map((scene) => scene.id), ['opening', 'ending', 'added-1'])
  assert.deepEqual(moveMultiShotScene(added, 'opening', -1), added, 'moving past the first boundary is a no-op')
  assert.deepEqual(moveMultiShotScene(added, 'missing', 1), added, 'an unknown scene ID is a no-op')

  const removed = removeMultiShotScene(added, 'ending', rules, idFactory('replacement'))
  assert.deepEqual(removed.map((scene) => scene.id), ['opening', 'added-1'])
  assert.equal(removeMultiShotScene(removed, 'opening', rules, idFactory()).length, rules.minShots)
})

test('adding or editing timing preserves the configured sequence bounds', () => {
  const full = Array.from({ length: rules.maxShots }, (_, index) => ({
    id: `shot-${index + 1}`,
    prompt: `Shot ${index + 1}`,
    duration: '3',
  }))
  assert.equal(totalMultiShotDuration(full), rules.totalMax)
  assert.deepEqual(appendMultiShotScene(full, rules, idFactory()), full, 'adding at the model maximum is a no-op')

  const changed = updateMultiShotSceneDuration(full, 'shot-1', '12', rules, idFactory())
  assert(Number(changed[0].duration) > Number(full[0].duration), 'the edited shot should receive as much requested time as the total permits')
  assert(Number(changed[0].duration) <= rules.shotMax)
  assert.equal(totalMultiShotDuration(changed), rules.totalMax)
  assert(changed.every((scene) => Number(scene.duration) >= rules.shotMin))
})

test('enhancement context contains the full brief, ordered sibling plan, current marker and every reference', () => {
  const finalBriefSentinel = 'FINAL_BRIEF_SENTINEL'
  const brief = `${'A continuous night chase through one railway station. '.repeat(4)}${finalBriefSentinel}`
  const scenes = [
    { id: 'wide', prompt: 'OPENING_WIDE_SENTINEL', duration: '3', referenceTags: ['@hero'] },
    { id: 'close', prompt: 'CURRENT_CLOSE_SENTINEL', duration: '4', referenceTags: ['@hero', '@case'] },
    { id: 'resolve', prompt: 'FINAL_RESOLUTION_SENTINEL', duration: '5' },
  ]
  const context = buildMultiShotEnhancementContext({
    model: 'Kling 3',
    brief,
    scenes,
    aspect: '16:9',
    resolution: '1080p',
    referenceManifest: [
      'First frame: station-opening.png',
      '@hero: courier-front.jpg and courier-side.jpg',
      '@case: evidence-case.mov, sampled chronologically',
      '@case audio: metal-latch.wav (label only)',
    ],
    sound: true,
  }, 'close')

  assert.match(context, /TARGET MODEL: Kling 3/)
  assert.match(context, /16:9 .* 1080p .* 12s .* sound on/i)
  assert.match(context, new RegExp(finalBriefSentinel), 'the end of the complete brief must not be clipped')
  assert(context.indexOf('OPENING_WIDE_SENTINEL') < context.indexOf('CURRENT_CLOSE_SENTINEL'))
  assert(context.indexOf('CURRENT_CLOSE_SENTINEL') < context.indexOf('FINAL_RESOLUTION_SENTINEL'))
  assert.match(context, /SHOT 02 .* CURRENT SHOT/)
  assert.match(context, /@hero, @case/)
  assert.match(context, /station-opening\.png/)
  assert.match(context, /courier-front\.jpg and courier-side\.jpg/)
  assert.match(context, /evidence-case\.mov, sampled chronologically/)
  assert.match(context, /metal-latch\.wav \(label only\)/)
})

test('provider compilation is ordered, deterministic, selective about tags and never truncates valid text', () => {
  const brief = 'A courier crosses one station while the same storm and wardrobe remain continuous.'
  const finalPromptSentinel = 'FINAL_SCENE_TEXT_SENTINEL'
  const scenes = [
    {
      id: 'one',
      prompt: 'Begin in a wide master as the courier enters.',
      duration: '3',
    },
    {
      id: 'two',
      prompt: `Move into a handheld close-up and reveal the case. ${finalPromptSentinel}`,
      duration: '4',
      referenceTags: ['@case', '@missing', '@case'],
    },
  ]

  const compiled = compileMultiShotProviderScenes({
    brief,
    scenes,
    elementTags: ['@hero', '@case', '@hero', 'not-a-tag'],
    rules,
  })

  assert.deepEqual(compiled, [
    {
      prompt: `Sequence brief: ${brief}\nShot 1/2: Begin in a wide master as the courier enters. @hero @case`,
      duration: 3,
    },
    {
      prompt: `Continue the same sequence with consistent subjects, world and visual continuity. Shot 2/2: Move into a handheld close-up and reveal the case. ${finalPromptSentinel} @case`,
      duration: 4,
    },
  ])
  assert.match(compiled[1].prompt, new RegExp(`${finalPromptSentinel} @case$`))
  assert.equal(compiled[1].prompt.includes('@missing'), false)
  assert.equal(compiled[1].prompt.match(/@case/g)?.length, 1)
})

test('provider prompt budget counts each selected element tag as 37 characters', () => {
  const boundaryRules = {
    ...rules,
    minShots: 1,
    maxShots: 1,
    totalMin: 1,
    totalMax: 12,
    promptMax: 120,
  }
  const brief = 'B'
  const prefix = `Sequence brief: ${brief}\nShot 1/1: `
  const tagWeightedCost = 1 + 37 // one separator space plus Kling's documented tag weight
  const exactDirection = 'x'.repeat(boundaryRules.promptMax - prefix.length - tagWeightedCost)
  const exactInput = {
    brief,
    scenes: [{ id: 'only', prompt: exactDirection, duration: '3' }],
    elementTags: ['@hero'],
    rules: boundaryRules,
  }

  assert.equal(validateMultiShotDraft(exactInput), null, 'the exact weighted boundary should pass')
  const compiled = compileMultiShotProviderScenes(exactInput)
  assert(compiled[0].prompt.endsWith(`${exactDirection} @hero`), 'valid text must not be silently truncated')

  const overBudget = {
    ...exactInput,
    scenes: [{ ...exactInput.scenes[0], prompt: `${exactDirection}x` }],
  }
  assert.match(validateMultiShotDraft(overBudget) ?? '', /exceeds.*120-character provider budget/i)
  assert.throws(() => compileMultiShotProviderScenes(overBudget), /exceeds.*120-character provider budget/i)

  const tagExcluded = {
    ...overBudget,
    scenes: [{ ...overBudget.scenes[0], referenceTags: [] }],
  }
  assert.equal(validateMultiShotDraft(tagExcluded), null, 'unselected tags must not consume a shot budget')
})

test('draft validation enforces brief, count, whole-shot timing and exact total boundaries', () => {
  const validate = (brief: string, scenes: Array<{ id: string; prompt: string; duration: string }>) =>
    validateMultiShotDraft({ brief, scenes, elementTags: [], rules })

  assert.match(validate('', validScenes()) ?? '', /complete sequence/i)
  assert.match(validate('x'.repeat(rules.briefMax + 1), validScenes()) ?? '', new RegExp(`${rules.briefMax} characters`))
  assert.match(validate('Story', [validScenes()[0]]) ?? '', /2–5 shots/)
  assert.match(validate('Story', Array.from({ length: 6 }, (_, i) => ({ id: String(i), prompt: 'Shot', duration: '2' }))) ?? '', /2–5 shots/)
  assert.match(validate('Story', [{ ...validScenes()[0], prompt: '' }, validScenes()[1]]) ?? '', /Describe shot 1/)

  assert.equal(validate('Story', [
    { id: 'a', prompt: 'A', duration: '1' },
    { id: 'b', prompt: 'B', duration: '2' },
  ]), null, 'the exact total minimum and shot minimum should pass')
  assert.equal(validate('Story', [
    { id: 'a', prompt: 'A', duration: '12' },
    { id: 'b', prompt: 'B', duration: '3' },
  ]), null, 'the exact total maximum and shot maximum should pass')

  assert.match(validate('Story', [
    { id: 'a', prompt: 'A', duration: '1' },
    { id: 'b', prompt: 'B', duration: '1' },
  ]) ?? '', /total 3–15 seconds/)
  assert.match(validate('Story', [
    { id: 'a', prompt: 'A', duration: '8' },
    { id: 'b', prompt: 'B', duration: '8' },
  ]) ?? '', /total 3–15 seconds/)
  assert.match(validate('Story', [
    { id: 'a', prompt: 'A', duration: '1.5' },
    { id: 'b', prompt: 'B', duration: '2' },
  ]) ?? '', /whole seconds/)
  assert.match(validate('Story', [
    { id: 'a', prompt: 'A', duration: '13' },
    { id: 'b', prompt: 'B', duration: '2' },
  ]) ?? '', /1–12 whole seconds/)
})
