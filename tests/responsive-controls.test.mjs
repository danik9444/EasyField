import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const legacyStyles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const redesignedStyles = readFileSync(new URL('../src/redesign.css', import.meta.url), 'utf8')
const settingsScreen = readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8')

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

test('Angles uses the same bounded primary-image stage as Edit Image', () => {
  const anglesCanvasRule = legacyStyles.match(/\.ef-angles-source-card \.ef-edit-canvas\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.doesNotMatch(anglesCanvasRule, /max-height:\s*none/)

  assert.match(
    redesignedStyles,
    /:is\(\.ef-edit-image-screen, \.ef-angles-screen\) \.ef-edit-canvas\s*\{[^}]*height:\s*clamp\(220px,36vh,300px\);[^}]*max-height:\s*300px;[^}]*aspect-ratio:\s*auto !important;/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-panel--expanded \.ef-angles-screen \.ef-angles-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\) 314px;/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-panel--expanded \.ef-angles-screen \.ef-angles-source-card\s*\{[^}]*min-height:\s*420px;[^}]*max-height:\s*560px;/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-panel--expanded \.ef-angles-screen \.ef-angles-source-card \.ef-edit-canvas\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*inherit;[^}]*max-height:\s*inherit;/s,
  )
  assert.doesNotMatch(
    redesignedStyles,
    /\.ef-panel--expanded \.ef-angles-screen \.ef-angles-source-card \.ef-edit-canvas\s*\{[^}]*min-height:\s*0;/s,
  )
})

test('Settings keeps compact content separated and exposes no accent-color control', () => {
  assert.doesNotMatch(settingsScreen, /ACCENT_OPTIONS|ef-accent-options|label="Accent"/)
  assert.doesNotMatch(legacyStyles, /\.ef-accent-options/)
  assert.doesNotMatch(redesignedStyles, /\.ef-accent-options/)

  assert.match(
    redesignedStyles,
    /\.ef-settings-section-head\s*\{[^}]*flex:\s*0 0 auto;/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-settings-group\s*\{[^}]*flex:\s*0 0 auto;/s,
  )
  assert.doesNotMatch(
    redesignedStyles,
    /\.ef-settings-section-head\s*\{[^}]*min-height:\s*0;/s,
  )
})

test('all seven Settings sections stay visible in a balanced compact grid', () => {
  assert.match(
    redesignedStyles,
    /\.ef-panel--compact \.ef-settings-nav-items\s*\{[^}]*grid-template-columns:\s*repeat\(12,minmax\(0,1fr\)\);[^}]*overflow:\s*visible;/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-panel--compact \.ef-settings-nav \.ef-settings-nav-items > button\s*\{[^}]*grid-column:\s*span 3;/s,
  )
  assert.match(
    redesignedStyles,
    /\.ef-panel--compact \.ef-settings-nav \.ef-settings-nav-items > button:nth-child\(n\+5\)\s*\{[^}]*grid-column:\s*span 4;/s,
  )
})
