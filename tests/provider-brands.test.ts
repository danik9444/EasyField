import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_MODEL_META,
  ANIMATION_ENGINE_META,
  IMAGE_EDIT_SPECIALIST_META,
  IMAGE_MODEL_META,
  MUSIC_MODEL_META,
  SOUND_EFFECT_MODEL_META,
  VIDEO_EDIT_MODEL_META,
  VIDEO_MODEL_META,
  VOICE_MODEL_META,
} from '../src/data/modelPresentation.ts'
import { AGENT_MODELS, IMAGE_MODELS, VIDEO_MODELS } from '../src/data/models.ts'
import { PROVIDER_BRAND_IDS, resolveProviderBrand } from '../src/data/providerBrands.ts'
import { VALIDATED_MODELS } from '../src/data/validatedModels.ts'

const metadataSets = [
  IMAGE_MODEL_META,
  VIDEO_MODEL_META,
  AGENT_MODEL_META,
  MUSIC_MODEL_META,
  SOUND_EFFECT_MODEL_META,
  VOICE_MODEL_META,
  VIDEO_EDIT_MODEL_META,
  IMAGE_EDIT_SPECIALIST_META,
  ANIMATION_ENGINE_META,
]

test('every detailed model option has a registered provider logo instead of a monogram', () => {
  const validBrands = new Set(PROVIDER_BRAND_IDS)
  for (const metadata of metadataSets) {
    for (const [model, meta] of Object.entries(metadata)) {
      assert.ok(meta.providerBrand, `${model} is missing a provider brand`)
      assert.ok(validBrands.has(meta.providerBrand), `${model} uses an unknown provider brand`)
    }
  }
})

test('every direct model catalog entry has branded presentation metadata', () => {
  for (const model of IMAGE_MODELS) assert.ok(IMAGE_MODEL_META[model]?.providerBrand, `Image model ${model} is unbranded`)
  for (const model of VIDEO_MODELS) assert.ok(VIDEO_MODEL_META[model]?.providerBrand, `Video model ${model} is unbranded`)
  for (const model of AGENT_MODELS) assert.ok(AGENT_MODEL_META[model]?.providerBrand, `Agent model ${model} is unbranded`)
})

test('generic workspaces resolve the real publisher before falling back to Kie', () => {
  for (const model of VALIDATED_MODELS) {
    const brand = resolveProviderBrand(model.name, model.id, model.provider)
    assert.ok(brand, `${model.name} has no brand or explicit provider fallback`)
  }

  assert.equal(resolveProviderBrand('Seedream 6 Ultra', 'future-seedream', 'kie'), 'bytedance')
  assert.equal(resolveProviderBrand('Wan 3', 'future-wan', 'kie'), 'alibaba')
  assert.equal(resolveProviderBrand('Unknown adapter', 'unknown', 'kie'), 'kie')
  assert.equal(resolveProviderBrand('v5.5', 'SUNO'), 'suno')
  assert.equal(resolveProviderBrand('Turbo v2.5', 'ELEVENLABS'), 'elevenlabs')
})
