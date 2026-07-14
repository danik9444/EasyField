import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const component = readFileSync(new URL('../src/components/MediaFileGrid.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('MediaFileGrid safely infers players only for one accepted playable media kind', () => {
  assert.match(component, /libraryKinds\.length === 1/)
  assert.match(component, /libraryKinds\[0\] === 'video' \|\| libraryKinds\[0\] === 'audio'/)
  assert.match(component, /previewKind === 'none' \? null/)
})

test('MediaFileGrid renders accessible in-plugin video and audio playback', () => {
  assert.match(component, /<video src=\{previewUrl\} controls playsInline preload="metadata"/)
  assert.match(component, /<audio src=\{previewUrl\} controls preload="metadata"/)
  assert.match(component, /aria-label=\{`Preview \$\{item\.name\}`\}/)
  assert.match(component, /item\.kind === 'upload' \? item\.url : null/)
})

test('media previews stay within compact and expanded panel bounds', () => {
  assert.match(styles, /\.ef-media-file\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s)
  assert.match(styles, /\.ef-media-file-preview video\s*\{[^}]*width:\s*100%;[^}]*max-height:\s*240px;[^}]*object-fit:\s*contain;/s)
  assert.match(styles, /\.ef-media-file-preview audio\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s)
})
