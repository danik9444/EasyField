import {
  computeWebhookHmacHex,
  parseAutoReloadInput,
  parseCheckoutAdapterConfig,
  parseCheckoutInput,
  parseCheckoutStatusInput,
  parsePaymentWebhook,
  requireConfiguredCheckoutUrl,
  WEBHOOK_MAX_AGE_SECONDS,
  WEBHOOK_MAX_FUTURE_SKEW_SECONDS,
  verifyHostedCheckoutSession,
  verifyWebhookHmac,
} from "./account_api.ts";

declare const Deno: { test(name: string, test: () => void | Promise<void>): void };

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
}

function assertThrows(action: () => unknown, contains?: string): void {
  try {
    action();
  } catch (error) {
    if (contains && (!(error instanceof Error) || !error.message.includes(contains))) {
      throw new Error(`Expected an error containing ${contains}`);
    }
    return;
  }
  throw new Error("Expected action to throw");
}

Deno.test("checkout input accepts only the renderer contract", () => {
  const parsed = parseCheckoutInput({
    kind: "subscription",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    planId: "creator",
    billingInterval: "annual",
  });
  assertEquals(parsed.kind, "subscription");
  assertThrows(() => parseCheckoutInput({
    kind: "top-up",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    amountCreditMicros: 1_000_000,
    price: 1,
  }), "unknown fields");
  assertThrows(() => parseCheckoutInput({
    kind: "subscription",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    planId: "operator-supplied",
    billingInterval: "monthly",
  }), "Unknown subscription plan");
});

Deno.test("checkout status input accepts only an owned-operation lookup shape", () => {
  const parsed = parseCheckoutStatusInput({
    kind: "partner",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
  });
  assertEquals(parsed.kind, "partner");
  assertThrows(() => parseCheckoutStatusInput({
    kind: "subscription",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    accountId: "123e4567-e89b-42d3-a456-426614174001",
  }), "only kind and requestId");
  assertThrows(() => parseCheckoutStatusInput({
    kind: "billing-portal",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
  }), "Unknown checkout status kind");
});

Deno.test("auto-reload rejects non-integer and unknown fields", () => {
  const disabled = parseAutoReloadInput({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    policy: { enabled: false },
  });
  assert(!disabled.policy.enabled);
  assertThrows(() => parseAutoReloadInput({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    policy: { enabled: true, triggerBalanceCreditMicros: 0, topUpAmountCreditMicros: 1.2 },
  }), "safe integer");
});

Deno.test("checkout adapter is unavailable until every secret and allowlist is configured", () => {
  assertThrows(() => parseCheckoutAdapterConfig({}), "not configured");
  const config = parseCheckoutAdapterConfig({
    EASYFIELD_BILLING_PROVIDER_ID: "merchant",
    EASYFIELD_CHECKOUT_API_URL: "https://merchant.internal.example/session",
    EASYFIELD_CHECKOUT_API_TOKEN: "0123456789abcdef0123456789abcdef",
    EASYFIELD_CHECKOUT_HOSTS: "checkout.example.test",
    EASYFIELD_CHECKOUT_VARIANTS_JSON: JSON.stringify({
      "subscription:creator:monthly": "creator-monthly",
    }),
    EASYFIELD_CHECKOUT_SUCCESS_URL: "https://account.example.test/success",
    EASYFIELD_CHECKOUT_CANCEL_URL: "https://account.example.test/cancel",
    EASYFIELD_BILLING_WEBHOOK_URL: "https://functions.example.test/webhook",
  });
  assertEquals(config.variants["subscription:creator:monthly"], "creator-monthly");
  assertEquals(
    requireConfiguredCheckoutUrl("https://checkout.example.test/session/abc", config.checkoutHosts),
    "https://checkout.example.test/session/abc",
  );
  assertThrows(
    () => requireConfiguredCheckoutUrl("https://attacker.example/session", config.checkoutHosts),
    "not allowlisted",
  );
});

Deno.test("hosted checkout response must echo the exact operation, product, and amount", () => {
  const expected = {
    operationId: "123e4567-e89b-42d3-a456-426614174000",
    purchaseKind: "subscription" as const,
    offerKey: "subscription:creator:monthly",
    variantId: "creator-monthly",
    amount: { currency: "USD", minorUnits: 3000, exponent: 2 as const },
  };
  const response = {
    ...expected,
    checkoutUrl: "https://checkout.example.test/session/abc",
    checkoutReference: "checkout-reference-123",
    expiresAt: "2026-07-15T12:00:00.000Z",
  };
  const verified = verifyHostedCheckoutSession(response, expected, new Set(["checkout.example.test"]));
  assertEquals(verified.offerKey, expected.offerKey);
  assertEquals(verified.amount?.minorUnits, 3000);
  assertThrows(() => verifyHostedCheckoutSession({
    ...response,
    amount: { currency: "USD", minorUnits: 1500, exponent: 2 },
  }, expected, new Set(["checkout.example.test"])), "amount does not match");
  assertThrows(() => verifyHostedCheckoutSession({
    ...response,
    variantId: "different-product",
  }, expected, new Set(["checkout.example.test"])), "identity does not match");
});

Deno.test("webhook HMAC covers its timestamp and exact raw bytes", async () => {
  const secret = "test-secret-that-is-at-least-thirty-two-bytes";
  const bytes = new TextEncoder().encode('{"event":"paid"}');
  const timestamp = "1784106000";
  const now = Number(timestamp) * 1000;
  const signature = await computeWebhookHmacHex(secret, timestamp, bytes);
  assert(await verifyWebhookHmac(secret, timestamp, bytes, signature, now));
  assert(!await verifyWebhookHmac(
    secret,
    timestamp,
    new TextEncoder().encode('{"event":"paid"}\n'),
    signature,
    now,
  ));
  assert(!await verifyWebhookHmac(secret, String(Number(timestamp) + 1), bytes, signature, now));
  assert(!await verifyWebhookHmac(secret, timestamp, bytes, "0".repeat(64), now));
});

Deno.test("webhook HMAC rejects stale, future, missing, and non-canonical timestamps", async () => {
  const secret = "test-secret-that-is-at-least-thirty-two-bytes";
  const bytes = new TextEncoder().encode('{"event":"paid"}');
  const nowSeconds = 1_784_106_000;
  const stale = String(nowSeconds - WEBHOOK_MAX_AGE_SECONDS - 1);
  const future = String(nowSeconds + WEBHOOK_MAX_FUTURE_SKEW_SECONDS + 1);
  const staleSignature = await computeWebhookHmacHex(secret, stale, bytes);
  const futureSignature = await computeWebhookHmacHex(secret, future, bytes);
  assert(!await verifyWebhookHmac(secret, stale, bytes, staleSignature, nowSeconds * 1000));
  assert(!await verifyWebhookHmac(secret, future, bytes, futureSignature, nowSeconds * 1000));
  assert(!await verifyWebhookHmac(secret, null, bytes, staleSignature, nowSeconds * 1000));
  assert(!await verifyWebhookHmac(secret, `0${nowSeconds}`, bytes, staleSignature, nowSeconds * 1000));
});

Deno.test("signed webhook normalization is strict and never authorizes entitlement", () => {
  const parsed = parsePaymentWebhook({
    type: "payment.completed",
    paymentReference: "payment-123",
    operationReference: "123e4567-e89b-42d3-a456-426614174000",
    amount: { currency: "USD", minorUnits: 3000, exponent: 2 },
    subscriptionReference: "subscription-123",
    periodStart: "2026-07-15T00:00:00.000Z",
    periodEnd: "2026-08-15T00:00:00.000Z",
  }, "delivery-123");
  assertEquals(parsed.reconciliationPayload.entitlementGrantAllowed, false);
  assertEquals(parsed.reconciliationPayload.operationReference, "123e4567-e89b-42d3-a456-426614174000");
  assertEquals(parsed.reconciliationPayload.subscriptionReference, "subscription-123");
  assertEquals(parsed.reconciliationPayload.periodStart, "2026-07-15T00:00:00.000Z");
  assertThrows(() => parsePaymentWebhook({
    type: "payment.completed",
    paymentReference: "payment-123",
    operationReference: "123e4567-e89b-42d3-a456-426614174000",
    amount: { currency: "USD", minorUnits: 3000, exponent: 2 },
    subscriptionReference: "subscription-123",
    periodStart: null,
    periodEnd: null,
  }, "delivery-123"), "supplied together");
  assertThrows(() => parsePaymentWebhook({
    type: "payment.completed",
    paymentReference: "payment-123",
    operationReference: "123e4567-e89b-42d3-a456-426614174000",
    amount: { currency: "USD", minorUnits: 3000, exponent: 2 },
    subscriptionReference: null,
    periodStart: null,
    periodEnd: null,
    grantCredits: true,
  }, "delivery-123"), "invalid");
});
