import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, IMAGE_MODELS, VIDEO_MODELS, VIDEO_MODEL_ALIASES } from '../src/data/models.ts'
import { CHAT_MODELS } from '../src/data/chatModels.ts'
import { modelsForTool } from '../src/data/validatedModels.ts'
import { IMAGE_MODEL_CONFIG } from '../src/data/imageModelConfig.ts'
import { VIDEO_MODEL_CONFIG } from '../src/data/videoModelConfig.ts'
import { AGENT_MODEL_META, IMAGE_MODEL_META, VIDEO_MODEL_META } from '../src/data/modelPresentation.ts'
import { CUSTOM_VIDEO_MODELS } from '../src/data/videoEditConfig.ts'
import { TOOL_DEFINITIONS } from '../src/data/toolDefinitions.ts'
import {
  EXTEND_VIDEO_MODELS,
  supportsExtendVideoReference,
  supportsExtendMultiShot,
  supportsKlingElementsForWorkflow,
} from '../src/data/extendVideoConfig.ts'
import { TRANSITION_VIDEO_MODELS } from '../src/data/transitionVideoConfig.ts'

test('Character belongs to Image while Avatar belongs to Video', () => {
  const image = TOOL_DEFINITIONS.filter((tool) => tool.category === 'image')
  const video = TOOL_DEFINITIONS.filter((tool) => tool.category === 'video')
  assert.equal(TOOL_DEFINITIONS.length, 20)
  assert.equal(image.some((tool) => tool.id === 'character' && tool.name === 'Character'), true)
  assert.equal(image.some((tool) => tool.id === 'avatar'), false)
  assert.equal(video.some((tool) => tool.id === 'avatar' && tool.name === 'Avatar'), true)
})

test('Upscale is a Footage tool backed by the two verified Topaz source adapters', () => {
  const footage = TOOL_DEFINITIONS.filter((tool) => tool.category === 'footage')
  assert.deepEqual(footage.map((tool) => tool.name), ['Culling', 'B-roll', 'Upscale'])
  assert.deepEqual(TOOL_DEFINITIONS.find((tool) => tool.id === 'upscale')?.sourceKinds, ['image', 'video'])
  assert.deepEqual(modelsForTool('upscale').map((model) => [model.name, model.inputKinds, model.outputKinds]), [
    ['Topaz Image Upscale', ['image'], ['image']],
    ['Topaz Video Upscale', ['video'], ['video']],
  ])
  assert.equal(modelsForTool('upscale').every((model) => model.validated && model.available), true)
})

test('latest Kie chat models have the documented Responses routes', () => {
  const expected = {
    'GPT 5.6 Sol': ['gpt-5-6-sol', 'codex'],
    'GPT 5.6 Terra': ['gpt-5-6-terra', 'codex'],
    'GPT 5.6 Luna': ['gpt-5-6-luna', 'codex'],
    'Grok 4.5': ['grok-4-5', 'grok'],
    'Grok 4.3': ['grok-4-3', 'grok'],
  } as const
  for (const [displayName, [model, path]] of Object.entries(expected)) {
    assert.equal(AGENT_MODELS.includes(displayName), true)
    assert.equal(CHAT_MODELS[displayName].family, 'responses')
    assert.equal(CHAT_MODELS[displayName].model, model)
    assert.equal(CHAT_MODELS[displayName].path, path)
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(CHAT_MODELS[displayName].reasoningEffort ?? ''))
  }
})

test('model menus stay in contiguous families with strongest tier first', () => {
  assert.deepEqual(IMAGE_MODELS, [
    'GPT Image 2',
    'Seedream 5 Pro', 'Seedream 5 Lite', 'Seedream 4.5',
    'Nano Banana Pro', 'Nano Banana 2', 'Nano Banana 2 Lite',
    'Flux 2', 'Wan 2.7 Image', 'Qwen2 Image',
  ])
  assert.deepEqual(VIDEO_MODELS, [
    'Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini',
    'Kling 3', 'Kling 3 Turbo', 'Kling 3 Motion Control',
    'Veo 3.1 Quality', 'Veo 3.1 Fast', 'Veo 3.1 Lite', 'Gemini Omni Video',
    'Grok Imagine 1.5 Preview', 'Grok Imagine Video',
    'Wan 2.7 Video',
    'Hailuo 2.3 Pro', 'Hailuo 2.3 Standard',
    'Runway AI Video', 'Happy Horse 1.1',
  ])
  assert.deepEqual(AGENT_MODELS, [
    'Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5',
    'GPT 5.6 Sol', 'GPT 5.6 Terra', 'GPT 5.6 Luna', 'GPT 5.5',
    'Grok 4.5', 'Grok 4.3',
    'Gemini 3.1 Pro', 'Gemini 3.5 Flash',
  ])
  assert.deepEqual(CUSTOM_VIDEO_MODELS.slice(0, 2), ['Seedance 2', 'Seedance 2 Fast'])

  const assertContiguousGroups = (models: string[], meta: Record<string, { group?: string }>) => {
    const closed = new Set<string>()
    let current = ''
    for (const model of models) {
      const group = meta[model]?.group ?? model
      if (group === current) continue
      if (current) closed.add(current)
      assert.equal(closed.has(group), false, `${group} appears in more than one menu block`)
      current = group
    }
  }
  assertContiguousGroups(IMAGE_MODELS, IMAGE_MODEL_META)
  assertContiguousGroups(VIDEO_MODELS, VIDEO_MODEL_META)
  assertContiguousGroups(AGENT_MODELS, AGENT_MODEL_META)

  assert.equal(DEFAULT_IMAGE_MODEL, 'Nano Banana Pro')
  assert.equal(DEFAULT_VIDEO_MODEL, 'Veo 3.1 Quality')
  assert.equal(DEFAULT_AGENT_MODEL, 'Opus 4.8')
  assert.equal(VIDEO_MODEL_ALIASES['Grok Imagine 1.5'], 'Grok Imagine 1.5 Preview')
})

test('Sound Effects exposes only validated current Suno Sounds models without a false duration capability', () => {
  const models = modelsForTool('sfx')
  assert.deepEqual(models.map((model) => model.name), ['Suno Sounds v5.5', 'Suno Sounds v5'])
  assert.equal(models.every((model) => model.validated && model.available), true)
  assert.equal(models.every((model) => model.priceCredits === 2.5 && model.priceUnit === 'request'), true)
  assert.equal(models.some((model) => model.capabilities.some((capability) => /duration/i.test(capability.label))), false)
})

test('Extend derives its model menu from verified start-frame capabilities without changing catalog order', () => {
  assert.deepEqual(EXTEND_VIDEO_MODELS, [
    'Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini',
    'Kling 3', 'Kling 3 Turbo',
    'Veo 3.1 Quality', 'Veo 3.1 Fast', 'Veo 3.1 Lite',
    'Wan 2.7 Video',
    'Hailuo 2.3 Pro', 'Hailuo 2.3 Standard',
    'Runway AI Video', 'Happy Horse 1.1',
  ])
  assert.equal(EXTEND_VIDEO_MODELS.every((model) => VIDEO_MODEL_CONFIG[model].firstFrame), true)
  assert.deepEqual(
    EXTEND_VIDEO_MODELS.filter(supportsExtendVideoReference),
    ['Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini', 'Wan 2.7 Video'],
  )
  assert.deepEqual(
    EXTEND_VIDEO_MODELS.filter((model) => VIDEO_MODEL_CONFIG[model].lastFrame),
    TRANSITION_VIDEO_MODELS,
  )
  assert.deepEqual(EXTEND_VIDEO_MODELS.filter(supportsExtendMultiShot), ['Kling 3'])
  assert.equal(supportsKlingElementsForWorkflow('Kling 3', 'extend'), true)
  assert.equal(supportsKlingElementsForWorkflow('Kling 3', 'create'), true)
  assert.equal(supportsKlingElementsForWorkflow('Kling 3', 'transition'), false)
  assert.equal(supportsKlingElementsForWorkflow('Kling 3 Turbo', 'extend'), false)
  assert.equal(supportsKlingElementsForWorkflow('Kling 3 Motion Control', 'extend'), false)
})

test('Extend exposes multi-shot only through the verified Kling 3 endpoint', () => {
  assert.deepEqual(
    EXTEND_VIDEO_MODELS.filter((model) => !!VIDEO_MODEL_CONFIG[model].multiShot),
    ['Kling 3'],
  )
  assert.deepEqual(VIDEO_MODEL_CONFIG['Kling 3'].multiShot, {
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

test('Transition exposes only models with verified ordered first and last frame contracts', () => {
  assert.deepEqual(TRANSITION_VIDEO_MODELS, [
    'Seedance 2', 'Seedance 2 Fast', 'Seedance 2 Mini',
    'Kling 3',
    'Veo 3.1 Quality', 'Veo 3.1 Fast', 'Veo 3.1 Lite',
    'Wan 2.7 Video',
  ])
  assert.equal(TRANSITION_VIDEO_MODELS.every((model) => (
    VIDEO_MODEL_CONFIG[model].firstFrame && VIDEO_MODEL_CONFIG[model].lastFrame
  )), true)
})

test('every selectable generation and agent model has a complete registry entry', () => {
  for (const model of IMAGE_MODELS) assert.ok(IMAGE_MODEL_CONFIG[model], `Missing image config: ${model}`)
  for (const model of VIDEO_MODELS) assert.ok(VIDEO_MODEL_CONFIG[model], `Missing video config: ${model}`)
  for (const model of AGENT_MODELS) assert.ok(CHAT_MODELS[model], `Missing chat adapter: ${model}`)
})
