import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WHISPER_LANGUAGES,
  createTranscriptCompanion,
  createTranscriptDocument,
  isRtlWhisperLanguage,
  isWhisperLanguageCode,
  parseTranscriptCompanion,
  transcriptToSrt,
  transcriptToText,
  transcriptToVtt,
  updateTranscriptSegment,
  whisperLanguageAliases,
  type WhisperRawResult,
} from '../src/data/transcript.ts'

const result: WhisperRawResult = {
  ok: true,
  engine: 'whisper.cpp',
  implementation: 'whisper.cpp',
  engineVersion: 'test-runtime',
  model: 'turbo',
  language: 'he',
  durationSeconds: 4.4,
  text: 'שלום עולם. EasyField עובד.',
  segments: [
    {
      startSeconds: 0.25,
      endSeconds: 1.8,
      text: 'שלום עולם.',
      wordIds: ['raw-w1', 'raw-w2'],
    },
    {
      startSeconds: 2.05,
      endSeconds: 4.4,
      text: 'EasyField עובד.',
      wordIds: ['raw-w3', 'raw-w4'],
    },
  ],
  words: [
    { id: 'raw-w1', startSeconds: 0.25, endSeconds: 0.75, text: 'שלום', confidence: 0.93 },
    { id: 'raw-w2', startSeconds: 0.84, endSeconds: 1.72, text: 'עולם.', confidence: 0.88 },
    { id: 'raw-w3', startSeconds: 2.05, endSeconds: 3.1, text: 'EasyField', confidence: 0.9 },
    { id: 'raw-w4', startSeconds: 3.2, endSeconds: 4.35, text: 'עובד.', confidence: 0.91 },
  ],
}

test('Whisper output becomes a versioned Hebrew transcript with ordered word timestamps', () => {
  const transcript = createTranscriptDocument({
    result,
    sourceName: 'Interview.mov',
    sourceKind: 'video',
    sourceArtifactId: 'cr-video',
    libraryCreationId: 'cr-video',
    requestedLanguage: 'auto',
    task: 'transcribe',
    wordTimestamps: true,
    now: 1234,
    documentId: 'transcript-test',
  })
  assert.equal(transcript.language, 'he')
  assert.equal(transcript.engineDetails.model, 'turbo')
  assert.equal(transcript.words.length, 4)
  assert.equal(transcript.segments.length, 2)
  assert.deepEqual(transcript.segments[0].wordIds, ['transcript-test-w1', 'transcript-test-w2'])
  assert.equal(transcript.source.libraryCreationId, 'cr-video')
})

test('SRT, VTT and text exports preserve edited RTL text and precise cue timing', () => {
  const original = createTranscriptDocument({
    result,
    sourceName: 'Interview.mov',
    sourceKind: 'video',
    sourceArtifactId: 'cr-video',
    requestedLanguage: 'he',
    task: 'transcribe',
    wordTimestamps: true,
    now: 1234,
    documentId: 'transcript-test',
  })
  const edited = updateTranscriptSegment(original, original.segments[0].id, 'שלום, עולם!', 2000)
  assert.equal(edited.revision, 2)
  assert.match(transcriptToSrt(edited), /00:00:00,250 --> 00:00:01,800\nשלום, עולם!/)
  assert.match(transcriptToVtt(edited), /^WEBVTT\n\n00:00:00\.250 --> 00:00:01\.800/m)
  assert.equal(transcriptToText(edited), 'שלום, עולם!\nEasyField עובד.')
})

test('Transcript Library companion round-trips the canonical document', () => {
  const transcript = createTranscriptDocument({
    result,
    sourceName: 'Interview.mov',
    sourceKind: 'video',
    sourceArtifactId: 'cr-video',
    requestedLanguage: 'auto',
    task: 'transcribe',
    wordTimestamps: true,
    now: 1234,
    documentId: 'transcript-test',
  })
  const companion = createTranscriptCompanion(transcript)
  assert.equal(companion.kind, 'transcript')
  assert.equal(companion.fileName, 'Interview.easyfield-transcript.json')
  assert.equal(companion.summary.wordCount, 4)
  assert.deepEqual(parseTranscriptCompanion(companion), transcript)
})

test('the renderer catalog exposes every canonical Whisper language once', () => {
  assert.equal(WHISPER_LANGUAGES.length, 100)
  assert.equal(new Set(WHISPER_LANGUAGES.map((language) => language.code)).size, 100)
  assert.equal(WHISPER_LANGUAGES.every((language) => isWhisperLanguageCode(language.code)), true)
  assert.deepEqual(whisperLanguageAliases(WHISPER_LANGUAGES.find((language) => language.code === 'zh')!), ['Mandarin'])
  assert.equal(isRtlWhisperLanguage('ar'), true)
  assert.equal(isRtlWhisperLanguage('fr'), false)
})

test('selected and detected multilingual codes stay attached to transcript documents', () => {
  const french = createTranscriptDocument({
    result: { ...result, language: 'French' },
    sourceName: 'Interview.wav',
    sourceKind: 'audio',
    sourceArtifactId: 'cr-audio',
    requestedLanguage: 'fr',
    task: 'transcribe',
    wordTimestamps: true,
    now: 1234,
    documentId: 'transcript-french',
  })
  assert.equal(french.language, 'fr')
  assert.equal(french.requestedLanguage, 'fr')
})
