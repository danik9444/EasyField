import { IMAGE_MODEL_CONFIG, resolveImageOptions } from './imageModelConfig.ts'
import {
  STORYBOARD_MAX_PROMPT_LENGTH,
  clampStoryboardVersionCount,
} from './storyboard.ts'
import type { JobRecoveryMetadata } from '../services/jobCenter.ts'

export const STORYBOARD_BOARD_JOB_NAMESPACE = 'easyfield.storyboard.complete-board.v1'

export interface StoryboardBoardJobSnapshot {
  requestedVersions: number
  promptSnapshot: string
  inputFingerprint: string
  model: string
  aspect: string
  resolution: string
  extras: Record<string, string>
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || value.length > maximum) return null
  return value
}

function normalizeExtras(value: unknown): Record<string, string> | null {
  const source = record(value)
  if (!source || Object.keys(source).length > 32) return null
  const entries: Array<[string, string]> = []
  for (const [key, rawValue] of Object.entries(source)) {
    if (!key || key.length > 80 || typeof rawValue !== 'string' || rawValue.length > 1_000) return null
    entries.push([key, rawValue])
  }
  return Object.fromEntries(entries)
}

export function createStoryboardBoardJobMetadata(
  draftKey: string,
  snapshot: StoryboardBoardJobSnapshot,
): JobRecoveryMetadata {
  return {
    namespace: STORYBOARD_BOARD_JOB_NAMESPACE,
    key: draftKey,
    payload: JSON.stringify({
      version: 1,
      requestedVersions: clampStoryboardVersionCount(snapshot.requestedVersions),
      promptSnapshot: snapshot.promptSnapshot,
      inputFingerprint: snapshot.inputFingerprint,
      model: snapshot.model,
      aspect: snapshot.aspect,
      resolution: snapshot.resolution,
      extras: snapshot.extras,
    }),
  }
}

/**
 * Validates local ledger data before it reaches renderer state. A corrupt or
 * future payload is ignored, never treated as permission to submit new work.
 */
export function parseStoryboardBoardJobMetadata(
  metadata: JobRecoveryMetadata | undefined,
  expectedDraftKey: string,
): StoryboardBoardJobSnapshot | null {
  if (
    !metadata
    || metadata.namespace !== STORYBOARD_BOARD_JOB_NAMESPACE
    || metadata.key !== expectedDraftKey
  ) return null

  let source: Record<string, unknown> | null = null
  try {
    source = record(JSON.parse(metadata.payload))
  } catch {
    return null
  }
  if (!source || source.version !== 1) return null

  const promptSnapshot = boundedText(source.promptSnapshot, STORYBOARD_MAX_PROMPT_LENGTH)
  const inputFingerprint = boundedText(source.inputFingerprint, 512)
  const model = boundedText(source.model, 160)
  const aspect = boundedText(source.aspect, 32)
  const resolution = boundedText(source.resolution, 32)
  const extras = normalizeExtras(source.extras)
  const requestedVersions = Number(source.requestedVersions)
  if (
    promptSnapshot === null
    || !inputFingerprint
    || !model
    || !IMAGE_MODEL_CONFIG[model]
    || aspect === null
    || resolution === null
    || !extras
    || !Number.isInteger(requestedVersions)
    || requestedVersions !== clampStoryboardVersionCount(requestedVersions)
  ) return null

  const options = resolveImageOptions(model, {
    aspect,
    resolution,
    extraOptionValues: extras,
  })
  return {
    requestedVersions,
    promptSnapshot,
    inputFingerprint,
    model,
    aspect: options.aspect,
    resolution: options.resolution,
    extras: options.extraOptionValues,
  }
}
