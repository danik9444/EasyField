import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const legacyStyles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const redesignedStyles = readFileSync(new URL('../src/redesign.css', import.meta.url), 'utf8')

function ruleFor(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

function assertFocusSafeHiddenCheckbox(styles, parentSelector, inputSelector, anchor) {
  const parent = ruleFor(styles, parentSelector)
  const input = ruleFor(styles, inputSelector)

  assert.match(parent, /position:\s*relative\s*;/)
  assert.match(parent, /overflow:\s*hidden\s*;/)
  assert.match(input, /position:\s*absolute\s*;/)
  assert.match(input, /top:\s*50%\s*;/)
  assert.match(input, anchor)
  assert.match(input, /width:\s*1px\s*;/)
  assert.match(input, /height:\s*1px\s*;/)
  assert.match(input, /clip-path:\s*inset\(50%\)\s*;/)
  assert.match(input, /transform:\s*translateY\(-50%\)\s*;/)
}

test('Avatar consent cannot scroll the application panel when its native checkbox receives focus', () => {
  assertFocusSafeHiddenCheckbox(
    legacyStyles,
    '.ef-avatar-consent',
    '.ef-avatar-consent > input',
    /left:\s*24px\s*;/,
  )
  assert.match(ruleFor(legacyStyles, '.ef-avatar-consent:has(> input:focus-visible)'), /outline:\s*2px\s+solid/)
})

test('Transcribe switches use the same focus-safe hidden-checkbox contract', () => {
  assertFocusSafeHiddenCheckbox(
    redesignedStyles,
    '.ef-transcribe-toggle',
    '.ef-transcribe-toggle input',
    /right:\s*30px\s*;/,
  )
  assert.match(ruleFor(redesignedStyles, '.ef-transcribe-toggle:has(> input:focus-visible)'), /outline:\s*2px\s+solid/)
})
