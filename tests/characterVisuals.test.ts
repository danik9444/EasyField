import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CHARACTER_TRAIT_GROUPS } from '../src/data/characterBuilder.ts'
import { getCharacterTraitVisual } from '../src/data/characterVisuals.ts'

test('every visual character card has a valid generated thumbnail', () => {
  const cardGroups = CHARACTER_TRAIT_GROUPS.filter((group) => group.layout === 'cards')
  const atlases = new Set<string>()

  for (const group of cardGroups) {
    for (const option of group.options.filter((entry) => !entry.hidden)) {
      const visual = getCharacterTraitVisual(group.id, option.id)
      if (group.id === 'tattoos') {
        assert.equal(visual, null, 'tattoo setup remains a lightweight action card')
        continue
      }
      assert.ok(visual, `${group.id}.${option.id} is missing a visual`)
      assert.ok(visual.index >= 0 && visual.index < visual.columns * visual.rows, `${group.id}.${option.id} points outside its atlas`)
      atlases.add(visual.atlas)
    }
  }

  assert.ok(atlases.size > 0)
  for (const atlas of atlases) {
    assert.match(atlas, /^file:/)
    assert.ok(existsSync(fileURLToPath(atlas)), `${atlas} does not exist`)
  }
})

test('chip and swatch controls remain lightweight non-image controls', () => {
  // Skin tone is intentionally being migrated from swatches to portrait cards. It
  // already has visuals so the transition cannot briefly leave blank cards.
  for (const group of CHARACTER_TRAIT_GROUPS.filter((entry) => entry.layout !== 'cards' && entry.id !== 'skinTone')) {
    for (const option of group.options) {
      assert.equal(getCharacterTraitVisual(group.id, option.id), null)
    }
  }
})

function visualKey(groupId: Parameters<typeof getCharacterTraitVisual>[0], optionId: string) {
  const visual = getCharacterTraitVisual(groupId, optionId)
  assert.ok(visual, `${groupId}.${optionId} is missing a visual`)
  return `${visual.atlas}|${visual.columns}x${visual.rows}|${visual.index}`
}

test('the redesigned character types have image cards', () => {
  for (const id of ['human', 'superhero', 'elf', 'cartoon']) {
    assert.ok(getCharacterTraitVisual('type', id), `type.${id} is missing a visual`)
  }
  const cartoon = getCharacterTraitVisual('type', 'cartoon')
  assert.equal(cartoon?.columns, 1)
  assert.equal(cartoon?.rows, 1)
  assert.match(cartoon?.atlas ?? '', /cartoon-character/)
})

test('skin comparison keeps one human identity and one fantasy identity', () => {
  const humanTones = ['porcelain', 'fair', 'light', 'medium', 'tan', 'brown', 'deep']
  const fantasyTones = ['obsidian', 'green', 'blue', 'purple']
  const humanKey = visualKey('skinTone', humanTones[0])
  const fantasyKey = visualKey('skinTone', fantasyTones[0])

  for (const id of humanTones) assert.equal(visualKey('skinTone', id), humanKey)
  for (const id of fantasyTones) assert.equal(visualKey('skinTone', id), fantasyKey)
  assert.notEqual(fantasyKey, humanKey)
  assert.equal(visualKey('skinTone', 'custom'), humanKey)
})

test('heritage cards use one clean dedicated atlas without legacy row bleed', () => {
  const ids = ['african', 'asian', 'european', 'indian', 'middle-eastern', 'mixed']
  const visuals = ids.map((id) => getCharacterTraitVisual('heritage', id))
  for (const [index, visual] of visuals.entries()) {
    assert.ok(visual, `heritage.${ids[index]} is missing a visual`)
    assert.equal(visual.columns, 3)
    assert.equal(visual.rows, 2)
    assert.equal(visual.index, index)
    assert.match(visual.atlas, /heritage-atlas/)
  }
})

test('age, body and hair choices expose the requested six visual stages', () => {
  const ages = ['baby', 'child', 'teen', 'young-adult', 'mature', 'senior']
  const bodyTypes = ['very-thin', 'slim', 'average', 'athletic', 'heavy', 'very-heavy']
  const hairstyles = ['bald', 'short', 'long', 'afro', 'curly', 'bob']

  const ageVisuals = ages.map((id) => getCharacterTraitVisual('age', id))
  for (const [index, visual] of ageVisuals.entries()) {
    assert.ok(visual, `age.${ages[index]} is missing a visual`)
    assert.equal(visual.columns, 3)
    assert.equal(visual.rows, 2)
    assert.equal(visual.index, index)
    assert.match(visual.atlas, /age-progression-atlas/)
  }
  assert.equal(new Set(ageVisuals.map((visual) => visual?.atlas)).size, 1)
  assert.deepEqual(bodyTypes.map((id) => getCharacterTraitVisual('bodyType', id)?.index), [6, 0, 1, 2, 4, 5])

  for (const id of hairstyles) {
    const visual = getCharacterTraitVisual('hair', id)
    assert.ok(visual, `hair.${id} is missing a visual`)
    assert.doesNotMatch(visual.atlas, /style-options/, `hair.${id} should use a human portrait example`)
  }
})
