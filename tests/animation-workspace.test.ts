import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANIMATION_SOUND_OPTIONS,
  ANIMATION_RECIPES,
  animationSoundInstruction,
  buildAnimationPromptContext,
  displayTextForAnimation,
  normalizeAnimationPrompts,
  normalizeAnimRecipe,
  normalizeAnimSoundMode,
  renderModeForRecipe,
} from '../src/data/animationConfig.ts'

const expectedRecipes = [
  ['custom', 'Custom'],
  ['smart-captions', 'Smart Captions'],
  ['text-motion-graphics', 'Text & Motion Graphics'],
  ['product-video', 'Product Video'],
  ['intros-outros', 'Intros & Outros'],
  ['overlays-graphics', 'Overlays & Graphics'],
  ['website-to-video', 'Website to Video'],
  ['audio-visualizer', 'Audio Visualizer'],
  ['data-to-video', 'Data to Video'],
] as const

test('publishes the exact Animation recipe ids, labels and display order', () => {
  assert.equal(ANIMATION_RECIPES.length, 9)
  assert.deepEqual(
    ANIMATION_RECIPES.map(({ id, label }) => [id, label]),
    expectedRecipes,
  )
})

test('normalizes current recipes and migrates every legacy Animation mode', () => {
  for (const [id] of expectedRecipes) assert.equal(normalizeAnimRecipe(id), id)

  assert.equal(normalizeAnimRecipe('presets'), 'text-motion-graphics')
  assert.equal(normalizeAnimRecipe('assets'), 'custom')
  assert.equal(normalizeAnimRecipe('template-video'), 'custom')
  assert.equal(normalizeAnimRecipe('prompt'), 'custom')
  assert.equal(normalizeAnimRecipe('unknown-recipe'), 'custom')
  assert.equal(normalizeAnimRecipe(undefined), 'custom')
  assert.equal(normalizeAnimRecipe(null), 'custom')
})

test('uses asset rendering only for media-led recipes with attached images', () => {
  const assetRecipes = ['custom', 'product-video', 'website-to-video', 'data-to-video'] as const

  for (const [id] of expectedRecipes) {
    assert.equal(renderModeForRecipe(id, 0), 'prompt', `${id} without images`)
    assert.equal(
      renderModeForRecipe(id, 2),
      assetRecipes.includes(id as (typeof assetRecipes)[number]) ? 'assets' : 'prompt',
      `${id} with images`,
    )
  }
})

test('migrates a removed Template Video prompt without retaining an unavailable recipe key', () => {
  const activeLegacyDraft = normalizeAnimationPrompts(
    { custom: 'Older custom idea', 'template-video': 'Keep this exact template draft', 'unsafe-recipe': 'ignore' },
    'template-video',
  )
  assert.deepEqual(activeLegacyDraft, { custom: 'Keep this exact template draft' })

  const inactiveLegacyDraft = normalizeAnimationPrompts(
    { 'template-video': 'Archived template direction', 'product-video': 'Product direction' },
    'product-video',
  )
  assert.deepEqual(inactiveLegacyDraft, {
    custom: 'Archived template direction',
    'product-video': 'Product direction',
  })

  assert.deepEqual(normalizeAnimationPrompts(undefined, 'assets', 'Legacy text field'), { custom: 'Legacy text field' })
})

test('publishes and normalizes the explicit Animation sound decision', () => {
  assert.deepEqual(ANIMATION_SOUND_OPTIONS.map(({ id, label }) => [id, label]), [
    ['with-sound', 'With sound'],
    ['without-sound', 'Without sound'],
  ])
  assert.equal(normalizeAnimSoundMode('with-sound'), 'with-sound')
  assert.equal(normalizeAnimSoundMode(true), 'with-sound')
  assert.equal(normalizeAnimSoundMode('without-sound'), 'without-sound')
  assert.equal(normalizeAnimSoundMode(false), 'without-sound')
  assert.equal(normalizeAnimSoundMode('unknown'), 'without-sound')
  assert.match(animationSoundInstruction('without-sound'), /final animation must be silent/i)
})

test('compiles format, sound and attached sources into prompt context', () => {
  const context = buildAnimationPromptContext(
    'product-video',
    'with-sound',
    'IMAGE REFERENCE · product-front.png\nDOCUMENT · launch-notes.docx',
  )
  assert.match(context, /SELECTED FORMAT · Product Video/)
  assert.match(context, /SOUND OUTPUT · With sound/)
  assert.match(context, /synchronized sound or music/i)
  assert.match(context, /ATTACHED MATERIAL\nIMAGE REFERENCE/)

  const migrated = buildAnimationPromptContext('template-video', 'invalid')
  assert.match(migrated, /SELECTED FORMAT · Custom/)
  assert.match(migrated, /SOUND OUTPUT · Without sound/)
  assert.doesNotMatch(migrated, /Template Video/)
})

test('builds bounded display copy with recipe-aware context and safe fallbacks', () => {
  assert.equal(displayTextForAnimation('custom', '', ''), 'Custom')
  assert.equal(displayTextForAnimation('audio-visualizer', '   ', '   '), 'Audio Visualizer')
  assert.equal(displayTextForAnimation('custom', '', 'Context fallback'), 'Context fallback')
  assert.equal(displayTextForAnimation('smart-captions', 'Prompt direction', 'Caption transcript'), 'Prompt direction')
  assert.equal(displayTextForAnimation('data-to-video', 'Prompt direction', 'Spreadsheet findings'), 'Prompt direction')
  assert.equal(displayTextForAnimation('product-video', 'Product direction', 'Reference notes'), 'Product direction')
  assert.equal(displayTextForAnimation('custom', '  Line one\n\n line two\tline three  '), 'Line one line two line three')

  const bounded = displayTextForAnimation('custom', `${'word '.repeat(80)}closing`)
  assert.ok(bounded.endsWith('…'))
  assert.ok(bounded.length <= 221, `expected no more than 220 source characters plus ellipsis, got ${bounded.length}`)
  assert.doesNotMatch(bounded.slice(0, -1), /\s$/)
})
