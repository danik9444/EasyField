import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHARACTER_BASIC_GROUPS,
  CHARACTER_TATTOO_REGIONS,
  CHARACTER_TRAIT_GROUPS,
  compileCharacterPrompt,
  compileCharacterSelectionContext,
  createDefaultCharacterDraft,
  normalizeCharacterDraft,
  toggleCharacterSelection,
} from '../src/data/characterBuilder.ts'

const visibleOptions = (groupId: string) => CHARACTER_TRAIT_GROUPS
  .find((group) => group.id === groupId)?.options
  .filter((entry) => !entry.hidden)
  .map((entry) => entry.label)

test('character v2 defaults cover the compact main registry', () => {
  const draft = createDefaultCharacterDraft()
  assert.equal(draft.schemaVersion, 2)
  assert.deepEqual(CHARACTER_BASIC_GROUPS.map((group) => group.id), [
    'type', 'gender', 'heritage', 'bodyType', 'skinTone', 'age', 'hair', 'eyeColor', 'tattoos',
  ])
  assert.equal(CHARACTER_TRAIT_GROUPS.length, 9)
  for (const group of CHARACTER_BASIC_GROUPS) {
    const value = draft.basics[group.id]
    assert.equal(value, '', `${group.id} must start unselected`)
  }
  assert.deepEqual(draft.tattooRegions, [])
  assert.deepEqual(draft.advanced, {})
})

test('approved visible taxonomy has four types, six ages, six bodies, and six human hairstyles', () => {
  assert.deepEqual(visibleOptions('type'), ['Human', 'Superhero', 'Elf', 'Cartoon character'])
  assert.deepEqual(visibleOptions('bodyType'), ['Very thin', 'Slim', 'Average', 'Athletic', 'Heavy', 'Very heavy'])
  assert.deepEqual(visibleOptions('skinTone'), ['Porcelain', 'Fair', 'Light', 'Medium', 'Tan', 'Brown', 'Deep', 'Obsidian', 'Green', 'Blue', 'Purple', 'Custom color'])
  assert.deepEqual(visibleOptions('age'), ['Baby', 'Child', 'Teen', 'Young adult', 'Mature', 'Senior'])
  assert.deepEqual(visibleOptions('hair'), ['Bald', 'Short hair', 'Long hair', 'Afro', 'Curly', 'Pixie cut'])
  assert.deepEqual(visibleOptions('tattoos'), ['Add tattoos'])
  assert.deepEqual(CHARACTER_TATTOO_REGIONS.map((entry) => entry.id), ['face', 'neck', 'torso', 'back', 'arms', 'legs'])
  assert.equal(CHARACTER_TRAIT_GROUPS.some((group) => group.id === 'skinDetails'), false)
})

test('repeat-click selection helper clears an active ordinary choice', () => {
  assert.equal(toggleCharacterSelection('elf', 'elf'), '')
  assert.equal(toggleCharacterSelection('', 'elf'), 'elf')
  assert.equal(toggleCharacterSelection('human', 'elf'), 'elf')
})

test('normalization preserves deliberate empty selections and drops invalid persisted selections', () => {
  const draft = normalizeCharacterDraft({
    schemaVersion: 2,
    mode: 'reference',
    referenceName: ' Sample\u0000 portrait.png ',
    referenceStrength: 999,
    basics: { type: '', gender: '', age: 'senior', bodyType: '../../bad', tattoos: '' },
    tattooRegions: ['face', 'face', 'arms', 'invalid'],
    customSkinColor: 'not-a-color',
    customNotes: 'x'.repeat(1200),
    preserveIdentity: false,
  })
  assert.equal(draft.mode, 'reference')
  assert.equal(draft.referenceStrength, 100)
  assert.equal(draft.basics.type, '')
  assert.equal(draft.basics.gender, '')
  assert.equal(draft.basics.age, 'senior')
  assert.equal(draft.basics.bodyType, '')
  assert.deepEqual(draft.tattooRegions, [])
  assert.equal(draft.customSkinColor, '#B86DFF')
  assert.equal(draft.customNotes.length, 1200)
  assert.equal(draft.preserveIdentity, false)
})

test('v1 advanced body, hair, and tattoo data migrate while removed advanced traits are discarded', () => {
  const migrated = normalizeCharacterDraft({
    schemaVersion: 1,
    basics: { type: 'elf', age: 'adult' },
    advanced: {
      bodyType: 'skinny',
      hair: 'afro',
      markings: 'tattoos',
      horns: 'antlers',
      eyeDetails: 'glowing',
      renderStyle: 'anime',
    },
  })
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.basics.type, 'elf')
  assert.equal(migrated.basics.age, 'young-adult')
  assert.equal(migrated.basics.bodyType, 'very-thin')
  assert.equal(migrated.basics.hair, 'afro')
  assert.equal(migrated.basics.tattoos, 'tattoos')
  assert.deepEqual(migrated.advanced, {})

  const prompt = compileCharacterPrompt(migrated)
  assert.match(prompt, /very thin body type/i)
  assert.match(prompt, /natural afro hairstyle/i)
  assert.match(prompt, /tattoos/i)
  assert.doesNotMatch(prompt, /antlers|glowing eyes|anime/i)
})

test('compiled prompt omits cleared groups and includes custom skin, age, tattoo regions, and notes', () => {
  const draft = createDefaultCharacterDraft()
  draft.basics.gender = ''
  draft.basics.heritage = ''
  draft.basics.skinTone = 'custom'
  draft.customSkinColor = '#12abef'
  draft.basics.age = 'custom'
  draft.customAge = 37
  draft.basics.tattoos = 'tattoos'
  draft.tattooRegions = ['arms', 'back']
  draft.customNotes = 'calm intelligence, silver collar'

  const prompt = compileCharacterPrompt(draft)
  assert.match(prompt, /custom skin color #12ABEF/i)
  assert.match(prompt, /37-year-old appearance/i)
  assert.match(prompt, /tattoos placed on the arms and back/i)
  assert.match(prompt, /silver collar/i)
  assert.doesNotMatch(prompt, /feminine presentation|mixed-heritage/i)
  assert.doesNotMatch(prompt, /Core identity:\s*\.|Detailed design:\s*\./i)
})

test('structured enhancer context excludes free-form notes', () => {
  const draft = createDefaultCharacterDraft()
  draft.basics.type = 'superhero'
  draft.basics.tattoos = 'tattoos'
  draft.tattooRegions = ['neck']
  draft.customNotes = 'secret phrase that must be enhanced separately'

  const context = compileCharacterSelectionContext(draft)
  assert.match(context, /cinematic superhero/i)
  assert.match(context, /tattoos placed on the neck/i)
  assert.doesNotMatch(context, /secret phrase/i)
})

test('tattoo selection never invents a placement when no region was chosen', () => {
  const draft = createDefaultCharacterDraft()
  draft.basics.tattoos = 'tattoos'

  const context = compileCharacterSelectionContext(draft)
  assert.match(context, /tattoos with placement left unspecified/i)
  assert.doesNotMatch(context, /chosen to suit/i)
})

test('an exact custom age is validated and invalid custom age becomes unselected', () => {
  const clamped = normalizeCharacterDraft({ basics: { age: 'custom' }, customAge: 999 })
  assert.equal(clamped.basics.age, 'custom')
  assert.equal(clamped.customAge, 120)

  const invalid = normalizeCharacterDraft({ basics: { age: 'custom' }, customAge: 'not-an-age' })
  assert.equal(invalid.basics.age, '')
  assert.equal(invalid.customAge, null)
})

test('reference mode describes identity preservation and selected strength', () => {
  const draft = createDefaultCharacterDraft()
  draft.mode = 'reference'
  draft.referenceStrength = 64
  draft.referenceName = 'hero.png'
  const prompt = compileCharacterPrompt(draft)
  assert.match(prompt, /attached character sample/i)
  assert.match(prompt, /64% identity/i)
  assert.match(prompt, /Preserve the recognizable facial identity/i)
})
