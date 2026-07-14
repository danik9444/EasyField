import type { BeatDetectionResult } from '../services/beatDetection'
import type { CreationCompanion } from './creations'

export type BeatStyleId = 'every-beat' | 'strong-beats' | 'every-2' | 'every-4' | 'custom'
export type BeatMarkerColor = 'Blue' | 'Cyan' | 'Green' | 'Yellow' | 'Red' | 'Pink' | 'Purple'

export interface BeatMarkerSettings {
  styleId: BeatStyleId
  everyNth: number
  minimumConfidence: number
  minimumGapSeconds: number
  offsetSeconds: number
  rangeStartSeconds: number | null
  rangeEndSeconds: number | null
  markerColor: BeatMarkerColor
  markerPrefix: string
}

export interface BeatMarker {
  time: number
  confidence: number
  sourceBeatIndex: number
  name: string
}

export interface BeatAnalysisDocument {
  schemaVersion: 1
  kind: 'easyfield-beat-analysis'
  analysisId: string
  analyzedAt: number
  source: {
    name: string
    kind: 'audio' | 'video'
    libraryCreationId?: string
  }
  engine: {
    name: 'librosa'
    version: string
    sampleRate: number
  }
  settings: BeatMarkerSettings
  analysis: BeatDetectionResult
  markers: BeatMarker[]
}

export const BEAT_MARKER_COLORS: readonly BeatMarkerColor[] = ['Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple']

export const BEAT_STYLE_PRESETS: ReadonlyArray<{
  id: BeatStyleId
  name: string
  description: string
  detail: string
}> = [
  { id: 'every-beat', name: 'Every beat', description: 'Maximum rhythmic detail', detail: '1×' },
  { id: 'strong-beats', name: 'Strong beats', description: 'Keep prominent rhythmic accents', detail: 'SMART' },
  { id: 'every-2', name: 'Every 2 beats', description: 'Balanced editorial pacing', detail: '2×' },
  { id: 'every-4', name: 'Every 4 beats', description: 'Broader phrase-like spacing', detail: '4×' },
  { id: 'custom', name: 'Custom', description: 'Exact density, confidence and range', detail: 'PRO' },
]

export const DEFAULT_BEAT_MARKER_SETTINGS: BeatMarkerSettings = {
  styleId: 'strong-beats',
  everyNth: 1,
  minimumConfidence: 0.62,
  minimumGapSeconds: 0.12,
  offsetSeconds: 0,
  rangeStartSeconds: null,
  rangeEndSeconds: null,
  markerColor: 'Cyan',
  markerPrefix: 'Beat',
}

const finite = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function normalizeBeatMarkerSettings(value?: Partial<BeatMarkerSettings> | null): BeatMarkerSettings {
  const styleId = BEAT_STYLE_PRESETS.some((preset) => preset.id === value?.styleId)
    ? value!.styleId!
    : DEFAULT_BEAT_MARKER_SETTINGS.styleId
  const markerColor = BEAT_MARKER_COLORS.includes(value?.markerColor as BeatMarkerColor)
    ? value!.markerColor as BeatMarkerColor
    : DEFAULT_BEAT_MARKER_SETTINGS.markerColor
  const normalizeRange = (input: unknown): number | null => {
    if (input == null || input === '') return null
    return clamp(finite(input, 0), 0, 24 * 60 * 60)
  }
  return {
    styleId,
    everyNth: Math.round(clamp(finite(value?.everyNth, DEFAULT_BEAT_MARKER_SETTINGS.everyNth), 1, 16)),
    minimumConfidence: clamp(finite(value?.minimumConfidence, DEFAULT_BEAT_MARKER_SETTINGS.minimumConfidence), 0, 1),
    minimumGapSeconds: clamp(finite(value?.minimumGapSeconds, DEFAULT_BEAT_MARKER_SETTINGS.minimumGapSeconds), 0, 10),
    offsetSeconds: clamp(finite(value?.offsetSeconds, DEFAULT_BEAT_MARKER_SETTINGS.offsetSeconds), -2, 2),
    rangeStartSeconds: normalizeRange(value?.rangeStartSeconds),
    rangeEndSeconds: normalizeRange(value?.rangeEndSeconds),
    markerColor,
    markerPrefix: String(value?.markerPrefix ?? DEFAULT_BEAT_MARKER_SETTINGS.markerPrefix).replace(/\s+/g, ' ').trim().slice(0, 32) || 'Beat',
  }
}

export function effectiveBeatMarkerSettings(settings: BeatMarkerSettings): BeatMarkerSettings {
  const normalized = normalizeBeatMarkerSettings(settings)
  if (normalized.styleId === 'custom') return normalized
  if (normalized.styleId === 'every-beat') return { ...normalized, everyNth: 1, minimumConfidence: 0, minimumGapSeconds: 0 }
  if (normalized.styleId === 'strong-beats') return { ...normalized, everyNth: 1, minimumConfidence: 0.62, minimumGapSeconds: 0.12 }
  if (normalized.styleId === 'every-2') return { ...normalized, everyNth: 2, minimumConfidence: 0, minimumGapSeconds: 0 }
  return { ...normalized, everyNth: 4, minimumConfidence: 0, minimumGapSeconds: 0 }
}

export function buildBeatMarkers(result: BeatDetectionResult, settings: BeatMarkerSettings): BeatMarker[] {
  const resolved = effectiveBeatMarkerSettings(settings)
  const start = resolved.rangeStartSeconds ?? 0
  const end = Math.min(result.durationSeconds, resolved.rangeEndSeconds ?? result.durationSeconds)
  if (end < start) return []

  const eligible = result.beats
    .map((beat, sourceBeatIndex) => ({ beat, sourceBeatIndex }))
    .filter(({ beat }) => beat.time >= start && beat.time <= end && beat.confidence >= resolved.minimumConfidence)
    .filter((_, index) => index % resolved.everyNth === 0)

  const markers: BeatMarker[] = []
  for (const { beat, sourceBeatIndex } of eligible) {
    const time = clamp(beat.time + resolved.offsetSeconds, start, end)
    const previous = markers.at(-1)
    if (previous && time - previous.time < resolved.minimumGapSeconds) continue
    markers.push({
      time: Math.round(time * 10_000) / 10_000,
      confidence: Math.round(beat.confidence * 10_000) / 10_000,
      sourceBeatIndex,
      name: `${resolved.markerPrefix} ${String(markers.length + 1).padStart(3, '0')}`,
    })
  }
  return markers
}

function safeStem(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72) || 'EasyField audio'
}

export function createBeatAnalysisCompanion(input: {
  sourceName: string
  sourceKind: 'audio' | 'video'
  libraryCreationId?: string
  result: BeatDetectionResult
  settings: BeatMarkerSettings
  markers: BeatMarker[]
  now?: number
  analysisId?: string
}): CreationCompanion {
  const analyzedAt = input.now ?? Date.now()
  const analysisId = input.analysisId ?? `beat-${analyzedAt.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  const document: BeatAnalysisDocument = {
    schemaVersion: 1,
    kind: 'easyfield-beat-analysis',
    analysisId,
    analyzedAt,
    source: {
      name: input.sourceName,
      kind: input.sourceKind,
      ...(input.libraryCreationId ? { libraryCreationId: input.libraryCreationId } : {}),
    },
    engine: { name: 'librosa', version: input.result.engineVersion, sampleRate: input.result.sampleRate },
    settings: effectiveBeatMarkerSettings(input.settings),
    analysis: input.result,
    markers: input.markers,
  }
  return {
    id: analysisId,
    kind: 'beat-analysis',
    schemaVersion: 1,
    fileName: `${safeStem(input.sourceName)}.easyfield-beats.json`,
    mimeType: 'application/vnd.easyfield.beats+json',
    data: JSON.stringify(document, null, 2),
    createdAt: analyzedAt,
    summary: {
      bpm: input.result.bpm,
      detectedBeats: input.result.beats.length,
      markerCount: input.markers.length,
      confidence: input.result.confidence,
      durationSeconds: input.result.durationSeconds,
      engine: 'librosa',
      engineVersion: input.result.engineVersion,
      markerColor: effectiveBeatMarkerSettings(input.settings).markerColor,
    },
  }
}

export function parseBeatAnalysisCompanion(companion: CreationCompanion): BeatAnalysisDocument | null {
  if (companion.kind !== 'beat-analysis' || companion.schemaVersion !== 1) return null
  try {
    const parsed = JSON.parse(companion.data) as BeatAnalysisDocument
    return parsed?.schemaVersion === 1 && parsed.kind === 'easyfield-beat-analysis' && Array.isArray(parsed.markers) ? parsed : null
  } catch {
    return null
  }
}
