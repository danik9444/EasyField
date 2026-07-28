import type {
  AccountCreditBalanceSnapshot,
  AccountPartnerEntitlementSnapshot,
  AccountPrivilegedBillingSnapshot,
  AccountSession,
  AccountSubscriptionSnapshot,
} from './account'
import type {
  AutoReloadPolicy,
  BillingInterval,
  CreditMicros,
  SubscriptionPlanId,
} from '../data/subscriptions'

/**
 * Renderer-safe account contracts. Authentication credentials, provider keys,
 * checkout URLs and payment references deliberately have no representation in
 * this module; Electron Main owns those values and returns display state only.
 */
export type AccountErrorCode =
  | 'invalid-input'
  | 'invalid-credentials'
  | 'email-unverified'
  | 'not-authenticated'
  | 'not-entitled'
  | 'rate-limited'
  | 'network'
  | 'service-unavailable'
  | 'checkout-unavailable'
  | 'oauth-cancelled'
  | 'oauth-expired'
  | 'oauth-in-progress'
  | 'recovery-in-progress'
  | 'internal'

export interface AccountBridgeError {
  code: AccountErrorCode
  message: string
  retryable: boolean
}

export type AccountResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AccountBridgeError }

export type AccountOAuthProvider = 'google' | 'apple'

/** Renderer observation of account-service reachability, separate from configuration. */
export type AccountServiceHealth = 'checking' | 'available' | 'unavailable' | 'unconfigured'

export interface AccountCapabilities {
  /** Main has a verified account-service configuration for this installation. */
  accountConfigured: boolean
  /** Main has a verified checkout configuration; UI visibility is not authority. */
  billingConfigured: boolean
  /** Sanitized allowlist of social sign-in providers configured by Electron Main. */
  oauthProviders: AccountOAuthProvider[]
  /** The server currently permits this account to submit paid generation work. */
  generationAccess: boolean
  /** The server permits this account to manage a direct provider credential. */
  directProviderAllowed: boolean
  /** Customer plan/top-up checkout is live end-to-end, not merely configured locally. */
  customerCheckoutAvailable: boolean
  /** The one-time Partner checkout is live with reversal handling enabled. */
  partnerCheckoutAvailable: boolean
  /** Existing subscribers may open the hosted billing-management portal. */
  billingPortalAvailable: boolean
}

export type AccountPurchaseKind = 'subscription' | 'top-up' | 'partner'

/**
 * Sanitized local observation of the one durable hosted-checkout operation.
 * No checkout URL, merchant reference, payment identifier, or provider name
 * may cross into the renderer.
 */
export type AccountCheckoutStatus =
  | {
      state: 'pending'
      kind: AccountPurchaseKind
      startedAtMs: number
      expiresAtMs: number
    }
  | {
      state: 'ready-to-resume'
      kind: AccountPurchaseKind
      startedAtMs: number
      expiresAtMs: number
    }
  | {
      state: 'awaiting-reconciliation' | 'completed' | 'closed-unpaid'
      kind: AccountPurchaseKind
      updatedAtMs: number
    }

export interface AccountViewSnapshot {
  version: 1
  /** Monotonic per Main process. Older async responses must not replace newer state. */
  revision: number
  measuredAtMs: number
  session: AccountSession
  subscription: AccountSubscriptionSnapshot | null
  balances: AccountCreditBalanceSnapshot | null
  partnerEntitlement: AccountPartnerEntitlementSnapshot | null
  autoReloadPolicy: AutoReloadPolicy
  checkoutStatus: AccountCheckoutStatus | null
  /** Null unless the server asserts an admin or active Partner entitlement. */
  privilegedBilling: AccountPrivilegedBillingSnapshot | null
  capabilities: AccountCapabilities
}

export const UNAVAILABLE_ACCOUNT_SNAPSHOT: Readonly<AccountViewSnapshot> = Object.freeze({
  version: 1,
  revision: 0,
  measuredAtMs: 0,
  session: Object.freeze({ status: 'signed-out' as const }),
  subscription: null,
  balances: null,
  partnerEntitlement: null,
  autoReloadPolicy: Object.freeze({ enabled: false as const }),
  checkoutStatus: null,
  privilegedBilling: null,
  capabilities: Object.freeze({
    accountConfigured: false,
    billingConfigured: false,
    oauthProviders: [],
    generationAccess: false,
    directProviderAllowed: false,
    customerCheckoutAvailable: false,
    partnerCheckoutAvailable: false,
    billingPortalAvailable: false,
  }),
})

export function createUnavailableAccountSnapshot(): AccountViewSnapshot {
  return {
    ...UNAVAILABLE_ACCOUNT_SNAPSHOT,
    session: { status: 'signed-out' },
    autoReloadPolicy: { enabled: false },
    capabilities: { ...UNAVAILABLE_ACCOUNT_SNAPSHOT.capabilities },
  }
}

export type AccountAuthOutcome =
  | { state: 'authenticated'; snapshot: AccountViewSnapshot }
  | { state: 'verification-required'; email: string }
  | { state: 'signed-out'; snapshot: AccountViewSnapshot }

export interface AccountOAuthStart {
  state: 'browser-opened'
  attemptId: string
  expiresAtMs: number
}

/**
 * Sanitized terminal state for a browser OAuth attempt. Main never exposes the
 * authorization code, provider response, access token or refresh token.
 */
export interface AccountOAuthCompletion {
  attemptId: string
  state: 'authenticated' | 'cancelled' | 'expired' | 'failed'
  message: string
}

export interface AccountPasswordRecoveryStart {
  accepted: true
  attemptId: string
  expiresAtMs: number
}

/**
 * Renderer-safe state for the email recovery flow. Recovery codes and the
 * temporary recovery session remain in Electron Main.
 */
export interface AccountPasswordRecoveryCompletion {
  attemptId: string
  state: 'ready' | 'completed' | 'cancelled' | 'expired' | 'failed'
  message: string
}

export interface AccountAcceptedNotice {
  accepted: true
}

export type AccountCheckoutRequest =
  | { kind: 'subscription'; planId: SubscriptionPlanId; billingInterval: BillingInterval }
  | { kind: 'top-up'; amountCreditMicros: CreditMicros }
  | { kind: 'partner' }
  | { kind: 'billing-portal' }
  | { kind: 'upstream-top-up' }

export interface AccountCheckoutOpened {
  state: 'opened'
  /** Opaque EasyField intent identifier; never a provider payment reference. */
  intentId: string
}

export interface AccountBridgeApi {
  restore(): Promise<AccountResult<AccountViewSnapshot>>
  signIn(input: { email: string; password: string }): Promise<AccountResult<AccountAuthOutcome>>
  signUp(input: { email: string; password: string }): Promise<AccountResult<AccountAuthOutcome>>
  startOAuth(input: { provider: AccountOAuthProvider }): Promise<AccountResult<AccountOAuthStart>>
  signOut(): Promise<AccountResult<{ snapshot: AccountViewSnapshot }>>
  requestPasswordReset(input: { email: string }): Promise<AccountResult<AccountPasswordRecoveryStart>>
  completePasswordRecovery(input: { attemptId: string; password: string }): Promise<AccountResult<{ snapshot: AccountViewSnapshot }>>
  cancelPasswordRecovery(input: { attemptId: string }): Promise<AccountResult<AccountAcceptedNotice>>
  updateProfile(input: { displayName: string }): Promise<AccountResult<AccountViewSnapshot>>
  resendVerification(input: { email: string }): Promise<AccountResult<AccountAcceptedNotice>>
  getSnapshot(input?: { force?: boolean }): Promise<AccountResult<AccountViewSnapshot>>
  checkout(input: AccountCheckoutRequest): Promise<AccountResult<AccountCheckoutOpened>>
  resumeCheckout(): Promise<AccountResult<AccountCheckoutOpened>>
  saveAutoReload(input: { policy: AutoReloadPolicy }): Promise<AccountResult<AccountViewSnapshot>>
  onChanged(listener: (snapshot: AccountViewSnapshot) => void): () => void
  onOAuthCompleted(listener: (completion: AccountOAuthCompletion) => void): () => void
  onPasswordRecoveryCompleted(listener: (completion: AccountPasswordRecoveryCompletion) => void): () => void
}
