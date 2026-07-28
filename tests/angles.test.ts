import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANGLES_MODELS,
  ANGLES_PROMPT_MAX,
  DEFAULT_ANGLES_MODEL,
  MAX_RANDOM_ANGLES,
  angleAspectRatios,
  angleDirectionPromptMax,
  createCustomAngleEntry,
  createRandomAngleEntries,
  normalizeAnglesDraft,
  normalizeRandomAngleCount,
} from '../src/data/angles.ts'
import { IMAGE_MODEL_CONFIG } from '../src/data/imageModelConfig.ts'
import { IMAGE_MODELS } from '../src/data/models.ts'
import { imageRunEstimate } from '../src/data/pricing.ts'
import { modelsForTool } from '../src/data/validatedModels.ts'
import { buildImageEditRequest } from '../src/data/providerModels.ts'
import { promptCharacterCount } from '../src/data/promptLimits.ts'

test('legacy Angles drafts migrate into the dedicated random/custom workspace', () => {
  const legacyCustom = normalizeAnglesDraft({
    recipeId: 'custom',
    modelId: 'nano-banana-pro',
    prompt: 'Camera just above the subject, 50mm portrait framing',
  })
  assert.equal(legacyCustom.mode, 'custom')
  assert.equal(legacyCustom.model, 'Nano Banana Pro')
  assert.equal(legacyCustom.customPrompt, 'Camera just above the subject, 50mm portrait framing')

  assert.equal(normalizeAnglesDraft({ model: 'Seedream 5.0 Pro' }).model, 'Seedream 5 Pro')
  assert.equal(normalizeAnglesDraft({ model: 'Wan 2.7' }).model, 'Wan 2.7 Image')
  assert.equal(normalizeAnglesDraft({ model: 'Qwen Image 2' }).model, 'Qwen2 Image')

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
  assert.deepEqual(ANGLES_MODELS, IMAGE_MODELS)
  const registry = modelsForTool('angles')
  assert.deepEqual(registry.map((model) => model.name), IMAGE_MODELS)
  registry.forEach((model) => {
    assert.equal(model.validated, true, model.name)
    assert.equal(model.available, true, model.name)
    assert.deepEqual(model.inputKinds, ['image'], model.name)
    assert.deepEqual(model.outputKinds, ['image'], model.name)
    assert.equal(normalizeAnglesDraft({ modelId: model.id }).model, model.name, `${model.id} draft migration`)
  })
})

test('every Angles model uses its exact edit route and keeps the source in slot one', () => {
  const expected: Record<string, { route: string; sourceField: string }> = {
    'GPT Image 2': { route: 'gpt-image-2-image-to-image', sourceField: 'input_urls' },
    'Seedream 5 Pro': { route: 'seedream/5-pro-image-to-image', sourceField: 'image_urls' },
    'Seedream 5 Lite': { route: 'seedream/5-lite-image-to-image', sourceField: 'image_urls' },
    'Seedream 4.5': { route: 'seedream/4.5-edit', sourceField: 'image_urls' },
    'Nano Banana Pro': { route: 'nano-banana-pro', sourceField: 'image_input' },
    'Nano Banana 2': { route: 'nano-banana-2', sourceField: 'image_input' },
    'Nano Banana 2 Lite': { route: 'nano-banana-2-lite', sourceField: 'image_urls' },
    'Flux 2': { route: 'flux-2/pro-image-to-image', sourceField: 'input_urls' },
    'Wan 2.7 Image': { route: 'wan/2-7-image', sourceField: 'input_urls' },
    'Qwen2 Image': { route: 'qwen2/image-edit', sourceField: 'image_url' },
  }
  const primarySourceUrl = 'https://media.example/source.png'
  ANGLES_MODELS.forEach((model) => {
    const config = IMAGE_MODEL_CONFIG[model]
    const request = buildImageEditRequest(model, {
      prompt: 'Camera direction',
      primarySourceUrl,
      referenceUrls: [],
      aspect: config.aspectRatios[0] ?? '',
      resolution: config.resolutions[0] ?? '',
      extras: Object.fromEntries(config.extraOptions.map((option) => [option.key, option.values[0]])),
    })
    assert.equal(request.family, 'jobs', model)
    if (request.family !== 'jobs') throw new Error(`Expected a tracked image job for ${model}`)
    assert.equal(request.model, expected[model].route, model)
    const source = request.input[expected[model].sourceField]
    assert.equal(Array.isArray(source) ? source[0] : source, primarySourceUrl, `${model} source slot`)
  })
})

test('random angle contracts fit every selectable model prompt ceiling', () => {
  const entries = createRandomAngleEntries(MAX_RANDOM_ANGLES, () => 0.42)
  ANGLES_MODELS.forEach((model) => {
    entries.forEach((entry) => {
      assert.ok(
        entry.prompt.length <= IMAGE_MODEL_CONFIG[model].promptMax,
        `${model} prompt ceiling must fit the complete ${entry.label} contract`,
      )
    })
  })
})

test('Angles shows only controls serialized by the active reference endpoint', () => {
  assert.deepEqual(angleAspectRatios('Wan 2.7 Image'), [])
  ANGLES_MODELS.filter((model) => model !== 'Wan 2.7 Image').forEach((model) => {
    assert.deepEqual(angleAspectRatios(model), IMAGE_MODEL_CONFIG[model].aspectRatios)
  })

  const wan = buildImageEditRequest('Wan 2.7 Image', {
    prompt: 'Camera direction',
    primarySourceUrl: 'https://media.example/source.png',
    referenceUrls: [],
    aspect: '16:9',
    resolution: '4K',
    extras: {},
  })
  assert.equal(wan.family, 'jobs')
  if (wan.family !== 'jobs') throw new Error('Expected a tracked Wan image job')
  assert.equal('aspect_ratio' in wan.input, false)
  assert.equal(wan.input.resolution, '4K')
})

test('Qwen custom directions use the exact remaining provider character budget', () => {
  const maximum = angleDirectionPromptMax('Qwen2 Image')
  const accepted = createCustomAngleEntry('א'.repeat(maximum))
  const rejected = createCustomAngleEntry('א'.repeat(maximum + 1))
  assert.ok(accepted)
  assert.ok(rejected)
  assert.equal(promptCharacterCount(accepted.prompt), IMAGE_MODEL_CONFIG['Qwen2 Image'].promptMax)
  assert.equal(promptCharacterCount(rejected.prompt), IMAGE_MODEL_CONFIG['Qwen2 Image'].promptMax + 1)

  const context = {
    primarySourceUrl: 'https://media.example/source.png',
    referenceUrls: [],
    aspect: '1:1',
    resolution: '',
    extras: { format: 'PNG' },
  }
  assert.doesNotThrow(() => buildImageEditRequest('Qwen2 Image', { ...context, prompt: accepted.prompt }))
  assert.throws(() => buildImageEditRequest('Qwen2 Image', { ...context, prompt: rejected.prompt }), /800 characters or fewer/)
})
