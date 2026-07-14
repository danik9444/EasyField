import {
  CREDIT_MICROS_PER_CREDIT,
  MONEY_MICROS_PER_USD,
  type BillingInterval,
  type CreditMicros,
  type MoneyMicros,
  type SubscriptionPlanId,
} from '../data/subscriptions.ts'

export type AccountPlatformRole = 'customer' | 'support' | 'admin'
export type AccountAuthMode = 'sign-in' | 'sign-up'
export type AccountSubscriptionStatus = 'active' | 'trialing' | 'past-due' | 'paused' | 'canceled' | 'expired' | 'incomplete'
export type AccountDatabaseSubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled' | 'expired' | 'incomplete'

export type AccountSession =
  | { status: 'signed-out' }
  | {
      status: 'signed-in'
      accountId: string
      email: string
      displayName?: string
      emailVerified: boolean
      /** Must be asserted by the server. Never infer this value from the email in the client. */
      platformRole: AccountPlatformRole
    }

export interface AccountSubscriptionSnapshot {
  planId: SubscriptionPlanId
  billingInterval: BillingInterval
  status: AccountSubscriptionStatus
  currentPeriodEndMs: number | null
  /** Authoritative service entitlement boundary. Do not infer access from the billing period alone. */
  entitlementEndsAtMs: number | null
  cancelAtPeriodEnd: boolean
}

export interface AccountCreditBalanceSnapshot {
  subscriptionCreditMicros: CreditMicros
  subscriptionExpiresAtMs: number | null
  purchasedCreditMicros: CreditMicros
  /** Promotional, manual-adjustment, or other server-authorized credit lots. */
  otherCreditMicros: CreditMicros
  measuredAtMs: number
}

/**
 * Diagnostic billing values that are never intended for a regular account.
 * The caller must obtain this snapshot from an authenticated admin endpoint.
 */
export interface AccountAdminBillingSnapshot {
  upstreamBalanceCreditMicros: CreditMicros | null
  latestRawCostMoneyMicros: MoneyMicros | null
  latestRawCostCurrencyCode: string | null
  measuredAtMs: number
}

export interface EmailPasswordAuthRequest {
  mode: AccountAuthMode
  email: string
  password: string
}

export interface PlanCheckoutRequest {
  planId: SubscriptionPlanId
  billingInterval: BillingInterval
}

export interface TopUpCheckoutRequest {
  planId: SubscriptionPlanId
  amountCreditMicros: CreditMicros
}

export type WholeCreditParseResult =
  | { ok: true; amountCreditMicros: CreditMicros; wholeCredits: number }
  | { ok: false; reason: 'empty' | 'invalid' | 'unsafe' }

function assertNonNegativeMicros(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer in micro-units.`)
  }
}

export function totalCreditMicros(balance: AccountCreditBalanceSnapshot): CreditMicros {
  assertNonNegativeMicros(balance.subscriptionCreditMicros, 'Subscription balance')
  assertNonNegativeMicros(balance.purchasedCreditMicros, 'Purchased balance')
  assertNonNegativeMicros(balance.otherCreditMicros, 'Other balance')
  const total = balance.subscriptionCreditMicros + balance.purchasedCreditMicros + balance.otherCreditMicros
  if (!Number.isSafeInteger(total)) throw new RangeError('Total credit balance exceeds the safe integer range.')
  return total
}

/** Maps the database's snake_case status vocabulary into the UI contract. */
export function mapAccountSubscriptionStatus(status: AccountDatabaseSubscriptionStatus): AccountSubscriptionStatus {
  switch (status) {
    case 'active': return 'active'
    case 'trialing': return 'trialing'
    case 'past_due': return 'past-due'
    case 'paused': return 'paused'
    case 'canceled': return 'canceled'
    case 'expired': return 'expired'
    case 'incomplete': return 'incomplete'
    default: {
      const unsupportedStatus: never = status
      throw new RangeError(`Unsupported subscription status: ${String(unsupportedStatus)}`)
    }
  }
}

export function parseWholeCreditInput(value: string): WholeCreditParseResult {
  const normalized = value.trim().replaceAll(',', '')
  if (!normalized) return { ok: false, reason: 'empty' }
  if (!/^\d+$/.test(normalized)) return { ok: false, reason: 'invalid' }
  const wholeCredits = Number(normalized)
  if (!Number.isSafeInteger(wholeCredits) || wholeCredits <= 0) return { ok: false, reason: 'unsafe' }
  const amountCreditMicros = wholeCredits * CREDIT_MICROS_PER_CREDIT
  if (!Number.isSafeInteger(amountCreditMicros)) return { ok: false, reason: 'unsafe' }
  return { ok: true, wholeCredits, amountCreditMicros }
}

export function wholeCreditsFromMicros(value: CreditMicros): number {
  assertNonNegativeMicros(value, 'Credit amount')
  return Math.floor(value / CREDIT_MICROS_PER_CREDIT)
}

export function formatCreditMicros(value: CreditMicros): string {
  assertNonNegativeMicros(value, 'Credit amount')
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value / CREDIT_MICROS_PER_CREDIT)
}

export function formatMoneyMicros(value: MoneyMicros, options: { currency?: string; minimumFractionDigits?: number; maximumFractionDigits?: number } = {}): string {
  assertNonNegativeMicros(value, 'Money amount')
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: options.currency ?? 'USD',
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(value / MONEY_MICROS_PER_USD)
}

export function formatAccountDate(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || !Number.isFinite(new Date(epochMs).getTime())) {
    throw new RangeError('Account date must be a valid non-negative epoch timestamp.')
  }
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(epochMs)
}

export function canShowAdminBilling(
  session: AccountSession,
  snapshot: AccountAdminBillingSnapshot | null | undefined,
): snapshot is AccountAdminBillingSnapshot {
  return session.status === 'signed-in' && session.platformRole === 'admin' && snapshot != null
}

/** Extra-credit pricing belongs to an active paid plan, never a plan-card preview. */
export function subscriptionAllowsTopUps(
  subscription: AccountSubscriptionSnapshot | null | undefined,
  nowMs = Date.now(),
): subscription is AccountSubscriptionSnapshot {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('Current time must be a valid non-negative epoch timestamp.')
  }
  return subscription != null
    && (subscription.status === 'active' || subscription.status === 'trialing')
    && subscription.entitlementEndsAtMs != null
    && Number.isSafeInteger(subscription.entitlementEndsAtMs)
    && subscription.entitlementEndsAtMs > nowMs
}
