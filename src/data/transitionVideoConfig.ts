import { VIDEO_MODELS } from './models.ts'
import { VIDEO_MODEL_CONFIG } from './videoModelConfig.ts'

export const LEGACY_TRANSITION_PROMPT = 'Create a seamless cinematic bridge that preserves motion, lighting, perspective and visual continuity between these shots'

export function initialTransitionPrompt(savedPrompt?: string): string {
  // Migrate the former opinionated starter text so existing installs can use
  // the new reference-led Auto path without manually clearing a saved default.
  return savedPrompt === LEGACY_TRANSITION_PROMPT ? '' : savedPrompt ?? ''
}

// A transition has two ordered endpoint frames. Generic reference-image input
// is not equivalent: every model shown here must expose both semantic fields in
// its verified adapter, while the global family order remains unchanged.
export const TRANSITION_VIDEO_MODELS = VIDEO_MODELS.filter((model) => {
  const config = VIDEO_MODEL_CONFIG[model]
  return config?.firstFrame === true && config?.lastFrame === true
})
