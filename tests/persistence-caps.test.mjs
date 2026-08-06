import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const main = read('../plugin/main.cjs')
const transcribe = read('../src/screens/Transcribe.tsx')
const storyboard = read('../src/screens/Storyboard.tsx')
const styles = read('../src/redesign.css')

test('Main externalizes oversized renderer state without raising the SQLite value cap', () => {
  assert.match(main, /const STATE_VALUE_LIMIT = 2 \* 1024 \* 1024/)
  assert.match(main, /if \(bytes <= STATE_VALUE_LIMIT\) \{\s*stateStore\.set\(namespace, key, value\)/s)
  assert.match(main, /const reference = stateDocumentStore\.write\(valueJson\)[\s\S]*stateStore\.set\(namespace, key, reference\)/)
  assert.doesNotMatch(main, /State value is too large/)
})

test('completed transcripts render before durable persistence and expose save recovery', () => {
  assert.match(
    transcribe,
    /setTranscript\(document\)[\s\S]*setPhase\('complete'\)[\s\S]*await persistTranscript\(document, librarySource\.id\)/,
  )
  assert.match(transcribe, /This transcript is complete and available to export, but it is not saved yet/)
  assert.match(transcribe, />Retry save<\/button>/)
  assert.match(transcribe, /NOT SAVED · EXPORT NOW/)
  assert.match(transcribe, /persistTranscript\(transcript, sourceCreationId\)\.then\(\(saved\) => \{\s*if \(saved\) onBack\(\)/)
  assert.doesNotMatch(transcribe, /className="ef-back-btn" onClick=\{onBack\}/)
})

test('Storyboard blocks back navigation after a failed save and shows sighted recovery UI', () => {
  assert.match(storyboard, /persistDraft\(draftRef\.current\)\.then\(onBack\)\.catch/)
  assert.doesNotMatch(storyboard, /persistDraft\(draftRef\.current\)\.finally\(onBack\)/)
  assert.match(storyboard, /className=\{`ef-story-save-state is-\$\{saveState\}`\}/)
  assert.match(storyboard, /Storyboard changes are not saved\./)
  assert.match(storyboard, /if \(!hydrated \|\| restoreFailed\) return/)
  assert.match(storyboard, /existing saved draft has not been overwritten/)
  assert.match(styles, /\.ef-story-save-state:not\(\.is-error\) \{ display: none; \}/)
})
