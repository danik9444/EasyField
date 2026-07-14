export interface MultiShotScene {
  id: string
  prompt: string
  duration: string
  /** Provider reference tags intentionally used by this shot. Undefined means all available tags. */
  referenceTags?: string[]
}

export interface MultiShotRules {
  minShots: number
  maxShots: number
  shotMin: number
  shotMax: number
  totalMin: number
  totalMax: number
  promptMax: number
  briefMax: number
}

export const DEFAULT_MULTI_SHOT_RULES: MultiShotRules = {
  minShots: 2,
  maxShots: 5,
  shotMin: 1,
  shotMax: 12,
  totalMin: 3,
  totalMax: 15,
  promptMax: 500,
  briefMax: 260,
}

/**
 * Provider-safe continuity direction used after removing the separate sequence
 * brief from the UI. It is fixed application behavior, never hidden user text.
 */
export const MULTI_SHOT_CONTINUITY_DIRECTION = 'Direct all ordered shots as one connected sequence. Preserve subject identity, setting, wardrobe, lighting, motion, camera logic and visual continuity throughout.'

const cleanText = (value: unknown): string =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim()
    : ''

const integerDuration = (value: unknown, rules: MultiShotRules): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return Math.min(5, rules.shotMax)
  return Math.min(rules.shotMax, Math.max(rules.shotMin, Math.round(parsed)))
}

function rebalanceDurationBounds(scenes: MultiShotScene[], rules: MultiShotRules): MultiShotScene[] {
  const next = scenes.map((scene) => ({ ...scene }))
  let total = totalMultiShotDuration(next)

  for (let i = next.length - 1; total > rules.totalMax && i >= 0; i -= 1) {
    const current = Number(next[i].duration)
    const reduction = Math.min(current - rules.shotMin, total - rules.totalMax)
    if (reduction > 0) {
      next[i].duration = String(current - reduction)
      total -= reduction
    }
  }

  for (let i = 0; total < rules.totalMin && i < next.length; i += 1) {
    const current = Number(next[i].duration)
    const addition = Math.min(rules.shotMax - current, rules.totalMin - total)
    if (addition > 0) {
      next[i].duration = String(current + addition)
      total += addition
    }
  }
  return next
}

export function normalizeMultiShotScenes(
  raw: unknown,
  rules: MultiShotRules,
  makeId: () => string,
): MultiShotScene[] {
  const values = Array.isArray(raw) ? raw.slice(0, rules.maxShots) : []
  const seen = new Set<string>()
  const scenes = values.flatMap((item): MultiShotScene[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const candidate = item as Record<string, unknown>
    let id = cleanText(candidate.id)
    if (!id || seen.has(id)) id = makeId()
    while (seen.has(id)) id = makeId()
    seen.add(id)
    const referenceTags = Array.isArray(candidate.referenceTags)
      ? Array.from(new Set(candidate.referenceTags.map(cleanText).filter(Boolean)))
      : undefined
    return [{
      id,
      prompt: cleanText(candidate.prompt).slice(0, rules.promptMax),
      duration: String(integerDuration(candidate.duration, rules)),
      ...(referenceTags ? { referenceTags } : {}),
    }]
  })

  while (scenes.length < rules.minShots) {
    let id = makeId()
    while (seen.has(id)) id = makeId()
    seen.add(id)
    scenes.push({ id, prompt: '', duration: String(Math.min(5, rules.shotMax)) })
  }
  return rebalanceDurationBounds(scenes, rules)
}

export function totalMultiShotDuration(scenes: readonly MultiShotScene[]): number {
  return scenes.reduce((sum, scene) => {
    const value = Number(scene.duration)
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)
}

export function moveMultiShotScene(
  scenes: readonly MultiShotScene[],
  id: string,
  direction: -1 | 1,
): MultiShotScene[] {
  const index = scenes.findIndex((scene) => scene.id === id)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= scenes.length) return [...scenes]
  const next = [...scenes]
  ;[next[index], next[destination]] = [next[destination], next[index]]
  return next
}

export function appendMultiShotScene(
  scenes: readonly MultiShotScene[],
  rules: MultiShotRules,
  makeId: () => string,
): MultiShotScene[] {
  if (scenes.length >= rules.maxShots) return [...scenes]
  const desired = Math.min(3, rules.shotMax)
  return normalizeMultiShotScenes(
    [...scenes, { id: makeId(), prompt: '', duration: String(desired) }],
    rules,
    makeId,
  )
}

export function updateMultiShotSceneDuration(
  scenes: readonly MultiShotScene[],
  id: string,
  duration: string,
  rules: MultiShotRules,
  makeId: () => string,
): MultiShotScene[] {
  return normalizeMultiShotScenes(
    scenes.map((scene) => scene.id === id ? { ...scene, duration } : scene),
    rules,
    makeId,
  )
}

export function removeMultiShotScene(
  scenes: readonly MultiShotScene[],
  id: string,
  rules: MultiShotRules,
  makeId: () => string,
): MultiShotScene[] {
  if (scenes.length <= rules.minShots) return [...scenes]
  return normalizeMultiShotScenes(scenes.filter((scene) => scene.id !== id), rules, makeId)
}

export interface MultiShotContextInput {
  model: string
  brief: string
  scenes: readonly MultiShotScene[]
  aspect: string
  resolution: string
  referenceManifest: readonly string[]
  sound: boolean
}

export function buildMultiShotEnhancementContext(
  input: MultiShotContextInput,
  currentSceneId?: string,
): string {
  const total = totalMultiShotDuration(input.scenes)
  const orderedShots = input.scenes.map((scene, index) => {
    const current = scene.id === currentSceneId ? ' · CURRENT SHOT' : ''
    const tags = scene.referenceTags?.length ? ` · references ${scene.referenceTags.join(', ')}` : ''
    return `SHOT ${String(index + 1).padStart(2, '0')}${current} · ${scene.duration}s${tags}\n${scene.prompt.trim() || '[not described yet]'}`
  })
  return [
    `TARGET MODEL: ${input.model}`,
    `OUTPUT: ${input.aspect || 'model default'} · ${input.resolution || 'model default'} · ${total}s · sound ${input.sound ? 'on' : 'off'}`,
    'COMPLETE SEQUENCE BRIEF:',
    input.brief.trim() || '[not written yet]',
    'ORDERED SHOT PLAN:',
    ...orderedShots,
    'SOURCE AND REFERENCE MANIFEST:',
    ...(input.referenceManifest.length ? input.referenceManifest.map((item) => `- ${item}`) : ['- No source material attached']),
  ].join('\n')
}

const uniqueTags = (tags: readonly string[]): string[] =>
  Array.from(new Set(tags.map((tag) => cleanText(tag)).filter((tag) => /^@[a-zA-Z0-9_]+$/.test(tag))))

/** Kie documents each Kling element mention as consuming 37 prompt characters. */
export function weightedMultiShotPromptLength(prompt: string): number {
  const tags = prompt.match(/@[a-zA-Z0-9_]+/g) ?? []
  const visible = prompt.replace(/@[a-zA-Z0-9_]+/g, '').length
  return visible + tags.length * 37
}

export interface CompileMultiShotInput {
  brief: string
  scenes: readonly MultiShotScene[]
  elementTags: readonly string[]
  rules: MultiShotRules
}

export interface CompiledMultiShotScene {
  prompt: string
  duration: number
}

export function compileMultiShotProviderScenes(input: CompileMultiShotInput): CompiledMultiShotScene[] {
  const brief = input.brief.trim()
  const allTags = uniqueTags(input.elementTags)
  return input.scenes.map((scene, index) => {
    const selectedTags = scene.referenceTags === undefined
      ? allTags
      : uniqueTags(scene.referenceTags).filter((tag) => allTags.includes(tag))
    const direction = scene.prompt.trim()
    const continuity = index === 0
      ? `Sequence brief: ${brief}\nShot 1/${input.scenes.length}: ${direction}`
      : `Continue the same sequence with consistent subjects, world and visual continuity. Shot ${index + 1}/${input.scenes.length}: ${direction}`
    const prompt = [continuity, ...selectedTags].filter(Boolean).join(' ')
    const duration = Number(scene.duration)
    if (!Number.isInteger(duration)) {
      throw new Error(`Shot ${index + 1} duration must be a whole number of seconds.`)
    }
    if (weightedMultiShotPromptLength(prompt) > input.rules.promptMax) {
      throw new Error(`Shot ${index + 1} exceeds Kling's ${input.rules.promptMax}-character provider budget after shared context and references.`)
    }
    return { prompt, duration }
  })
}

export function validateMultiShotDraft(input: CompileMultiShotInput): string | null {
  const brief = input.brief.trim()
  if (!brief) return 'Describe the complete sequence before generating.'
  if (brief.length > input.rules.briefMax) return `Sequence brief must stay within ${input.rules.briefMax} characters.`
  if (input.scenes.length < input.rules.minShots || input.scenes.length > input.rules.maxShots) {
    return `Use ${input.rules.minShots}–${input.rules.maxShots} shots for this model.`
  }
  for (let i = 0; i < input.scenes.length; i += 1) {
    const scene = input.scenes[i]
    if (!scene.prompt.trim()) return `Describe shot ${i + 1} before generating.`
    const duration = Number(scene.duration)
    if (!Number.isInteger(duration) || duration < input.rules.shotMin || duration > input.rules.shotMax) {
      return `Shot ${i + 1} must be ${input.rules.shotMin}–${input.rules.shotMax} whole seconds.`
    }
  }
  const total = totalMultiShotDuration(input.scenes)
  if (total < input.rules.totalMin || total > input.rules.totalMax) {
    return `Sequence duration must total ${input.rules.totalMin}–${input.rules.totalMax} seconds.`
  }
  try {
    compileMultiShotProviderScenes(input)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}
