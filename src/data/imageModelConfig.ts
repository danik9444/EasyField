// Per-model generation options, sourced from published cloud API schemas —
// the image-to-image/edit variant of each model,
// since that's the variant that accepts reference images. Verified 2026-07-13.

export interface ImageModelOption {
  key: string
  label: string
  values: string[]
}

export interface ImageModelConfig {
  /** Provider prompt ceiling published by the active cloud endpoint. */
  promptMax: number
  maxReferenceImages: number
  aspectRatios: string[]
  resolutions: string[]
  extraOptions: ImageModelOption[]
}

export const IMAGE_MODEL_CONFIG: Record<string, ImageModelConfig> = {
  // GPT Image 2 image-to-image schema.
  'GPT Image 2': {
    promptMax: 20_000,
    maxReferenceImages: 16,
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'],
    resolutions: ['1K', '2K', '4K'],
    extraOptions: [],
  },
  // Seedream 5 Pro text-to-image and image-to-image schemas.
  // basic=1K, high=2K; edit accepts up to 10 JPEG/PNG/WebP references (10 MB each).
  'Seedream 5 Pro': {
    promptMax: 5_000,
    maxReferenceImages: 10,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2'],
    resolutions: ['1K', '2K'],
    extraOptions: [{ key: 'format', label: 'FORMAT', values: ['PNG', 'JPEG'] }],
  },
  // Nano Banana Pro image-to-image schema.
  'Nano Banana Pro': {
    promptMax: 10_000,
    maxReferenceImages: 8,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K', '4K'],
    extraOptions: [{ key: 'format', label: 'FORMAT', values: ['PNG', 'JPG'] }],
  },
  // Nano Banana 2 schema.
  'Nano Banana 2': {
    promptMax: 20_000,
    maxReferenceImages: 14,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '4:1', '1:4', '8:1', '1:8'],
    resolutions: ['1K', '2K', '4K'],
    extraOptions: [{ key: 'format', label: 'FORMAT', values: ['PNG', 'JPG'] }],
  },
  // Nano Banana 2 Lite schema — no resolution parameter documented.
  'Nano Banana 2 Lite': {
    promptMax: 20_000,
    maxReferenceImages: 10,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '4:1', '1:4', '8:1', '1:8'],
    resolutions: [],
    extraOptions: [],
  },
  // Seedream 5 Lite image-to-image schema — "quality" tier basic=2K, high=4K.
  'Seedream 5 Lite': {
    promptMax: 3_000,
    maxReferenceImages: 14,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    resolutions: ['2K', '4K'],
    extraOptions: [],
  },
  // Seedream 4.5 edit schema — "quality" tier basic=2K, high=4K.
  'Seedream 4.5': {
    promptMax: 3_000,
    maxReferenceImages: 14,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'],
    resolutions: ['2K', '4K'],
    extraOptions: [],
  },
  // Wan 2.7 still-image schema.
  'Wan 2.7 Image': {
    promptMax: 5_000,
    maxReferenceImages: 9,
    aspectRatios: ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
    resolutions: ['1K', '2K', '4K'],
    extraOptions: [],
  },
  // Qwen2 image-edit schema — fixed native 2K output, single
  // reference image only. The published input has no quality/tier parameter;
  // exposing one would imply a paid option that never reaches the API.
  'Qwen2 Image': {
    promptMax: 800,
    maxReferenceImages: 1,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
    resolutions: [],
    extraOptions: [{ key: 'format', label: 'FORMAT', values: ['PNG', 'JPEG'] }],
  },
  // Flux 2 Pro and Flex image-to-image schemas.
  'Flux 2': {
    promptMax: 5_000,
    maxReferenceImages: 8,
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
    resolutions: ['1K', '2K'],
    extraOptions: [{ key: 'variant', label: 'VARIANT', values: ['Pro', 'Flex'] }],
  },
}

// Ideogram V3 Edit schema.
export const IDEOGRAM_V3_EDIT_PROMPT_MAX = 5_000

function pickDefaultAspect(ratios: string[]): string {
  return ratios.includes('16:9') ? '16:9' : (ratios.includes('1:1') ? '1:1' : ratios[0])
}

export interface ImageOptions {
  aspect: string
  resolution: string
  extraOptionValues: Record<string, string>
}

export function defaultOptionsFor(model: string): ImageOptions {
  const cfg = IMAGE_MODEL_CONFIG[model]
  const extraOptionValues: Record<string, string> = {}
  cfg.extraOptions.forEach((opt) => {
    extraOptionValues[opt.key] = opt.values[0]
  })
  return {
    aspect: pickDefaultAspect(cfg.aspectRatios),
    resolution: cfg.resolutions[0] ?? '',
    extraOptionValues,
  }
}

// Resolve a model's options from stored values, dropping anything no longer
// valid for the model and falling back to defaults.
export function resolveImageOptions(model: string, stored?: Partial<ImageOptions>): ImageOptions {
  const cfg = IMAGE_MODEL_CONFIG[model]
  const def = defaultOptionsFor(model)
  const extraOptionValues: Record<string, string> = {}
  cfg.extraOptions.forEach((opt) => {
    const v = stored?.extraOptionValues?.[opt.key]
    extraOptionValues[opt.key] = v && opt.values.includes(v) ? v : opt.values[0]
  })
  return {
    aspect: stored?.aspect && cfg.aspectRatios.includes(stored.aspect) ? stored.aspect : def.aspect,
    resolution: stored?.resolution && cfg.resolutions.includes(stored.resolution) ? stored.resolution : def.resolution,
    extraOptionValues,
  }
}
