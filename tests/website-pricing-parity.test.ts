/**
 * The marketing site keeps its own plain-USD price table so it can build
 * without the plugin's micro-unit domain module. That duplication is why the
 * deployed site advertised Creator annual at $300 while the server and the
 * plugin both charged $240: nothing compared the two.
 *
 * These tests are that comparison. `src/data/subscriptions.ts` is the client
 * authority and is itself pinned against the server catalog by the migration
 * tests, so tying the website to it closes the last edge of the triangle.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREDIT_MICROS_PER_CREDIT,
  MONEY_MICROS_PER_USD,
  SUBSCRIPTION_PLAN_IDS,
  SUBSCRIPTION_PLANS,
} from '../src/data/subscriptions.ts'
import { pricingPlans } from '../website/src/content.ts'

test('the website lists exactly the plans the product sells, in catalog order', () => {
  assert.deepEqual(
    pricingPlans.map((plan) => plan.id),
    [...SUBSCRIPTION_PLAN_IDS],
    'a plan added, removed or reordered on one side only',
  )
})

test('every website price equals the charged price', () => {
  for (const planId of SUBSCRIPTION_PLAN_IDS) {
    const authority = SUBSCRIPTION_PLANS[planId]
    const advertised = pricingPlans.find((plan) => plan.id === planId)
    assert.ok(advertised, `${planId} is missing from the website price table`)

    assert.equal(advertised.name, authority.name, `${planId}: advertised name`)

    // Micro-units are the billing authority; the site may only restate them.
    // Asserting the conversion in this direction keeps a fractional-dollar
    // price from being silently rounded into an advertised whole number.
    assert.equal(
      advertised.monthly * MONEY_MICROS_PER_USD,
      authority.monthlyChargeMoneyMicros,
      `${planId}: advertised monthly price is not the charged monthly price`,
    )
    assert.equal(
      advertised.annual * MONEY_MICROS_PER_USD,
      authority.annualChargeMoneyMicros,
      `${planId}: advertised annual price is not the charged annual price`,
    )
    assert.equal(
      advertised.credits,
      (authority.monthlyGrantCreditMicros / CREDIT_MICROS_PER_CREDIT).toLocaleString('en-US'),
      `${planId}: advertised monthly credit grant`,
    )
  }
})

test('the per-month figure the site derives matches the published equivalent', () => {
  // App.tsx renders `Math.round(plan.annual / 12)` next to the annual price.
  // That derived number is what a customer compares against the monthly tier,
  // so it has to agree with the equivalent the plan catalog publishes rather
  // than merely being arithmetically defensible.
  for (const planId of SUBSCRIPTION_PLAN_IDS) {
    const authority = SUBSCRIPTION_PLANS[planId]
    const advertised = pricingPlans.find((plan) => plan.id === planId)
    assert.ok(advertised)

    assert.equal(
      Math.round(advertised.annual / 12) * MONEY_MICROS_PER_USD,
      authority.annualMonthlyEquivalentMoneyMicros,
      `${planId}: the site's rendered per-month equivalent contradicts the catalog`,
    )
  }
})

test('no advertised annual plan costs more than paying monthly', () => {
  // The same invariant tests/subscriptions.test.ts enforces on the catalog,
  // restated against the numbers a prospect actually reads. Creator once
  // failed this on both sides at $300 against $24/month.
  for (const plan of pricingPlans) {
    assert.ok(
      plan.annual < plan.monthly * 12,
      `${plan.id}: advertised annual $${plan.annual} is not below twelve monthly charges ($${plan.monthly * 12})`,
    )
  }
})
