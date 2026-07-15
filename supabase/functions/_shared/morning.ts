import type {
  AmbiguousChargeResult,
  BillingCustomer,
  HostedPaymentRequest,
  HostedPaymentSession,
  MoneyAmount,
  SavedPaymentMethod,
  SavedPaymentMethodChargeRequest,
  SavedPaymentMethodChargeResult,
  SavedPaymentMethodPage,
  SavedPaymentMethodSearch,
  VerifiedBillingWebhook,
} from "./billing_contracts.ts";

/**
 * @deprecated Research scaffold only. Morning is document/accounting-only for
 * EasyField and is not an approved payment processor. Do not deploy, import or
 * call this adapter from a production billing flow.
 */
export const MORNING_PROVIDER_ID = "morning" as const;

export type MorningPaidDocumentType = 320 | 400 | 405 | 600;
export type MorningDocumentVatType = 0 | 1 | 2;
export type MorningItemVatType = 0 | 1 | 2;
export type MorningLanguage = "he" | "en";
export type MorningPaymentGroup = 100 | 110 | 120 | 150 | 160;
export type MorningCurrency = "ILS" | "USD" | "EUR" | "GBP";
export type MorningCardType = 0 | 1 | 2 | 3 | 4 | 5;
export type MorningTokenStatus = 0 | 1 | 2 | 3 | 4;
export type MorningEnvironment = "production" | "sandbox";

export const MORNING_MAX_MINOR_UNITS = 100_000_000;
export const MORNING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const MORNING_ENDPOINTS: Readonly<Record<MorningEnvironment, {
  readonly oauthTokenUrl: string;
  readonly paymentFormUrl: string;
  readonly tokenSearchUrl: string;
  readonly tokenChargeBaseUrl: string;
}>> = {
  production: {
    oauthTokenUrl: "https://api.morning.co/idp/v1/oauth/token",
    paymentFormUrl: "https://api.greeninvoice.co.il/api/v1/payments/form",
    tokenSearchUrl: "https://api.greeninvoice.co.il/api/v1/payments/tokens/search",
    tokenChargeBaseUrl: "https://api.greeninvoice.co.il/api/v1/payments/tokens/",
  },
  sandbox: {
    oauthTokenUrl: "https://api.sandbox.morning.dev/idp/v1/oauth/token",
    paymentFormUrl: "https://sandbox.d.greeninvoice.co.il/api/v1/payments/form",
    tokenSearchUrl: "https://sandbox.d.greeninvoice.co.il/api/v1/payments/tokens/search",
    tokenChargeBaseUrl: "https://sandbox.d.greeninvoice.co.il/api/v1/payments/tokens/",
  },
};

/**
 * Billing accepts only the payment topic. Morning signs the body but not the
 * topic header, so exposing a second topic with the same secret would make a
 * captured delivery reusable across endpoints.
 */
export type MorningWebhookTopic = "payment/received";

export interface MorningApiConfig {
  /** Selects an immutable set of official OAuth and payment endpoints. */
  readonly environment: MorningEnvironment;
  /** Exact HTTPS origins allowed for success, failure, and notification URLs. */
  readonly callbackOrigins: readonly string[];
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetcher?: typeof fetch;
}

export interface MorningAccessToken {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  /** Unix timestamp in seconds, as returned by Morning. */
  readonly expiresAtEpochSeconds: number;
}

export interface MorningIncomeRow {
  readonly catalogNum?: string;
  readonly description: string;
  /** Whole units only. Fractional quantities are intentionally unsupported. */
  readonly quantity: number;
  /** Exact gross unit price; must use the request currency and exponent 2. */
  readonly price: MoneyAmount;
  readonly vatType: MorningItemVatType;
}

export interface MorningPaymentDocumentOptions {
  readonly documentType: MorningPaidDocumentType;
  readonly vatType: MorningDocumentVatType;
  readonly language: MorningLanguage;
  readonly maxPayments?: number;
  readonly income?: readonly MorningIncomeRow[];
  readonly remarks?: string;
}

export interface MorningHostedPaymentRequest extends HostedPaymentRequest,
  MorningPaymentDocumentOptions {
  readonly pluginId?: string;
  readonly paymentGroup?: MorningPaymentGroup;
  readonly addCustomerToMorning?: boolean;
}

export interface MorningSavedTokenSearch extends SavedPaymentMethodSearch {
  readonly lastFour?: string;
  readonly cardHolder?: string;
  readonly cardTypes?: readonly MorningCardType[];
}

export interface MorningTokenChargeRequest extends SavedPaymentMethodChargeRequest,
  MorningPaymentDocumentOptions {}

export interface MorningWebhookHeaders {
  readonly topic: MorningWebhookTopic;
  readonly webhookId: string;
  readonly deliveryId: string;
  readonly timestamp: string;
  readonly correlationId: string;
  readonly userAgent: string;
  readonly signature: string;
}

export interface MorningPaymentTransactionSummary {
  readonly id?: string;
  readonly createdAt?: number;
  readonly amount?: MoneyAmount;
  readonly gatewayTransactionId?: string;
}

export interface MorningPaymentReceivedEvent {
  readonly type: "payment/received";
  readonly id?: string;
  readonly reconciliationState: "ready" | "needs_reconciliation";
  /** A verified delivery is never sufficient by itself to grant entitlement. */
  readonly entitlementGrantAllowed: false;
  readonly issues: readonly string[];
  readonly operationReference?: string;
  readonly total?: MoneyAmount;
  readonly transactions: readonly MorningPaymentTransactionSummary[];
}

export type MorningWebhookEvent = MorningPaymentReceivedEvent;

export interface MorningWebhookVerificationOptions {
  readonly secret: string | Uint8Array;
  /** Server-owned ID of the one payment webhook configured for this endpoint. */
  readonly expectedWebhookId: string;
  readonly maxAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
  readonly now?: Date;
}

export type MorningHeaderSource =
  | Headers
  | Readonly<Record<string, string | null | undefined>>;

export class MorningApiError extends Error {
  readonly status?: number;
  readonly providerCode?: string;

  constructor(
    message: string,
    details: { readonly status?: number; readonly providerCode?: string } = {},
  ) {
    super(message);
    this.name = "MorningApiError";
    this.status = details.status;
    this.providerCode = details.providerCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSafePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function requireSafeNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function parseHttpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} cannot contain credentials`);
  }
  return parsed;
}

function requireHttpsUrl(value: string, label: string): string {
  return parseHttpsUrl(value, label).toString();
}

function normalizeAllowedCallbackOrigin(value: string): string {
  const parsed = parseHttpsUrl(value, "Allowed callback origin");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Allowed callback origins must contain only scheme, host, and optional port");
  }
  return parsed.origin;
}

function requireAllowedCallbackUrl(
  value: string,
  label: string,
  allowedOrigins: readonly string[],
): string {
  const parsed = parseHttpsUrl(value, label);
  if (parsed.hash) throw new TypeError(`${label} cannot contain a fragment`);
  const normalizedOrigins = new Set(allowedOrigins.map(normalizeAllowedCallbackOrigin));
  if (!normalizedOrigins.has(parsed.origin)) {
    throw new TypeError(`${label} origin is not allowlisted`);
  }
  return parsed.toString();
}

function bearerHeaders(accessToken: string): Headers {
  const token = requireNonEmptyString(accessToken, "Morning access token");
  return new Headers({
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
  });
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function providerErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const candidate = payload.error ?? payload.errorCode;
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : undefined;
}

function validateApiConfig(config: MorningApiConfig): (typeof MORNING_ENDPOINTS)[MorningEnvironment] {
  if (config.environment !== "production" && config.environment !== "sandbox") {
    throw new TypeError("Morning environment must be production or sandbox");
  }
  if (!Array.isArray(config.callbackOrigins) || config.callbackOrigins.length === 0) {
    throw new TypeError("At least one EasyField callback origin must be configured");
  }
  config.callbackOrigins.forEach(normalizeAllowedCallbackOrigin);
  requireNonEmptyString(config.clientId, "Morning client ID");
  requireNonEmptyString(config.clientSecret, "Morning client secret");
  return MORNING_ENDPOINTS[config.environment];
}

export async function requestMorningAccessToken(
  config: MorningApiConfig,
  signal?: AbortSignal,
): Promise<MorningAccessToken> {
  const endpoints = validateApiConfig(config);
  const fetcher = config.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(endpoints.oauthTokenUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      signal,
    });
  } catch (error) {
    throw new MorningApiError(
      error instanceof Error ? `Morning token request failed: ${error.message}` : "Morning token request failed",
    );
  }

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new MorningApiError("Morning rejected the OAuth token request", {
      status: response.status,
      providerCode: providerErrorCode(payload),
    });
  }
  if (!isRecord(payload)) {
    throw new MorningApiError("Morning returned an invalid OAuth response", {
      status: response.status,
    });
  }

  const accessToken = requireNonEmptyString(payload.accessToken, "Morning OAuth accessToken");
  if (payload.tokenType !== "Bearer") {
    throw new MorningApiError("Morning returned an unsupported OAuth token type", {
      status: response.status,
    });
  }
  const expiresAtEpochSeconds = requireSafePositiveInteger(
    payload.expiresAt,
    "Morning OAuth expiresAt",
  );
  return { accessToken, tokenType: "Bearer", expiresAtEpochSeconds };
}

export function isMorningAccessTokenUsable(
  token: MorningAccessToken,
  nowEpochSeconds: number,
  minimumRemainingSeconds: number,
): boolean {
  if (!Number.isFinite(nowEpochSeconds) || !Number.isFinite(minimumRemainingSeconds)) {
    throw new TypeError("Token timing arguments must be finite numbers");
  }
  return token.expiresAtEpochSeconds - nowEpochSeconds > minimumRemainingSeconds;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_INCOME_QUANTITY = 10_000;

function requireBoundedText(value: unknown, label: string, maxLength: number): string {
  const text = requireNonEmptyString(value, label);
  if (text.length > maxLength || UNSAFE_TEXT_PATTERN.test(text)) {
    throw new TypeError(`${label} is too long or contains control characters`);
  }
  return text;
}

function requireOperationId(value: unknown, label: string): string {
  const operationId = requireNonEmptyString(value, label);
  if (operationId !== operationId.trim() || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new TypeError(`${label} must be 1-64 opaque ASCII letters, digits, dot, underscore, colon, or dash`);
  }
  return operationId;
}

function operationRemark(operationId: string, remarks: string | undefined): string {
  const reference = `EasyField operation: ${requireOperationId(operationId, "Charge operation ID")}`;
  if (!remarks) return reference;
  const safeRemarks = requireBoundedText(remarks, "Charge remarks", 900);
  return `${safeRemarks}\n${reference}`;
}

function assertMorningMoney(amount: MoneyAmount): number {
  if (!Number.isSafeInteger(amount.minorUnits) || amount.minorUnits <= 0) {
    throw new TypeError("Money minorUnits must be a positive safe integer");
  }
  if (amount.minorUnits > MORNING_MAX_MINOR_UNITS) {
    throw new TypeError("Money amount exceeds the EasyField charge safety cap");
  }
  if (amount.exponent !== 2) {
    throw new TypeError("Morning payment currencies require exponent 2");
  }
  if (!["ILS", "USD", "EUR", "GBP"].includes(amount.currency)) {
    throw new TypeError(`Morning does not document payment support for ${amount.currency}`);
  }
  return amount.minorUnits / 100;
}

function morningClient(customer: BillingCustomer, add: boolean | undefined): Record<string, unknown> {
  const name = requireBoundedText(customer.name, "Customer name", 200);
  const email = requireBoundedText(customer.email, "Customer email", 254);
  if (!SAFE_EMAIL_PATTERN.test(email)) throw new TypeError("Customer email is invalid");
  const result: Record<string, unknown> = {
    name,
    emails: [email],
    add: add ?? false,
  };
  if (customer.providerCustomerId) {
    result.id = requireBoundedText(customer.providerCustomerId, "Provider customer ID", 128);
  }
  if (customer.taxId) result.taxId = requireBoundedText(customer.taxId, "Customer tax ID", 64);
  if (customer.address) result.address = requireBoundedText(customer.address, "Customer address", 300);
  if (customer.city) result.city = requireBoundedText(customer.city, "Customer city", 100);
  if (customer.postalCode) result.zip = requireBoundedText(customer.postalCode, "Customer postal code", 32);
  if (customer.countryCode) {
    if (!/^[A-Z]{2}$/.test(customer.countryCode)) {
      throw new TypeError("Customer country code must be a two-letter upper-case ISO code");
    }
    result.country = customer.countryCode;
  }
  if (customer.phone) result.phone = requireBoundedText(customer.phone, "Customer phone", 40);
  return result;
}

function validateDocumentOptions(options: MorningPaymentDocumentOptions): void {
  if (![320, 400, 405, 600].includes(options.documentType)) {
    throw new TypeError("Unsupported Morning paid document type");
  }
  if (![0, 1, 2].includes(options.vatType)) {
    throw new TypeError("Unsupported Morning VAT type");
  }
  if (options.language !== "he" && options.language !== "en") {
    throw new TypeError("Unsupported Morning document language");
  }
  if (
    options.maxPayments !== undefined &&
    (!Number.isInteger(options.maxPayments) || options.maxPayments < 1 || options.maxPayments > 36)
  ) {
    throw new TypeError("Morning maxPayments must be between 1 and 36");
  }
}

function mapIncomeRows(
  rows: readonly MorningIncomeRow[] | undefined,
  expectedAmount: MoneyAmount,
): readonly Record<string, unknown>[] | undefined {
  if (!rows) return undefined;
  if (rows.length === 0) throw new TypeError("Morning income rows cannot be empty when supplied");
  assertMorningMoney(expectedAmount);
  let totalMinorUnits = 0;
  const mapped = rows.map((row, index) => {
    const description = requireBoundedText(row.description, `Income row ${index + 1} description`, 500);
    const quantity = requireSafePositiveInteger(row.quantity, `Income row ${index + 1} quantity`);
    if (quantity > MAX_INCOME_QUANTITY) throw new TypeError(`Income row ${index + 1} quantity is too large`);
    const price = assertMorningMoney(row.price);
    if (row.price.currency !== expectedAmount.currency) {
      throw new TypeError(`Income row ${index + 1} currency must match the payment currency`);
    }
    const rowMinorUnits = row.price.minorUnits * quantity;
    if (!Number.isSafeInteger(rowMinorUnits) || rowMinorUnits > MORNING_MAX_MINOR_UNITS) {
      throw new TypeError(`Income row ${index + 1} total exceeds the charge safety cap`);
    }
    totalMinorUnits += rowMinorUnits;
    if (!Number.isSafeInteger(totalMinorUnits) || totalMinorUnits > MORNING_MAX_MINOR_UNITS) {
      throw new TypeError("Income row total exceeds the charge safety cap");
    }
    if (![0, 1, 2].includes(row.vatType)) {
      throw new TypeError(`Unsupported VAT type in income row ${index + 1}`);
    }
    return {
      ...(row.catalogNum
        ? { catalogNum: requireBoundedText(row.catalogNum, `Income row ${index + 1} catalog number`, 100) }
        : {}),
      description,
      quantity,
      price,
      currency: row.price.currency,
      vatType: row.vatType,
    };
  });
  if (totalMinorUnits !== expectedAmount.minorUnits) {
    throw new TypeError("Income rows must reconcile exactly to the payment amount in minor units");
  }
  return mapped;
}

export function buildMorningPaymentFormBody(
  config: MorningApiConfig,
  request: MorningHostedPaymentRequest,
): Readonly<Record<string, unknown>> {
  validateApiConfig(config);
  validateDocumentOptions(request);
  const operationId = requireOperationId(request.operationId, "Payment operation ID");
  const body: Record<string, unknown> = {
    description: requireBoundedText(request.description, "Payment description", 500),
    type: request.documentType,
    amount: assertMorningMoney(request.amount),
    currency: request.amount.currency,
    vatType: request.vatType,
    lang: request.language,
    client: morningClient(request.customer, request.addCustomerToMorning),
    successUrl: requireAllowedCallbackUrl(
      request.successUrl,
      "Payment success URL",
      config.callbackOrigins,
    ),
    failureUrl: requireAllowedCallbackUrl(
      request.failureUrl,
      "Payment failure URL",
      config.callbackOrigins,
    ),
    notifyUrl: requireAllowedCallbackUrl(
      request.notificationUrl,
      "Payment notification URL",
      config.callbackOrigins,
    ),
    // Keep this provider correlation field opaque. Allowing display text here
    // risks leaking an email, project title, or other PII into callbacks.
    custom: operationId,
  };
  if (request.maxPayments !== undefined) body.maxPayments = request.maxPayments;
  if (request.pluginId) body.pluginId = requireBoundedText(request.pluginId, "Payment plugin ID", 128);
  if (request.paymentGroup !== undefined) body.group = request.paymentGroup;
  if (request.income) body.income = mapIncomeRows(request.income, request.amount);
  if (request.remarks) body.remarks = requireBoundedText(request.remarks, "Payment remarks", 1_000);
  return body;
}

export async function createMorningHostedPaymentForm(
  config: MorningApiConfig,
  accessToken: string,
  request: MorningHostedPaymentRequest,
  signal?: AbortSignal,
): Promise<HostedPaymentSession> {
  const endpoints = validateApiConfig(config);
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(endpoints.paymentFormUrl, {
    method: "POST",
    headers: bearerHeaders(accessToken),
    body: JSON.stringify(buildMorningPaymentFormBody(config, request)),
    redirect: "error",
    signal,
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new MorningApiError("Morning rejected the hosted payment form request", {
      status: response.status,
      providerCode: providerErrorCode(payload),
    });
  }
  if (
    !isRecord(payload) || payload.success !== true || payload.errorCode !== 0 ||
    typeof payload.url !== "string"
  ) {
    throw new MorningApiError("Morning returned an invalid hosted payment form response", {
      status: response.status,
      providerCode: providerErrorCode(payload),
    });
  }
  return {
    provider: MORNING_PROVIDER_ID,
    operationId: request.operationId,
    checkoutUrl: requireHttpsUrl(payload.url, "Morning checkout URL"),
    state: "created",
  };
}

function parseTokenStatus(status: unknown): SavedPaymentMethod["state"] {
  if (status === 1 || status === 2) return "active";
  if (status === 4) return "expired";
  if (status === 0 || status === 3) return "inactive";
  return "unknown";
}

function parseExpiry(expires: string): { expiryMonth?: number; expiryYear?: number } {
  if (!/^\d{4}$/.test(expires)) return {};
  const expiryMonth = Number(expires.slice(0, 2));
  const expiryYear = 2000 + Number(expires.slice(2));
  if (expiryMonth < 1 || expiryMonth > 12) return {};
  return { expiryMonth, expiryYear };
}

function cardDisplayName(cardType: unknown, lastFour: string): string {
  const names: Readonly<Record<number, string>> = {
    0: "Card",
    1: "Isracard",
    2: "Visa",
    3: "Mastercard",
    4: "American Express",
    5: "Diners",
  };
  return `${typeof cardType === "number" ? names[cardType] ?? "Card" : "Card"} •••• ${lastFour}`;
}

export async function searchMorningSavedTokens(
  config: MorningApiConfig,
  accessToken: string,
  search: MorningSavedTokenSearch,
  signal?: AbortSignal,
): Promise<SavedPaymentMethodPage> {
  const endpoints = validateApiConfig(config);
  const providerCustomerId = requireBoundedText(
    search.providerCustomerId,
    "Provider customer ID",
    128,
  );
  const requestBody: Record<string, unknown> = { externalKey: providerCustomerId };
  if (search.page !== undefined) {
    requestBody.page = requireSafePositiveInteger(search.page, "Morning token search page");
  }
  if (search.pageSize !== undefined) {
    const pageSize = requireSafePositiveInteger(search.pageSize, "Morning token search page size");
    if (pageSize > 100) throw new TypeError("Morning token search page size cannot exceed 100");
    requestBody.pageSize = pageSize;
  }
  if (search.lastFour) {
    if (!/^\d{4}$/.test(search.lastFour)) throw new TypeError("Card last four must contain four digits");
    requestBody.paymentNumber = search.lastFour;
  }
  if (search.cardHolder) {
    requestBody.cardHolder = requireBoundedText(search.cardHolder, "Card holder", 200);
  }
  if (search.cardTypes) {
    if (
      search.cardTypes.length === 0 ||
      search.cardTypes.some((cardType) => ![0, 1, 2, 3, 4, 5].includes(cardType))
    ) {
      throw new TypeError("Morning card type filter is invalid");
    }
    requestBody.cardType = [...new Set(search.cardTypes)];
  }

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(endpoints.tokenSearchUrl, {
    method: "POST",
    headers: bearerHeaders(accessToken),
    body: JSON.stringify(requestBody),
    redirect: "error",
    signal,
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok || !isRecord(payload) || !Array.isArray(payload.items)) {
    throw new MorningApiError("Morning saved-token search failed", {
      status: response.status,
      providerCode: providerErrorCode(payload),
    });
  }

  const items = payload.items.map((raw, index): SavedPaymentMethod => {
    if (!isRecord(raw)) throw new MorningApiError(`Morning token ${index + 1} is invalid`);
    const id = requireNonEmptyString(raw.id, `Morning token ${index + 1} ID`);
    const lastFour = requireNonEmptyString(raw.number, `Morning token ${index + 1} last four`);
    if (!/^\d{4}$/.test(lastFour)) throw new MorningApiError(`Morning token ${index + 1} last four is invalid`);
    if (raw.externalKey !== providerCustomerId) {
      throw new MorningApiError("Morning returned a saved token outside the requested customer scope");
    }
    const expires = typeof raw.expires === "string" ? parseExpiry(raw.expires) : {};
    const currencies = Array.isArray(raw.currencies)
      ? raw.currencies.filter((value): value is string => typeof value === "string")
      : [];
    return {
      provider: MORNING_PROVIDER_ID,
      id,
      providerCustomerId,
      displayName: cardDisplayName(raw.cardType, lastFour),
      lastFour,
      ...expires,
      state: parseTokenStatus(raw.status),
      supportedCurrencies: currencies,
    };
  });

  return {
    items,
    page: requireSafePositiveInteger(payload.page, "Morning token result page"),
    pageSize: requireSafePositiveInteger(payload.pageSize, "Morning token result pageSize"),
    total: requireSafeNonNegativeInteger(payload.total, "Morning token result total"),
    pages: requireSafeNonNegativeInteger(payload.pages, "Morning token result pages"),
  };
}

export function buildMorningTokenChargeBody(
  config: MorningApiConfig,
  request: MorningTokenChargeRequest,
): Readonly<Record<string, unknown>> {
  validateApiConfig(config);
  validateDocumentOptions(request);
  const operationId = requireOperationId(request.operationId, "Charge operation ID");
  requireBoundedText(request.paymentMethodId, "Morning payment token ID", 200);
  const body: Record<string, unknown> = {
    description: requireBoundedText(request.description, "Charge description", 500),
    type: request.documentType,
    amount: assertMorningMoney(request.amount),
    currency: request.amount.currency,
    vatType: request.vatType,
    lang: request.language,
    notifyUrl: requireAllowedCallbackUrl(
      request.notificationUrl,
      "Charge notification URL",
      config.callbackOrigins,
    ),
    remarks: operationRemark(operationId, request.remarks),
  };
  if (request.maxPayments !== undefined) body.maxPayments = request.maxPayments;
  if (request.income) body.income = mapIncomeRows(request.income, request.amount);
  return body;
}

function unknownCharge(
  operationId: string,
  reason: AmbiguousChargeResult["reason"],
  providerStatus?: number,
): AmbiguousChargeResult {
  return {
    provider: MORNING_PROVIDER_ID,
    operationId,
    state: "unknown",
    definitive: false,
    reason,
    nextAction: "reconcile_before_retry",
    automaticRetryAllowed: false,
    ...(providerStatus === undefined ? {} : { providerStatus }),
  };
}

function isAmbiguousHttpStatus(status: number): boolean {
  return (status >= 300 && status < 400) || status >= 500 ||
    status === 408 || status === 409 || status === 425 || status === 429;
}

function isValidChargeSuccessPayload(
  payload: unknown,
  request: MorningTokenChargeRequest,
): payload is Record<string, unknown> & { id: string } {
  if (!isRecord(payload)) return false;
  if (
    typeof payload.id !== "string" || payload.id.trim().length === 0 || payload.id.length > 200 ||
    !Number.isSafeInteger(payload.number) || Number(payload.number) <= 0 ||
    payload.type !== request.documentType ||
    typeof payload.signed !== "boolean" ||
    payload.lang !== request.language ||
    !isRecord(payload.client) ||
    !isRecord(payload.url)
  ) {
    return false;
  }
  if (
    payload.client.id !== undefined &&
    (typeof payload.client.id !== "string" || payload.client.id.trim().length === 0)
  ) {
    return false;
  }
  for (const key of ["origin", "he", "en"] as const) {
    const candidate = payload.url[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") return false;
    try {
      requireHttpsUrl(candidate, `Morning charge response URL ${key}`);
    } catch {
      return false;
    }
  }
  if (
    payload.transactionId !== undefined &&
    (typeof payload.transactionId !== "string" || payload.transactionId.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

/**
 * Executes exactly one saved-token charge request.
 *
 * Morning documents no idempotency key for this endpoint. Transport failures,
 * ambiguous HTTP statuses, and malformed success responses therefore return an
 * `unknown` result. Callers must reconcile and must not automatically retry.
 */
export async function chargeMorningSavedTokenOnce(
  config: MorningApiConfig,
  accessToken: string,
  request: MorningTokenChargeRequest,
  signal?: AbortSignal,
): Promise<SavedPaymentMethodChargeResult> {
  const endpoints = validateApiConfig(config);
  const body = buildMorningTokenChargeBody(config, request);
  const tokenId = encodeURIComponent(requireBoundedText(request.paymentMethodId, "Morning payment token ID", 200));
  const fetcher = config.fetcher ?? fetch;

  let response: Response;
  try {
    response = await fetcher(`${endpoints.tokenChargeBaseUrl}${tokenId}/charge`, {
      method: "POST",
      headers: bearerHeaders(accessToken),
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "AbortError"
      ? "provider_timeout"
      : "transport_error";
    return unknownCharge(request.operationId, reason);
  }

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    if (isAmbiguousHttpStatus(response.status)) {
      return unknownCharge(
        request.operationId,
        response.status >= 500 ? "provider_unavailable" : "ambiguous_http_status",
        response.status,
      );
    }
    return {
      provider: MORNING_PROVIDER_ID,
      operationId: request.operationId,
      state: "failed",
      definitive: true,
      reason: providerErrorCode(payload) ?? `http_${response.status}`,
      providerStatus: response.status,
      automaticRetryAllowed: false,
    };
  }

  if (!isValidChargeSuccessPayload(payload, request)) {
    return unknownCharge(request.operationId, "invalid_success_response", response.status);
  }
  return {
    provider: MORNING_PROVIDER_ID,
    operationId: request.operationId,
    state: "succeeded",
    providerDocumentId: payload.id,
    providerTransactionId: typeof payload.transactionId === "string" ? payload.transactionId : undefined,
    automaticRetryAllowed: false,
  };
}

function secretBytes(secret: string | Uint8Array): Uint8Array {
  const bytes = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (bytes.byteLength === 0) throw new TypeError("Morning webhook secret cannot be empty");
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function computeMorningWebhookHmacHex(
  rawBody: Uint8Array,
  secret: string | Uint8Array,
): Promise<string> {
  if (!(rawBody instanceof Uint8Array)) {
    throw new TypeError("Morning webhook body must be raw bytes");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, rawBody);
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyMorningWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  secret: string | Uint8Array,
): Promise<boolean> {
  const supplied = hexToBytes(signature.trim());
  if (!supplied) return false;
  const expected = hexToBytes(await computeMorningWebhookHmacHex(rawBody, secret));
  return expected !== undefined && constantTimeEqual(expected, supplied);
}

function readHeader(source: MorningHeaderSource, name: string): string | undefined {
  if (source instanceof Headers) return source.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === wanted && typeof value === "string") return value;
  }
  return undefined;
}

function readRequiredHeader(source: MorningHeaderSource, name: string): string {
  return requireNonEmptyString(readHeader(source, name), `Morning ${name} header`);
}

export function validateMorningWebhookHeaders(
  source: MorningHeaderSource,
  expectedWebhookId: string,
): MorningWebhookHeaders {
  const topic = readRequiredHeader(source, "x-webhook-topic");
  if (topic !== "payment/received") throw new TypeError(`Unexpected Morning webhook topic: ${topic}`);
  const webhookId = requireBoundedText(expectedWebhookId, "Expected Morning webhook ID", 300);
  if (readRequiredHeader(source, "x-webhook-id") !== webhookId) {
    throw new TypeError("Unexpected Morning webhook ID");
  }
  const userAgent = readRequiredHeader(source, "user-agent");
  if (!/^morning webhooks(?:\s|\/)/i.test(userAgent)) {
    throw new TypeError("Unexpected Morning webhook user-agent");
  }
  return {
    topic,
    webhookId,
    deliveryId: readRequiredHeader(source, "x-webhook-delivery-id"),
    timestamp: readRequiredHeader(source, "x-webhook-timestamp"),
    correlationId: readRequiredHeader(source, "x-correlation-id"),
    userAgent,
    signature: readRequiredHeader(source, "x-webhook-signature"),
  };
}

function validateDeliveryTime(
  timestamp: string,
  now: Date,
  maxAgeSeconds: number,
  maxFutureSkewSeconds: number,
): void {
  if (
    !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0 ||
    !Number.isFinite(maxFutureSkewSeconds) || maxFutureSkewSeconds < 0
  ) {
    throw new TypeError("Morning webhook time windows must be finite non-negative numbers");
  }
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new TypeError("Morning webhook comparison time is invalid");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(timestamp);
  if (!match) throw new TypeError("Morning webhook timestamp must be canonical UTC ISO-8601");
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const emittedAt = Date.parse(normalized);
  if (!Number.isFinite(emittedAt) || new Date(emittedAt).toISOString() !== normalized) {
    throw new TypeError("Morning webhook timestamp is invalid");
  }
  const ageMilliseconds = nowMilliseconds - emittedAt;
  if (ageMilliseconds > maxAgeSeconds * 1000) throw new TypeError("Morning webhook is too old");
  if (ageMilliseconds < -maxFutureSkewSeconds * 1000) {
    throw new TypeError("Morning webhook timestamp is too far in the future");
  }
}

function optionalSafeString(
  value: unknown,
  issuePrefix: string,
  issues: string[],
  maxLength = 200,
): string | undefined {
  if (value === undefined) {
    issues.push(`${issuePrefix}_missing`);
    return undefined;
  }
  if (
    typeof value !== "string" || value.trim().length === 0 || value.length > maxLength ||
    UNSAFE_TEXT_PATTERN.test(value)
  ) {
    issues.push(`${issuePrefix}_invalid`);
    return undefined;
  }
  return value;
}

function majorNumberToMoney(
  value: unknown,
  currency: MorningCurrency | undefined,
  issuePrefix: string,
  issues: string[],
): MoneyAmount | undefined {
  if (currency === undefined) {
    issues.push(`${issuePrefix}_currency_missing`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push(`${issuePrefix}_invalid`);
    return undefined;
  }
  const scaled = value * 100;
  const minorUnits = Math.round(scaled);
  if (
    !Number.isSafeInteger(minorUnits) || minorUnits > MORNING_MAX_MINOR_UNITS ||
    Math.abs(scaled - minorUnits) > 1e-7
  ) {
    issues.push(`${issuePrefix}_precision_or_limit_invalid`);
    return undefined;
  }
  return { currency, minorUnits, exponent: 2 };
}

function parsePaymentTransaction(
  value: unknown,
  index: number,
  issues: string[],
): MorningPaymentTransactionSummary {
  const prefix = `transaction_${index + 1}`;
  if (!isRecord(value)) {
    issues.push(`${prefix}_invalid`);
    return {};
  }
  const id = optionalSafeString(value.id, `${prefix}_id`, issues);
  const currency = typeof value.currency === "string" &&
      ["ILS", "USD", "EUR", "GBP"].includes(value.currency)
    ? value.currency as MorningCurrency
    : undefined;
  if (currency === undefined) issues.push(`${prefix}_currency_invalid`);
  const amount = majorNumberToMoney(value.total, currency, `${prefix}_total`, issues);
  let createdAt: number | undefined;
  if (value.createdAt !== undefined) {
    if (Number.isSafeInteger(value.createdAt) && Number(value.createdAt) > 0) {
      createdAt = Number(value.createdAt);
    } else {
      issues.push(`${prefix}_created_at_invalid`);
    }
  }
  let gatewayTransactionId: string | undefined;
  if (value.gatewayTransactionId !== undefined) {
    gatewayTransactionId = optionalSafeString(
      value.gatewayTransactionId,
      `${prefix}_gateway_transaction_id`,
      issues,
    );
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(amount === undefined ? {} : { amount }),
    ...(gatewayTransactionId === undefined ? {} : { gatewayTransactionId }),
  };
}

function safeOperationReference(custom: unknown): string | undefined {
  const candidate = typeof custom === "string"
    ? custom
    : isRecord(custom) && typeof custom.operationId === "string"
    ? custom.operationId
    : undefined;
  return candidate !== undefined && OPERATION_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function parseMorningWebhookEvent(payload: unknown): MorningWebhookEvent {
  if (!isRecord(payload)) throw new TypeError("Morning webhook JSON body must be an object");
  const issues: string[] = [];
  const id = optionalSafeString(payload.id, "provider_event_id", issues);
  const operationReference = safeOperationReference(payload.custom);
  if (operationReference === undefined) issues.push("operation_reference_missing");
  const transactionValues = Array.isArray(payload.transactions) ? payload.transactions : [];
  if (transactionValues.length === 0) issues.push("transactions_missing");
  const transactions = transactionValues.map((value, index) => parsePaymentTransaction(value, index, issues));
  const transactionCurrencies = new Set(
    transactions.flatMap((transaction) => transaction.amount ? [transaction.amount.currency] : []),
  );
  const currency = transactionCurrencies.size === 1
    ? [...transactionCurrencies][0] as MorningCurrency
    : undefined;
  if (transactionCurrencies.size > 1) issues.push("mixed_transaction_currencies");
  const total = majorNumberToMoney(payload.total, currency, "payment_total", issues);
  if (total && transactions.length > 0 && transactions.every((transaction) => transaction.amount)) {
    const transactionTotal = transactions.reduce(
      (sum, transaction) => sum + (transaction.amount?.minorUnits ?? 0),
      0,
    );
    if (transactionTotal !== total.minorUnits) issues.push("transaction_total_mismatch");
  }
  return {
    type: "payment/received",
    ...(id === undefined ? {} : { id }),
    reconciliationState: issues.length === 0 ? "ready" : "needs_reconciliation",
    entitlementGrantAllowed: false,
    issues,
    ...(operationReference === undefined ? {} : { operationReference }),
    ...(total === undefined ? {} : { total }),
    transactions,
  };
}

async function sha256Hex(rawBody: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", rawBody);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Verifies the HMAC over the exact raw bytes before parsing JSON.
 *
 * The caller must persist the signed-body SHA-256, deliveryId, and an optional
 * providerEventId with unique constraints. Morning signs the body, not the
 * delivery headers, so timestamp validation alone cannot prevent replay.
 */
export async function verifyMorningWebhookDelivery(
  headersSource: MorningHeaderSource,
  rawBody: Uint8Array,
  receivedAt: Date,
  options: MorningWebhookVerificationOptions,
): Promise<VerifiedBillingWebhook<MorningWebhookEvent>> {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError("Morning webhook body must be raw bytes");
  if (rawBody.byteLength > MORNING_WEBHOOK_MAX_BODY_BYTES) {
    throw new TypeError("Morning webhook body exceeds the maximum accepted size");
  }
  if (!Number.isFinite(receivedAt.getTime())) throw new TypeError("Morning webhook receivedAt is invalid");
  const headers = validateMorningWebhookHeaders(headersSource, options.expectedWebhookId);
  const signatureValid = await verifyMorningWebhookSignature(
    rawBody,
    headers.signature,
    options.secret,
  );
  if (!signatureValid) throw new TypeError("Morning webhook signature is invalid");
  const now = options.now ?? receivedAt;
  validateDeliveryTime(headers.timestamp, now, options.maxAgeSeconds, options.maxFutureSkewSeconds);

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw new TypeError("Morning webhook body is not valid UTF-8 JSON");
  }
  const event = parseMorningWebhookEvent(decoded);
  const signedBodySha256 = await sha256Hex(rawBody);
  return {
    provider: MORNING_PROVIDER_ID,
    webhookId: headers.webhookId,
    deliveryId: headers.deliveryId,
    correlationId: headers.correlationId,
    topic: headers.topic,
    emittedAt: headers.timestamp,
    receivedAt: receivedAt.toISOString(),
    ...(event.id === undefined ? {} : { providerEventId: event.id }),
    signedBodySha256,
    event,
  };
}
