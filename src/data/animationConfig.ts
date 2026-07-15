// Animation tool — two local code-to-video engines the user can pick between,
// like the model pickers elsewhere:
//   HyperFrames (heygen-com/hyperframes) — write HTML/CSS/GSAP → MP4 (Node CLI)
//   Remotion    (remotion.dev)           — write React → MP4 (@remotion/player + renderer)
// Both are installed locally; rendering runs through the local CLIs (dev
// middleware), so nothing here contacts the cloud-generation gateway.

export const ANIM_ENGINES = ['HyperFrames', 'Remotion'] as const
export type AnimEngine = (typeof ANIM_ENGINES)[number]

export const ANIMATION_RECIPES = [
  {
    id: 'custom',
    label: 'Custom',
    description: 'Build a flexible motion composition from your direction and references.',
    placeholder: 'Describe the complete animation, hierarchy, timing, transitions and visual style…',
    defaultPreset: 'Kinetic Type',
    inputHint: 'Any source',
  },
  {
    id: 'smart-captions',
    label: 'Smart Captions',
    description: 'Design animated captions around supplied copy, transcript or footage.',
    placeholder: 'Describe caption placement, rhythm, emphasis, typography and safe areas…',
    defaultPreset: 'Lower Third',
    inputHint: 'Video · transcript',
  },
  {
    id: 'text-motion-graphics',
    label: 'Text & Motion Graphics',
    description: 'Create typography-led titles, callouts and graphic sequences.',
    placeholder: 'Describe the text, graphic language, pacing and entrance or exit motion…',
    defaultPreset: 'Kinetic Type',
    inputHint: 'Text · brand assets',
  },
  {
    id: 'product-video',
    label: 'Product Video',
    description: 'Turn product media and messaging into a polished promo sequence.',
    placeholder: 'Describe the product, key benefits, shot order, copy and desired finish…',
    defaultPreset: 'Slide Up',
    inputHint: 'Images · video',
  },
  {
    id: 'intros-outros',
    label: 'Intros & Outros',
    description: 'Create branded openings, endings, logo reveals and end cards.',
    placeholder: 'Describe the brand reveal, title, logo behavior, timing and final hold…',
    defaultPreset: 'Title Card',
    inputHint: 'Logo · copy',
  },
  {
    id: 'overlays-graphics',
    label: 'Overlays & Graphics',
    description: 'Design lower thirds, labels, panels and editorial overlays.',
    placeholder: 'Describe the overlay, information hierarchy, screen position and motion…',
    defaultPreset: 'Lower Third',
    inputHint: 'Copy · references',
  },
  {
    id: 'website-to-video',
    label: 'Website to Video',
    description: 'Translate a public webpage and its message into a video treatment.',
    placeholder: 'Describe what to extract from the website and the video story it should become…',
    defaultPreset: 'Slide Up',
    inputHint: 'Public HTTPS URL',
  },
  {
    id: 'audio-visualizer',
    label: 'Audio Visualizer',
    description: 'Build a rhythmic visual treatment around music, voice or sound.',
    placeholder: 'Describe the waveform, colors, rhythm response, titles and background motion…',
    defaultPreset: 'Pop Scale',
    inputHint: 'Audio · artwork',
  },
  {
    id: 'data-to-video',
    label: 'Data to Video',
    description: 'Turn spreadsheet or structured text into an animated data story.',
    placeholder: 'Describe the key findings, chart sequence, annotations and narrative emphasis…',
    defaultPreset: 'Fade In',
    inputHint: 'Excel · CSV · text',
  },
] as const

export type AnimRecipeId = (typeof ANIMATION_RECIPES)[number]['id']

// Backward-compatible export for any stale caller while the old three-mode
// drafts are migrated into the recipe workspace.
export const ANIM_MODES = ANIMATION_RECIPES

export function normalizeAnimRecipe(value: unknown): AnimRecipeId {
  if (ANIMATION_RECIPES.some((recipe) => recipe.id === value)) return value as AnimRecipeId
  if (value === 'presets') return 'text-motion-graphics'
  // Template Video was removed from the workspace. Both its current id and
  // the older `assets` mode migrate to Custom, which preserves the open-ended
  // prompt/source workflow without silently changing the user's intent.
  if (value === 'template-video' || value === 'assets') return 'custom'
  return 'custom'
}

export function renderModeForRecipe(recipe: AnimRecipeId, imageCount: number): 'prompt' | 'assets' {
  if (imageCount > 0 && ['product-video', 'website-to-video', 'data-to-video', 'custom'].includes(recipe)) return 'assets'
  return 'prompt'
}

export const ANIMATION_SOUND_OPTIONS = [
  {
    id: 'with-sound',
    label: 'With sound',
    description: 'Build the visual timing and a synchronized sound direction together.',
  },
  {
    id: 'without-sound',
    label: 'Without sound',
    description: 'Create a silent visual output; attached audio may guide timing only.',
  },
] as const

export type AnimSoundMode = (typeof ANIMATION_SOUND_OPTIONS)[number]['id']

export const DEFAULT_ANIM_SOUND_MODE: AnimSoundMode = 'without-sound'

/** Normalize both the current enum and short-lived/legacy boolean controls. */
export function normalizeAnimSoundMode(value: unknown): AnimSoundMode {
  if (value === 'with-sound' || value === true || value === 'sound' || value === 'with' || value === 'on') return 'with-sound'
  return 'without-sound'
}

export function animationSoundInstruction(value: unknown): string {
  return normalizeAnimSoundMode(value) === 'with-sound'
    ? 'The final animation includes sound. Use attached audio or sound direction from the user when supplied; otherwise leave the sound content unspecified instead of inventing it during prompt enhancement.'
    : 'The final animation must be silent. Attached audio may inform rhythm and timing, but it must not be included in the output.'
}

/**
 * Compiles the selected workflow, sound decision and attached material into one
 * read-only block for prompt enhancement/planning. The user's prompt remains
 * the only creative control; these fields constrain its interpretation.
 */
export function buildAnimationPromptContext(
  recipeValue: unknown,
  soundValue: unknown,
  attachedContext = '',
): string {
  const recipe = normalizeAnimRecipe(recipeValue)
  const recipeDefinition = ANIMATION_RECIPES.find((entry) => entry.id === recipe)!
  const sound = normalizeAnimSoundMode(soundValue)
  const soundDefinition = ANIMATION_SOUND_OPTIONS.find((entry) => entry.id === sound)!
  const blocks = [
    `SELECTED FORMAT · ${recipeDefinition.label}\n${recipeDefinition.description}`,
    `SOUND OUTPUT · ${soundDefinition.label}\n${animationSoundInstruction(sound)}`,
  ]
  if (attachedContext.trim()) blocks.push(`ATTACHED MATERIAL\n${attachedContext.trim()}`)
  return blocks.join('\n\n')
}

/**
 * Filters a persisted prompt map to current recipes and moves a removed
 * Template Video prompt into Custom. If the removed recipe was active, its
 * prompt wins so the editor reopens exactly the draft the user was working on.
 */
export function normalizeAnimationPrompts(
  value: unknown,
  activeRecipeValue?: unknown,
  legacyTextValue?: unknown,
): Partial<Record<AnimRecipeId, string>> {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const prompts: Partial<Record<AnimRecipeId, string>> = {}

  for (const recipe of ANIMATION_RECIPES) {
    if (typeof raw[recipe.id] === 'string') prompts[recipe.id] = raw[recipe.id] as string
  }

  const activeRecipe = normalizeAnimRecipe(activeRecipeValue)
  const legacyText = typeof legacyTextValue === 'string' ? legacyTextValue : ''
  const removedTemplatePrompt = typeof raw['template-video'] === 'string' ? raw['template-video'] as string : ''
  const removedRecipeWasActive = activeRecipeValue === 'template-video' || activeRecipeValue === 'assets'

  if (removedRecipeWasActive) {
    prompts.custom = removedTemplatePrompt || legacyText || prompts.custom || ''
  } else if (!prompts.custom && removedTemplatePrompt) {
    prompts.custom = removedTemplatePrompt
  }

  if (!prompts[activeRecipe] && legacyText) prompts[activeRecipe] = legacyText
  return prompts
}

export function displayTextForAnimation(recipe: AnimRecipeId, prompt: string, contextText = ''): string {
  // The prompt is the user's command for every format. Attached material can
  // fill an empty draft, but must never silently replace explicit direction.
  const preferred = prompt.trim() || contextText.trim()
  const compact = preferred.replace(/\s+/g, ' ').trim()
  if (!compact) return ANIMATION_RECIPES.find((entry) => entry.id === recipe)?.label ?? 'EasyField Animation'
  if (compact.length <= 220) return compact
  const sentence = compact.slice(0, 220).replace(/\s+\S*$/, '').trim()
  return `${sentence || compact.slice(0, 217)}…`
}

// Motion presets implemented in BOTH engines (Remotion component + HyperFrames HTML).
export const ANIM_PRESETS = ['Fade In', 'Slide Up', 'Pop Scale', 'Kinetic Type', 'Lower Third', 'Title Card']

export const ANIM_ASPECTS = ['16:9', '9:16', '1:1', '4:5']
export const ANIM_FPS = ['24', '30', '60']
export const ANIM_DURATIONS = ['3', '5', '8', '10', '15'] // seconds

export const ANIM_BGS = ['#0E0E13', '#101826', '#1A1020', '#0A1512', '#FFFFFF']

export interface AnimSettings {
  engine: AnimEngine
  mode: string
  recipe: AnimRecipeId
  text: string
  preset: string
  accent: string
  bg: string
  aspect: string
  fps: number
  durationSec: number
}

// aspect → pixel dimensions (kept even so FFmpeg is happy).
export function dimsFor(aspect: string): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      return { width: 1080, height: 1920 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:5':
      return { width: 1080, height: 1350 }
    default:
      return { width: 1920, height: 1080 }
  }
}
