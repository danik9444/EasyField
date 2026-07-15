import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_RELOAD_DISABLED,
  CREDIT_MICROS_PER_CREDIT,
  MINIMUM_TOP_UP_MONEY_MICROS,
  MONEY_MICROS_PER_USD,
  PARTNER_MEMBERSHIP,
  PROPOSED_PLAN_CHANGE_DEFAULTS,
  SUBSCRIPTION_PLAN_IDS,
  SUBSCRIPTION_PLANS,
  calculateTopUpMoneyMicros,
  calculateTopUpRawMoneyMicros,
  createPurchasedCreditLot,
  createSubscriptionGrantSchedule,
  isModelEntitled,
  minimumTopUpCreditMicros,
  quoteTopUp,
  validateAutoReloadPolicy,
} from '../src/data/subscriptions.ts'

test('Partner is a separate one-time lifetime product with no included credits', () => {
  assert.deepEqual(PARTNER_MEMBERSHIP, {
    id: 'partner_lifetime',
    name: 'Partner',
    oneTimeChargeMoneyMicros: 999_000_000,
    includedCreditMicros: 0,
    directCreditMoneyMicrosPerCredit: 5_000,
    lifetimeAccess: true,
    allModelsIncluded: true,
  })
  assert.equal(Object.hasOwn(SUBSCRIPTION_PLANS, PARTNER_MEMBERSHIP.id), false)
})

test('the four plans use exact integer-micro prices, grants and top-up rates', () => {
  assert.deepEqual(SUBSCRIPTION_PLAN_IDS, ['starter', 'creator', 'pro', 'studio'])
  assert.deepEqual(
    SUBSCRIPTION_PLAN_IDS.map((id) => {
      const plan = SUBSCRIPTION_PLANS[id]
      return [
        plan.name,
        plan.monthlyChargeMoneyMicros,
        plan.annualMonthlyEquivalentMoneyMicros,
        plan.annualChargeMoneyMicros,
        plan.monthlyGrantCreditMicros,
        plan.topUpMoneyMicrosPerCredit,
      ]
    }),
    [
      ['Starter', 15_000_000, 12_000_000, 144_000_000, 800_000_000, 20_000],
      ['Creator', 30_000_000, 25_000_000, 300_000_000, 2_000_000_000, 15_000],
      ['Pro', 60_000_000, 49_000_000, 588_000_000, 5_000_000_000, 12_000],
      ['Studio', 129_000_000, 99_000_000, 1_188_000_000, 12_000_000_000, 10_000],
    ],
  )

  for (const plan of Object.values(SUBSCRIPTION_PLANS)) {
    assert.equal(plan.annualChargeMoneyMicros, plan.annualMonthlyEquivalentMoneyMicros * 12)
    for (const value of [
      plan.monthlyChargeMoneyMicros,
      plan.annualChargeMoneyMicros,
      plan.annualMonthlyEquivalentMoneyMicros,
      plan.monthlyGrantCreditMicros,
      plan.topUpMoneyMicrosPerCredit,
    ]) assert.equal(Number.isSafeInteger(value), true)
  }
})

test('top-up quotes use integer micros and enforce the ten-dollar minimum', () => {
  assert.equal(calculateTopUpMoneyMicros('starter', 1_000 * CREDIT_MICROS_PER_CREDIT), 20 * MONEY_MICROS_PER_USD)
  assert.equal(calculateTopUpMoneyMicros('creator', 1_000 * CREDIT_MICROS_PER_CREDIT), 15 * MONEY_MICROS_PER_USD)
  assert.equal(calculateTopUpMoneyMicros('pro', 1_000 * CREDIT_MICROS_PER_CREDIT), 12 * MONEY_MICROS_PER_USD)
  assert.equal(calculateTopUpMoneyMicros('studio', 1_000 * CREDIT_MICROS_PER_CREDIT), 10 * MONEY_MICROS_PER_USD)

  assert.deepEqual(
    SUBSCRIPTION_PLAN_IDS.map(minimumTopUpCreditMicros),
    [500, 667, 834, 1_000].map((credits) => credits * CREDIT_MICROS_PER_CREDIT),
  )
  const tooSmall = quoteTopUp('studio', 999 * CREDIT_MICROS_PER_CREDIT)
  assert.equal(tooSmall.chargeMoneyMicros, 9_990_000)
  assert.equal(tooSmall.minimumChargeMoneyMicros, MINIMUM_TOP_UP_MONEY_MICROS)
  assert.equal(tooSmall.meetsMinimum, false)
  assert.equal(quoteTopUp('studio', 1_000 * CREDIT_MICROS_PER_CREDIT).meetsMinimum, true)

  const partialCent = quoteTopUp('pro', 834 * CREDIT_MICROS_PER_CREDIT)
  assert.equal(partialCent.rawChargeMoneyMicros, 10_008_000)
  assert.equal(partialCent.chargeMoneyMicros, 10_010_000)
  assert.equal(partialCent.meetsMinimum, true)
  assert.equal(calculateTopUpRawMoneyMicros('pro', 833 * CREDIT_MICROS_PER_CREDIT), 9_996_000)
  assert.equal(calculateTopUpMoneyMicros('pro', 833 * CREDIT_MICROS_PER_CREDIT), 10_000_000)
  assert.equal(quoteTopUp('pro', 833 * CREDIT_MICROS_PER_CREDIT).meetsMinimum, false)
})

test('subscription grants expire monthly and annual billing creates twelve monthly windows', () => {
  const start = Date.UTC(2028, 0, 31, 12, 30)
  const monthly = createSubscriptionGrantSchedule('creator', 'monthly', start)
  assert.equal(monthly.length, 1)
  assert.equal(monthly[0].availableAtMs, start)
  assert.equal(monthly[0].expiresAtMs, Date.UTC(2028, 1, 29, 12, 30))
  assert.equal(monthly[0].amountCreditMicros, 2_000 * CREDIT_MICROS_PER_CREDIT)

  const annual = createSubscriptionGrantSchedule('pro', 'annual', start)
  assert.equal(annual.length, 12)
  assert.equal(annual[0].availableAtMs, start)
  assert.equal(annual[0].expiresAtMs, annual[1].availableAtMs)
  assert.equal(annual[11].availableAtMs, Date.UTC(2028, 11, 31, 12, 30))
  assert.equal(annual[11].expiresAtMs, Date.UTC(2029, 0, 31, 12, 30))
  assert.ok(annual.every((grant) => grant.expiresAtMs > grant.availableAtMs))
  assert.ok(annual.every((grant) => grant.amountCreditMicros === 5_000 * CREDIT_MICROS_PER_CREDIT))
})

test('purchased credits are explicitly non-expiring', () => {
  const purchasedAt = Date.UTC(2026, 6, 14)
  const lot = createPurchasedCreditLot(2_000 * CREDIT_MICROS_PER_CREDIT, purchasedAt)
  assert.equal(lot.source, 'purchased-top-up')
  assert.equal(lot.remainingCreditMicros, 2_000 * CREDIT_MICROS_PER_CREDIT)
  assert.equal(lot.availableAtMs, purchasedAt)
  assert.equal(lot.expiresAtMs, null)
})

test('Starter blocks only exact regular Seedance 2 identities', () => {
  assert.equal(isModelEntitled('starter', 'Seedance 2'), false)
  assert.equal(isModelEntitled('starter', ' seedance-2 '), false)
  assert.equal(isModelEntitled('starter', { id: 'bytedance/seedance-2', name: 'Seedance 2' }), false)

  assert.equal(isModelEntitled('starter', 'Seedance 2 Fast'), true)
  assert.equal(isModelEntitled('starter', 'Seedance 2 Mini'), true)
  assert.equal(isModelEntitled('starter', 'Seedance 2 regular preview'), true)
  assert.equal(isModelEntitled('starter', 'bytedance/seedance-2-fast'), true)
  assert.equal(isModelEntitled('creator', 'Seedance 2'), true)
})

test('auto-reload is optional and validates the plan top-up minimum', () => {
  assert.deepEqual(validateAutoReloadPolicy('studio', AUTO_RELOAD_DISABLED), [])
  assert.deepEqual(validateAutoReloadPolicy('studio', {
    enabled: true,
    triggerBalanceCreditMicros: 500 * CREDIT_MICROS_PER_CREDIT,
    topUpAmountCreditMicros: 1_000 * CREDIT_MICROS_PER_CREDIT,
  }), [])
  assert.match(validateAutoReloadPolicy('studio', {
    enabled: true,
    triggerBalanceCreditMicros: 500 * CREDIT_MICROS_PER_CREDIT,
    topUpAmountCreditMicros: 999 * CREDIT_MICROS_PER_CREDIT,
  })[0], /at least/i)
})

test('plan-change behavior remains explicitly proposed', () => {
  assert.equal(PROPOSED_PLAN_CHANGE_DEFAULTS.decisionStatus, 'proposed')
  assert.equal(PROPOSED_PLAN_CHANGE_DEFAULTS.downgradeTiming, 'next-renewal')
  assert.equal(PROPOSED_PLAN_CHANGE_DEFAULTS.purchasedCredits, 'preserve-without-expiry')
})
