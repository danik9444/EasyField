import { VIDEO_MODELS } from './models.ts'
import { VIDEO_MODEL_CONFIG } from './videoModelConfig.ts'

// Extend uses the existing, verified Create Video adapters. Deriving this list
// preserves the editorial family order while ensuring every visible model has
// a semantic first-frame input in its validated contract.
export const EXTEND_VIDEO_MODELS = VIDEO_MODELS.filter(
  (model) => VIDEO_MODEL_CONFIG[model]?.firstFrame === true,
)

export function supportsExtendVideoReference(model: string): boolean {
  const config = VIDEO_MODEL_CONFIG[model]
  return EXTEND_VIDEO_MODELS.includes(model) && config?.extendVideoReference === true && !!config.video
}

/**
 * The full Kling 3 image-to-video endpoint accepts an ordered multi-shot
 * plan anchored by one starting image. In Extend, that image is the captured
 * rendered end frame of the selected timeline shot. Turbo and every other
 * Extend adapter remain Standard-only because their contracts do not accept
 * `multi_shots` / `multi_prompt`.
 */
export function supportsExtendMultiShot(model: string): boolean {
  const config = VIDEO_MODEL_CONFIG[model]
  return model === 'Kling 3'
    && EXTEND_VIDEO_MODELS.includes(model)
    && config?.firstFrame === true
    && !!config.multiShot
}

/**
 * Kling's named Elements are accepted by the full Kling 3 endpoint for both a
 * new clip and a frame-led extension. They are deliberately unavailable to
 * Turbo/Motion Control and to Transition, whose provider contracts reject the
 * `kling_elements` payload.
 */
export function supportsKlingElementsForWorkflow(
  model: string,
  workflow: 'create' | 'extend' | 'transition',
): boolean {
  return model === 'Kling 3' && workflow !== 'transition'
}
