/**
 * Pure validation and cryptographic helpers for the EasyField account edge
 * functions. This module intentionally contains no provider SDK, credential,
 * product price, or Deno runtime dependency.
 */

export const MAX_ACCOUNT_REQUEST_BYTES = 64 * 1024;
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
export const WEBHOOK_MAX_FUTURE_SKEW_SECONDS = 30;

const PLAN_IDS = new Set(["starter", "creator", "pro", "studio"]);
const BILLING_INTERVALS = new Set(["monthly", "annual"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type CheckoutInput =
  | {
      readonly kind: "subscription";
      readonly requestId: string;
      readonly planId: "starter" | "creator" | "pro" | "studio";
      readonly billingInterval: "monthly" | "annual";
    }
  | {
      readonly kind: "top-up";
      readonly requestId: string;
      readonly amountCreditMicros: number;
    }
  | { readonly kind: "partner"; readonly requestId: string }
  | { readonly kind: "billing-portal"; readonly requestId: string };

export type AutoReloadInput = {
  readonly requestId: string;
  readonly policy:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly triggerBalanceCreditMicros: number;
        readonly topUpAmountCreditMicros: number;
      };
};

export interface CheckoutStatusInput {
  readonly kind: "subscription" | "top-up" | "partner";
  readonly requestId: string;
}

export interface CheckoutAdapterConfig {
  readonly providerId: string;
  readonly endpoint: string;
  readonly token: string;
  readonly checkoutHosts: ReadonlySet<string>;
  readonly variants: Readonly<Record<string, string>>;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly webhookUrl: string;
}

export interface HostedCheckoutExpectation {
  readonly operationId: string;
  readonly purchaseKind: "subscription" | "top-up" | "partner" | "billing-portal";
  readonly offerKey: string;
  readonly variantId: string;
  readonly amount: {
    readonly currency: string;
    readonly minorUnits: number;
    readonly exponent: 2;
  } | null;
}

export interface VerifiedHostedCheckoutSession extends HostedCheckoutExpectation {
  readonly checkoutUrl: string;
  readonly checkoutReference: string;
  readonly expiresAt: string | null;
}

export interface NormalizedPaymentWebhook {
  readonly deliveryId: string;
  readonly paymentReference: string;
  readonly operationReference: string;
  readonly amount: {
    readonly currency: string;
    readonly minorUnits: number;
    readonly exponent: 2;
  };
  readonly subscriptionReference: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly reconciliationPayload: {
    readonly type: "payment/received";
    readonly id: string;
    readonly reconciliationState: "ready";
    readonly entitlementGrantAllowed: false;
    readonly issues: readonly [];
    readonly operationReference: string;
    readonly subscriptionReference: string | null;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
    readonly total: {
      readonly currency: string;
      readonly minorUnits: number;
      readonly exponent: 2;
    };
    readonly transactions: readonly [{
      readonly id: string;
      readonly amount: {
        readonly currency: string;
        readonly minorUnits: number;
        readonly exponent: 2;
      };
    }];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireOpaqueRef(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || !OPAQUE_REF_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}`);
  }
  return Number(value);
}

function requireHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an HTTPS URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError(`${label} must be an HTTPS URL without credentials or a fragment`);
  }
  return parsed.toString();
}

export function parseBearerToken(header: string | null): string {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header ?? "");
  if (!match || match[1].length > 16_384) throw new TypeError("Missing or invalid bearer token");
  return match[1];
}

export function parseCheckoutInput(value: unknown): CheckoutInput {
  if (!isRecord(value)) throw new TypeError("Checkout request must be an object");
  const kind = value.kind;
  const requestId = requireUuid(value.requestId, "requestId");
  if (kind === "subscription") {
    if (!exactKeys(value, ["kind", "requestId", "planId", "billingInterval"])) {
      throw new TypeError("Checkout request contains unknown fields");
    }
    if (typeof value.planId !== "string" || !PLAN_IDS.has(value.planId)) {
      throw new TypeError("Unknown subscription plan");
    }
    if (typeof value.billingInterval !== "string" || !BILLING_INTERVALS.has(value.billingInterval)) {
      throw new TypeError("Unknown billing interval");
    }
    return {
      kind,
      requestId,
      planId: value.planId as "starter" | "creator" | "pro" | "studio",
      billingInterval: value.billingInterval as "monthly" | "annual",
    };
  }
  if (kind === "top-up") {
    if (!exactKeys(value, ["kind", "requestId", "amountCreditMicros"])) {
      throw new TypeError("Checkout request contains unknown fields");
    }
    return {
      kind,
      requestId,
      amountCreditMicros: requireSafeInteger(value.amountCreditMicros, "amountCreditMicros", 1),
    };
  }
  if (kind === "partner" || kind === "billing-portal") {
    if (!exactKeys(value, ["kind", "requestId"])) {
      throw new TypeError("Checkout request contains unknown fields");
    }
    return { kind, requestId };
  }
  throw new TypeError("Unsupported checkout kind");
}

export function parseCheckoutStatusInput(value: unknown): CheckoutStatusInput {
  if (!isRecord(value) || !exactKeys(value, ["kind", "requestId"])) {
    throw new TypeError("Checkout status request must contain only kind and requestId");
  }
  if (!["subscription", "top-up", "partner"].includes(String(value.kind))) {
    throw new TypeError("Unknown checkout status kind");
  }
  return {
    kind: value.kind as CheckoutStatusInput["kind"],
    requestId: requireUuid(value.requestId, "requestId"),
  };
}

export function parseAutoReloadInput(value: unknown): AutoReloadInput {
  if (!isRecord(value) || !exactKeys(value, ["policy", "requestId"]) || !isRecord(value.policy)) {
    throw new TypeError("Auto-reload request is invalid");
  }
  const requestId = requireUuid(value.requestId, "requestId");
  const policy = value.policy;
  if (policy.enabled === false && exactKeys(policy, ["enabled"])) {
    return { requestId, policy: { enabled: false } };
  }
  if (
    policy.enabled === true
    && exactKeys(policy, ["enabled", "triggerBalanceCreditMicros", "topUpAmountCreditMicros"])
  ) {
    return {
      requestId,
      policy: {
        enabled: true,
        triggerBalanceCreditMicros: requireSafeInteger(
          policy.triggerBalanceCreditMicros,
          "triggerBalanceCreditMicros",
        ),
        topUpAmountCreditMicros: requireSafeInteger(
          policy.topUpAmountCreditMicros,
          "topUpAmountCreditMicros",
          1,
        ),
      },
    };
  }
  throw new TypeError("Auto-reload policy is invalid");
}

function parseHostSet(raw: string | undefined): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const host = item.trim().toLowerCase();
    if (/^[a-z0-9.-]+$/.test(host) && !host.startsWith(".") && !host.endsWith(".")) hosts.add(host);
  }
  if (hosts.size === 0) throw new TypeError("No checkout hosts are configured");
  return hosts;
}

function parseVariants(raw: string | undefined): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new TypeError("Checkout variants are not configured");
  }
  if (!isRecord(parsed)) throw new TypeError("Checkout variants are not configured");
  const variants: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^(subscription:(starter|creator|pro|studio):(monthly|annual)|top-up:(starter|creator|pro|studio)|partner|billing-portal)$/.test(key)) {
      throw new TypeError("Checkout variant key is invalid");
    }
    variants[key] = requireOpaqueRef(value, "Checkout variant");
  }
  if (Object.keys(variants).length === 0) throw new TypeError("Checkout variants are not configured");
  return Object.freeze(variants);
}

export function parseCheckoutAdapterConfig(env: Readonly<Record<string, string | undefined>>): CheckoutAdapterConfig {
  const providerId = env.EASYFIELD_BILLING_PROVIDER_ID?.trim().toLowerCase() ?? "";
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(providerId)) throw new TypeError("Billing provider is not configured");
  const token = env.EASYFIELD_CHECKOUT_API_TOKEN?.trim() ?? "";
  if (token.length < 16 || token.length > 8192) throw new TypeError("Checkout API credential is not configured");
  return Object.freeze({
    providerId,
    endpoint: requireHttpsUrl(env.EASYFIELD_CHECKOUT_API_URL, "Checkout API URL"),
    token,
    checkoutHosts: parseHostSet(env.EASYFIELD_CHECKOUT_HOSTS),
    variants: parseVariants(env.EASYFIELD_CHECKOUT_VARIANTS_JSON),
    successUrl: requireHttpsUrl(env.EASYFIELD_CHECKOUT_SUCCESS_URL, "Checkout success URL"),
    cancelUrl: requireHttpsUrl(env.EASYFIELD_CHECKOUT_CANCEL_URL, "Checkout cancel URL"),
    webhookUrl: requireHttpsUrl(env.EASYFIELD_BILLING_WEBHOOK_URL, "Billing webhook URL"),
  });
}

export function requireConfiguredCheckoutUrl(value: unknown, hosts: ReadonlySet<string>): string {
  const url = requireHttpsUrl(value, "Checkout URL");
  const parsed = new URL(url);
  if (!hosts.has(parsed.hostname.toLowerCase())) throw new TypeError("Checkout URL host is not allowlisted");
  return url;
}

export function verifyHostedCheckoutSession(
  value: unknown,
  expected: HostedCheckoutExpectation,
  hosts: ReadonlySet<string>,
): VerifiedHostedCheckoutSession {
  if (!isRecord(value)) throw new TypeError("Hosted checkout response is invalid");
  if (
    value.operationId !== expected.operationId
    || value.purchaseKind !== expected.purchaseKind
    || value.offerKey !== expected.offerKey
    || value.variantId !== expected.variantId
  ) throw new TypeError("Hosted checkout identity does not match the requested product");

  if (expected.amount === null) {
    if (value.amount !== null) throw new TypeError("Hosted checkout amount does not match the requested product");
  } else {
    if (
      !isRecord(value.amount)
      || value.amount.currency !== expected.amount.currency
      || value.amount.minorUnits !== expected.amount.minorUnits
      || value.amount.exponent !== expected.amount.exponent
    ) throw new TypeError("Hosted checkout amount does not match the requested product");
  }

  const checkoutUrl = requireConfiguredCheckoutUrl(value.checkoutUrl, hosts);
  const checkoutReference = requireOpaqueRef(value.checkoutReference, "Checkout reference");
  let expiresAt: string | null = null;
  if (value.expiresAt != null) {
    if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new TypeError("Hosted checkout expiry is invalid");
    }
    expiresAt = new Date(Date.parse(value.expiresAt)).toISOString();
  }
  return {
    checkoutUrl,
    checkoutReference,
    expiresAt,
    operationId: expected.operationId,
    purchaseKind: expected.purchaseKind,
    offerKey: expected.offerKey,
    variantId: expected.variantId,
    amount: expected.amount,
  };
}

function parseIsoInstant(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 64) throw new TypeError(`${label} is invalid`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} is invalid`);
  return new Date(millis).toISOString();
}

export function parsePaymentWebhook(value: unknown, deliveryId: string): NormalizedPaymentWebhook {
  if (!isRecord(value) || !exactKeys(value, [
    "type", "paymentReference", "operationReference", "amount",
    "subscriptionReference", "periodStart", "periodEnd",
  ])) throw new TypeError("Webhook body is invalid");
  if (value.type !== "payment.completed" || !isRecord(value.amount)) {
    throw new TypeError("Unsupported webhook event");
  }
  const normalizedDeliveryId = requireOpaqueRef(deliveryId, "Webhook delivery ID");
  const paymentReference = requireOpaqueRef(value.paymentReference, "Payment reference");
  const operationReference = requireUuid(value.operationReference, "Operation reference");
  if (!exactKeys(value.amount, ["currency", "minorUnits", "exponent"])) {
    throw new TypeError("Webhook amount is invalid");
  }
  const currency = value.amount.currency;
  if (typeof currency !== "string" || !ISO_CURRENCY_PATTERN.test(currency)) {
    throw new TypeError("Webhook currency is invalid");
  }
  const minorUnits = requireSafeInteger(value.amount.minorUnits, "Webhook amount", 1);
  if (value.amount.exponent !== 2) throw new TypeError("Webhook currency exponent must be 2");
  const subscriptionReference = value.subscriptionReference == null
    ? null
    : requireOpaqueRef(value.subscriptionReference, "Subscription reference");
  const periodStart = parseIsoInstant(value.periodStart, "Subscription period start");
  const periodEnd = parseIsoInstant(value.periodEnd, "Subscription period end");
  if ((periodStart === null) !== (periodEnd === null)) {
    throw new TypeError("Subscription period bounds must both be supplied");
  }
  if ((subscriptionReference === null) !== (periodStart === null)) {
    throw new TypeError("Subscription identity and period must be supplied together");
  }
  if (periodStart && periodEnd && Date.parse(periodEnd) <= Date.parse(periodStart)) {
    throw new TypeError("Subscription period end must follow its start");
  }
  const amount = { currency, minorUnits, exponent: 2 as const };
  return {
    deliveryId: normalizedDeliveryId,
    paymentReference,
    operationReference,
    amount,
    subscriptionReference,
    periodStart,
    periodEnd,
    reconciliationPayload: {
      type: "payment/received",
      id: paymentReference,
      reconciliationState: "ready",
      entitlementGrantAllowed: false,
      issues: [],
      operationReference,
      subscriptionReference,
      periodStart,
      periodEnd,
      total: amount,
      transactions: [{ id: paymentReference, amount }],
    },
  };
}

/**
 * A topic this integration does not handle. Distinct from every other parse
 * failure on purpose: providers emit dozens of event types on the same
 * endpoint, and refusing an unknown one makes them retry it forever.
 *
 * The distinction has to be a type rather than a message, because the two
 * outcomes are opposite. An unhandled topic is acknowledged and dropped. A
 * malformed body of a topic we DO handle must be rejected — acknowledging it
 * would tell the provider a real payment was received and stop the retry that
 * is the only thing standing between a customer and losing their money.
 */
export class UnhandledWebhookTopicError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: this module is imported by the Node test runner, which strips
  // types without generating code, and a parameter property needs codegen.
  readonly topic: string;

  constructor(topic: string) {
    super("Unhandled webhook topic");
    this.name = "UnhandledWebhookTopicError";
    this.topic = topic;
  }
}

export type ReversalType = "refund" | "chargeback" | "dispute_lost";

const REVERSAL_TYPES: readonly ReversalType[] = ["refund", "chargeback", "dispute_lost"];

export interface NormalizedReversalWebhook {
  readonly deliveryId: string;
  readonly reversalReference: string;
  readonly reversedPaymentReference: string;
  readonly reversalType: ReversalType;
  readonly amount: {
    readonly currency: string;
    readonly minorUnits: number;
    readonly exponent: 2;
  };
  readonly reversalPayload: {
    readonly type: "payment/reversed";
    readonly id: string;
    readonly reversedPaymentReference: string;
    readonly reversalType: ReversalType;
    readonly reason: string;
    readonly total: {
      readonly currency: string;
      readonly minorUnits: number;
      readonly exponent: 2;
    };
  };
}

export function parseReversalWebhook(value: unknown, deliveryId: string): NormalizedReversalWebhook {
  if (!isRecord(value) || !exactKeys(value, [
    "type", "reversalReference", "reversedPaymentReference",
    "reversalType", "amount", "reason",
  ])) throw new TypeError("Webhook body is invalid");
  if (value.type !== "payment.reversed") throw new UnhandledWebhookTopicError(String(value.type));
  if (!isRecord(value.amount)) throw new TypeError("Webhook amount is invalid");

  const normalizedDeliveryId = requireOpaqueRef(deliveryId, "Webhook delivery ID");
  const reversalReference = requireOpaqueRef(value.reversalReference, "Reversal reference");
  const reversedPaymentReference = requireOpaqueRef(
    value.reversedPaymentReference,
    "Reversed payment reference",
  );
  if (reversalReference === reversedPaymentReference) {
    throw new TypeError("A reversal cannot reference itself");
  }

  const reversalType = value.reversalType;
  if (typeof reversalType !== "string" || !REVERSAL_TYPES.includes(reversalType as ReversalType)) {
    throw new TypeError("Reversal type is invalid");
  }

  if (!exactKeys(value.amount, ["currency", "minorUnits", "exponent"])) {
    throw new TypeError("Webhook amount is invalid");
  }
  const currency = value.amount.currency;
  if (typeof currency !== "string" || !ISO_CURRENCY_PATTERN.test(currency)) {
    throw new TypeError("Webhook currency is invalid");
  }
  const minorUnits = requireSafeInteger(value.amount.minorUnits, "Webhook amount", 1);
  if (value.amount.exponent !== 2) throw new TypeError("Webhook currency exponent must be 2");

  const reason = value.reason;
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 1000) {
    throw new TypeError("Reversal reason is invalid");
  }

  const amount = { currency, minorUnits, exponent: 2 as const };
  return {
    deliveryId: normalizedDeliveryId,
    reversalReference,
    reversedPaymentReference,
    reversalType: reversalType as ReversalType,
    amount,
    reversalPayload: {
      type: "payment/reversed",
      id: reversalReference,
      reversedPaymentReference,
      reversalType: reversalType as ReversalType,
      reason: reason.trim(),
      total: amount,
    },
  };
}

export type ParsedBillingWebhook =
  | { readonly kind: "payment"; readonly payment: NormalizedPaymentWebhook }
  | { readonly kind: "reversal"; readonly reversal: NormalizedReversalWebhook };

/**
 * Routes one delivery to the parser for its topic. Anything neither parser
 * claims raises {@link UnhandledWebhookTopicError} so the caller can
 * acknowledge it; anything a parser claims and then rejects raises a TypeError
 * so the caller refuses it.
 */
export function parseBillingWebhook(value: unknown, deliveryId: string): ParsedBillingWebhook {
  const topic = isRecord(value) && typeof value.type === "string" ? value.type : "";
  if (topic === "payment.completed") {
    return { kind: "payment", payment: parsePaymentWebhook(value, deliveryId) };
  }
  if (topic === "payment.reversed") {
    return { kind: "reversal", reversal: parseReversalWebhook(value, deliveryId) };
  }
  throw new UnhandledWebhookTopicError(topic);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function parseWebhookTimestamp(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,10}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function timestampedWebhookBytes(timestamp: string, bytes: Uint8Array): Uint8Array {
  if (parseWebhookTimestamp(timestamp) === null) throw new TypeError("Webhook timestamp is invalid");
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signedBytes = new Uint8Array(prefix.byteLength + bytes.byteLength);
  signedBytes.set(prefix);
  signedBytes.set(bytes, prefix.byteLength);
  return signedBytes;
}

export async function computeWebhookHmacHex(
  secret: string,
  timestamp: string,
  bytes: Uint8Array,
): Promise<string> {
  if (secret.length < 32 || secret.length > 8192) throw new TypeError("Webhook secret is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(
    await crypto.subtle.sign("HMAC", key, timestampedWebhookBytes(timestamp, bytes)),
  ));
}

export async function verifyWebhookHmac(
  secret: string,
  timestamp: string | null,
  bytes: Uint8Array,
  signature: string | null,
  nowMilliseconds = Date.now(),
): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const timestampSeconds = parseWebhookTimestamp(timestamp);
  if (timestampSeconds === null || !Number.isFinite(nowMilliseconds)) return false;
  const ageMilliseconds = nowMilliseconds - timestampSeconds * 1000;
  if (
    ageMilliseconds > WEBHOOK_MAX_AGE_SECONDS * 1000
    || ageMilliseconds < -WEBHOOK_MAX_FUTURE_SKEW_SECONDS * 1000
  ) return false;
  const expected = await computeWebhookHmacHex(secret, timestamp!, bytes);
  const received = signature.toLowerCase();
  let mismatch = expected.length ^ received.length;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  return mismatch === 0;
}
