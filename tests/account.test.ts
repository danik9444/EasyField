import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  canShowAdminBilling,
  formatCreditMicros,
  formatMoneyMicros,
  mapAccountSubscriptionStatus,
  parseWholeCreditInput,
  subscriptionAllowsTopUps,
  totalCreditMicros,
  type AccountAdminBillingSnapshot,
  type AccountCreditBalanceSnapshot,
  type AccountSession,
} from '../src/core/account.ts'
import { CREDIT_MICROS_PER_CREDIT, MONEY_MICROS_PER_USD } from '../src/data/subscriptions.ts'

const measuredAtMs = Date.UTC(2026, 6, 15)
const accountScreenSource = readFileSync(new URL('../src/screens/Account.tsx', import.meta.url), 'utf8')
const accountStylesSource = readFileSync(new URL('../src/account.css', import.meta.url), 'utf8')

test('account balance keeps expiring and purchased credits separate while deriving the total', () => {
  const balance: AccountCreditBalanceSnapshot = {
    subscriptionCreditMicros: 1_250 * CREDIT_MICROS_PER_CREDIT,
    subscriptionExpiresAtMs: Date.UTC(2026, 7, 1),
    purchasedCreditMicros: 400 * CREDIT_MICROS_PER_CREDIT,
    otherCreditMicros: 25 * CREDIT_MICROS_PER_CREDIT,
    measuredAtMs,
  }
  assert.equal(totalCreditMicros(balance), 1_675 * CREDIT_MICROS_PER_CREDIT)
  assert.equal(formatCreditMicros(balance.subscriptionCreditMicros), '1,250')
  assert.equal(formatMoneyMicros(12_500_000, { minimumFractionDigits: 2 }), '$12.50')
})

test('whole-credit input is exact and rejects decimal, zero and unsafe values', () => {
  assert.deepEqual(parseWholeCreditInput(' 1,250 '), {
    ok: true,
    wholeCredits: 1_250,
    amountCreditMicros: 1_250 * CREDIT_MICROS_PER_CREDIT,
  })
  assert.deepEqual(parseWholeCreditInput(''), { ok: false, reason: 'empty' })
  assert.deepEqual(parseWholeCreditInput('12.5'), { ok: false, reason: 'invalid' })
  assert.deepEqual(parseWholeCreditInput('0'), { ok: false, reason: 'unsafe' })
  assert.deepEqual(parseWholeCreditInput(String(Number.MAX_SAFE_INTEGER)), { ok: false, reason: 'unsafe' })
})

test('raw platform billing is gated only by the server-asserted admin role', () => {
  const snapshot: AccountAdminBillingSnapshot = {
    upstreamBalanceCreditMicros: 90_000 * CREDIT_MICROS_PER_CREDIT,
    latestRawCostMoneyMicros: 35_000,
    latestRawCostCurrencyCode: 'USD',
    measuredAtMs,
  }
  const signedOut: AccountSession = { status: 'signed-out' }
  const regular: AccountSession = {
    status: 'signed-in',
    accountId: 'account-user',
    email: 'editor@example.com',
    emailVerified: true,
    platformRole: 'customer',
  }
  const admin: AccountSession = {
    status: 'signed-in',
    accountId: 'account-admin',
    email: 'admin@example.com',
    emailVerified: true,
    platformRole: 'admin',
  }
  const support: AccountSession = {
    status: 'signed-in',
    accountId: 'account-support',
    email: 'support@example.com',
    emailVerified: true,
    platformRole: 'support',
  }

  assert.equal(canShowAdminBilling(signedOut, snapshot), false)
  assert.equal(canShowAdminBilling(regular, snapshot), false)
  assert.equal(canShowAdminBilling(support, snapshot), false)
  assert.equal(canShowAdminBilling(admin, null), false)
  assert.equal(canShowAdminBilling(admin, snapshot), true)
  assert.equal(snapshot.latestRawCostMoneyMicros, 0.035 * MONEY_MICROS_PER_USD)
})

test('invalid authoritative balances throw instead of being silently clamped', () => {
  assert.throws(() => totalCreditMicros({
    subscriptionCreditMicros: -1,
    subscriptionExpiresAtMs: null,
    purchasedCreditMicros: 0,
    otherCreditMicros: 0,
    measuredAtMs,
  }), /non-negative safe integer/i)
})

test('database subscription statuses are explicitly mapped into UI statuses', () => {
  assert.equal(mapAccountSubscriptionStatus('past_due'), 'past-due')
  assert.equal(mapAccountSubscriptionStatus('active'), 'active')
  assert.throws(
    () => mapAccountSubscriptionStatus('unknown' as never),
    /unsupported subscription status/i,
  )
})

test('plan-priced top-ups require an active, unexpired entitlement', () => {
  const nowMs = Date.UTC(2026, 6, 15, 12)
  const base = {
    planId: 'creator' as const,
    billingInterval: 'monthly' as const,
    currentPeriodEndMs: Date.UTC(2026, 7, 15),
    entitlementEndsAtMs: Date.UTC(2026, 7, 15),
    cancelAtPeriodEnd: false,
  }
  assert.equal(subscriptionAllowsTopUps(null, nowMs), false)
  assert.equal(subscriptionAllowsTopUps({ ...base, status: 'incomplete' }, nowMs), false)
  assert.equal(subscriptionAllowsTopUps({ ...base, status: 'past-due' }, nowMs), false)
  assert.equal(subscriptionAllowsTopUps({ ...base, status: 'active' }, nowMs), true)
  assert.equal(subscriptionAllowsTopUps({ ...base, status: 'trialing' }, nowMs), true)
  assert.equal(subscriptionAllowsTopUps({ ...base, status: 'active', entitlementEndsAtMs: nowMs }, nowMs), false)
  assert.equal(subscriptionAllowsTopUps({ ...base, status: 'trialing', entitlementEndsAtMs: null }, nowMs), false)
  assert.throws(() => subscriptionAllowsTopUps({ ...base, status: 'active' }, Number.NaN), /current time/i)
})

test('account controls keep their semantic names and persist auto-reload disable', () => {
  assert.match(accountScreenSource, /<h1>Plans & credits<\/h1>/)
  assert.match(accountScreenSource, /aria-label=\{policy\.enabled \? 'Turn off auto-reload' : 'Turn on auto-reload'\}/)
  assert.match(accountScreenSource, /onRequestSaveAutoReload\(disabledPolicy\)/)
  assert.match(accountScreenSource, /balances\.otherCreditMicros > 0/)
})

test('account stylesheet does not render supporting text below 11px', () => {
  const sizes = [...accountStylesSource.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]))
  assert.ok(sizes.length > 0)
  assert.equal(sizes.every((size) => size >= 11), true)
  assert.match(accountStylesSource, /--account-muted:\s*#c0c0cc/)
  assert.match(accountStylesSource, /--account-subtle:\s*#a6a6b3/)
})
