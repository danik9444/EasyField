import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { MIN_PASSWORD_LENGTH } from '../src/core/account.ts'

const require = createRequire(import.meta.url)
const { createAccountService } = require('../plugin/account-service.cjs')

const SERVICE_SOURCE = readFileSync(fileURLToPath(new URL('../plugin/account-service.cjs', import.meta.url)), 'utf8')

function serviceWithRecordedFetch() {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
  const service = createAccountService({
    supabaseUrl: 'https://project.example.test',
    anonKey: 'public-anon-key',
    accountApiUrl: '',
    checkoutHosts: [],
    oauthProviders: [],
    callbackUrl: 'http://127.0.0.1:18832/auth/callback',
    recoveryCallbackUrl: 'http://127.0.0.1:18832/auth/recovery',
    confirmCallbackUrl: 'http://127.0.0.1:18832/auth/confirm',
    fetchImpl,
    readSession: () => '',
    writeSession: () => {},
    clearSession: () => {},
    readCheckoutState: () => '',
    writeCheckoutState: () => {},
    clearCheckoutState: () => {},
    openExternal: () => {},
  })
  return { service, calls }
}

// The renderer and the Electron main process cannot import from each other, so
// the minimum is written twice. This is the guard that keeps the copies equal.
test('the plugin service mirrors the renderer minimum password length', () => {
  const declared = /const MIN_PASSWORD_LENGTH = (\d+);/.exec(SERVICE_SOURCE)
  assert.ok(declared, 'plugin/account-service.cjs must declare MIN_PASSWORD_LENGTH')
  assert.equal(
    Number(declared[1]),
    MIN_PASSWORD_LENGTH,
    'plugin/account-service.cjs and src/core/account.ts disagree about the minimum password length',
  )
})

test('no password guidance quotes a length other than the shared minimum', () => {
  const quoted = [...SERVICE_SOURCE.matchAll(/at least (\d+) characters/g)].map((match) => Number(match[1]))
  assert.deepEqual(quoted, [], `hardcoded password lengths left in prose: ${quoted.join(', ')}`)
})

test('sign-up rejects a password below the minimum without reaching the network', async () => {
  const { service, calls } = serviceWithRecordedFetch()
  const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)

  const result = await service.signUp({ email: 'new@example.test', password: short })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalid-input')
  assert.match(result.error.message, new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`))
  assert.equal(calls.length, 0, 'a password the policy forbids must not be sent anywhere')
})

// The regression this file exists for: raising the minimum must never lock out
// an account whose password was chosen under the old one. The server still
// accepts it; the plugin must still be willing to ask.
test('sign-in accepts a password shorter than the current minimum', async () => {
  const { service, calls } = serviceWithRecordedFetch()
  const legacy = 'a'.repeat(MIN_PASSWORD_LENGTH - 2)

  const result = await service.signIn({ email: 'existing@example.test', password: legacy })

  assert.equal(result.ok, false, 'the stub backend answers 500, so this is not a successful sign-in')
  assert.notEqual(result.error.code, 'invalid-input', 'a pre-existing password must not be refused before it is tried')
  assert.equal(calls.length, 1, 'sign-in must reach the token endpoint')
  assert.match(calls[0].url, /\/auth\/v1\/token/)
})

test('sign-in still refuses an empty password', async () => {
  const { service, calls } = serviceWithRecordedFetch()

  const result = await service.signIn({ email: 'existing@example.test', password: '' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalid-input')
  assert.equal(calls.length, 0)
})

test('password recovery holds new passwords to the minimum', async () => {
  const { service, calls } = serviceWithRecordedFetch()
  const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)

  const result = await service.completePasswordRecovery({
    attemptId: '00000000-0000-4000-8000-000000000000',
    password: short,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'invalid-input')
  assert.equal(calls.length, 0)
})
