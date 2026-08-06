import {
  MAX_WEBHOOK_BYTES,
  type ParsedBillingWebhook,
  parseBillingWebhook,
  sha256Hex,
  UnhandledWebhookTopicError,
  verifyWebhookHmac,
} from "../_shared/account_api.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new HttpError(503, "Webhook is not configured");
  return value;
}

function safeHeaderName(value: string | undefined, fallback: string): string {
  const name = (value ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9-]{1,80}$/.test(name)) throw new HttpError(503, "Webhook is not configured");
  return name;
}

function supabaseBaseUrl(): string {
  const value = requiredEnv("SUPABASE_URL");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(503, "Webhook is not configured");
  }
}

async function reconcileEvent(
  rpc: "easyfield_account_reconcile_payment_event" | "easyfield_account_reconcile_payment_reversal",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let response: Response;
  try {
    response = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        apikey: key,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "Webhook storage is unavailable");
  }
  if (!response.ok) throw new HttpError(503, "Payment reconciliation is unavailable");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(503, "Payment reconciliation is unavailable");
  }
  if (
    typeof payload !== "object"
    || payload === null
    || Array.isArray(payload)
    || (payload as Record<string, unknown>).processed !== true
  ) throw new HttpError(503, "Payment reconciliation is unavailable");
  return payload as Record<string, unknown>;
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) throw new HttpError(413, "Webhook is too large");
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
      throw new HttpError(413, "Webhook is too large");
    }

    const signatureHeader = safeHeaderName(
      Deno.env.get("EASYFIELD_WEBHOOK_SIGNATURE_HEADER"),
      "x-signature",
    );
    const deliveryHeader = safeHeaderName(
      Deno.env.get("EASYFIELD_WEBHOOK_DELIVERY_HEADER"),
      "x-delivery-id",
    );
    const timestampHeader = safeHeaderName(
      Deno.env.get("EASYFIELD_WEBHOOK_TIMESTAMP_HEADER"),
      "x-timestamp",
    );
    const verified = await verifyWebhookHmac(
      requiredEnv("EASYFIELD_WEBHOOK_SECRET"),
      request.headers.get(timestampHeader),
      rawBody,
      request.headers.get(signatureHeader),
    );
    if (!verified) throw new HttpError(401, "Invalid webhook signature");

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
    } catch {
      throw new HttpError(400, "Webhook body is invalid");
    }
    let parsed: ParsedBillingWebhook;
    try {
      parsed = parseBillingWebhook(decoded, request.headers.get(deliveryHeader) ?? "");
    } catch (error) {
      // These two outcomes are opposite and must stay that way. A provider
      // emits many topics on one endpoint; refusing an unrecognised one makes
      // it retry forever. But a malformed body of a topic we DO handle has to
      // be refused — acknowledging it tells the provider a real payment was
      // received and stops the retry that is the customer's only recourse.
      if (error instanceof UnhandledWebhookTopicError) {
        return json({ accepted: true, processed: false, ignored: true }, 200);
      }
      throw new HttpError(400, "Webhook body is invalid");
    }
    const provider = requiredEnv("EASYFIELD_BILLING_PROVIDER_ID").toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider)) throw new HttpError(503, "Webhook is not configured");
    const rawBodySha256 = await sha256Hex(rawBody);

    if (parsed.kind === "reversal") {
      const { reversal } = parsed;
      const reconciliation = await reconcileEvent(
        "easyfield_account_reconcile_payment_reversal",
        {
          p_provider: provider,
          p_provider_event_id: reversal.reversalReference,
          p_provider_delivery_id: reversal.deliveryId,
          p_raw_body_sha256: rawBodySha256,
          p_payload: reversal.reversalPayload,
        },
      );
      return json({
        accepted: true,
        processed: true,
        reversed: true,
        replayed: reconciliation.replayed === true,
      }, 200);
    }

    const { payment } = parsed;
    const reconciliation = await reconcileEvent(
      "easyfield_account_reconcile_payment_event",
      {
        p_provider: provider,
        p_provider_event_id: payment.paymentReference,
        p_provider_delivery_id: payment.deliveryId,
        p_raw_body_sha256: rawBodySha256,
        p_payload: payment.reconciliationPayload,
      },
    );

    return json({
      accepted: true,
      processed: true,
      replayed: reconciliation.replayed === true,
    }, 200);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    return json({ error: "Webhook is unavailable" }, 503);
  }
});
