import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROMPT_ENHANCEMENT_TEMPERATURE,
  buildEnhanceSystemMessage,
  buildEnhanceUserMessage,
  canEnhancePrompt,
  resolveEnhancementInputMode,
  type EnhanceReference,
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

test('empty prompt enhancement is allowed by any attached reference kind', () => {
  const references: EnhanceReference[] = [
    { role: 'image reference', label: 'frame.png' },
    { role: 'video reference', label: 'clip.mov', durationSeconds: 4 },
    { role: 'audio reference', label: 'voice.wav', durationSeconds: 3 },
    { role: 'document reference', label: 'brief.docx' },
  ]
  assert.equal(canEnhancePrompt('', []), false)
  assert.equal(canEnhancePrompt('   ', []), false)
  assert.equal(canEnhancePrompt('Direction', []), true)
  for (const reference of references) assert.equal(canEnhancePrompt('', [reference]), true, reference.role)
  assert.equal(canEnhancePrompt('x', [], 3), false)
  assert.equal(canEnhancePrompt('x', [references[0]], 3), true)
  assert.equal(resolveEnhancementInputMode(''), 'reference-draft')
  assert.equal(resolveEnhancementInputMode('Keep this exact request'), 'rewrite')
})

test('reference-led Auto message never presents an empty string as a creative request', () => {
  const message = buildEnhanceUserMessage({
    rough: '   ',
    targetModel: 'Seedance 2',
    mediaKind: 'video',
    purpose: 'transition',
  }, [
    '- outgoing shot end frame "out.png" [image attached]',
    '- incoming shot start frame "in.png" [image attached]',
    '- audio reference "guide.wav" · duration 3.0s',
  ], 2)
  assert.match(message, /REFERENCE-LED AUTO DRAFT/)
  assert.match(message, /No written direction was supplied/i)
  assert.match(message, /outgoing shot end frame/)
  assert.match(message, /incoming shot start frame/)
  assert.match(message, /guide\.wav/)
  assert.doesNotMatch(message, /AUTHORITATIVE PRIMARY TEXT/)
  assert.doesNotMatch(message, /complete creative request/i)
  assert.doesNotMatch(message, /:\s*\n""/)
})

test('Transition is always an ordered endpoint bridge in Auto and normal enhancement', () => {
  const normal = buildEnhanceSystemMessage('Seedance 2', 'video', 20_000, undefined, true, undefined, 'transition', 'rewrite')
  assert.match(normal, /outgoing-shot end frame to the incoming-shot start frame/i)
  assert.match(normal, /bridge between those exact endpoints/i)
  assert.match(normal, /Preserve every transition method, motion or effect the user named/i)
  assert.match(normal, /never a standalone shot/i)

  const automatic = buildEnhanceSystemMessage('Seedance 2', 'video', 20_000, undefined, true, undefined, 'transition', 'reference-draft')
  assert.match(automatic, /begins exactly on the ordered outgoing-shot end frame/i)
  assert.match(automatic, /finishes exactly on the incoming-shot start frame/i)
  assert.match(automatic, /minimum transition mechanism supported by their visible relationship/i)
  assert.match(automatic, /never a standalone shot/i)
  assert.match(automatic, /must not add a subject, event, object, location, text, dialogue or sound/i)
  assert.match(automatic, /Names, roles, durations and notes are metadata/i)
})

test('every task purpose has a bounded reference-led Auto contract', () => {
  const purposes: EnhancePurpose[] = [
    'create', 'edit', 'extend', 'transition', 'angle', 'story-brief', 'story-scene',
    'multi-shot-scene', 'character-notes', 'animation', 'music', 'single-sfx',
    'foley-direction', 'avatar', 'broll', 'captions', 'transcribe', 'beat', 'culling', 'workflow',
  ]
  for (const purpose of purposes) {
    const profile = resolvePromptEnhancementProfile('Generic target', 'workflow', purpose, 'reference-draft')
    assert.equal(profile.inputMode, 'reference-draft', purpose)
    assert.ok(profile.purposeGuidance.length > 80, purpose)
    assert.doesNotMatch(profile.purposeGuidance, /Clarify only|Improve only the current/i, purpose)
  }
})
