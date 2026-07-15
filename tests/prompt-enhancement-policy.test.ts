import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROMPT_ENHANCEMENT_TEMPERATURE,
  buildEnhanceSystemMessage,
  buildEnhanceUserMessage,
  type EnhanceMediaKind,
  type EnhancePurpose,
} from '../src/services/chat.ts'
import { resolvePromptEnhancementProfile } from '../src/data/promptEnhancementProfiles.ts'

test('every prompt enhancement kind follows the same strict fidelity contract', () => {
  const cases: Array<[EnhanceMediaKind, EnhancePurpose]> = [
    ['image', 'create'],
    ['video', 'edit'],
    ['audio', 'single-sfx'],
    ['workflow', 'workflow'],
  ]

  cases.forEach(([mediaKind, purpose]) => {
    const system = buildEnhanceSystemMessage(
      'Generic target model',
      mediaKind,
      1_234,
      undefined,
      true,
      { label: 'project context', text: 'Read-only facts' },
      purpose,
    )
    assert.match(system, /Never invent or choose an unspecified subject/i, mediaKind)
    assert.match(system, /Missing or ambiguous information must remain unspecified/i, mediaKind)
    assert.match(system, /Model adaptation may change wording, order and structure only/i, mediaKind)
    assert.match(system, /never permits new facts, new scope/i, mediaKind)
    assert.match(system, /preserve names, quoted dialogue, onscreen text/i, mediaKind)
    assert.match(system, /Never infer unseen action, identity, story, causality, dialogue, sound or timing/i, mediaKind)
    assert.match(system, /read-only.*never rewrite, quote, summarize, fill blanks from/si, mediaKind)
  })
})

test('enhancement length is proportional to the request instead of the model ceiling', () => {
  const system = buildEnhanceSystemMessage('Generic target model', 'video', 20_000, undefined, false, undefined, 'create')
  assert.match(system, /Use the shortest prompt that expresses the request accurately/i)
  assert.match(system, /simple request should usually remain a few concise sentences or lines/i)
  assert.match(system, /Use more detail only when the user supplied more detail/i)
  assert.match(system, /20,?000 characters is a hard ceiling, never a target/i)
  assert.match(system, /There is no minimum length and no padding/i)
  assert.doesNotMatch(system, /Write with rich, production-ready specificity/i)
  assert.doesNotMatch(system, /One flowing, coherent, richly detailed description/i)
  assert.doesNotMatch(system, /enrich, don't contradict/i)
})

test('Seedance 2 family gets conditional long-form guidance without permission to pad', () => {
  for (const model of ['Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini']) {
    const profile = resolvePromptEnhancementProfile(model, 'video', 'create')
    assert.equal(profile.id, 'seedance-2', model)
    assert.match(profile.modelGuidance, /longer chronological prompt when the user supplied/i, model)
    assert.match(profile.modelGuidance, /A simple request must still stay concise/i, model)
    assert.match(profile.modelGuidance, /Never add beats, time segments, camera moves/i, model)
  }

  for (const lookalike of ['Seedance 20', 'New Seedance 2 preview', 'Seedance 2.1']) {
    assert.equal(resolvePromptEnhancementProfile(lookalike, 'video', 'create').id, 'adaptive', lookalike)
  }

  const generic = buildEnhanceSystemMessage('Generic video model', 'video', 20_000, undefined, false, undefined, 'create')
  assert.doesNotMatch(generic, /Seedance 2 can use a longer chronological prompt/i)
})

test('task purpose prevents create-style expansion in edit, angle, story, Foley and character prompts', () => {
  const expected: Array<[EnhancePurpose, string]> = [
    ['edit', 'Describe only the requested change'],
    ['angle', 'Refine only camera position'],
    ['story-brief', 'Improve only the story brief'],
    ['story-scene', 'Improve only the current scene text'],
    ['multi-shot-scene', 'Improve only the current shot'],
    ['foley-direction', 'Describe only Foley events'],
    ['character-notes', 'Clarify only the custom character traits'],
  ]
  expected.forEach(([purpose, phrase]) => {
    const system = buildEnhanceSystemMessage('Generic target model', purpose === 'foley-direction' ? 'audio' : 'image', 2_000, undefined, false, undefined, purpose)
    assert.match(system, new RegExp(phrase, 'i'), purpose)
  })
})

test('short and detailed primary requests are sent in full as the authoritative source', () => {
  const short = buildEnhanceUserMessage({
    rough: 'A dog runs.',
    targetModel: 'Seedance 2',
    mediaKind: 'video',
    purpose: 'create',
  })
  assert.match(short, /AUTHORITATIVE PRIMARY TEXT TO IMPROVE/)
  assert.match(short, /"A dog runs\."/)
  assert.match(short, /complete creative request/i)

  const tail = 'FINAL_USER_DETAIL_SENTINEL'
  const detailedRequest = `${'Explicit supplied action. '.repeat(300)}No dialogue. No new characters. ${tail}`
  const detailed = buildEnhanceUserMessage({
    rough: detailedRequest,
    targetModel: 'Seedance 2',
    mediaKind: 'video',
    purpose: 'create',
    supportingContext: { label: 'sequence context', text: 'Read-only sibling shot' },
  }, ['- reference video "Source" [frames attached]'], 1)
  assert.match(detailed, /No dialogue\. No new characters\./)
  assert.match(detailed, new RegExp(tail))
  assert.ok(detailed.indexOf('AUTHORITATIVE PRIMARY') < detailed.indexOf('READ-ONLY SEQUENCE CONTEXT'))
  assert.ok(detailed.indexOf('READ-ONLY SEQUENCE CONTEXT') < detailed.indexOf('Reference material I attached'))
})

test('faithful enhancement uses low creativity without changing planner sampling', () => {
  assert.equal(PROMPT_ENHANCEMENT_TEMPERATURE, 0.2)
})
