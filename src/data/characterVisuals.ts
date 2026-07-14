import type { CharacterTraitField } from './characterBuilder'

export interface CharacterTraitVisual {
  atlas: string
  columns: number
  rows: number
  index: number
}

const atlases = {
  type: new URL('../assets/character/character-type-atlas-v2.jpg', import.meta.url).href,
  cartoon: new URL('../assets/character/cartoon-character.jpg', import.meta.url).href,
  gender: new URL('../assets/character/gender-atlas.jpg', import.meta.url).href,
  eyeColor: new URL('../assets/character/eye-color-atlas.jpg', import.meta.url).href,
  face: new URL('../assets/character/face-options-atlas-v2.jpg', import.meta.url).href,
  identityBody: new URL('../assets/character/identity-body-atlas.jpg', import.meta.url).href,
  heritage: new URL('../assets/character/heritage-atlas.jpg', import.meta.url).href,
  materialPattern: new URL('../assets/character/material-pattern-atlas.jpg', import.meta.url).href,
  bodyType: new URL('../assets/character/body-type-atlas.jpg', import.meta.url).href,
  age: new URL('../assets/character/age-progression-atlas.jpg', import.meta.url).href,
  limbs: new URL('../assets/character/limb-options-atlas.jpg', import.meta.url).href,
  styleOptions: new URL('../assets/character/style-options-v2.jpg', import.meta.url).href,
} as const

type VisualSource = keyof typeof atlases

const sourceShape: Record<VisualSource, { columns: number; rows: number }> = {
  type: { columns: 4, rows: 4 },
  cartoon: { columns: 1, rows: 1 },
  gender: { columns: 3, rows: 2 },
  eyeColor: { columns: 4, rows: 4 },
  face: { columns: 5, rows: 5 },
  identityBody: { columns: 4, rows: 5 },
  heritage: { columns: 3, rows: 2 },
  materialPattern: { columns: 4, rows: 5 },
  bodyType: { columns: 4, rows: 2 },
  age: { columns: 3, rows: 2 },
  limbs: { columns: 3, rows: 4 },
  styleOptions: { columns: 4, rows: 5 },
}

const visualIndex: Partial<Record<CharacterTraitField, Record<string, readonly [VisualSource, number]>>> = {
  type: {
    human: ['type', 0], superhero: ['identityBody', 19], cartoon: ['cartoon', 0],
    ant: ['type', 1], bee: ['type', 2], octopus: ['type', 3],
    crocodile: ['type', 4], iguana: ['type', 5], lizard: ['type', 6], alien: ['type', 7],
    beetle: ['type', 8], reptile: ['type', 9], amphibian: ['type', 10], elf: ['type', 11], mantis: ['type', 12],
  },
  gender: {
    female: ['gender', 0], male: ['gender', 1], 'trans-man': ['gender', 2],
    'trans-woman': ['gender', 3], nonbinary: ['gender', 4],
  },
  heritage: {
    african: ['heritage', 0], asian: ['heritage', 1], european: ['heritage', 2],
    indian: ['heritage', 3], 'middle-eastern': ['heritage', 4], mixed: ['heritage', 5],
  },
  skinTone: {
    // Every natural tone intentionally starts from the exact same portrait. The UI
    // applies the option tone as a non-destructive tint so users compare color, not
    // a different face, pose or light setup.
    porcelain: ['type', 0], fair: ['type', 0], light: ['type', 0], medium: ['type', 0],
    tan: ['type', 0], brown: ['type', 0], deep: ['type', 0], custom: ['type', 0],
    // Fantasy colors use one clearly non-human portrait rather than recoloring the
    // human example into an uncanny result.
    obsidian: ['type', 7], green: ['type', 7], blue: ['type', 7], purple: ['type', 7],
  },
  eyeColor: {
    black: ['eyeColor', 0], purple: ['eyeColor', 1], green: ['eyeColor', 2], white: ['eyeColor', 3],
    brown: ['eyeColor', 4], 'solid-black': ['eyeColor', 5], 'blind-white': ['eyeColor', 6], 'deep-brown': ['eyeColor', 7],
    blue: ['eyeColor', 8], amber: ['eyeColor', 9], red: ['eyeColor', 10], grey: ['eyeColor', 11], custom: ['eyeColor', 12],
  },
  age: {
    baby: ['age', 0], child: ['age', 1], teen: ['age', 2],
    'young-adult': ['age', 3], mature: ['age', 4], senior: ['age', 5],
  },
  eyeType: {
    human: ['face', 0], reptile: ['face', 1], mechanical: ['face', 2],
  },
  eyeDetails: {
    'different-eyes': ['face', 3], blind: ['face', 4], scarred: ['face', 5], glowing: ['face', 6],
  },
  mouth: {
    'small-mouth': ['face', 7], 'large-mouth': ['face', 8], 'no-teeth': ['face', 9], 'different-teeth': ['face', 10],
    'sharp-teeth': ['face', 11], 'forked-tongue': ['face', 12], 'two-tongues': ['face', 13],
  },
  ears: {
    human: ['face', 14], elf: ['face', 15], none: ['face', 16], wing: ['face', 17],
  },
  horns: {
    small: ['face', 18], big: ['face', 19], antlers: ['face', 20],
  },
  skinMaterial: {
    human: ['materialPattern', 0], scales: ['materialPattern', 1], fur: ['materialPattern', 2],
    amphibian: ['materialPattern', 3], fish: ['materialPattern', 4], metallic: ['materialPattern', 5],
  },
  surfacePattern: {
    solid: ['materialPattern', 6], stripes: ['materialPattern', 7], spots: ['materialPattern', 8],
    chess: ['materialPattern', 9], veins: ['materialPattern', 10], giraffe: ['materialPattern', 11],
    cowhide: ['materialPattern', 12],
  },
  bodyType: {
    'very-thin': ['bodyType', 6],
    slim: ['bodyType', 0], lean: ['bodyType', 1], athletic: ['bodyType', 2], muscular: ['bodyType', 3],
    average: ['bodyType', 1], curvy: ['bodyType', 4], heavy: ['bodyType', 4],
    'very-heavy': ['bodyType', 5], skinny: ['bodyType', 6],
  },
  leftArm: {
    normal: ['limbs', 0], cute: ['limbs', 1], robotic: ['limbs', 2], prosthetic: ['limbs', 3], mechanical: ['limbs', 4], none: ['limbs', 5],
  },
  rightArm: {
    normal: ['limbs', 0], cute: ['limbs', 1], robotic: ['limbs', 2], prosthetic: ['limbs', 3], mechanical: ['limbs', 4], none: ['limbs', 5],
  },
  leftLeg: {
    normal: ['limbs', 6], cute: ['limbs', 7], robotic: ['limbs', 8], prosthetic: ['limbs', 9], mechanical: ['limbs', 10], none: ['limbs', 11],
  },
  rightLeg: {
    normal: ['limbs', 6], cute: ['limbs', 7], robotic: ['limbs', 8], prosthetic: ['limbs', 9], mechanical: ['limbs', 10], none: ['limbs', 11],
  },
  hair: {
    // Human portrait examples keep this control grounded in hairstyles rather than
    // fantasy head growth. The old fantasy IDs remain mapped for draft migration.
    bald: ['face', 16], short: ['gender', 1], long: ['gender', 0], afro: ['gender', 5],
    curly: ['type', 0], bob: ['type', 15],
    punk: ['styleOptions', 4], fur: ['styleOptions', 5], tentacles: ['styleOptions', 6], spines: ['styleOptions', 7],
  },
  markings: {
    tattoos: ['styleOptions', 8], piercing: ['styleOptions', 9], scarification: ['styleOptions', 10],
    symbols: ['styleOptions', 11], cyber: ['styleOptions', 12],
  },
  renderStyle: {
    'hyper-realistic': ['styleOptions', 13], anime: ['styleOptions', 14], cartoon: ['styleOptions', 15], 'illustration-2d': ['styleOptions', 16],
  },
}

export function getCharacterTraitVisual(groupId: CharacterTraitField, optionId: string): CharacterTraitVisual | null {
  const entry = visualIndex[groupId]?.[optionId]
  if (!entry) return null
  const [source, index] = entry
  return { atlas: atlases[source], ...sourceShape[source], index }
}
