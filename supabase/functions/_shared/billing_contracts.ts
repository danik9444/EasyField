/**
 * Provider-neutral billing contracts.
 *
 * These types deliberately keep provider credentials, provider-specific
 * document codes, and raw card data out of the application contract.
 */

export type BillingProviderId = string;

export interface MoneyAmount {
  /** Upper-case ISO 4217 code. */
  readonly currency: string;
  /** Integer amount in the currency's smallest unit. */
  readonly minorUnits: number;
  /** Must equal the ISO 4217 exponent for currency. */
  readonly exponent: number;
}

export interface BillingCustomer {
  /** Stable EasyField/Supabase user ID. Never an email address. */
  readonly customerId: string;
  readonly name: string;
  readonly email: string;
  readonly providerCustomerId?: string;
  readonly taxId?: string;
  readonly address?: string;
  readonly city?: string;
  readonly postalCode?: string;
  readonly countryCode?: string;
  readonly phone?: string;
}

export interface HostedPaymentRequest {
  /** Persisted locally before any provider call. */
  readonly operationId: string;
  readonly amount: MoneyAmount;
  readonly description: string;
  readonly customer: BillingCustomer;
  readonly successUrl: string;
  readonly failureUrl: string;
  readonly notificationUrl: string;
}

export interface HostedPaymentSession {
  readonly provider: BillingProviderId;
  readonly operationId: string;
  readonly checkoutUrl: string;
  readonly state: "created";
}

export interface SavedPaymentMethod {
  readonly provider: BillingProviderId;
  readonly id: string;
  readonly providerCustomerId?: string;
  readonly displayName: string;
  readonly lastFour: string;
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
  readonly state: "active" | "inactive" | "expired" | "unknown";
  readonly supportedCurrencies: readonly string[];
}

export interface SavedPaymentMethodSearch {
  /** Server-resolved provider customer key. User-facing searches must be scoped. */
  readonly providerCustomerId: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface SavedPaymentMethodPage {
  readonly items: readonly SavedPaymentMethod[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pages: number;
}

export interface SavedPaymentMethodChargeRequest {
  /** Stable renewal-attempt ID, persisted before calling the provider. */
  readonly operationId: string;
  readonly paymentMethodId: string;
  readonly amount: MoneyAmount;
  readonly description: string;
  readonly notificationUrl: string;
}

interface ChargeResultBase {
  readonly provider: BillingProviderId;
  readonly operationId: string;
  /** Provider token charges must never be retried automatically. */
  readonly automaticRetryAllowed: false;
}

export interface SuccessfulChargeResult extends ChargeResultBase {
  readonly state: "succeeded";
  readonly providerDocumentId: string;
  readonly providerTransactionId?: string;
}

export interface DefinitiveChargeFailure extends ChargeResultBase {
  readonly state: "failed";
  readonly definitive: true;
  readonly reason: string;
  readonly providerStatus?: number;
}

export interface AmbiguousChargeResult extends ChargeResultBase {
  readonly state: "unknown";
  readonly definitive: false;
  readonly reason:
    | "transport_error"
    | "provider_timeout"
    | "provider_unavailable"
    | "ambiguous_http_status"
    | "invalid_success_response";
  /** Reconcile against webhooks/provider records before a human retries. */
  readonly nextAction: "reconcile_before_retry";
  readonly providerStatus?: number;
}

export type SavedPaymentMethodChargeResult =
  | SuccessfulChargeResult
  | DefinitiveChargeFailure
  | AmbiguousChargeResult;

export interface VerifiedBillingWebhook<TEvent = unknown> {
  readonly provider: BillingProviderId;
  readonly webhookId: string;
  readonly deliveryId: string;
  readonly correlationId: string;
  readonly topic: string;
  readonly emittedAt: string;
  readonly receivedAt: string;
  /** Provider event ID from the signed body when supplied by the provider. */
  readonly providerEventId?: string;
  /** SHA-256 of the exact signed body. Always deduplicate this value. */
  readonly signedBodySha256: string;
  readonly event: TEvent;
}

export type SubscriptionInterval = "month" | "year";

export type BillingSubscriptionState =
  | "pending"
  | "active"
  | "past_due"
  | "canceled";

/**
 * Our database owns this lifecycle. A payment adapter must not pretend that a
 * provider supports subscriptions when it only supports one-off charges.
 */
export interface BillingSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly planId: string;
  readonly interval: SubscriptionInterval;
  readonly amount: MoneyAmount;
  readonly paymentMethodId: string;
  readonly state: BillingSubscriptionState;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly nextChargeAt: string;
}

export type RenewalAttemptState =
  | "scheduled"
  | "charging"
  | "succeeded"
  | "failed"
  | "unknown";

export interface RenewalAttempt {
  readonly id: string;
  readonly subscriptionId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly amount: MoneyAmount;
  readonly state: RenewalAttemptState;
  readonly providerDocumentId?: string;
  readonly providerTransactionId?: string;
  readonly failureReason?: string;
}
