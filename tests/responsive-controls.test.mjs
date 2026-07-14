import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const legacyStyles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const redesignedStyles = readFileSync(new URL('../src/redesign.css', import.meta.url), 'utf8')

test('Settings uses one switch implementation and never paints a second knob', () => {
  assert.equal(legacyStyles.match(/\.ef-toggle\s*\{/g)?.length, 1)
  assert.doesNotMatch(legacyStyles, /\.ef-toggle::after\s*\{/)
  assert.match(legacyStyles, /\.ef-toggle\.is-on\s+span\s*\{[^}]*translateX\(15px\)/s)
})

test('Edit Video reference headers stack their label above actions in Compact mode', () => {
  const rule = redesignedStyles.match(/\.ef-panel--compact \.ef-edit-video-screen \.ef-ref-header\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /display:\s*grid/)
  assert.match(rule, /grid-template-columns:\s*minmax\(0,1fr\)\s+auto\s+auto/)
  assert.match(
    redesignedStyles,
    /\.ef-panel--compact \.ef-edit-video-screen \.ef-ref-header > \.ef-field-label\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-panel--compact \.ef-edit-video-screen \.ef-ref-header > \.ef-spacer\s*\{[^}]*display:\s*none/s,
  )
})
