import {
  MAX_ACCOUNT_REQUEST_BYTES,
  parseAutoReloadInput,
  parseBearerToken,
  parseCheckoutAdapterConfig,
  parseCheckoutInput,
  parseCheckoutStatusInput,
  requireConfiguredCheckoutUrl,
  verifyHostedCheckoutSession,
  type CheckoutAdapterConfig,
  type CheckoutInput,
  type CheckoutStatusInput,
  type HostedCheckoutExpectation,
  type VerifiedHostedCheckoutSession,
} from "../_shared/account_api.ts";
import { classifyGenerationGatewayRequest } from "../_shared/generation_gateway.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

type JsonRecord = Record<string, unknown>;

// Customer plans must never be sold before the metered generation gateway is
// able to spend those credits. Partner access uses a separate direct path, but
// its purchase remains independently gated below until refund and chargeback
// reversal is proven. Change this only in the same release that replaces the
// fail-closed gateway below with durable quote/reserve/capture and tests.
const CUSTOMER_GENERATION_GATEWAY_READY = false;
// A lifetime entitlement must be revoked automatically on a verified refund
// or chargeback before the one-time Partner product may be sold. Keep the
// checkout closed until the merchant adapter and webhook reversal contract are
// deployed and covered by reconciliation tests.
const PARTNER_REVERSAL_HANDLING_READY = false;

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly email_confirmed_at?: string | null;
  readonly confirmed_at?: string | null;
}

interface PreparedCheckout {
  readonly intentId: string;
  readonly purchaseKind: "subscription" | "top-up" | "partner";
  readonly offerKey: string;
  readonly amountMinorUnits: number;
  readonly currencyCode: string;
}

interface AuthoritativeCheckoutStatus {
  readonly version: 1;
  readonly kind: CheckoutStatusInput["kind"];
  readonly requestId: string;
  readonly intentId: string;
  readonly state: "prepared" | "open" | "awaiting-reconciliation" | "completed" | "closed-unpaid";
  readonly terminal: boolean;
  readonly mayStartNewCheckout: boolean;
  readonly checkoutUrl: string | null;
  readonly providerExpiresAt: string | null;
  readonly updatedAt: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function envRecord(): Record<string, string | undefined> {
  return {
    EASYFIELD_BILLING_PROVIDER_ID: Deno.env.get("EASYFIELD_BILLING_PROVIDER_ID"),
    EASYFIELD_CHECKOUT_API_URL: Deno.env.get("EASYFIELD_CHECKOUT_API_URL"),
    EASYFIELD_CHECKOUT_API_TOKEN: Deno.env.get("EASYFIELD_CHECKOUT_API_TOKEN"),
    EASYFIELD_CHECKOUT_HOSTS: Deno.env.get("EASYFIELD_CHECKOUT_HOSTS"),
    EASYFIELD_CHECKOUT_VARIANTS_JSON: Deno.env.get("EASYFIELD_CHECKOUT_VARIANTS_JSON"),
    EASYFIELD_CHECKOUT_SUCCESS_URL: Deno.env.get("EASYFIELD_CHECKOUT_SUCCESS_URL"),
    EASYFIELD_CHECKOUT_CANCEL_URL: Deno.env.get("EASYFIELD_CHECKOUT_CANCEL_URL"),
    EASYFIELD_BILLING_WEBHOOK_URL: Deno.env.get("EASYFIELD_BILLING_WEBHOOK_URL"),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ACCOUNT_REQUEST_BYTES) {
    throw new HttpError(413, "Request is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ACCOUNT_REQUEST_BYTES) throw new HttpError(413, "Request is too large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "Account service is not configured");
  return value;
}

function supabaseBaseUrl(): string {
  const value = requiredEnv("SUPABASE_URL");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error();
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(503, "Account service is not configured");
  }
}

async function limitedJson(response: Response, limit = 2 * 1024 * 1024): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("response-too-large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error("response-too-large");
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function authenticate(request: Request): Promise<{ token: string; user: AuthUser }> {
  let token: string;
  try {
    token = parseBearerToken(request.headers.get("authorization"));
  } catch {
    throw new HttpError(401, "Authentication required");
  }
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  let response: Response;
  try {
    response = await fetch(`${supabaseBaseUrl()}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: anonKey, accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "Account service is unavailable");
  }
  if (!response.ok) throw new HttpError(401, "Authentication required");
  const payload = await limitedJson(response);
  if (
    !isRecord(payload)
    || typeof payload.id !== "string"
    || typeof payload.email !== "string"
    || !(payload.email_confirmed_at || payload.confirmed_at)
  ) throw new HttpError(403, "A verified account is required");
  return { token, user: payload as unknown as AuthUser };
}

async function serviceRpc<T>(name: string, body: JsonRecord): Promise<T> {
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let response: Response;
  try {
    response = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "Account service is unavailable");
  }
  const payload = await limitedJson(response);
  if (!response.ok) {
    // Database and provider details are intentionally never reflected to the client.
    if (response.status === 400 || response.status === 409) throw new HttpError(400, "The billing request is not valid");
    if (response.status === 401 || response.status === 403) throw new HttpError(403, "This account is not eligible for that operation");
    throw new HttpError(503, "Account service is unavailable");
  }
  return payload as T;
}

function preparedCheckout(value: unknown): PreparedCheckout {
  if (
    !isRecord(value)
    || typeof value.intentId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(value.intentId)
    || !["subscription", "top-up", "partner"].includes(String(value.purchaseKind))
    || typeof value.offerKey !== "string"
    || !Number.isSafeInteger(value.amountMinorUnits)
    || Number(value.amountMinorUnits) <= 0
    || typeof value.currencyCode !== "string"
    || !/^[A-Z]{3}$/.test(value.currencyCode)
  ) throw new HttpError(503, "Account service returned an invalid checkout");
  return value as unknown as PreparedCheckout;
}

function authoritativeCheckoutStatus(
  value: unknown,
  input: CheckoutStatusInput,
): AuthoritativeCheckoutStatus {
  const allowedKeys = new Set([
    "version", "kind", "requestId", "intentId", "state", "terminal",
    "mayStartNewCheckout", "checkoutUrl", "providerExpiresAt", "updatedAt",
  ]);
  const states = new Set([
    "prepared", "open", "awaiting-reconciliation", "completed", "closed-unpaid",
  ]);
  if (
    !isRecord(value)
    || Object.keys(value).length !== allowedKeys.size
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.version !== 1
    || value.kind !== input.kind
    || value.requestId !== input.requestId
    || typeof value.intentId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.intentId)
    || typeof value.state !== "string"
    || !states.has(value.state)
    || typeof value.terminal !== "boolean"
    || typeof value.mayStartNewCheckout !== "boolean"
    || (value.providerExpiresAt !== null
      && (typeof value.providerExpiresAt !== "string" || !Number.isFinite(Date.parse(value.providerExpiresAt))))
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) throw new HttpError(503, "Account service returned an invalid checkout status");

  const terminal = value.state === "completed" || value.state === "closed-unpaid";
  const mayStartNewCheckout = value.state === "closed-unpaid"
    || (value.state === "completed" && value.kind === "top-up");
  if (value.terminal !== terminal || value.mayStartNewCheckout !== mayStartNewCheckout) {
    throw new HttpError(503, "Account service returned an invalid checkout status");
  }

  let checkoutUrl: string | null = null;
  if (value.state === "open") {
    let config: CheckoutAdapterConfig;
    try {
      config = parseCheckoutAdapterConfig(envRecord());
      checkoutUrl = requireConfiguredCheckoutUrl(value.checkoutUrl, config.checkoutHosts);
    } catch {
      throw new HttpError(503, "Account service returned an invalid checkout status");
    }
  } else if (value.checkoutUrl !== null) {
    throw new HttpError(503, "Account service returned an invalid checkout status");
  }

  return { ...(value as unknown as AuthoritativeCheckoutStatus), checkoutUrl };
}

function adapterVariant(config: CheckoutAdapterConfig, offerKey: string): string {
  const variant = config.variants[offerKey];
  if (!variant) throw new HttpError(503, "Checkout is not configured for this product");
  return variant;
}

async function createHostedSession(
  config: CheckoutAdapterConfig,
  input: {
    readonly operationId: string;
    readonly offerKey: string;
    readonly purchaseKind: HostedCheckoutExpectation["purchaseKind"];
    readonly amountMinorUnits?: number;
    readonly currencyCode?: string;
    readonly user: AuthUser;
  },
): Promise<VerifiedHostedCheckoutSession> {
  const hasAmount = input.amountMinorUnits != null;
  if (
    hasAmount !== (input.currencyCode != null)
    || (input.currencyCode != null && !/^[A-Z]{3}$/.test(input.currencyCode))
  ) throw new HttpError(503, "Checkout returned an invalid catalog amount");
  const variantId = adapterVariant(config, input.offerKey);
  const expected: HostedCheckoutExpectation = {
    operationId: input.operationId,
    purchaseKind: input.purchaseKind,
    offerKey: input.offerKey,
    variantId,
    amount: input.amountMinorUnits == null
      ? null
      : {
          currency: input.currencyCode as string,
          minorUnits: input.amountMinorUnits,
          exponent: 2,
        },
  };
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": input.operationId,
      },
      redirect: "error",
      body: JSON.stringify({
        operationId: input.operationId,
        variantId,
        offerKey: input.offerKey,
        purchaseKind: input.purchaseKind,
        amount: expected.amount,
        customer: { accountId: input.user.id, email: input.user.email },
        successUrl: config.successUrl,
        cancelUrl: config.cancelUrl,
        notificationUrl: config.webhookUrl,
        metadata: {
          operationId: input.operationId,
          purchaseKind: input.purchaseKind,
          offerKey: input.offerKey,
          variantId,
        },
      }),
    });
  } catch {
    throw new HttpError(503, "Checkout is temporarily unavailable");
  }
  const payload = await limitedJson(response);
  if (!response.ok || !isRecord(payload)) throw new HttpError(503, "Checkout is temporarily unavailable");
  try {
    return verifyHostedCheckoutSession(payload, expected, config.checkoutHosts);
  } catch {
    throw new HttpError(503, "Checkout returned a mismatched session");
  }
}

async function handleCheckout(request: Request, user: AuthUser): Promise<Response> {
  let input: CheckoutInput;
  try {
    input = parseCheckoutInput(await readJson(request));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The checkout request is invalid");
  }
  if (!CUSTOMER_GENERATION_GATEWAY_READY && (input.kind === "subscription" || input.kind === "top-up")) {
    throw new HttpError(503, "Customer plans are not available until generation access is ready");
  }
  if (!PARTNER_REVERSAL_HANDLING_READY && input.kind === "partner") {
    throw new HttpError(503, "Partner checkout is not available until reversal handling is ready");
  }
  let config: CheckoutAdapterConfig;
  try {
    config = parseCheckoutAdapterConfig(envRecord());
  } catch {
    throw new HttpError(503, "Checkout is not configured");
  }

  if (input.kind === "billing-portal") {
    const hosted = await createHostedSession(config, {
      operationId: input.requestId,
      offerKey: "billing-portal",
      purchaseKind: input.kind,
      user,
    });
    return json({
      checkoutUrl: hosted.checkoutUrl,
      intentId: input.requestId,
      requestId: input.requestId,
      checkoutKind: input.kind,
      checkoutExpiresAt: hosted.expiresAt,
    });
  }

  const prepared = preparedCheckout(await serviceRpc<unknown>("easyfield_account_prepare_checkout", {
    p_user_id: user.id,
    p_purchase_kind: input.kind,
    p_plan_key: input.kind === "subscription" ? input.planId : null,
    p_billing_interval: input.kind === "subscription" ? input.billingInterval : null,
    p_credit_microcredits: input.kind === "top-up" ? input.amountCreditMicros : null,
    p_idempotency_key: input.requestId,
    p_provider: config.providerId,
  }));

  const hosted = await createHostedSession(config, {
    operationId: prepared.intentId,
    offerKey: prepared.offerKey,
    purchaseKind: prepared.purchaseKind,
    amountMinorUnits: prepared.amountMinorUnits,
    currencyCode: prepared.currencyCode,
    user,
  });
  await serviceRpc("easyfield_account_open_checkout", {
    p_user_id: user.id,
    p_intent_id: prepared.intentId,
    p_purchase_kind: prepared.purchaseKind,
    p_provider: config.providerId,
    p_provider_checkout_ref: hosted.checkoutReference,
    p_checkout_url: hosted.checkoutUrl,
    p_expires_at: hosted.expiresAt,
  });
  return json({
    checkoutUrl: hosted.checkoutUrl,
    intentId: prepared.intentId,
    requestId: input.requestId,
    checkoutKind: input.kind,
    checkoutExpiresAt: hosted.expiresAt,
  });
}

async function handleCheckoutStatus(request: Request, user: AuthUser): Promise<Response> {
  let input: CheckoutStatusInput;
  try {
    input = parseCheckoutStatusInput(await readJson(request));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The checkout status request is invalid");
  }
  const value = await serviceRpc<unknown>("easyfield_account_checkout_status", {
    p_user_id: user.id,
    p_purchase_kind: input.kind,
    p_request_id: input.requestId,
  });
  // Missing, wrong-kind and foreign-account operations deliberately share one
  // response so this endpoint cannot be used to enumerate checkout records.
  if (value === null) throw new HttpError(404, "Checkout was not found");
  return json(authoritativeCheckoutStatus(value, input));
}

async function handleAutoReload(request: Request, user: AuthUser): Promise<Response> {
  let input: ReturnType<typeof parseAutoReloadInput>;
  try {
    input = parseAutoReloadInput(await readJson(request));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The auto-reload request is invalid");
  }
  if (input.policy.enabled && (!CUSTOMER_GENERATION_GATEWAY_READY || !checkoutAdapterReady())) {
    throw new HttpError(503, "Auto-reload is unavailable until customer billing and generation are ready");
  }
  await serviceRpc("easyfield_account_set_auto_reload", {
    p_user_id: user.id,
    p_enabled: input.policy.enabled,
    p_trigger_below_microcredits: input.policy.enabled ? input.policy.triggerBalanceCreditMicros : 0,
    p_reload_microcredits: input.policy.enabled ? input.policy.topUpAmountCreditMicros : 0,
    p_idempotency_key: input.requestId,
  });
  return json({ saved: true });
}

function parsePrivilegedSnapshot(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new HttpError(503, "Balance service returned an invalid response");
  const keys = new Set(["upstreamBalanceCreditMicros", "latestRawCostMoneyMicros", "latestRawCostCurrencyCode", "measuredAtMs"]);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new HttpError(503, "Balance service returned an invalid response");
  for (const field of ["upstreamBalanceCreditMicros", "latestRawCostMoneyMicros", "measuredAtMs"] as const) {
    if (value[field] != null && (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)) {
      throw new HttpError(503, "Balance service returned an invalid response");
    }
  }
  if (value.latestRawCostCurrencyCode != null && (typeof value.latestRawCostCurrencyCode !== "string" || !/^[A-Z]{3}$/.test(value.latestRawCostCurrencyCode))) {
    throw new HttpError(503, "Balance service returned an invalid response");
  }
  return value;
}

async function handlePrivilegedSnapshot(user: AuthUser): Promise<Response> {
  const allowed = await serviceRpc<boolean>("easyfield_account_has_direct_access", { p_user_id: user.id });
  if (allowed !== true) throw new HttpError(403, "This account is not eligible for direct billing");
  const endpoint = requiredEnv("EASYFIELD_PRIVILEGED_BALANCE_API_URL");
  const token = requiredEnv("EASYFIELD_PRIVILEGED_BALANCE_API_TOKEN");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error();
  } catch {
    throw new HttpError(503, "Balance service is not configured");
  }
  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-account-id": user.id },
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "Balance service is unavailable");
  }
  if (!response.ok) throw new HttpError(503, "Balance service is unavailable");
  return json(parsePrivilegedSnapshot(await limitedJson(response)));
}

async function handleDirectAccess(user: AuthUser): Promise<Response> {
  const allowed = await serviceRpc<boolean>("easyfield_account_has_direct_access", { p_user_id: user.id });
  if (typeof allowed !== "boolean") throw new HttpError(503, "Account service returned an invalid access decision");
  return json({ accountId: user.id, allowed });
}

function checkoutAdapterReady(): boolean {
  try {
    parseCheckoutAdapterConfig(envRecord());
    return true;
  } catch {
    return false;
  }
}

function handleServiceCapabilities(user: AuthUser): Response {
  const checkoutReady = checkoutAdapterReady();
  return json({
    accountId: user.id,
    customerGenerationReady: CUSTOMER_GENERATION_GATEWAY_READY,
    customerCheckoutAvailable: CUSTOMER_GENERATION_GATEWAY_READY && checkoutReady,
    partnerCheckoutAvailable: PARTNER_REVERSAL_HANDLING_READY && checkoutReady,
    billingPortalAvailable: checkoutReady,
  });
}

function routePath(request: Request): string {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const marker = "/easyfield-account";
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) || "/" : path;
}

Deno.serve(async (request) => {
  try {
    const path = routePath(request);
    const isGenerationGateway = path === "/gateway/provider"
      || path.startsWith("/gateway/provider/")
      || path === "/gateway/provider-upload"
      || path.startsWith("/gateway/provider-upload/");
    if (isGenerationGateway) {
      // Authenticate even while disabled so this endpoint cannot become an
      // unauthenticated capability probe. A paid generation gateway requires
      // an authoritative server price resolver plus atomic quote/reservation
      // and provider-task binding. Those contracts are not configured yet, so
      // forwarding would risk unbilled work and is deliberately fail-closed.
      await authenticate(request);
      try {
        classifyGenerationGatewayRequest(request, path);
      } catch (error) {
        if (error instanceof TypeError && error.message === "method-not-allowed") {
          throw new HttpError(405, "Method not allowed");
        }
        // Do not expose an arbitrary forwarding surface while the data plane
        // is disabled. Only exact, verified adapter routes reach the standard
        // fail-closed capability response.
        throw new HttpError(404, "Not found");
      }
      return json({
        error: "Generation gateway is not configured",
        code: "generation-gateway-unavailable",
      }, 503);
    }
    if ((path === "/privileged-snapshot" || path === "/direct-access" || path === "/service-capabilities") && request.method !== "GET") {
      throw new HttpError(405, "Method not allowed");
    }
    if ((path === "/checkout" || path === "/checkout-status" || path === "/auto-reload") && request.method !== "POST") {
      throw new HttpError(405, "Method not allowed");
    }
    if (!["/checkout", "/checkout-status", "/auto-reload", "/privileged-snapshot", "/direct-access", "/service-capabilities"].includes(path)) {
      throw new HttpError(404, "Not found");
    }
    const { user } = await authenticate(request);
    if (path === "/checkout") return await handleCheckout(request, user);
    if (path === "/checkout-status") return await handleCheckoutStatus(request, user);
    if (path === "/auto-reload") return await handleAutoReload(request, user);
    if (path === "/direct-access") return await handleDirectAccess(user);
    if (path === "/service-capabilities") return handleServiceCapabilities(user);
    return await handlePrivilegedSnapshot(user);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    return json({ error: "Account service is unavailable" }, 503);
  }
});
