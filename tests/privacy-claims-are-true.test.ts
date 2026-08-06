/**
 * The Settings panel used to promise two controls that did not exist: "Every
 * cloud run shows its price and upload manifest" and "Cloud consent: First use
 * + manifest every run". `uploadManifest` and `consentRequired` appear only as
 * fields on a type nothing constructs, so neither was ever built or rendered.
 *
 * A false statement to a paying customer is bad on its own. This one was worse
 * than that: it would have contradicted the privacy policy the product needs
 * before any payment provider will complete onboarding.
 *
 * These tests hold the panel to what the code actually does. They are written
 * so that implementing a promise is the way to make the promise legal again —
 * each one fails on an unbacked claim, not on the feature existing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8')
}

const settingsScreen = read('src/screens/SettingsScreen.tsx')
const contracts = read('src/core/contracts.ts')
const settingsModule = read('src/settings.ts')

/** Everything the privacy section renders, as one blob of user-visible copy. */
function privacySection(): string {
  const match = /section === 'privacy' && \(([\s\S]+?)\n {10}\)\}/.exec(settingsScreen)
  assert.ok(match, 'the privacy section is no longer recognisable in SettingsScreen')
  return match[1]
}

test('a per-run upload manifest is not promised while nothing builds one', () => {
  // `uploadManifest` is declared on a type; being declared is not being shown.
  // If a future change renders one, this test should be updated deliberately
  // rather than the claim being restored on its own.
  const isConstructed = /uploadManifest\s*[:=]\s*(\[|buildUploadManifest|manifest)/.test(contracts)
    || /uploadManifest/.test(settingsScreen.replace(/Not in this build/, ''))

  if (!isConstructed) {
    const copy = privacySection()
    assert.doesNotMatch(
      copy,
      /shows its price and upload manifest/,
      'the panel promises a per-run upload manifest that nothing constructs',
    )
    assert.doesNotMatch(
      copy,
      /manifest every run/,
      'the panel promises a manifest on every run that nothing constructs',
    )
  }
})

test('a cloud consent gate is not promised while nothing enforces one', () => {
  // The only consent control that exists in the product is the Avatar
  // likeness-rights checkbox. `consentRequired` is a field on a dead type.
  const enforced = /consentRequired/.test(settingsScreen)
    || /requireCloudConsent|awaitCloudConsent|consentGate/.test(contracts)

  if (!enforced) {
    assert.doesNotMatch(
      privacySection(),
      /First use \+ manifest every run/,
      'the panel describes a consent flow that nothing implements',
    )
  }
})

test('a switch is offered only when something reads it', () => {
  // `settings.telemetry` is declared, defaulted and parsed, and no code path
  // has ever read it to send anything. A toggle that changes nothing is a
  // claim that something happens.
  const telemetryIsConsumed = /telemetry/.test(read('src/services/host.ts'))

  if (!telemetryIsConsumed) {
    assert.doesNotMatch(
      privacySection(),
      /<Toggle[^>]*telemetry/i,
      'a telemetry toggle is offered but nothing reads the setting',
    )
    // The field may stay in the persisted shape — removing it would discard a
    // stored preference — but the panel must not imply it does anything.
    assert.match(settingsModule, /telemetry: boolean/)
  }
})

test('the panel says plainly that cloud runs send media off the machine', () => {
  const copy = privacySection()
  assert.match(
    copy,
    /leave this Mac/,
    'the panel no longer states that customer media leaves the machine',
  )
  // Local tools must not be swept into that statement; they genuinely send
  // nothing, and overstating is its own kind of inaccuracy.
  assert.match(copy, /Animations, Transcribe and Beat Detection/)
})

test('the panel points at a published policy that names the sub-processors', () => {
  // GDPR Article 13(1)(e) requires naming recipients. The name belongs in the
  // published policy — a public URL a prospect can read before installing —
  // and the panel is where an installed customer finds that URL.
  assert.match(settingsScreen, /const PRIVACY_POLICY_URL = 'https:\/\/easyfield\.ai\/privacy'/)
  assert.match(privacySection(), /PRIVACY_POLICY_URL/)
  assert.match(privacySection(), /Sub-processors/)
})

test('the sub-processor link cannot open a tab with access to this window', () => {
  const copy = privacySection()
  const anchor = /<a[^>]*href=\{PRIVACY_POLICY_URL\}[^>]*>/.exec(copy)
  assert.ok(anchor, 'the policy link is not an anchor to PRIVACY_POLICY_URL')
  assert.match(anchor[0], /rel="noreferrer noopener"/)
})
