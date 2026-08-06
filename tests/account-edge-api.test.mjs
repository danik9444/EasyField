import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const denoTests = [];
globalThis.Deno = {
  test(name, fn) {
    denoTests.push({ name, fn });
  },
};

await import("../supabase/functions/_shared/account_api_test.ts");
await import("../supabase/functions/_shared/generation_gateway_test.ts");

for (const item of denoTests) test(item.name, item.fn);

test("account Edge Function exposes generation routes as an authenticated fail-closed boundary", async () => {
  const source = await readFile(new URL("../supabase/functions/easyfield-account/index.ts", import.meta.url), "utf8");
  assert.match(source, /await authenticate\(request\)/);
  assert.match(source, /generation-gateway-unavailable/);
  assert.doesNotMatch(source, /EASYFIELD_GENERATION_GATEWAY_TOKEN/);
});

test("hosted checkout is verified against server-owned product identity before URL return", async () => {
  const source = await readFile(new URL("../supabase/functions/easyfield-account/index.ts", import.meta.url), "utf8");
  assert.match(source, /verifyHostedCheckoutSession\(payload, expected, config\.checkoutHosts\)/);
  assert.match(source, /requestId: input\.requestId/);
  assert.match(source, /checkoutKind: input\.kind/);
  assert.match(source, /checkoutExpiresAt: hosted\.expiresAt/);
});

test("paid products remain fail-closed behind their required operational safety gates", async () => {
  const source = await readFile(new URL("../supabase/functions/easyfield-account/index.ts", import.meta.url), "utf8");
  assert.match(source, /CUSTOMER_GENERATION_GATEWAY_READY = false/);
  assert.match(source, /PARTNER_REVERSAL_HANDLING_READY = false/);
  assert.match(source, /input\.kind === "partner"[\s\S]+reversal handling is ready/);
  assert.match(source, /customerCheckoutAvailable: CUSTOMER_GENERATION_GATEWAY_READY && checkoutReady/);
  assert.match(source, /partnerCheckoutAvailable: PARTNER_REVERSAL_HANDLING_READY && checkoutReady/);
  assert.match(source, /input\.policy\.enabled && \(!CUSTOMER_GENERATION_GATEWAY_READY \|\| !checkoutAdapterReady\(\)\)/);
  assert.match(source, /Auto-reload is unavailable until customer billing and generation are ready/);
});

test("direct access is decided by the authoritative database predicate on every Edge request", async () => {
  const source = await readFile(new URL("../supabase/functions/easyfield-account/index.ts", import.meta.url), "utf8");
  assert.match(source, /handleDirectAccess[\s\S]+easyfield_account_has_direct_access/);
  assert.match(source, /accountId: user\.id, allowed/);
  assert.match(source, /path === "\/direct-access"/);
});

test("checkout recovery reads authoritative intent status without exposing it in a URL", async () => {
  const source = await readFile(new URL("../supabase/functions/easyfield-account/index.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/202607150006_checkout_status_recovery.sql", import.meta.url), "utf8");
  assert.match(source, /parseCheckoutStatusInput\(await readJson\(request\)\)/);
  assert.match(source, /easyfield_account_checkout_status/);
  assert.match(source, /path === "\/checkout-status"/);
  assert.match(source, /request\.method !== "POST"/);
  assert.doesNotMatch(source, /searchParams\.get\(["']requestId/);
  assert.match(migration, /p_user_id uuid,[\s\S]+p_purchase_kind text,[\s\S]+p_request_id uuid/);
  assert.match(migration, /customer\.user_id = p_user_id/);
  assert.match(migration, /p_purchase_kind is null/);
  assert.match(migration, /reconcile duplicate ambiguous subscription intents first/);
  assert.match(migration, /reconcile duplicate ambiguous Partner intents first/);
  assert.match(migration, /revoke all on function public\.easyfield_account_checkout_status/);
  assert.match(migration, /grant execute[\s\S]+to service_role/);
});

test("payment webhook invokes one atomic, replay-safe reconciliation RPC", async () => {
  const accountMigration = await readFile(new URL("../supabase/migrations/202607150004_account_edge_api.sql", import.meta.url), "utf8");
  const reconciliationMigration = await readFile(new URL("../supabase/migrations/202607150005_atomic_payment_reconciliation.sql", import.meta.url), "utf8");
  const recoveryMigration = await readFile(new URL("../supabase/migrations/202607150006_checkout_status_recovery.sql", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../supabase/functions/easyfield-billing-webhook/index.ts", import.meta.url), "utf8");
  const accountApi = await readFile(new URL("../supabase/functions/_shared/account_api.ts", import.meta.url), "utf8");
  const reconcileFunction = reconciliationMigration.slice(
    reconciliationMigration.indexOf("create or replace function public.easyfield_account_reconcile_payment_event"),
  );
  // The RPC name became a parameter when reversal routing was added, so the
  // path is built from a closed union rather than written inline. The
  // invariant is unchanged: reconciliation goes through the atomic RPCs, and
  // the raw record RPC is never reachable from the edge.
  assert.match(webhook, /rpc\/\$\{rpc\}/);
  assert.match(
    webhook,
    /rpc:\s*"easyfield_account_reconcile_payment_event"\s*\|\s*"easyfield_account_reconcile_payment_reversal"/,
  );
  assert.match(webhook, /reconcileEvent\(\s*"easyfield_account_reconcile_payment_event"/);
  assert.doesNotMatch(webhook, /easyfield_account_record_payment_event/);
  assert.match(webhook, /EASYFIELD_WEBHOOK_TIMESTAMP_HEADER/);
  assert.match(webhook, /request\.headers\.get\(timestampHeader\),[\s\S]+rawBody/);
  assert.match(accountApi, /WEBHOOK_MAX_AGE_SECONDS = 5 \* 60/);
  assert.match(accountApi, /WEBHOOK_MAX_FUTURE_SKEW_SECONDS = 30/);
  assert.match(accountApi, /timestampedWebhookBytes\(timestamp, bytes\)/);
  assert.match(reconcileFunction, /billing_private\.record_payment_event/);
  assert.match(reconcileFunction, /billing_private\.claim_payment_event/);
  assert.match(reconcileFunction, /billing_private\.finish_payment_event/);
  assert.match(reconcileFunction, /update public\.checkout_intents/);
  assert.match(reconcileFunction, /insert into public\.subscriptions/);
  assert.match(reconcileFunction, /update public\.subscriptions[\s\S]+status = 'active'/);
  assert.match(reconcileFunction, /billing_private\.grant_credits/);
  assert.match(reconcileFunction, /billing_private\.set_partner_purchase_intent_state/);
  assert.match(reconcileFunction, /v_event\.status = 'processed'/);
  assert.match(reconcileFunction, /billing_private\.payment_entitlement_claims/);
  assert.match(reconcileFunction, /exception when others then[\s\S]+finish_payment_event\([\s\S]+?'failed'/);
  assert.match(reconcileFunction, /'processed', false/);
  assert.match(reconciliationMigration, /revoke all on function public\.easyfield_account_reconcile_payment_event/);
  assert.match(accountMigration, /revoke all on function public\.easyfield_account_prepare_checkout/);
  assert.match(accountMigration, /checkout_intents_one_payable_subscription_per_customer/);
  assert.match(accountMigration, /A subscription checkout is already awaiting payment/);
  assert.doesNotMatch(accountMigration, /update public\.checkout_intents\s+set status = 'expired'/);
  assert.match(recoveryMigration, /status in \('created', 'open', 'expired', 'cancelled', 'failed'\)/);
  assert.match(recoveryMigration, /reject_duplicate_active_subscription_checkout/);
  assert.doesNotMatch(recoveryMigration, /clock_timestamp\(\)[\s\S]+set status = 'expired'/);
});
