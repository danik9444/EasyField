import { VIDEO_MODELS } from './models.ts'
import { VIDEO_MODEL_CONFIG } from './videoModelConfig.ts'

// A transition has two ordered endpoint frames. Generic reference-image input
// is not equivalent: every model shown here must expose both semantic fields in
// its verified adapter, while the global family order remains unchanged.
export const TRANSITION_VIDEO_MODELS = VIDEO_MODELS.filter((model) => {
  const config = VIDEO_MODEL_CONFIG[model]
  return config?.firstFrame === true && config?.lastFrame === true
})
