/**
 * Subscription and credit-ledger domain values.
 *
 * Money and credits are persisted as integer micro-units. Floating-point USD
 * and credit values may be derived for display, but must never be written back
 * as billing authority.
 */

export type MoneyMicros = number
export type CreditMicros = number
export type SubscriptionPlanId = 'starter' | 'creator' | 'pro' | 'studio'
export type BillingInterval = 'monthly' | 'annual'

export const MONEY_MICROS_PER_USD = 1_000_000
export const MONEY_MICROS_PER_USD_CENT = 10_000
export const CREDIT_MICROS_PER_CREDIT = 1_000_000
export const MINIMUM_TOP_UP_MONEY_MICROS: MoneyMicros = 10 * MONEY_MICROS_PER_USD

export interface SubscriptionPlan {
  id: SubscriptionPlanId
  name: 'Starter' | 'Creator' | 'Pro' | 'Studio'
  monthlyChargeMoneyMicros: MoneyMicros
  annualChargeMoneyMicros: MoneyMicros
  annualMonthlyEquivalentMoneyMicros: MoneyMicros
  monthlyGrantCreditMicros: CreditMicros
  topUpMoneyMicrosPerCredit: MoneyMicros
  modelAccessNote: string
  autoReloadAvailable: true
}

function definePlan(plan: SubscriptionPlan): Readonly<SubscriptionPlan> {
  return Object.freeze(plan)
}

export const SUBSCRIPTION_PLAN_IDS = ['starter', 'creator', 'pro', 'studio'] as const

export const SUBSCRIPTION_PLANS: Readonly<Record<SubscriptionPlanId, Readonly<SubscriptionPlan>>> = Object.freeze({
  starter: definePlan({
    id: 'starter',
    name: 'Starter',
    monthlyChargeMoneyMicros: 15 * MONEY_MICROS_PER_USD,
    annualChargeMoneyMicros: 144 * MONEY_MICROS_PER_USD,
    annualMonthlyEquivalentMoneyMicros: 12 * MONEY_MICROS_PER_USD,
    monthlyGrantCreditMicros: 800 * CREDIT_MICROS_PER_CREDIT,
    topUpMoneyMicrosPerCredit: 20_000,
    modelAccessNote: 'Seedance 2 Fast and Mini included; full Seedance 2 is not included.',
    autoReloadAvailable: true,
  }),
  creator: definePlan({
    id: 'creator',
    name: 'Creator',
    monthlyChargeMoneyMicros: 30 * MONEY_MICROS_PER_USD,
    annualChargeMoneyMicros: 300 * MONEY_MICROS_PER_USD,
    annualMonthlyEquivalentMoneyMicros: 25 * MONEY_MICROS_PER_USD,
    monthlyGrantCreditMicros: 2_000 * CREDIT_MICROS_PER_CREDIT,
    topUpMoneyMicrosPerCredit: 15_000,
    modelAccessNote: 'All verified model families included.',
    autoReloadAvailable: true,
  }),
  pro: definePlan({
    id: 'pro',
    name: 'Pro',
    monthlyChargeMoneyMicros: 60 * MONEY_MICROS_PER_USD,
    annualChargeMoneyMicros: 588 * MONEY_MICROS_PER_USD,
    annualMonthlyEquivalentMoneyMicros: 49 * MONEY_MICROS_PER_USD,
    monthlyGrantCreditMicros: 5_000 * CREDIT_MICROS_PER_CREDIT,
    topUpMoneyMicrosPerCredit: 12_000,
    modelAccessNote: 'All verified model families included.',
    autoReloadAvailable: true,
  }),
  studio: definePlan({
    id: 'studio',
    name: 'Studio',
    monthlyChargeMoneyMicros: 129 * MONEY_MICROS_PER_USD,
    annualChargeMoneyMicros: 1_188 * MONEY_MICROS_PER_USD,
    annualMonthlyEquivalentMoneyMicros: 99 * MONEY_MICROS_PER_USD,
    monthlyGrantCreditMicros: 12_000 * CREDIT_MICROS_PER_CREDIT,
    topUpMoneyMicrosPerCredit: 10_000,
    modelAccessNote: 'All verified model families included.',
    autoReloadAvailable: true,
  }),
})

export function getSubscriptionPlan(planId: SubscriptionPlanId): Readonly<SubscriptionPlan> {
  return SUBSCRIPTION_PLANS[planId]
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer in micro-units.`)
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  assertNonNegativeSafeInteger(value, label)
  if (value === 0) throw new RangeError(`${label} must be greater than zero.`)
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range.`)
  }
  return Number(value)
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('The divisor must be positive.')
  return (numerator + denominator - 1n) / denominator
}

/** Nominal plan-rate quote before payment-rail rounding. */
export function calculateTopUpRawMoneyMicros(
  planId: SubscriptionPlanId,
  amountCreditMicros: CreditMicros,
): MoneyMicros {
  assertPositiveSafeInteger(amountCreditMicros, 'Top-up credits')
  const rate = getSubscriptionPlan(planId).topUpMoneyMicrosPerCredit
  return safeNumber(
    ceilDiv(BigInt(amountCreditMicros) * BigInt(rate), BigInt(CREDIT_MICROS_PER_CREDIT)),
    'Top-up cost',
  )
}

/** Credit-card charges are denominated in cents; never round a charge down. */
export function roundMoneyMicrosUpToUsdCent(amountMoneyMicros: MoneyMicros): MoneyMicros {
  assertPositiveSafeInteger(amountMoneyMicros, 'Money amount')
  return safeNumber(
    ceilDiv(BigInt(amountMoneyMicros), BigInt(MONEY_MICROS_PER_USD_CENT))
      * BigInt(MONEY_MICROS_PER_USD_CENT),
    'Rounded charge',
  )
}

export function calculateTopUpMoneyMicros(
  planId: SubscriptionPlanId,
  amountCreditMicros: CreditMicros,
): MoneyMicros {
  return roundMoneyMicrosUpToUsdCent(calculateTopUpRawMoneyMicros(planId, amountCreditMicros))
}

/** Minimum purchasable amount, rounded up to a whole credit. */
export function minimumTopUpCreditMicros(planId: SubscriptionPlanId): CreditMicros {
  const rate = getSubscriptionPlan(planId).topUpMoneyMicrosPerCredit
  const wholeCredits = ceilDiv(BigInt(MINIMUM_TOP_UP_MONEY_MICROS), BigInt(rate))
  return safeNumber(wholeCredits * BigInt(CREDIT_MICROS_PER_CREDIT), 'Minimum top-up credits')
}

export interface TopUpQuote {
  planId: SubscriptionPlanId
  amountCreditMicros: CreditMicros
  rawChargeMoneyMicros: MoneyMicros
  chargeMoneyMicros: MoneyMicros
  minimumChargeMoneyMicros: MoneyMicros
  minimumAmountCreditMicros: CreditMicros
  meetsMinimum: boolean
}

export function quoteTopUp(planId: SubscriptionPlanId, amountCreditMicros: CreditMicros): TopUpQuote {
  const rawChargeMoneyMicros = calculateTopUpRawMoneyMicros(planId, amountCreditMicros)
  const chargeMoneyMicros = roundMoneyMicrosUpToUsdCent(rawChargeMoneyMicros)
  const minimumAmountCreditMicros = minimumTopUpCreditMicros(planId)
  return {
    planId,
    amountCreditMicros,
    rawChargeMoneyMicros,
    chargeMoneyMicros,
    minimumChargeMoneyMicros: MINIMUM_TOP_UP_MONEY_MICROS,
    minimumAmountCreditMicros,
    // Test the advertised per-credit price before cent rounding. A sub-$10
    // nominal purchase cannot cross the minimum merely because cards use cents.
    meetsMinimum: rawChargeMoneyMicros >= MINIMUM_TOP_UP_MONEY_MICROS,
  }
}

export type AutoReloadPolicy =
  | { enabled: false }
  | {
      enabled: true
      triggerBalanceCreditMicros: CreditMicros
      topUpAmountCreditMicros: CreditMicros
    }

export const AUTO_RELOAD_DISABLED: AutoReloadPolicy = Object.freeze({ enabled: false })

export function validateAutoReloadPolicy(
  planId: SubscriptionPlanId,
  policy: AutoReloadPolicy,
): readonly string[] {
  if (!policy.enabled) return []
  const errors: string[] = []
  try {
    assertNonNegativeSafeInteger(policy.triggerBalanceCreditMicros, 'Auto-reload trigger')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const quote = quoteTopUp(planId, policy.topUpAmountCreditMicros)
    if (!quote.meetsMinimum) {
      errors.push(`Auto-reload must purchase at least ${quote.minimumAmountCreditMicros} credit micros.`)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors
}

export interface SubscriptionCreditGrant {
  source: 'subscription-grant'
  planId: SubscriptionPlanId
  billingInterval: BillingInterval
  sequence: number
  amountCreditMicros: CreditMicros
  remainingCreditMicros: CreditMicros
  availableAtMs: number
  expiresAtMs: number
}

export interface PurchasedCreditLot {
  source: 'purchased-top-up'
  amountCreditMicros: CreditMicros
  remainingCreditMicros: CreditMicros
  availableAtMs: number
  expiresAtMs: null
}

export type CreditLot = SubscriptionCreditGrant | PurchasedCreditLot

function assertEpochMs(value: number, label: string): void {
  assertNonNegativeSafeInteger(value, label)
  if (!Number.isFinite(new Date(value).getTime())) throw new RangeError(`${label} must be a valid UTC timestamp.`)
}

/**
 * Adds calendar months in UTC while clamping end-of-month anchors. Calculating
 * every boundary from the original anchor avoids cumulative date drift.
 */
export function addUtcMonthsClamped(epochMs: number, months: number): number {
  assertEpochMs(epochMs, 'Grant anchor')
  if (!Number.isSafeInteger(months)) throw new RangeError('Month offset must be a safe integer.')
  const source = new Date(epochMs)
  const targetMonth = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1))
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate()
  return Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth(),
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )
}

/**
 * Monthly subscriptions receive one monthly grant window. Annual subscriptions
 * are billed once but still receive twelve distinct, expiring monthly grants.
 */
export function createSubscriptionGrantSchedule(
  planId: SubscriptionPlanId,
  billingInterval: BillingInterval,
  billingPeriodStartMs: number,
): readonly SubscriptionCreditGrant[] {
  assertEpochMs(billingPeriodStartMs, 'Billing period start')
  const plan = getSubscriptionPlan(planId)
  const count = billingInterval === 'annual' ? 12 : 1
  return Object.freeze(Array.from({ length: count }, (_, sequence) => Object.freeze({
    source: 'subscription-grant' as const,
    planId,
    billingInterval,
    sequence,
    amountCreditMicros: plan.monthlyGrantCreditMicros,
    remainingCreditMicros: plan.monthlyGrantCreditMicros,
    availableAtMs: addUtcMonthsClamped(billingPeriodStartMs, sequence),
    expiresAtMs: addUtcMonthsClamped(billingPeriodStartMs, sequence + 1),
  })))
}

export function createPurchasedCreditLot(
  amountCreditMicros: CreditMicros,
  purchasedAtMs: number,
): Readonly<PurchasedCreditLot> {
  assertPositiveSafeInteger(amountCreditMicros, 'Purchased credits')
  assertEpochMs(purchasedAtMs, 'Purchase time')
  return Object.freeze({
    source: 'purchased-top-up',
    amountCreditMicros,
    remainingCreditMicros: amountCreditMicros,
    availableAtMs: purchasedAtMs,
    expiresAtMs: null,
  })
}

export type ModelIdentity = string | { id?: string; name?: string }

const STARTER_BLOCKED_MODEL_NAMES = new Set(['seedance 2'])
const STARTER_BLOCKED_MODEL_IDS = new Set(['seedance-2', 'bytedance/seedance-2'])

function normalizeModelIdentity(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

/** Starter blocks only the regular Seedance 2 identity, never family matches. */
export function isModelEntitled(planId: SubscriptionPlanId, model: ModelIdentity): boolean {
  if (planId !== 'starter') return true
  if (typeof model === 'string') {
    const exact = normalizeModelIdentity(model)
    return !STARTER_BLOCKED_MODEL_NAMES.has(exact) && !STARTER_BLOCKED_MODEL_IDS.has(exact)
  }
  return !STARTER_BLOCKED_MODEL_NAMES.has(normalizeModelIdentity(model.name))
    && !STARTER_BLOCKED_MODEL_IDS.has(normalizeModelIdentity(model.id))
}

/**
 * Product defaults that are intentionally not accepted policy yet. Billing and
 * entitlement services must not execute them until an ADR revision accepts the
 * plan-change decision.
 */
export const PROPOSED_PLAN_CHANGE_DEFAULTS = Object.freeze({
  decisionStatus: 'proposed' as const,
  upgradeTiming: 'immediate-with-provider-proration' as const,
  downgradeTiming: 'next-renewal' as const,
  monthlyToAnnualTiming: 'immediate-with-provider-proration' as const,
  annualToMonthlyTiming: 'next-renewal' as const,
  existingSubscriptionGrants: 'retain-original-expiry' as const,
  purchasedCredits: 'preserve-without-expiry' as const,
})
