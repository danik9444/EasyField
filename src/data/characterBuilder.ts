export type CharacterBuilderMode = 'custom' | 'reference'
export type CharacterSection = 'basics' | 'face' | 'body' | 'style'
export type CharacterTraitLayout = 'cards' | 'swatches' | 'chips'

export type CharacterBasicField =
  | 'type'
  | 'gender'
  | 'heritage'
  | 'bodyType'
  | 'skinTone'
  | 'age'
  | 'hair'
  | 'eyeColor'
  | 'tattoos'

/**
 * Kept as a compatibility export while the v1 UI and persisted drafts migrate.
 * These fields are deliberately absent from the v2 registry and prompt compiler.
 */
export type CharacterAdvancedField =
  | 'eyeType' | 'eyeDetails' | 'mouth' | 'ears' | 'horns' | 'skinMaterial' | 'surfacePattern'
  | 'bodyType' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg'
  | 'hair' | 'markings' | 'renderStyle'

export type CharacterTraitField = CharacterBasicField | CharacterAdvancedField
export type CharacterTattooRegion = 'face' | 'neck' | 'torso' | 'back' | 'arms' | 'legs'

export interface CharacterTraitOption {
  id: string
  label: string
  prompt: string
  hidden?: boolean
  description?: string
  symbol?: string
  tone?: string
  color?: string
}

export interface CharacterTraitGroup<F extends CharacterTraitField = CharacterTraitField> {
  id: F
  label: string
  description?: string
  section: CharacterSection
  layout: CharacterTraitLayout
  icon: string
  color: string
  defaultValue: string
  options: CharacterTraitOption[]
}

export interface CharacterDraft {
  schemaVersion: 2
  mode: CharacterBuilderMode
  referenceAssetId: string | null
  referenceName: string
  referenceStrength: number
  customAge: number | null
  customSkinColor: string
  tattooRegions: CharacterTattooRegion[]
  basics: Record<CharacterBasicField, string>
  /** @deprecated v1 migration shell. Advanced traits are never compiled. */
  advanced: Record<CharacterAdvancedField, string>
  customNotes: string
  preserveIdentity: boolean
}

// Persist the largest currently published cloud image-prompt envelope. The
// active model's smaller, scaffold-aware budget is enforced in the workspace
// without deleting a draft when the user changes models or traits.
export const CHARACTER_CUSTOM_NOTES_STORAGE_MAX = 20_000

const option = (
  id: string,
  label: string,
  prompt: string,
  symbol?: string,
  tone?: string,
  description?: string,
  color?: string,
): CharacterTraitOption => ({ id, label, prompt, symbol, tone, description, color })

export const CHARACTER_TATTOO_REGIONS: ReadonlyArray<{ id: CharacterTattooRegion; label: string; prompt: string; symbol: string }> = [
  { id: 'face', label: 'Face', prompt: 'face', symbol: '◉' },
  { id: 'neck', label: 'Neck', prompt: 'neck', symbol: '⌇' },
  { id: 'torso', label: 'Torso', prompt: 'torso', symbol: '◇' },
  { id: 'back', label: 'Back', prompt: 'back', symbol: '◈' },
  { id: 'arms', label: 'Arms', prompt: 'arms', symbol: '⌁' },
  { id: 'legs', label: 'Legs', prompt: 'legs', symbol: 'Ⅱ' },
]

export const CHARACTER_BASIC_GROUPS: CharacterTraitGroup<CharacterBasicField>[] = [
  {
    id: 'type', label: 'Character Type', description: 'Choose the character foundation.', section: 'basics', layout: 'cards', icon: '✦', color: '#F2D66E', defaultValue: '',
    options: [
      option('human', 'Human', 'human character', '◉', 'human'),
      option('superhero', 'Superhero', 'original cinematic superhero character', '✦', 'superhero'),
      option('elf', 'Elf', 'ethereal elven humanoid character', '♢', 'elf'),
      option('cartoon', 'Cartoon character', 'premium stylized cartoon character', '◌', 'cartoon'),
    ],
  },
  {
    id: 'gender', label: 'Gender', description: 'Choose the character presentation.', section: 'basics', layout: 'cards', icon: '⚧', color: '#5FE7E7', defaultValue: '',
    options: [
      option('female', 'Female', 'feminine presentation', '♀'),
      option('male', 'Male', 'masculine presentation', '♂'),
      option('trans-man', 'Trans man', 'trans man presentation', '⚧'),
      option('trans-woman', 'Trans woman', 'trans woman presentation', '⚧'),
      option('nonbinary', 'Non-binary', 'non-binary presentation', '◌'),
    ],
  },
  {
    id: 'heritage', label: 'Ethnicity / Origin Base', description: 'Choose a respectful visual origin base.', section: 'basics', layout: 'cards', icon: '◎', color: '#F5B94E', defaultValue: '',
    options: [
      option('african', 'African', 'African heritage facial features', 'AF', 'warm'),
      option('asian', 'Asian', 'Asian heritage facial features', 'AS', 'cool'),
      option('european', 'European', 'European heritage facial features', 'EU', 'light'),
      option('indian', 'Indian', 'Indian heritage facial features', 'IN', 'warm'),
      option('middle-eastern', 'Middle Eastern', 'Middle Eastern heritage facial features', 'ME', 'gold'),
      option('mixed', 'Mixed', 'naturally blended mixed-heritage facial features', 'MX', 'mixed'),
    ],
  },
  {
    id: 'bodyType', label: 'Body Type', description: 'Choose a body silhouette from very thin to very heavy.', section: 'basics', layout: 'cards', icon: '▥', color: '#6F95FF', defaultValue: '',
    options: [
      option('very-thin', 'Very thin', 'very thin body type'),
      option('slim', 'Slim', 'slim body type'),
      option('average', 'Average', 'average body type'),
      option('athletic', 'Athletic', 'athletic medium-build body type'),
      option('heavy', 'Heavy', 'heavy body type'),
      option('very-heavy', 'Very heavy', 'very heavy body type'),
    ],
  },
  {
    id: 'skinTone', label: 'Skin Color', description: 'Natural tones keep one identity; fantasy tones use a suitable character example.', section: 'basics', layout: 'cards', icon: '●', color: '#54D56B', defaultValue: '',
    options: [
      option('porcelain', 'Porcelain', 'porcelain skin tone', undefined, 'human', undefined, '#EEE6DC'),
      option('fair', 'Fair', 'fair skin tone', undefined, 'human', undefined, '#E4C0A5'),
      option('light', 'Light', 'light skin tone', undefined, 'human', undefined, '#D8AC89'),
      option('medium', 'Medium', 'medium skin tone', undefined, 'human', undefined, '#BD8061'),
      option('tan', 'Tan', 'tan skin tone', undefined, 'human', undefined, '#A9684D'),
      option('brown', 'Brown', 'rich brown skin tone', undefined, 'human', undefined, '#744833'),
      option('deep', 'Deep', 'deep dark skin tone', undefined, 'human', undefined, '#3F2924'),
      option('obsidian', 'Obsidian', 'matte obsidian fantasy skin', undefined, 'fantasy', undefined, '#171719'),
      option('green', 'Green', 'fantasy emerald green skin', undefined, 'fantasy', undefined, '#246F4B'),
      option('blue', 'Blue', 'fantasy cobalt blue skin', undefined, 'fantasy', undefined, '#286BBD'),
      option('purple', 'Purple', 'fantasy violet skin', undefined, 'fantasy', undefined, '#7A24B5'),
      option('custom', 'Custom color', 'custom selected skin color', undefined, 'custom', 'Choose any exact skin color.', '#B86DFF'),
    ],
  },
  {
    id: 'age', label: 'Age', description: 'Choose a life stage or enter an exact age.', section: 'basics', layout: 'cards', icon: '◫', color: '#A4A7B0', defaultValue: '',
    options: [
      option('baby', 'Baby', 'baby appearance with age-appropriate proportions'),
      option('child', 'Child', 'child appearance with age-appropriate features'),
      option('teen', 'Teen', 'teenage appearance with age-appropriate features'),
      option('young-adult', 'Young adult', 'young adult appearance'),
      option('mature', 'Mature', 'mature adult appearance with authentic age detail'),
      option('senior', 'Senior', 'elderly appearance with authentic age detail'),
      { ...option('custom', 'Exact age', ''), hidden: true },
    ],
  },
  {
    id: 'hair', label: 'Hair', description: 'Choose a human hairstyle.', section: 'basics', layout: 'cards', icon: '◧', color: '#E26BD2', defaultValue: '',
    options: [
      option('bald', 'Bald', 'bald head'),
      option('short', 'Short hair', 'short natural human hair'),
      option('long', 'Long hair', 'long natural human hair'),
      option('afro', 'Afro', 'natural afro hairstyle'),
      option('curly', 'Curly', 'natural curly human hair'),
      option('bob', 'Pixie cut', 'short human pixie haircut'),
    ],
  },
  {
    id: 'eyeColor', label: 'Eye Color', section: 'basics', layout: 'cards', icon: '◉', color: '#D341FF', defaultValue: '',
    options: [
      option('black', 'Black', 'black irises', undefined, undefined, undefined, '#14161C'),
      option('purple', 'Purple', 'violet irises', undefined, undefined, undefined, '#A27BDE'),
      option('green', 'Green', 'green irises', undefined, undefined, undefined, '#86AD57'),
      option('white', 'White', 'white irises', undefined, undefined, undefined, '#EDF4F6'),
      option('brown', 'Brown', 'warm brown irises', undefined, undefined, undefined, '#9C6132'),
      option('solid-black', 'Black (Solid / Void)', 'fully solid black void eyes', undefined, undefined, undefined, '#020203'),
      option('blind-white', 'White (Blind / Empty)', 'clouded white blind eyes', undefined, undefined, undefined, '#F4F6F2'),
      option('deep-brown', 'Deep Brown', 'deep brown irises', undefined, undefined, undefined, '#59351F'),
      option('blue', 'Blue', 'blue irises', undefined, undefined, undefined, '#54A9ED'),
      option('amber', 'Amber', 'amber irises', undefined, undefined, undefined, '#DDA63B'),
      option('red', 'Red', 'red irises', undefined, undefined, undefined, '#EE4B56'),
      option('grey', 'Grey', 'grey irises', undefined, undefined, undefined, '#9DA9B1'),
      option('custom', 'Custom', 'custom selected eye color', undefined, undefined, undefined, '#63E6FF'),
    ],
  },
  {
    id: 'tattoos', label: 'Tattoos', description: 'Add tattoos, then choose one or more placement areas.', section: 'basics', layout: 'cards', icon: '⌁', color: '#E26BD2', defaultValue: '',
    options: [option('tattoos', 'Add tattoos', 'tasteful, intentional tattoos')],
  },
]

/** @deprecated Advanced groups were removed from the v2 Character experience. */
export const CHARACTER_ADVANCED_GROUPS: CharacterTraitGroup<CharacterAdvancedField>[] = []
export const CHARACTER_TRAIT_GROUPS: CharacterTraitGroup[] = [...CHARACTER_BASIC_GROUPS]

const defaultBasics = Object.fromEntries(
  CHARACTER_BASIC_GROUPS.map((group) => [group.id, group.defaultValue]),
) as Record<CharacterBasicField, string>

export const DEFAULT_CHARACTER_DRAFT: CharacterDraft = {
  schemaVersion: 2,
  mode: 'custom',
  referenceAssetId: null,
  referenceName: '',
  referenceStrength: 72,
  customAge: null,
  customSkinColor: '#B86DFF',
  tattooRegions: [],
  basics: defaultBasics,
  advanced: {} as Record<CharacterAdvancedField, string>,
  customNotes: '',
  preserveIdentity: true,
}

export function createDefaultCharacterDraft(): CharacterDraft {
  return {
    ...DEFAULT_CHARACTER_DRAFT,
    basics: { ...DEFAULT_CHARACTER_DRAFT.basics },
    advanced: {} as Record<CharacterAdvancedField, string>,
    tattooRegions: [],
  }
}

export function toggleCharacterSelection(currentValue: string, nextValue: string): string {
  return currentValue === nextValue ? '' : nextValue
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, maximum) : ''
}

export function sanitizeCharacterSkinColor(value: unknown): string {
  const color = safeText(value, 7)
  return /^#[\da-f]{6}$/i.test(color) ? color.toUpperCase() : DEFAULT_CHARACTER_DRAFT.customSkinColor
}

function normalizeGroupSelection(group: CharacterTraitGroup, value: unknown): string {
  if (value === '') return ''
  const selected = typeof value === 'string' ? value : ''
  return group.options.some((entry) => entry.id === selected) ? selected : group.defaultValue
}

const V1_BODY_TYPE_MAP: Readonly<Record<string, string>> = {
  skinny: 'very-thin',
  slim: 'slim',
  lean: 'average',
  athletic: 'athletic',
  muscular: 'athletic',
  curvy: 'heavy',
  heavy: 'heavy',
}

const V1_AGE_MAP: Readonly<Record<string, string>> = {
  kid: 'child',
  adult: 'young-adult',
  mature: 'mature',
  senior: 'senior',
  custom: 'custom',
}

function migrateLegacySelection(
  field: CharacterBasicField,
  basicsSource: Record<string, unknown>,
  advancedSource: Record<string, unknown>,
): unknown {
  if (Object.prototype.hasOwnProperty.call(basicsSource, field)) {
    const value = basicsSource[field]
    if (field === 'bodyType' && typeof value === 'string') return V1_BODY_TYPE_MAP[value] ?? value
    if (field === 'age' && typeof value === 'string') return V1_AGE_MAP[value] ?? value
    return value
  }

  if (field === 'bodyType' && typeof advancedSource.bodyType === 'string') {
    return V1_BODY_TYPE_MAP[advancedSource.bodyType] ?? advancedSource.bodyType
  }
  if (field === 'hair' && typeof advancedSource.hair === 'string') return advancedSource.hair
  if (field === 'tattoos' && advancedSource.markings === 'tattoos') return 'tattoos'
  return undefined
}

function normalizeTattooRegions(value: unknown): CharacterTattooRegion[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set<CharacterTattooRegion>(CHARACTER_TATTOO_REGIONS.map((region) => region.id))
  return [...new Set(value.filter((entry): entry is CharacterTattooRegion => (
    typeof entry === 'string' && allowed.has(entry as CharacterTattooRegion)
  )))]
}

export function normalizeCharacterDraft(value: unknown): CharacterDraft {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const basicsSource = source.basics && typeof source.basics === 'object'
    ? source.basics as Record<string, unknown>
    : {}
  const advancedSource = source.advanced && typeof source.advanced === 'object'
    ? source.advanced as Record<string, unknown>
    : {}
  const strength = Number(source.referenceStrength)
  const rawCustomAge = Number(source.customAge)
  const customAge = source.customAge !== null && source.customAge !== '' && Number.isFinite(rawCustomAge)
    ? Math.round(Math.min(120, Math.max(1, rawCustomAge)))
    : null
  const basics = Object.fromEntries(CHARACTER_BASIC_GROUPS.map((group) => [
    group.id,
    normalizeGroupSelection(group, migrateLegacySelection(group.id, basicsSource, advancedSource)),
  ])) as Record<CharacterBasicField, string>
  if (basics.age === 'custom' && customAge === null) basics.age = ''

  const tattooRegions = basics.tattoos === 'tattoos' ? normalizeTattooRegions(source.tattooRegions) : []
  return {
    schemaVersion: 2,
    mode: source.mode === 'reference' ? 'reference' : 'custom',
    referenceAssetId: safeText(source.referenceAssetId, 200) || null,
    referenceName: safeText(source.referenceName, 240),
    referenceStrength: Number.isFinite(strength)
      ? Math.round(Math.min(100, Math.max(20, strength)))
      : DEFAULT_CHARACTER_DRAFT.referenceStrength,
    customAge,
    customSkinColor: sanitizeCharacterSkinColor(source.customSkinColor),
    tattooRegions,
    basics,
    advanced: {} as Record<CharacterAdvancedField, string>,
    customNotes: safeText(source.customNotes, CHARACTER_CUSTOM_NOTES_STORAGE_MAX),
    preserveIdentity: source.preserveIdentity !== false,
  }
}

function selectedPrompt(group: CharacterTraitGroup, value: string): string {
  return group.options.find((entry) => entry.id === value)?.prompt ?? ''
}

function joinNaturalLanguage(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

function compileStructuredTraits(draft: CharacterDraft): string[] {
  return CHARACTER_BASIC_GROUPS.flatMap((group) => {
    const value = draft.basics[group.id]
    if (!value) return []
    if (group.id === 'age' && value === 'custom') {
      return draft.customAge === null ? [] : [`${draft.customAge}-year-old appearance`]
    }
    if (group.id === 'skinTone' && value === 'custom') {
      return [`custom skin color ${draft.customSkinColor}`]
    }
    if (group.id === 'tattoos') {
      const placements = draft.tattooRegions
        .map((region) => CHARACTER_TATTOO_REGIONS.find((candidate) => candidate.id === region)?.prompt)
        .filter((region): region is string => Boolean(region))
      return [placements.length > 0
        ? `tasteful, intentional tattoos placed on the ${joinNaturalLanguage(placements)}`
        : 'tasteful, intentional tattoos with placement left unspecified']
    }
    const prompt = selectedPrompt(group, value)
    return prompt ? [prompt] : []
  })
}

/**
 * Structured, read-only context for the AI prompt enhancer. Free-form notes are
 * intentionally excluded so the enhancer can improve them without echoing them.
 */
export function compileCharacterSelectionContext(input: CharacterDraft): string {
  const traits = compileStructuredTraits(normalizeCharacterDraft(input))
  return traits.length > 0 ? `Selected character traits: ${traits.join('; ')}.` : ''
}

export function compileCharacterPrompt(input: CharacterDraft): string {
  const draft = normalizeCharacterDraft(input)
  const traits = compileStructuredTraits(draft)
  const reference = draft.mode === 'reference'
    ? `Use the attached character sample as a ${draft.referenceStrength}% identity and design anchor. ${draft.preserveIdentity ? 'Preserve the recognizable facial identity and defining proportions while applying the selected changes.' : 'Use it as loose inspiration while allowing a new identity.'}`
    : 'Create an original character identity from scratch; do not imitate a recognizable real person.'
  const coreIdentity = traits.length > 0 ? `Character design: ${traits.join(', ')}.` : ''
  const notes = draft.customNotes ? `Additional direction: ${draft.customNotes}.` : ''
  return [
    'Design one production-ready, visually consistent character.',
    reference,
    coreIdentity,
    notes,
    'Show a single three-quarter character portrait with coherent anatomy, a clean neutral background, readable silhouette, detailed face and wardrobe, no extra people, no text, no labels, no watermark.',
  ].filter(Boolean).join(' ')
}
