import { IMAGE_MODEL_CONFIG, type ImageOptions } from './imageModelConfig.ts'
import { IMAGE_MODEL_ALIASES } from './models.ts'
import { promptCharacterCount, truncatePrompt } from './promptLimits.ts'

export type AnglesMode = 'random' | 'custom'

// Angles is an image-edit workflow. Keep this reviewed allowlist explicit so a
// future text-to-image model cannot appear here merely by joining the general
// image catalog. The order mirrors Create Image: families stay contiguous and
// their strongest current member appears first.
export const ANGLES_MODELS = [
  'GPT Image 2',
  'Seedream 5 Pro',
  'Seedream 5 Lite',
  'Seedream 4.5',
  'Nano Banana Pro',
  'Nano Banana 2',
  'Nano Banana 2 Lite',
  'Flux 2',
  'Wan 2.7 Image',
  'Qwen2 Image',
] as const
export const DEFAULT_ANGLES_MODEL = 'Seedream 5 Pro'
// Persistence envelope only. The active Angles model applies its smaller live
// provider budget without deleting a draft when the model changes.
export const ANGLES_PROMPT_MAX = 20_000
export const MIN_RANDOM_ANGLES = 1
export const MAX_RANDOM_ANGLES = 8
export const DEFAULT_RANDOM_ANGLES = 4

export interface AngleRequestEntry {
  id: string
  label: string
  prompt: string
}

export interface AnglesDraft {
  schemaVersion: 1
  mode: AnglesMode
  model: string
  randomCount: number
  customPrompt: string
  perModel: Record<string, ImageOptions>
}

interface RandomAnglePreset {
  id: string
  label: string
  direction: string
}

const RANDOM_ANGLE_PRESETS: RandomAnglePreset[] = [
  { id: 'front-three-quarter-left', label: 'Front ¾ left', direction: 'Move the camera to a front three-quarter view from the subject’s left side, at eye level, with natural perspective.' },
  { id: 'front-three-quarter-right', label: 'Front ¾ right', direction: 'Move the camera to a front three-quarter view from the subject’s right side, at eye level, with natural perspective.' },
  { id: 'left-profile', label: 'Left profile', direction: 'Show a clean left-side profile, with the camera perpendicular to the subject and the original framing scale preserved.' },
  { id: 'right-profile', label: 'Right profile', direction: 'Show a clean right-side profile, with the camera perpendicular to the subject and the original framing scale preserved.' },
  { id: 'high-angle', label: 'High angle', direction: 'Raise the camera above the subject and tilt downward for a clearly different high-angle viewpoint without distorting anatomy or geometry.' },
  { id: 'low-angle', label: 'Low angle', direction: 'Lower the camera below the subject and tilt upward for a clearly different low-angle viewpoint without distorting anatomy or geometry.' },
  { id: 'rear-three-quarter', label: 'Rear ¾', direction: 'Orbit behind the subject into a rear three-quarter view while keeping the subject recognizable and the scene spatially coherent.' },
  { id: 'overhead', label: 'Overhead', direction: 'Use a controlled overhead camera looking down on the same subject and scene, retaining realistic scale and spatial relationships.' },
]

const MODEL_ID_ALIASES: Record<string, string> = {
  'gpt-image-2': 'GPT Image 2',
  'seedream-5-pro': 'Seedream 5 Pro',
  'seedream-5-lite': 'Seedream 5 Lite',
  'seedream-4-5': 'Seedream 4.5',
  'seedream-4.5': 'Seedream 4.5',
  'nano-banana-pro': 'Nano Banana Pro',
  'nano-banana-2': 'Nano Banana 2',
  'nano-banana-2-lite': 'Nano Banana 2 Lite',
  'flux-2': 'Flux 2',
  'wan-2-7-image': 'Wan 2.7 Image',
  'wan-2.7-image': 'Wan 2.7 Image',
  'qwen2-image': 'Qwen2 Image',
  ...IMAGE_MODEL_ALIASES,
}

function safeModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ANGLES_MODEL
  const model = MODEL_ID_ALIASES[value] ?? value
  return (ANGLES_MODELS as readonly string[]).includes(model) ? model : DEFAULT_ANGLES_MODEL
}

export function normalizeRandomAngleCount(value: unknown): number {
  const count = Math.round(Number(value))
  if (!Number.isFinite(count)) return DEFAULT_RANDOM_ANGLES
  return Math.min(MAX_RANDOM_ANGLES, Math.max(MIN_RANDOM_ANGLES, count))
}

/**
 * Output controls that are actually serialized by the model's reference-image
 * endpoint. Wan 2.7 currently accepts an aspect only for text-to-image; its
 * reference workflow derives framing from the source, so Angles must not show
 * a control that would be silently ignored.
 */
export function angleAspectRatios(model: string): readonly string[] {
  if (model === 'Wan 2.7 Image') return []
  return IMAGE_MODEL_CONFIG[model]?.aspectRatios ?? []
}

export function angleDirectionPromptMax(model: string): number {
  const providerMaximum = IMAGE_MODEL_CONFIG[model]?.promptMax ?? ANGLES_PROMPT_MAX
  return Math.max(1, providerMaximum - promptCharacterCount(compileAnglePrompt('')))
}

export function normalizeAnglesDraft(raw: unknown): AnglesDraft {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const legacyRecipe = source.recipeId
  const mode: AnglesMode = source.mode === 'custom' || legacyRecipe === 'custom' ? 'custom' : 'random'
  const customPromptSource = typeof source.customPrompt === 'string'
    ? source.customPrompt
    : typeof source.prompt === 'string'
      ? source.prompt
      : ''
  const perModel = source.perModel && typeof source.perModel === 'object'
    ? source.perModel as Record<string, ImageOptions>
    : {}
  return {
    schemaVersion: 1,
    mode,
    model: safeModel(source.model ?? source.modelId),
    randomCount: normalizeRandomAngleCount(source.randomCount),
    // Preserve every draft that can fit any current cloud image model. The
    // selected model's smaller live budget is enforced without deleting text
    // on a model switch.
    customPrompt: truncatePrompt(customPromptSource, ANGLES_PROMPT_MAX),
    perModel,
  }
}

export function compileAnglePrompt(direction: string): string {
  return [
    'Use image 1 as the immutable source of truth.',
    'Create one standalone image of the exact same subject and scene from a new camera viewpoint.',
    'Preserve identity, facial features, body proportions, wardrobe, props, materials, environment, lighting, color palette and visual style.',
    'Change only camera position, elevation, lens perspective or framing as requested. Reconstruct newly revealed surfaces coherently.',
    'Do not create a contact sheet, split screen, collage, text, labels, duplicate subjects or a different moment.',
    '',
    `Camera direction: ${direction.trim()}`,
  ].join('\n')
}

export function createRandomAngleEntries(
  countValue: unknown,
  random: () => number = Math.random,
): AngleRequestEntry[] {
  const count = normalizeRandomAngleCount(countValue)
  const shuffled = [...RANDOM_ANGLE_PRESETS]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const raw = Math.floor(random() * (index + 1))
    const target = Math.min(index, Math.max(0, Number.isFinite(raw) ? raw : 0))
    ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
  }
  return shuffled.slice(0, count).map((preset) => ({
    id: preset.id,
    label: preset.label,
    prompt: compileAnglePrompt(preset.direction),
  }))
}

export function createCustomAngleEntry(prompt: string): AngleRequestEntry | null {
  const direction = prompt.trim()
  if (!direction) return null
  return {
    id: 'custom-angle',
    label: 'Custom angle',
    prompt: compileAnglePrompt(direction),
  }
}
