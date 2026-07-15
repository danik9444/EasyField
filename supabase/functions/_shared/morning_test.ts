import {
  buildMorningPaymentFormBody,
  buildMorningTokenChargeBody,
  chargeMorningSavedTokenOnce,
  computeMorningWebhookHmacHex,
  MORNING_MAX_MINOR_UNITS,
  MORNING_WEBHOOK_MAX_BODY_BYTES,
  parseMorningWebhookEvent,
  requestMorningAccessToken,
  searchMorningSavedTokens,
  verifyMorningWebhookDelivery,
  verifyMorningWebhookSignature,
  type MorningApiConfig,
  type MorningHostedPaymentRequest,
  type MorningTokenChargeRequest,
} from "./morning.ts";

declare const Deno: {
  test(name: string, test: () => void | Promise<void>): void;
};

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = "Values differ"): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertThrows(action: () => unknown, messageIncludes?: string): void {
  try {
    action();
  } catch (error) {
    if (messageIncludes && (!(error instanceof Error) || !error.message.includes(messageIncludes))) {
      throw new Error(`Expected error containing ${messageIncludes}`);
    }
    return;
  }
  throw new Error("Expected action to throw");
}

async function assertRejects(action: () => Promise<unknown>, messageIncludes?: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (messageIncludes && (!(error instanceof Error) || !error.message.includes(messageIncludes))) {
      throw new Error(`Expected rejection containing ${messageIncludes}`);
    }
    return;
  }
  throw new Error("Expected promise to reject");
}

function apiConfig(fetcher: typeof fetch = fetch): MorningApiConfig {
  return {
    environment: "sandbox",
    callbackOrigins: ["https://billing.example.test"],
    clientId: "unit-test-client",
    clientSecret: "unit-test-secret",
    fetcher,
  };
}

const chargeRequest: MorningTokenChargeRequest = {
  operationId: "renewal-attempt-1",
  paymentMethodId: "saved-token-1",
  amount: { currency: "ILS", minorUnits: 4_900, exponent: 2 },
  description: "EasyField monthly renewal",
  notificationUrl: "https://billing.example.test/morning/notify",
  documentType: 320,
  vatType: 0,
  language: "he",
};

const hostedRequest: MorningHostedPaymentRequest = {
  operationId: "checkout-1",
  amount: { currency: "ILS", minorUnits: 4_900, exponent: 2 },
  description: "EasyField monthly plan",
  customer: {
    customerId: "local-user-1",
    name: "Test Customer",
    email: "customer@example.test",
  },
  successUrl: "https://billing.example.test/success",
  failureUrl: "https://billing.example.test/failure",
  notificationUrl: "https://billing.example.test/morning/notify",
  documentType: 320,
  vatType: 0,
  language: "he",
};

async function webhookHeaders(
  rawBody: Uint8Array,
  emittedAt = "2026-07-14T09:00:00.000Z",
  topic = "payment/received",
  webhookId = "webhook-config-1",
): Promise<Headers> {
  const signature = await computeMorningWebhookHmacHex(rawBody, "unit-test-webhook-secret");
  return new Headers({
    "x-webhook-topic": topic,
    "x-webhook-id": webhookId,
    "x-webhook-delivery-id": "delivery-1",
    "x-webhook-timestamp": emittedAt,
    "x-correlation-id": "correlation-1",
    "x-webhook-signature": signature,
    "user-agent": "morning webhooks 2.1",
  });
}

function webhookOptions() {
  return {
    secret: "unit-test-webhook-secret",
    expectedWebhookId: "webhook-config-1",
    maxAgeSeconds: 300,
    maxFutureSkewSeconds: 30,
  } as const;
}

Deno.test("Morning HMAC verification uses the exact raw bytes", async () => {
  // RFC 4231 test case 1 (HMAC-SHA256).
  const secret = new Uint8Array(20).fill(0x0b);
  const body = new TextEncoder().encode("Hi There");
  const expected = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";

  assertEquals(await computeMorningWebhookHmacHex(body, secret), expected);
  assert(await verifyMorningWebhookSignature(body, expected, secret));
  assert(
    !(await verifyMorningWebhookSignature(new TextEncoder().encode("Hi There "), expected, secret)),
    "Mutating the raw body must invalidate the signature",
  );
});

Deno.test("verified payment webhook is minimal, non-grantable, and ready for reconciliation", async () => {
  const rawBody = new TextEncoder().encode(JSON.stringify({
    id: "payment-event-1",
    total: 49,
    custom: { operationId: "checkout-1" },
    payer: { email: "must-not-escape@example.test" },
    transactions: [{
      id: "transaction-1",
      currency: "ILS",
      total: 49,
      authorizationCode: "must-not-escape",
      paymentMethod: { cardNumber: "0008" },
    }],
  }));
  const delivery = await verifyMorningWebhookDelivery(
    await webhookHeaders(rawBody),
    rawBody,
    new Date("2026-07-14T09:00:05.000Z"),
    webhookOptions(),
  );

  assertEquals(delivery.providerEventId, "payment-event-1");
  assertEquals(delivery.signedBodySha256.length, 64);
  assertEquals(delivery.event.type, "payment/received");
  if (delivery.event.type === "payment/received") {
    assertEquals(delivery.event.reconciliationState, "ready");
    assertEquals(delivery.event.entitlementGrantAllowed, false);
    assertEquals(delivery.event.operationReference, "checkout-1");
    assert(!("payer" in delivery.event), "Payer PII must not escape the parser");
    assert(!("authorizationCode" in delivery.event.transactions[0]), "Authorization code must be redacted");
  }
});

Deno.test("optional webhook fields produce needs_reconciliation instead of rejection", async () => {
  const rawBody = new TextEncoder().encode("{}");
  const delivery = await verifyMorningWebhookDelivery(
    await webhookHeaders(rawBody),
    rawBody,
    new Date("2026-07-14T09:00:05.000Z"),
    webhookOptions(),
  );

  assertEquals(delivery.providerEventId, undefined);
  assertEquals(delivery.event.reconciliationState, "needs_reconciliation");
  assertEquals(delivery.event.entitlementGrantAllowed, false);
  assert(delivery.event.issues.length > 0);
});

Deno.test("a complete payment without a proven operation reference cannot auto-reconcile", async () => {
  const event = parseMorningWebhookEvent({
    id: "payment-event-2",
    total: 49,
    transactions: [{ id: "transaction-2", currency: "USD", total: 49 }],
  });
  assertEquals(event.reconciliationState, "needs_reconciliation");
  assertEquals(event.operationReference, undefined);
  assert(event.issues.includes("operation_reference_missing"));
});

Deno.test("billing exposes only payment webhooks and rejects cross-topic replay", async () => {
  const rawBody = new TextEncoder().encode(JSON.stringify({ id: "payment-1" }));
  const headers = await webhookHeaders(rawBody, "2026-07-14T09:00:00.000Z", "document/created");
  await assertRejects(
    () => verifyMorningWebhookDelivery(
      headers,
      rawBody,
      new Date("2026-07-14T09:00:05.000Z"),
      webhookOptions(),
    ),
    "Unexpected Morning webhook topic",
  );
});

Deno.test("payment webhook is bound to the configured webhook ID", async () => {
  const rawBody = new TextEncoder().encode(JSON.stringify({ id: "payment-1" }));
  const headers = await webhookHeaders(
    rawBody,
    "2026-07-14T09:00:00.000Z",
    "payment/received",
    "different-webhook",
  );
  await assertRejects(
    () => verifyMorningWebhookDelivery(
      headers,
      rawBody,
      new Date("2026-07-14T09:00:05.000Z"),
      webhookOptions(),
    ),
    "Unexpected Morning webhook ID",
  );
});

Deno.test("webhook rejects non-canonical or non-finite time validation", async () => {
  const rawBody = new TextEncoder().encode(JSON.stringify({ id: "payment-1" }));
  const nonCanonical = await webhookHeaders(rawBody, "2026-07-14 09:00:00Z");
  await assertRejects(
    () => verifyMorningWebhookDelivery(
      nonCanonical,
      rawBody,
      new Date("2026-07-14T09:00:05.000Z"),
      webhookOptions(),
    ),
    "canonical UTC ISO-8601",
  );
  const validHeaders = await webhookHeaders(rawBody);
  await assertRejects(
    () => verifyMorningWebhookDelivery(
      validHeaders,
      rawBody,
      new Date("2026-07-14T09:00:05.000Z"),
      { ...webhookOptions(), maxAgeSeconds: Number.NaN },
    ),
    "finite non-negative",
  );
  await assertRejects(
    () => verifyMorningWebhookDelivery(
      validHeaders,
      rawBody,
      new Date(Number.NaN),
      webhookOptions(),
    ),
    "receivedAt is invalid",
  );
});

Deno.test("webhook rejects an oversized body before verification", async () => {
  const rawBody = new Uint8Array(MORNING_WEBHOOK_MAX_BODY_BYTES + 1);
  await assertRejects(
    () => verifyMorningWebhookDelivery(
      new Headers(),
      rawBody,
      new Date("2026-07-14T09:00:05.000Z"),
      webhookOptions(),
    ),
    "maximum accepted size",
  );
});

Deno.test("OAuth uses exact sandbox endpoint and rejects redirects", async () => {
  let capturedUrl = "";
  let capturedRedirect: RequestRedirect | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capturedUrl = String(input);
    capturedRedirect = init?.redirect;
    return new Response(JSON.stringify({
      accessToken: "access-token",
      tokenType: "Bearer",
      expiresAt: 1_900_000_000,
    }), { status: 200 });
  }) as typeof fetch;

  await requestMorningAccessToken(apiConfig(fetcher));
  assertEquals(capturedUrl, "https://api.sandbox.morning.dev/idp/v1/oauth/token");
  assertEquals(capturedRedirect, "error");
});

Deno.test("callback URLs must use an explicitly allowlisted EasyField origin", () => {
  buildMorningPaymentFormBody(apiConfig(), hostedRequest);
  assertThrows(
    () => buildMorningPaymentFormBody(apiConfig(), {
      ...hostedRequest,
      successUrl: "https://billing.example.test.attacker.invalid/success",
    }),
    "origin is not allowlisted",
  );
});

Deno.test("hosted checkout correlation cannot be overridden with display text or PII", () => {
  const injectedRequest = {
    ...hostedRequest,
    customReference: "customer@example.test",
  };
  const body = buildMorningPaymentFormBody(apiConfig(), injectedRequest);
  assertEquals(body.custom, hostedRequest.operationId);
});

Deno.test("money uses exponent 2, a hard cap, and exact income reconciliation", () => {
  const body = buildMorningTokenChargeBody(apiConfig(), {
    ...chargeRequest,
    income: [{
      description: "Two plan units",
      quantity: 2,
      price: { currency: "ILS", minorUnits: 2_450, exponent: 2 },
      vatType: 0,
    }],
  });
  assertEquals(body.amount, 49);
  assert(Array.isArray(body.income));
  assertThrows(
    () => buildMorningTokenChargeBody(apiConfig(), {
      ...chargeRequest,
      amount: { currency: "ILS", minorUnits: 4_900, exponent: 3 },
    }),
    "exponent 2",
  );
  assertThrows(
    () => buildMorningTokenChargeBody(apiConfig(), {
      ...chargeRequest,
      amount: { currency: "ILS", minorUnits: MORNING_MAX_MINOR_UNITS + 1, exponent: 2 },
    }),
    "safety cap",
  );
  assertThrows(
    () => buildMorningTokenChargeBody(apiConfig(), {
      ...chargeRequest,
      income: [{
        description: "Does not add up",
        quantity: 1,
        price: { currency: "ILS", minorUnits: 2_450, exponent: 2 },
        vatType: 0,
      }],
    }),
    "reconcile exactly",
  );
});

Deno.test("saved-token search is customer-scoped and rejects mismatched results", async () => {
  let requestExternalKey: unknown;
  let requestRedirect: RequestRedirect | undefined;
  const goodFetcher = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestExternalKey = JSON.parse(String(init?.body)).externalKey;
    requestRedirect = init?.redirect;
    return new Response(JSON.stringify({
      total: 1,
      page: 1,
      pageSize: 25,
      from: 1,
      to: 1,
      pages: 1,
      items: [{
        id: "token-1",
        number: "0008",
        externalKey: "customer-1",
        currencies: ["ILS"],
        status: 1,
      }],
    }), { status: 200 });
  }) as typeof fetch;
  const page = await searchMorningSavedTokens(
    apiConfig(goodFetcher),
    "access-token",
    { providerCustomerId: "customer-1" },
  );
  assertEquals(requestExternalKey, "customer-1");
  assertEquals(requestRedirect, "error");
  assertEquals(page.items[0].providerCustomerId, "customer-1");

  const wrongCustomerFetcher = (async (): Promise<Response> => new Response(JSON.stringify({
    total: 1,
    page: 1,
    pageSize: 25,
    from: 1,
    to: 1,
    pages: 1,
    items: [{ id: "token-2", number: "0009", externalKey: "customer-2" }],
  }), { status: 200 })) as typeof fetch;
  await assertRejects(
    () => searchMorningSavedTokens(
      apiConfig(wrongCustomerFetcher),
      "access-token",
      { providerCustomerId: "customer-1" },
    ),
    "outside the requested customer scope",
  );
});

Deno.test("saved-token charge includes stable reference and makes one attempt after transport failure", async () => {
  const body = buildMorningTokenChargeBody(apiConfig(), chargeRequest);
  assertEquals(body.remarks, "EasyField operation: renewal-attempt-1");
  assertThrows(
    () => buildMorningTokenChargeBody(apiConfig(), { ...chargeRequest, operationId: "bad\nreference" }),
    "opaque ASCII",
  );

  let calls = 0;
  const fetcher = (async (): Promise<Response> => {
    calls += 1;
    throw new TypeError("simulated network failure");
  }) as typeof fetch;
  const result = await chargeMorningSavedTokenOnce(apiConfig(fetcher), "access-token", chargeRequest);
  assertEquals(calls, 1, "A token charge must never be automatically retried");
  assertEquals(result.state, "unknown");
  assertEquals(result.automaticRetryAllowed, false);
});

Deno.test("saved-token charge validates the full official success response", async () => {
  const fullSuccessFetcher = (async (): Promise<Response> => new Response(JSON.stringify({
    id: "document-1",
    number: 40034,
    type: 320,
    signed: true,
    lang: "he",
    client: { id: "client-1" },
    url: { origin: "https://documents.example.test/document-1" },
    transactionId: "transaction-1",
  }), { status: 200 })) as typeof fetch;
  const success = await chargeMorningSavedTokenOnce(
    apiConfig(fullSuccessFetcher),
    "access-token",
    chargeRequest,
  );
  assertEquals(success.state, "succeeded");

  const partialSuccessFetcher = (async (): Promise<Response> => new Response(JSON.stringify({
    id: "document-1",
  }), { status: 200 })) as typeof fetch;
  const partial = await chargeMorningSavedTokenOnce(
    apiConfig(partialSuccessFetcher),
    "access-token",
    chargeRequest,
  );
  assertEquals(partial.state, "unknown");
  if (partial.state === "unknown") assertEquals(partial.reason, "invalid_success_response");
});

for (const status of [302, 408, 409, 425, 429, 500, 503]) {
  Deno.test(`saved-token charge status ${status} stays ambiguous and single-attempt`, async () => {
    let calls = 0;
    const fetcher = (async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ errorCode: "provider_error" }), { status });
    }) as typeof fetch;
    const result = await chargeMorningSavedTokenOnce(apiConfig(fetcher), "access-token", chargeRequest);
    assertEquals(calls, 1);
    assertEquals(result.state, "unknown");
    assertEquals(result.automaticRetryAllowed, false);
  });
}
