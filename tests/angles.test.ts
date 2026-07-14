import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANGLES_PROMPT_MAX,
  DEFAULT_ANGLES_MODEL,
  MAX_RANDOM_ANGLES,
  createCustomAngleEntry,
  createRandomAngleEntries,
  normalizeAnglesDraft,
  normalizeRandomAngleCount,
} from '../src/data/angles.ts'
import { imageRunEstimate } from '../src/data/pricing.ts'
import { modelsForTool } from '../src/data/validatedModels.ts'
import { buildImageEditRequest } from '../src/data/providerModels.ts'

test('legacy Angles drafts migrate into the dedicated random/custom workspace', () => {
  const legacyCustom = normalizeAnglesDraft({
    recipeId: 'custom',
    modelId: 'nano-banana-pro',
    prompt: 'Camera just above the subject, 50mm portrait framing',
  })
  assert.equal(legacyCustom.mode, 'custom')
  assert.equal(legacyCustom.model, 'Nano Banana Pro')
  assert.equal(legacyCustom.customPrompt, 'Camera just above the subject, 50mm portrait framing')

  const invalid = normalizeAnglesDraft({ mode: 'unknown', model: 'unverified', randomCount: 999, customPrompt: 'x'.repeat(ANGLES_PROMPT_MAX + 50) })
  assert.equal(invalid.mode, 'random')
  assert.equal(invalid.model, DEFAULT_ANGLES_MODEL)
  assert.equal(invalid.randomCount, MAX_RANDOM_ANGLES)
  assert.equal(invalid.customPrompt.length, ANGLES_PROMPT_MAX)
})

test('random angle count is always a finite reviewed batch size', () => {
  assert.equal(normalizeRandomAngleCount(0), 1)
  assert.equal(normalizeRandomAngleCount(-8), 1)
  assert.equal(normalizeRandomAngleCount(4.4), 4)
  assert.equal(normalizeRandomAngleCount(500), MAX_RANDOM_ANGLES)
  assert.equal(normalizeRandomAngleCount(Number.NaN), 4)
})

test('a random batch freezes distinct camera positions with source-preservation instructions', () => {
  const values = [0.73, 0.12, 0.91, 0.36, 0.57, 0.04, 0.82]
  let index = 0
  const entries = createRandomAngleEntries(6, () => values[index++ % values.length])
  assert.equal(entries.length, 6)
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 6)
  entries.forEach((entry) => {
    assert.match(entry.prompt, /image 1 as the immutable source of truth/i)
    assert.match(entry.prompt, /preserve identity/i)
    assert.match(entry.prompt, /change only camera position/i)
    assert.match(entry.prompt, /camera direction:/i)
    assert.match(entry.prompt, /do not create a contact sheet/i)
  })
})

test('a custom direction is preserved inside the immutable angle contract', () => {
  assert.equal(createCustomAngleEntry('   '), null)
  const entry = createCustomAngleEntry('Tight 85mm close-up from ten degrees below eye line')
  assert.ok(entry)
  assert.match(entry.prompt, /Tight 85mm close-up from ten degrees below eye line/)
  assert.match(entry.prompt, /same subject and scene/i)
  assert.equal(entry.label, 'Custom angle')
})

test('Angles price preflight scales with the number of image-to-image outputs', () => {
  const one = imageRunEstimate('Nano Banana Pro', '1K', { format: 'PNG' }, 1, { referenceCount: 1 })
  const six = imageRunEstimate('Nano Banana Pro', '1K', { format: 'PNG' }, 6, { referenceCount: 1 })
  assert.equal(typeof one.credits, 'number')
  assert.equal(six.credits, (one.credits ?? 0) * 6)
  assert.equal(six.count, 6)
})

test('Angles exposes only the verified model registry entries', () => {
  assert.deepEqual(modelsForTool('angles').map((model) => model.name), ['Seedream 5 Pro', 'Nano Banana Pro'])
})

test('every Angles provider request keeps the primary source in input slot one', () => {
  const shared = {
    prompt: 'Camera direction',
    primarySourceUrl: 'https://media.example/source.png',
    referenceUrls: [],
    aspect: '16:9',
    resolution: '1K',
    extras: { format: 'PNG' },
  }
  const seedream = buildImageEditRequest('Seedream 5 Pro', shared) as { input: { image_urls: string[] } }
  const nano = buildImageEditRequest('Nano Banana Pro', shared) as { input: { image_input: string[] } }
  assert.equal(seedream.input.image_urls[0], shared.primarySourceUrl)
  assert.equal(nano.input.image_input[0], shared.primarySourceUrl)
})
