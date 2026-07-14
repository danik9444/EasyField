import type { TranscriptDocument, TranscriptWord } from '../core/contracts'
import type { TranscriptCreationCompanion } from './creations'

export interface WhisperLanguageDefinition {
  code: string
  name: string
  aliases?: readonly string[]
}

/**
 * The 100 language tokens exposed by current OpenAI Whisper multilingual models.
 * Keep this list data-driven so the picker, validation and persisted drafts all
 * agree on the same canonical ISO-style code.
 */
export const WHISPER_LANGUAGES = [
  { code: 'af', name: 'Afrikaans' },
  { code: 'sq', name: 'Albanian' },
  { code: 'am', name: 'Amharic' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hy', name: 'Armenian' },
  { code: 'as', name: 'Assamese' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'ba', name: 'Bashkir' },
  { code: 'eu', name: 'Basque' },
  { code: 'be', name: 'Belarusian' },
  { code: 'bn', name: 'Bengali' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'br', name: 'Breton' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'my', name: 'Myanmar', aliases: ['Burmese'] },
  { code: 'ca', name: 'Catalan', aliases: ['Valencian'] },
  { code: 'zh', name: 'Chinese', aliases: ['Mandarin'] },
  { code: 'hr', name: 'Croatian' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch', aliases: ['Flemish'] },
  { code: 'en', name: 'English' },
  { code: 'et', name: 'Estonian' },
  { code: 'fo', name: 'Faroese' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'ht', name: 'Haitian Creole', aliases: ['Haitian'] },
  { code: 'ha', name: 'Hausa' },
  { code: 'haw', name: 'Hawaiian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'is', name: 'Icelandic' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'jw', name: 'Javanese' },
  { code: 'kn', name: 'Kannada' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'km', name: 'Khmer' },
  { code: 'ko', name: 'Korean' },
  { code: 'lo', name: 'Lao' },
  { code: 'la', name: 'Latin' },
  { code: 'lv', name: 'Latvian' },
  { code: 'ln', name: 'Lingala' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lb', name: 'Luxembourgish', aliases: ['Letzeburgesch'] },
  { code: 'mk', name: 'Macedonian' },
  { code: 'mg', name: 'Malagasy' },
  { code: 'ms', name: 'Malay' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'mt', name: 'Maltese' },
  { code: 'mi', name: 'Maori' },
  { code: 'mr', name: 'Marathi' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'ne', name: 'Nepali' },
  { code: 'no', name: 'Norwegian' },
  { code: 'nn', name: 'Nynorsk' },
  { code: 'oc', name: 'Occitan' },
  { code: 'ps', name: 'Pashto', aliases: ['Pushto'] },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'pa', name: 'Punjabi', aliases: ['Panjabi'] },
  { code: 'ro', name: 'Romanian', aliases: ['Moldavian', 'Moldovan'] },
  { code: 'ru', name: 'Russian' },
  { code: 'sa', name: 'Sanskrit' },
  { code: 'sr', name: 'Serbian' },
  { code: 'sn', name: 'Shona' },
  { code: 'sd', name: 'Sindhi' },
  { code: 'si', name: 'Sinhala', aliases: ['Sinhalese'] },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'so', name: 'Somali' },
  { code: 'es', name: 'Spanish', aliases: ['Castilian'] },
  { code: 'su', name: 'Sundanese' },
  { code: 'sw', name: 'Swahili' },
  { code: 'sv', name: 'Swedish' },
  { code: 'tl', name: 'Tagalog' },
  { code: 'tg', name: 'Tajik' },
  { code: 'ta', name: 'Tamil' },
  { code: 'tt', name: 'Tatar' },
  { code: 'te', name: 'Telugu' },
  { code: 'th', name: 'Thai' },
  { code: 'bo', name: 'Tibetan' },
  { code: 'tr', name: 'Turkish' },
  { code: 'tk', name: 'Turkmen' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'cy', name: 'Welsh' },
  { code: 'yi', name: 'Yiddish' },
  { code: 'yo', name: 'Yoruba' },
  { code: 'yue', name: 'Cantonese' },
] as const satisfies readonly WhisperLanguageDefinition[]

export type WhisperLanguageCode = typeof WHISPER_LANGUAGES[number]['code']
export type TranscriptLanguageChoice = 'auto' | WhisperLanguageCode
export type TranscriptLanguage = WhisperLanguageCode | 'mixed'

const WHISPER_LANGUAGE_CODES = new Set<string>(WHISPER_LANGUAGES.map((language) => language.code))
const RTL_WHISPER_LANGUAGE_CODES = new Set<WhisperLanguageCode>(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd'])

export function isWhisperLanguageCode(value: unknown): value is WhisperLanguageCode {
  return typeof value === 'string' && WHISPER_LANGUAGE_CODES.has(value)
}

export function whisperLanguageForCode(code: WhisperLanguageCode) {
  return WHISPER_LANGUAGES.find((language) => language.code === code)
}

export function whisperLanguageAliases(language: WhisperLanguageDefinition): readonly string[] {
  return language.aliases ?? []
}

export function isRtlWhisperLanguage(value: string): boolean {
  return isWhisperLanguageCode(value) && RTL_WHISPER_LANGUAGE_CODES.has(value)
}
export type TranscriptTask = 'transcribe' | 'translate'
export type WhisperModelId = 'large-v3' | 'turbo' | 'medium' | 'small' | 'base' | 'tiny'

export interface WhisperModelDefinition {
  id: WhisperModelId
  name: string
  description: string
  approximateBytes: number
  memoryLabel: string
  speedLabel: string
  badge?: string
  translation: boolean
}

export const WHISPER_MODELS: readonly WhisperModelDefinition[] = [
  { id: 'large-v3', name: 'Whisper Large v3', description: 'Highest multilingual accuracy for difficult dialogue.', approximateBytes: 3_095_033_483, memoryLabel: '10 GB memory', speedLabel: 'BEST QUALITY', badge: 'BEST', translation: true },
  { id: 'turbo', name: 'Whisper Turbo', description: 'Large-v3 quality tuned for much faster local transcription.', approximateBytes: 1_624_555_275, memoryLabel: '6 GB memory', speedLabel: 'RECOMMENDED', badge: 'FAST · PRO', translation: false },
  { id: 'medium', name: 'Whisper Medium', description: 'High multilingual accuracy with a smaller footprint.', approximateBytes: 1_533_763_059, memoryLabel: '5 GB memory', speedLabel: 'HIGH QUALITY', translation: true },
  { id: 'small', name: 'Whisper Small', description: 'Balanced accuracy and speed for everyday editing.', approximateBytes: 487_601_967, memoryLabel: '2 GB memory', speedLabel: 'BALANCED', badge: 'VALUE', translation: true },
  { id: 'base', name: 'Whisper Base', description: 'Quick drafts on lighter Macs and short clips.', approximateBytes: 147_951_465, memoryLabel: '1 GB memory', speedLabel: 'QUICK', translation: true },
  { id: 'tiny', name: 'Whisper Tiny', description: 'Fastest rough transcript with the lowest local load.', approximateBytes: 77_691_713, memoryLabel: '1 GB memory', speedLabel: 'FASTEST', translation: true },
]

export interface TranscriptSourceAnchor {
  projectId?: string
  timelineId?: string
  itemId?: string
  itemStartFrame?: number
  itemEndFrame?: number
  timelineFps?: number
  sourceStartFrame?: number
  sourceEndFrame?: number
  durationSeconds?: number
  trackType?: string
  trackIndex?: number
}

export interface TranscriptSegment {
  id: string
  startSeconds: number
  endSeconds: number
  text: string
  wordIds: string[]
}

export interface EasyFieldTranscriptDocument extends TranscriptDocument {
  schemaVersion: 1
  kind: 'easyfield-transcript'
  createdAt: number
  source: {
    name: string
    kind: 'audio' | 'video'
    libraryCreationId?: string
    anchor?: TranscriptSourceAnchor
  }
  engineDetails: {
    name: 'openai-whisper'
    implementation: 'whisper.cpp'
    model: WhisperModelId
    version: string
  }
  task: TranscriptTask
  requestedLanguage: TranscriptLanguageChoice
  durationSeconds: number
  wordTimestamps: boolean
  segments: TranscriptSegment[]
}

export interface WhisperRawResult {
  ok: true
  engine: 'whisper.cpp'
  implementation?: 'whisper.cpp'
  engineVersion?: string
  model: WhisperModelId
  language: string
  durationSeconds: number
  text: string
  segments: Array<{
    startSeconds: number
    endSeconds: number
    text: string
    wordIds: string[]
  }>
  words: Array<{ id: string; startSeconds: number; endSeconds: number; text: string; confidence?: number }>
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').trim()
}

function normalizeLanguage(value: string, requested: TranscriptLanguageChoice, task: TranscriptTask): TranscriptLanguage {
  if (task === 'translate') return 'en'
  const normalized = value.trim().toLocaleLowerCase()
  if (isWhisperLanguageCode(normalized)) return normalized
  const detected = WHISPER_LANGUAGES.find((language) => (
    language.name.toLocaleLowerCase() === normalized
    || whisperLanguageAliases(language).some((alias) => alias.toLocaleLowerCase() === normalized)
  ))
  if (detected) return detected.code
  if (requested !== 'auto') return requested
  return 'mixed'
}

export function createTranscriptDocument(input: {
  result: WhisperRawResult
  sourceName: string
  sourceKind: 'audio' | 'video'
  sourceArtifactId: string
  libraryCreationId?: string
  sourceAnchor?: TranscriptSourceAnchor
  requestedLanguage: TranscriptLanguageChoice
  task: TranscriptTask
  wordTimestamps: boolean
  now?: number
  documentId?: string
}): EasyFieldTranscriptDocument {
  const now = input.now ?? Date.now()
  const id = input.documentId ?? `transcript-${now.toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  const durationSeconds = clamp(finite(input.result.durationSeconds), 0, 24 * 60 * 60)
  const words: TranscriptWord[] = []
  const segments: TranscriptSegment[] = []
  let previousSegmentEnd = 0

  input.result.segments.slice(0, 100_000).forEach((rawSegment, segmentIndex) => {
    const startSeconds = clamp(finite(rawSegment.startSeconds, previousSegmentEnd), previousSegmentEnd, durationSeconds || 24 * 60 * 60)
    const endSeconds = clamp(finite(rawSegment.endSeconds, startSeconds), startSeconds, durationSeconds || 24 * 60 * 60)
    const wordIds: string[] = []
    for (const sourceWordId of rawSegment.wordIds.slice(0, 20_000)) {
      const rawWord = input.result.words.find((candidate) => candidate.id === sourceWordId)
      if (!rawWord) continue
      const wordStart = clamp(finite(rawWord.startSeconds, startSeconds), startSeconds, endSeconds)
      const wordEnd = clamp(finite(rawWord.endSeconds, wordStart), wordStart, endSeconds)
      const text = cleanText(rawWord.text)
      if (!text) continue
      const wordId = `${id}-w${words.length + 1}`
      words.push({
        id: wordId,
        text,
        startSeconds: Math.round(wordStart * 1000) / 1000,
        endSeconds: Math.round(wordEnd * 1000) / 1000,
        ...(Number.isFinite(rawWord.confidence) ? { confidence: clamp(Number(rawWord.confidence), 0, 1) } : {}),
      })
      wordIds.push(wordId)
    }
    const text = cleanText(rawSegment.text) || wordIds.map((wordId) => words.find((word) => word.id === wordId)?.text ?? '').join(' ').trim()
    if (!text && !wordIds.length) return
    segments.push({
      id: `${id}-s${segmentIndex + 1}`,
      startSeconds: Math.round(startSeconds * 1000) / 1000,
      endSeconds: Math.round(endSeconds * 1000) / 1000,
      text,
      wordIds,
    })
    previousSegmentEnd = endSeconds
  })

  return {
    schemaVersion: 1,
    kind: 'easyfield-transcript',
    id,
    projectId: input.sourceAnchor?.projectId ?? 'local-project',
    sourceArtifactId: input.sourceArtifactId,
    language: normalizeLanguage(input.result.language, input.requestedLanguage, input.task),
    engine: 'local',
    words,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    source: {
      name: input.sourceName,
      kind: input.sourceKind,
      ...(input.libraryCreationId ? { libraryCreationId: input.libraryCreationId } : {}),
      ...(input.sourceAnchor ? { anchor: input.sourceAnchor } : {}),
    },
    engineDetails: {
      name: 'openai-whisper',
      implementation: 'whisper.cpp',
      model: input.result.model,
      version: input.result.engineVersion || 'available',
    },
    task: input.task,
    requestedLanguage: input.requestedLanguage,
    durationSeconds,
    wordTimestamps: input.wordTimestamps,
    segments,
  }
}

export function updateTranscriptSegment(
  document: EasyFieldTranscriptDocument,
  segmentId: string,
  text: string,
  now = Date.now(),
): EasyFieldTranscriptDocument {
  return {
    ...document,
    segments: document.segments.map((segment) => segment.id === segmentId ? { ...segment, text: text.replace(/\u0000/g, '') } : segment),
    revision: document.revision + 1,
    updatedAt: now,
  }
}

function safeStem(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72) || 'EasyField transcript'
}

function cueTime(seconds: number, separator: ',' | '.'): string {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(totalMilliseconds / 3_600_000)
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000)
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000)
  const millis = totalMilliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`
}

export function transcriptToSrt(document: EasyFieldTranscriptDocument): string {
  return document.segments.map((segment, index) => `${index + 1}\n${cueTime(segment.startSeconds, ',')} --> ${cueTime(segment.endSeconds, ',')}\n${segment.text.trim()}\n`).join('\n')
}

export function transcriptToVtt(document: EasyFieldTranscriptDocument): string {
  return `WEBVTT\n\n${document.segments.map((segment) => `${cueTime(segment.startSeconds, '.')} --> ${cueTime(segment.endSeconds, '.')}\n${segment.text.trim()}\n`).join('\n')}`
}

export function transcriptToText(document: EasyFieldTranscriptDocument): string {
  return document.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n')
}

export function transcriptFileName(document: EasyFieldTranscriptDocument, extension: 'json' | 'srt' | 'vtt' | 'txt'): string {
  return `${safeStem(document.source.name)}.${extension}`
}

export function createTranscriptCompanion(document: EasyFieldTranscriptDocument): TranscriptCreationCompanion {
  return {
    id: document.id,
    kind: 'transcript',
    schemaVersion: 1,
    fileName: `${safeStem(document.source.name)}.easyfield-transcript.json`,
    mimeType: 'application/vnd.easyfield.transcript+json',
    data: JSON.stringify(document, null, 2),
    createdAt: document.createdAt,
    summary: {
      language: document.language,
      model: document.engineDetails.model,
      durationSeconds: document.durationSeconds,
      segmentCount: document.segments.length,
      wordCount: document.words.length,
      wordTimestamps: document.wordTimestamps,
      sourceKind: document.source.kind,
    },
  }
}

export function parseTranscriptCompanion(companion: { kind: string; schemaVersion: number; data: string }): EasyFieldTranscriptDocument | null {
  if (companion.kind !== 'transcript' || companion.schemaVersion !== 1) return null
  try {
    const value = JSON.parse(companion.data) as EasyFieldTranscriptDocument
    if (value?.schemaVersion !== 1 || value.kind !== 'easyfield-transcript' || !Array.isArray(value.segments) || !Array.isArray(value.words)) return null
    return value
  } catch {
    return null
  }
}
