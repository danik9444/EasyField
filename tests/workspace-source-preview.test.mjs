import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const component = readFileSync(new URL('../src/components/WorkspaceSourcePreviewList.tsx', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../src/screens/ToolWorkspace.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/redesign.css', import.meta.url), 'utf8')

test('generic tool sources render accessible in-plugin video and audio players', () => {
  assert.match(component, /<video src=\{previewUrl\} controls playsInline preload="metadata" aria-label=\{label\} \/>/)
  assert.match(component, /<audio src=\{previewUrl\} controls preload="metadata" aria-label=\{label\} \/>/)
  assert.doesNotMatch(component, /autoPlay/)
  assert.match(workspace, /<WorkspaceSourcePreviewList sources=\{sources\} onRemove=\{removeSource\} onClear=\{clearSources\} \/>/)
})

test('uploaded media preview URLs are owned and revoked by the preview component', () => {
  assert.match(component, /source\.blobUrl \|\| !source\.file/)
  assert.match(component, /URL\.createObjectURL\(source\.file\)/)
  assert.match(component, /return \(\) => URL\.revokeObjectURL\(nextUrl\)/)
  assert.match(component, /return source\.blobUrl \?\? localPreviewUrl/)
})

test('generic workspace media stays contained in compact and expanded layouts', () => {
  assert.match(styles, /\.ef-workspace-source-list\s*\{[^}]*max-height:\s*min\(310px, 46vh\);[^}]*overflow-y:\s*auto;/s)
  assert.match(styles, /\.ef-workspace-source-card\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;[^}]*overflow:\s*hidden;/s)
  assert.match(styles, /\.ef-workspace-source-preview video\s*\{[^}]*width:\s*100%;[^}]*max-height:\s*240px;[^}]*object-fit:\s*contain;/s)
  assert.match(styles, /\.ef-workspace-source-preview audio\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s)
})
