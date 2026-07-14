import { SOUND_EFFECT_KEYS, type SoundEffectCtx } from './kieModels.ts'
import type { FoleyConfidence, FoleyPlanEvent } from '../services/chat.ts'

export type SoundEffectsMode = 'single' | 'foley'
export type FoleyGuidanceMode = 'guided' | 'auto'
export type FoleyEventStatus = 'ready' | 'generating' | 'done' | 'error' | 'pending'

export const SOUND_EFFECT_MODES: Array<{ id: SoundEffectsMode; label: string; summary: string }> = [
  { id: 'single', label: 'Single sound', summary: 'Create one standalone effect from text' },
  { id: 'foley', label: 'Auto Foley', summary: 'Review timed events before generating' },
]

export const FOLEY_GUIDANCE_MODES: Array<{ id: FoleyGuidanceMode; label: string; summary: string }> = [
  { id: 'guided', label: 'Guided prompt', summary: 'Tell EasyField what to prioritize or avoid' },
  { id: 'auto', label: 'Full auto', summary: 'Let the visible action decide the complete Foley plan' },
]

export interface SoundEffectsPreferences {
  mode: SoundEffectsMode
  foleyGuidance: FoleyGuidanceMode
  model: SoundEffectCtx['model']
  singlePrompt: string
  foleyDirection: string
  loop: boolean
  bpm: number
  key: SoundEffectCtx['key']
  advancedOpen: boolean
}

export interface FoleyEventState extends FoleyPlanEvent {
  id: string
  approved: boolean
  status: FoleyEventStatus
  urls: string[]
  error?: string
  charged?: number | null
}

const DEFAULT_SINGLE_PROMPT = 'A clean cinematic camera shutter click with a short mechanical tail'
const DEFAULT_FOLEY_DIRECTION = 'Identify the clearly visible production-ready Foley. Prioritize physical contact, footsteps, props, cloth and environmental interaction; omit music and dialogue.'

export function normalizeSoundEffectsPreferences(raw: unknown): SoundEffectsPreferences {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const legacyWorkflow = typeof value.workflow === 'string' ? value.workflow : ''
  const legacyPicture = value.mode === 'picture'
  const mode: SoundEffectsMode = value.mode === 'foley' || legacyPicture
    ? 'foley'
    : value.mode === 'single'
      ? 'single'
    : legacyWorkflow === 'Auto Foley'
      ? 'foley'
      : 'single'
  const foleyGuidance: FoleyGuidanceMode = value.foleyGuidance === 'auto' ? 'auto' : 'guided'
  const model: SoundEffectCtx['model'] = value.model === 'V5' ? 'V5' : 'V5_5'
  const legacyPrompt = typeof value.prompt === 'string' ? value.prompt : ''
  const legacyPicturePrompt = typeof value.picturePrompt === 'string' ? value.picturePrompt.trim() : ''
  const bpm = Number(value.bpm)
  const key = SOUND_EFFECT_KEYS.includes(value.key as SoundEffectCtx['key']) ? value.key as SoundEffectCtx['key'] : 'Any'
  return {
    mode,
    foleyGuidance,
    model,
    singlePrompt: typeof value.singlePrompt === 'string' ? value.singlePrompt : legacyPrompt || DEFAULT_SINGLE_PROMPT,
    foleyDirection: legacyPicture && legacyPicturePrompt
      ? legacyPicturePrompt
      : typeof value.foleyDirection === 'string'
        ? value.foleyDirection
        : DEFAULT_FOLEY_DIRECTION,
    loop: typeof value.loop === 'boolean' ? value.loop : value.loop === 'On',
    bpm: Number.isInteger(bpm) && bpm >= 1 && bpm <= 300 ? bpm : 120,
    key,
    advancedOpen: value.advancedOpen === true,
  }
}

export function resolveFoleyDirection(guidance: FoleyGuidanceMode, direction: string): string {
  return guidance === 'guided' ? direction.trim() : ''
}

export function makeFoleyEventStates(events: FoleyPlanEvent[], idPrefix = 'foley'): FoleyEventState[] {
  return events.map((event, index) => ({
    ...event,
    id: `${idPrefix}-${index + 1}`,
    approved: true,
    status: 'ready',
    urls: [],
  }))
}

export function formatFoleyTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  const remainder = safe - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`
}

export function isFoleyConfidence(value: string): value is FoleyConfidence {
  return value === 'high' || value === 'medium' || value === 'low'
}

export function foleyRecordFrame(
  itemStartFrame: number,
  itemEndFrame: number,
  fps: number,
  offsetSeconds: number,
): number | null {
  if (
    !Number.isFinite(fps)
    || fps <= 0
    || !Number.isSafeInteger(itemStartFrame)
    || !Number.isSafeInteger(itemEndFrame)
    || itemEndFrame <= itemStartFrame
    || !Number.isFinite(offsetSeconds)
    || offsetSeconds < 0
  ) return null
  const frame = itemStartFrame + Math.round(offsetSeconds * fps)
  return frame < itemEndFrame ? frame : null
}
