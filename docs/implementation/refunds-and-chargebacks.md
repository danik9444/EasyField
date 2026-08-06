# Refund and chargeback ingestion, provider-agnostically (webhook contract → normalized reversal event → per-operation reversal handling → append-only evidence → PARTNER_REVERSAL_HANDLING_READY)

## Current state
VERIFIED — all four audit findings are correct, with these corrections and additions.

1. ONE EVENT SHAPE. `supabase/functions/_shared/account_api.ts:357-414` `parsePaymentWebhook` requires exact keys `["type","paymentReference","operationReference","amount","subscriptionReference","periodStart","periodEnd"]` and `value.type !== "payment.completed"` throws `"Unsupported webhook event"`. `supabase/functions/easyfield-billing-webhook/index.ts:126-129` turns any throw into HTTP 400 `"Webhook body is invalid"` — a reversal is not dropped silently, it is rejected with a 400, which most providers retry forever. The refusal is deeper than the parser: `billing_private.record_payment_event` (`202607140001_subscription_billing.sql:3257`) hard-fails on `v_event_type is distinct from 'payment/received'`, and `billing_private.payment_reconciliation_payload_is_valid` (`202607150005_atomic_payment_reconciliation.sql:68-77`) rejects `total`/`transactions` for any non-`payment/received` type and allows no unknown top-level keys. So three layers must be extended, not one.

Signature verification (correct, provider-neutral, keep): `verifyWebhookHmac(secret, timestamp, rawBody, signature)` at `account_api.ts:457-479` — HMAC-SHA256 over `"<timestamp>." || rawBody`, constant-time compare, ±`WEBHOOK_MAX_AGE_SECONDS`=300 / `WEBHOOK_MAX_FUTURE_SKEW_SECONDS`=30. Header names come from `EASYFIELD_WEBHOOK_SIGNATURE_HEADER` / `_DELIVERY_HEADER` / `_TIMESTAMP_HEADER`, each re-validated by `safeHeaderName` against `^[a-z0-9-]{1,80}$`.

operationReference resolution (payment path): the signed body carries `operationReference` (a UUID), and `public.easyfield_account_reconcile_payment_event` (`202607150005:221`) casts it and requires it to match EXACTLY ONE of `public.checkout_intents.id` or `billing_private.partner_purchase_intents.id` (`v_has_checkout = v_has_partner` → raise, line 267). Provider/currency/exponent/minor-units are all re-asserted against our own row before anything is claimed.

2. `billing_private.revoke_partner_entitlement(uuid, text, text)` — `202607150003_partner_lifetime_access.sql:420-470`. Requires `p_terminal_status in ('revoked','refunded','chargeback')` and a 3..1000 char reason; locks `public.partner_entitlements` by `customer_id FOR UPDATE`; raises `23503` if absent. It is one-way and correct. Its idempotency is CONDITIONAL, not unconditional: it returns the existing row only when `status = p_terminal_status AND revocation_reason = v_reason` (line 451-455); any other terminal status/reason raises `55000`. A caller must therefore derive a DETERMINISTIC reason string, or a webhook redelivery will fail the transaction. Callers: ZERO. `grep -rn revoke_partner_entitlement` returns only its definition (`:420`), its `revoke`/`grant` lines (`:880`, `:900`), and three SQL-text assertions in `tests/subscription-schema.test.mjs:859,897,901`.

3. CHARGEBACK LEAVES $999 ACTIVE FOREVER. Confirmed: `public.partner_entitlements` (`202607150003:357-384`) has `status in ('active','revoked','refunded','chargeback')` and `ends_at timestamptz check (ends_at is null)`; activation (`activate_partner_lifetime_entitlement`, `:472`) writes `'active'` with `ends_at = null`; `billing_private.is_active_partner` (`:693`) returns true for `entitlement.status = 'active' and ends_at is null`, and `can_use_direct_provider_billing` (`:721`) is what gates raw-provider access. Nothing in the tree ever moves that row off `'active'`.

4. `PARTNER_REVERSAL_HANDLING_READY = false` at `supabase/functions/easyfield-account/index.ts:35`. Two runtime uses (`:352` 503 on `input.kind === "partner"`, `:515` `partnerCheckoutAvailable`), and — the part that matters — two build-gate uses in `scripts/release-account-config.mjs`: `:320` `assertProjectReleaseAccountConfig` FAILS the production release while it is `false`, and `:359` `assertCiAccountReleaseStructure` FAILS while it is NOT `false`. The two gates are mutually exclusive by design. Test pins: `tests/account-edge-api.test.mjs:35,38`; `tests/release-account-config.test.mjs:207,243,266,410,420`. Docs: `docs/LAUNCH_READINESS.md:67`, `docs/ADMIN_CONSOLE.md:239`, `docs/ACCOUNT_READINESS.md:85`, `docs/ADR-002-subscriptions-and-credit-ledger.md:221`.

CREDIT-LEDGER PRIMITIVES AVAILABLE FOR A CLAWBACK (`202607140001_subscription_billing.sql`). There is NO clawback primitive today. The nearest template is `billing_private.expire_account_credit_lots(p_account_id)` (`:1987-2035`): it locks `public.credit_accounts FOR UPDATE`, iterates lots ordered `expires_at, granted_at, id FOR UPDATE`, zeroes `available_microcredits`, decrements the account and increments `lifetime_expired_microcredits`, and appends a `credit_ledger` row with `on conflict (account_id, idempotency_key) do nothing`. A clawback is that shape, scoped to named lots and bounded by an amount. What already permits it without schema surgery: `credit_ledger.entry_type` already allows `'refund'` and `'adjustment'` (`:274`), and `available_delta_microcredits` is a plain `bigint` so it may be negative. What forbids a negative balance: `credit_accounts.available_microcredits >= 0` (`:169`) and `credit_grant_lots.available_microcredits >= 0` (`:218`) are deployed CHECKs, and `reserve_credits` (`:2180`) actively cross-checks account balance against lot balances (`'Credit lot balance does not reconcile with account balance'`). Reserved microcredits are untouchable: they are pinned by `credit_reservation_allocations` and by `check (available + reserved <= total)` (`:225`).

WHICH LOT A PAYMENT FUNDED. `credit_grant_lots.checkout_intent_id` is UNIQUE (`:334`) for `credit_pack` / `auto_reload` / MONTHLY `subscription` lots. ANNUAL lots are different: `credit_grant_lots_paid_source_shape` (`:336-352`) puts `annual_monthly_grant` in the "neither checkout nor renewal" bucket, so an annual payment's lots are reachable only through `public.subscription_grant_schedule.granted_lot_id` filtered by `annual_checkout_intent_id`. An implementer who follows `checkout_intent_id` alone will silently claw back nothing for an annual plan.

SPEND IS ALREADY SUBSCRIPTION-GATED. `billing_private.create_generation_quote` (`:1602`) refuses every non-admin without a live catalog-backed subscription (`:1646-1666`). Cancelling the subscription therefore stops all spend of remaining credits without inventing a negative balance.

STATUS VOCABULARY THAT ALREADY EXISTS. `billing_customers.status in ('active','delinquent','closed')` (`:81`); `'delinquent'` is read by nothing except `is_active_partner`, which TOLERATES it (`202607150003:709`) — it is a pure flag. `'closed'` is a hard block in `create_partner_purchase_intent` (`202607150003:583`). `subscriptions.status in ('incomplete','trialing','active','past_due','paused','canceled','expired')` (`:114`); `enforce_subscription_state_and_catalog` (`202607150001:185`) permits `active → canceled` (the catalog re-check only fires for `new.status in ('trialing','active')`, and only `old.status in ('canceled','expired')` is terminal). `subscription_grant_schedule.status in ('pending','granting','granted','skipped','cancelled')` (`:514`); `enforce_grant_schedule_terminal_state` (`202607150001:227`) permits `pending → cancelled`.

LOCK ORDER ACTUALLY USED BY THE PAYMENT PATH (`202607150005`, must be matched): `payment_events` (`:212`) → `checkout_intents` (`:255`) → `partner_purchase_intents` (`:261`) → `billing_customers` (`:290`) → `subscriptions` (`:314`) → `subscription_grant_schedule` (`:488`) → `credit_accounts`/`credit_grant_lots` (inside `grant_credits`). The credit subsystem's own documented order is account → quote → reservation/lots (`:2097-2099`).

ALREADY-CORRECT GUARD WORTH NOT BREAKING: `billing_private.checkout_payment_event_is_verified` (`:688`) requires `event_type = 'payment/received'`, so a reversal event can never be mistaken for completion evidence. `protect_claimed_payment_event_terminal` (`202607150003:95`) and `protect_payment_event_evidence` (`:597`) make the ORIGINAL payment event immutable — the reversal must never touch it.

WHAT THE BRIEF GOT SLIGHTLY WRONG: reversal events are not "thrown away", they are 400-rejected (worse — providers retry them indefinitely and the operator sees nothing). And the flag does not only gate partner checkout: it is half of a two-sided CI/release gate, so flipping it breaks `assertCiAccountReleaseStructure` by design.

## Seam
The adapter seam is exactly two functions and nothing else. Both live in ONE new file, `supabase/functions/_shared/billing_provider_adapter.ts`, which stays unimplemented until a provider is chosen. Everything upstream and downstream of them is provider-neutral and is fully implemented by this spec.

Declared in `supabase/functions/_shared/billing_contracts.ts` (types only, no runtime):

```ts
export type BillingReversalType = "refund" | "chargeback" | "dispute_lost";

export type CanonicalBillingWebhookEvent =
  | {
      readonly kind: "payment";
      /** Provider's own id for the money-in event. Opaque, 1..300 chars, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/ */
      readonly paymentReference: string;
      /** OUR operation UUID, echoed back by the provider from checkout metadata. */
      readonly operationReference: string;
      readonly amount: MoneyAmount;               // exponent MUST be 2
      readonly subscriptionReference: string | null;
      readonly periodStart: string | null;        // ISO-8601 Z
      readonly periodEnd: string | null;          // ISO-8601 Z
    }
  | {
      readonly kind: "reversal";
      /** Provider's own id for the REVERSAL event. Never reused across reversals. */
      readonly reversalReference: string;
      /** The provider's id of the ORIGINAL money-in event being reversed.
       *  This is the ONLY link. The adapter must NOT restate our operation UUID:
       *  we resolve the operation from our own payment_events + payment_entitlement_claims. */
      readonly reversedPaymentReference: string;
      readonly reversalType: BillingReversalType;
      /** Amount actually reversed. May be < the original (partial refund). */
      readonly amount: MoneyAmount;               // exponent MUST be 2
      readonly reversedAt: string;                // ISO-8601 Z
    };

export interface BillingWebhookAdapter {
  readonly providerId: string;
  /** SEAM 1 — "verify this provider signature".
   *  Receives the exact bytes as delivered, before any decoding. MUST NOT throw;
   *  return false on anything it cannot prove. */
  verifySignature(rawBody: Uint8Array, headers: Headers): Promise<boolean>;
  /** SEAM 2 — "map this provider event onto the normalized shape".
   *  Receives the already-JSON-decoded body. MUST throw for any event the product
   *  does not handle (subscription.updated, invoice.created, ...) so the caller can
   *  200-ack-and-ignore it rather than retry forever. MUST NOT invent an amount,
   *  a reversal type, or a reversed-payment reference it did not receive. */
  toCanonicalEvent(decodedBody: unknown, headers: Headers): CanonicalBillingWebhookEvent;
}
```

Declared in the new `supabase/functions/_shared/billing_provider_adapter.ts`:

```ts
export class BillingProviderNotSelectedError extends Error {}

/** THE SEAM. Returns the adapter for EASYFIELD_BILLING_PROVIDER_ADAPTER.
 *  Today the only implemented value is "canonical-hmac" — our own signing scheme,
 *  used by integration tests and by any provider willing to sign our shape.
 *  Every other value throws BillingProviderNotSelectedError. Implementing a real
 *  provider means adding ONE case here that returns a BillingWebhookAdapter; no
 *  other file in the repository changes. */
export function resolveBillingWebhookAdapter(
  env: Readonly<Record<string, string | undefined>>,
): BillingWebhookAdapter;

/** The provider-neutral adapter that exists today: HMAC-SHA256 over
 *  `"<timestamp>." || rawBody` via the already-deployed verifyWebhookHmac, and a
 *  toCanonicalEvent that accepts only our two canonical wire shapes,
 *  `type: "payment.completed"` and `type: "payment.reversed"`. */
export function canonicalHmacWebhookAdapter(
  env: Readonly<Record<string, string | undefined>>,
): BillingWebhookAdapter;
```

Nothing else is provider-shaped. The normalized reversal DTO, its database validator, the operation resolution, the clawback, the revocation, the evidence table, the alerting and the scheduled settlement sweep are all implemented now and are provider-independent.

## Steps

### Step 1: Declare the canonical reversal contract and the adapter seam (types only)
FILE: supabase/functions/_shared/billing_contracts.ts

APPEND ONLY — do not modify any existing export in this file. Add `BillingReversalType`, `CanonicalBillingWebhookEvent` and `BillingWebhookAdapter` exactly as given in the `seam` field. Keep the file free of runtime code and of any provider name; it currently contains only interfaces and type aliases and must stay that way. Add a file-level comment above the new block: reversal events carry NO operationReference on purpose — the provider is not trusted to restate which of our operations a refund belongs to; we resolve it from our own payment_events + payment_entitlement_claims, and refuse when we cannot.

### Step 2: Add the reversal wire parser next to the payment parser
FILE: supabase/functions/_shared/account_api.ts

APPEND ONLY. `parsePaymentWebhook` (line 357) is unchanged, still exported, still accepts only `type === "payment.completed"`.

Add `export interface NormalizedReversalWebhook { readonly deliveryId: string; readonly reversalReference: string; readonly reversedPaymentReference: string; readonly reversalType: "refund" | "chargeback" | "dispute_lost"; readonly amount: { readonly currency: string; readonly minorUnits: number; readonly exponent: 2 }; readonly reversedAt: string; readonly reconciliationPayload: { readonly type: "payment/reversed"; readonly id: string; readonly reconciliationState: "ready"; readonly entitlementGrantAllowed: false; readonly issues: readonly []; readonly reversalType: "refund" | "chargeback" | "dispute_lost"; readonly reversedPaymentReference: string; readonly reversedAt: string; readonly total: {currency;minorUnits;exponent:2}; readonly transactions: readonly [{ readonly id: string; readonly amount: {currency;minorUnits;exponent:2} }] } }`.

Add `const REVERSAL_TYPES = new Set(["refund", "chargeback", "dispute_lost"]);`

Add `export function parseReversalWebhook(value: unknown, deliveryId: string): NormalizedReversalWebhook`. Mirror `parsePaymentWebhook` line-for-line in strictness: `isRecord(value)` and `exactKeys(value, ["type","reversalReference","reversedPaymentReference","reversalType","amount","reversedAt"])` else `throw new TypeError("Webhook body is invalid")`; `value.type !== "payment.reversed" || !isRecord(value.amount)` -> `throw new TypeError("Unsupported webhook event")`; `requireOpaqueRef(deliveryId, ...)`, `requireOpaqueRef(value.reversalReference, "Reversal reference")`, `requireOpaqueRef(value.reversedPaymentReference, "Reversed payment reference")`; reject `reversalReference === reversedPaymentReference` with `throw new TypeError("Reversal reference must differ from its payment")`; `REVERSAL_TYPES.has(value.reversalType)` else throw; `exactKeys(value.amount, ["currency","minorUnits","exponent"])`, `ISO_CURRENCY_PATTERN` on currency, `requireSafeInteger(value.amount.minorUnits, "Webhook amount", 1)`, `value.amount.exponent !== 2` -> throw; `const reversedAt = parseIsoInstant(value.reversedAt, "Reversal instant"); if (reversedAt === null) throw new TypeError("Reversal instant is required");`. Return `reconciliationPayload` with `reconciliationState: "ready"`, `entitlementGrantAllowed: false`, `issues: []`, `id: reversalReference`, `transactions: [{ id: reversalReference, amount }]` — the same never-authorizes-entitlement discipline as the payment DTO.

Add `export type NormalizedBillingWebhook = { readonly kind: "payment"; readonly payment: NormalizedPaymentWebhook } | { readonly kind: "reversal"; readonly reversal: NormalizedReversalWebhook };` and `export function normalizeCanonicalEvent(event: CanonicalBillingWebhookEvent, deliveryId: string): NormalizedBillingWebhook` which re-serialises the canonical event into the wire object and runs it back through `parsePaymentWebhook` / `parseReversalWebhook`. Re-parsing rather than trusting the adapter is deliberate: the adapter is the only untrusted code in the path.

### Step 3: Create the provider adapter seam file
FILE: supabase/functions/_shared/billing_provider_adapter.ts
DEPENDS: Add the reversal wire parser next to the payment parser

NEW FILE. Exports `BillingProviderNotSelectedError`, `canonicalHmacWebhookAdapter(env)` and `resolveBillingWebhookAdapter(env)` with the signatures in the `seam` field.

`canonicalHmacWebhookAdapter`: `providerId = env.EASYFIELD_BILLING_PROVIDER_ID` lowercased, validated `/^[a-z][a-z0-9_-]{1,39}$/`. `verifySignature(rawBody, headers)` resolves the three header names through the same `safeHeaderName` regex the webhook function already uses and delegates to `verifyWebhookHmac(env.EASYFIELD_WEBHOOK_SECRET, headers.get(tsHeader), rawBody, headers.get(sigHeader))`; it catches everything and returns `false`. `toCanonicalEvent(decodedBody)` reads `decodedBody.type`: `"payment.completed"` -> `{kind:"payment", ...}`, `"payment.reversed"` -> `{kind:"reversal", ...}`, anything else -> `throw new TypeError("Unsupported webhook event")`.

`resolveBillingWebhookAdapter(env)`: `switch ((env.EASYFIELD_BILLING_PROVIDER_ADAPTER ?? "canonical-hmac").trim().toLowerCase())` — `"canonical-hmac"` returns the above; `default` throws `new BillingProviderNotSelectedError("No billing webhook adapter is implemented for this provider")`. NO provider name, SDK, import or URL appears in this file. The comment above `resolveBillingWebhookAdapter` states that adding a provider is one `case` here and nothing else.

### Step 4: Route the webhook function by event kind
FILE: supabase/functions/easyfield-billing-webhook/index.ts
DEPENDS: Create the provider adapter seam file

Replace the body of the `Deno.serve` handler between signature verification and the RPC call. Keep unchanged: method/size guards (lines 90-96), `safeHeaderName` env resolution, `sha256Hex(rawBody)`, the `provider` regex check, the `json({accepted, processed, replayed}, 200)` response shape, and every `HttpError` status already emitted.

New flow: (1) `const adapter = resolveBillingWebhookAdapter(envRecord())` — a thrown `BillingProviderNotSelectedError` becomes `HttpError(503, "Webhook is not configured")`. (2) `if (!(await adapter.verifySignature(rawBody, request.headers))) throw new HttpError(401, "Invalid webhook signature")` — replaces the inline `verifyWebhookHmac` call at lines 110-116. (3) JSON-decode exactly as today (line 120). (4) `let canonical; try { canonical = adapter.toCanonicalEvent(decoded, request.headers); } catch { return json({accepted:true, processed:false, ignored:true}, 200); }` — CHANGED BEHAVIOUR, and the point of this step: an event kind we do not handle is ACKNOWLEDGED, not 400-rejected. A 400 makes a provider retry an unhandled topic forever, which is the actual failure the audit describes. A signature failure is still 401; a malformed body of a kind we DO handle is still 400. (5) `const normalized = normalizeCanonicalEvent(canonical, request.headers.get(deliveryHeader) ?? "")` — a throw here is `HttpError(400, "Webhook body is invalid")`, unchanged. (6) Dispatch on `normalized.kind`: `"payment"` -> POST `/rest/v1/rpc/easyfield_account_reconcile_payment_event` with the existing five `p_*` args, byte-identical to today; `"reversal"` -> POST `/rest/v1/rpc/easyfield_account_reconcile_reversal_event` with `{p_provider, p_provider_event_id: normalized.reversal.reversalReference, p_provider_delivery_id: normalized.reversal.deliveryId, p_raw_body_sha256: await sha256Hex(rawBody), p_payload: normalized.reversal.reconciliationPayload}`.

Generalise `reconcileEvent(body)` into `callReconciliationRpc(rpcName: string, body: Record<string, unknown>)`; keep `redirect: "error"`, the `processed !== true` -> 503 assertion and every existing 503 message string.

### Step 5: Migration preamble, lock order, and the reversal payload validator
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql

NEW FILE — forward-only. No line of any deployed migration is edited. Opens `begin;` and closes `commit;`.

Header comment in the house voice: revoke_partner_entitlement has existed since 202607150003 and nothing has ever called it, so a chargeback on the $999 lifetime product leaves the entitlement 'active' forever; three layers refuse a reversal today (the TS parser, record_payment_event's `event_type <> 'payment/received'` guard, and payment_reconciliation_payload_is_valid's non-received branch); and nothing here fabricates a provider decision — every refusal path leaves the signed event as `failed` with a reason instead of guessing.

DDL preflight lock, taken first, in this exact order (matches the payment path in 202607150005 so the two can never deadlock):
`lock table public.payment_events, public.checkout_intents, billing_private.partner_purchase_intents, public.billing_customers, public.subscriptions, public.subscription_grant_schedule, public.credit_accounts, public.credit_grant_lots in share row exclusive mode;`

Then `create or replace function billing_private.payment_reversal_payload_is_valid(p_payload jsonb) returns boolean language plpgsql stable strict set search_path = '' as $$ ... $$;` — a NEW validator, because the deployed `payment_reconciliation_payload_is_valid` allowlists only the payment keys and its non-`payment/received` branch explicitly rejects `total`/`transactions`. It must assert, with the same closed-world style as its sibling: `jsonb_typeof(p_payload) = 'object'`; no key outside `array['type','id','reconciliationState','entitlementGrantAllowed','issues','reversalType','reversedPaymentReference','reversedAt','total','transactions']`; `p_payload ?& array['type','id','reconciliationState','entitlementGrantAllowed','issues','reversalType','reversedPaymentReference','reversedAt','total','transactions']`; `p_payload->>'type' = 'payment/reversed'`; `p_payload->>'reconciliationState' = 'ready'`; `p_payload->'entitlementGrantAllowed' = 'false'::jsonb`; `jsonb_array_length(p_payload->'issues') = 0`; `p_payload->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$'`; `p_payload->>'reversedPaymentReference' ~` the same pattern; `p_payload->>'id' <> p_payload->>'reversedPaymentReference'`; `p_payload->>'reversalType' in ('refund','chargeback','dispute_lost')`; `p_payload->>'reversedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'`; `billing_private.payment_reconciliation_amount_is_valid(p_payload->'total')` (reuse the deployed helper at 202607140001:3047); `jsonb_array_length(p_payload->'transactions') = 1`; the single transaction has no key outside `array['id','amount']`, `->>'id' = p_payload->>'id'`, and `->'amount' = p_payload->'total'`. Ends `exception when others then return false;` exactly like its sibling.

`revoke all on function billing_private.payment_reversal_payload_is_valid(jsonb) from public, anon, authenticated; grant execute ... to service_role;`

### Step 6: Teach record_payment_event the second event type
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql
DEPENDS: Migration preamble, lock order, and the reversal payload validator

`create or replace function billing_private.record_payment_event(p_provider text, p_provider_event_id text, p_provider_delivery_id text, p_event_type text, p_raw_body_sha256 text, p_payload jsonb) returns table (payment_event_id uuid, payment_delivery_id uuid, event_inserted boolean, delivery_inserted boolean, event_status text)` — copy the deployed body from 202607140001:3225-3348 VERBATIM and change exactly two predicates inside the opening validation block:

  `or v_event_type is distinct from 'payment/received'`
->`or v_event_type not in ('payment/received', 'payment/reversed')`

  `or not billing_private.payment_reconciliation_payload_is_valid(p_payload, v_event_type)`
->`or not (case v_event_type when 'payment/received' then billing_private.payment_reconciliation_payload_is_valid(p_payload, v_event_type) else billing_private.payment_reversal_payload_is_valid(p_payload) end)`

Everything else — the `octet_length(p_payload::text) > 262144` cap, the signed-id/`body:`-hash identity derivation, the `(provider, provider_event_id)` then `(provider, raw_body_sha256)` dedup ladder, the `'Signed payment event ID was replayed with different evidence'` assertion, and the whole delivery-row resolution — is byte-identical. Add a comment above the function stating that a reversal event is a SEPARATE, independently-deduplicated payment_events row and never mutates the event it reverses.

Note for the implementer, do not change: `billing_private.checkout_payment_event_is_verified` (202607140001:688) already requires `event_type = 'payment/received'`, so widening record_payment_event cannot make a reversal event complete a checkout.

### Step 7: Append-only reversal evidence tables
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql
DEPENDS: Migration preamble, lock order, and the reversal payload validator

```sql
create table billing_private.payment_reversals (
  id uuid primary key default gen_random_uuid(),
  reversal_payment_event_id uuid not null unique references public.payment_events(id) on delete restrict,
  reversed_payment_event_id uuid not null references public.payment_events(id) on delete restrict,
  provider text not null check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_reversal_ref text not null check (char_length(provider_reversal_ref) between 1 and 300),
  reversal_type text not null check (reversal_type in ('refund','chargeback','dispute_lost')),
  claim_type text not null check (claim_type in ('subscription','credit_pack','auto_reload','partner_lifetime')),
  claim_id uuid not null,
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  original_amount_currency_micros bigint not null check (original_amount_currency_micros > 0),
  reversed_amount_currency_micros bigint not null check (reversed_amount_currency_micros > 0),
  full_reversal boolean not null,
  entitlement_action text not null check (entitlement_action in (
    'partner_revoked','partner_retained','subscription_canceled','subscription_retained','credits_only')),
  clawback_target_microcredits bigint not null check (clawback_target_microcredits >= 0),
  initial_clawback_recovered_microcredits bigint not null check (initial_clawback_recovered_microcredits >= 0),
  initial_clawback_shortfall_microcredits bigint not null check (initial_clawback_shortfall_microcredits >= 0),
  reversed_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_reversal_ref),
  check (reversal_payment_event_id <> reversed_payment_event_id),
  check (reversed_amount_currency_micros <= original_amount_currency_micros),
  check (full_reversal = (reversed_amount_currency_micros = original_amount_currency_micros)),
  check (initial_clawback_recovered_microcredits + initial_clawback_shortfall_microcredits
         = clawback_target_microcredits)
);

-- A payment can be partially refunded more than once, but reversed in full only once.
create unique index payment_reversals_one_full_per_payment
  on billing_private.payment_reversals (reversed_payment_event_id) where full_reversal;
create index payment_reversals_reversed_payment_idx
  on billing_private.payment_reversals (reversed_payment_event_id, recorded_at);
create index payment_reversals_outstanding_idx
  on billing_private.payment_reversals (recorded_at)
  where initial_clawback_shortfall_microcredits > 0;

create trigger payment_reversals_are_immutable
before update or delete on billing_private.payment_reversals
for each row execute function billing_private.reject_immutable_mutation();

-- Per-lot, per-attempt. Append-only, so the later settlement sweep records a new
-- row rather than rewriting the first attempt. Outstanding for a (reversal, lot)
-- is target_microcredits - sum(recovered_microcredits).
create table billing_private.payment_reversal_clawbacks (
  id uuid primary key default gen_random_uuid(),
  reversal_id uuid not null references billing_private.payment_reversals(id) on delete restrict,
  lot_id uuid not null references public.credit_grant_lots(id) on delete restrict,
  account_id uuid not null references public.credit_accounts(id) on delete restrict,
  target_microcredits bigint not null check (target_microcredits > 0),
  recovered_microcredits bigint not null check (recovered_microcredits >= 0),
  attempted_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  check (recovered_microcredits <= target_microcredits)
);
create index payment_reversal_clawbacks_lot_idx
  on billing_private.payment_reversal_clawbacks (reversal_id, lot_id, attempted_at);

create trigger payment_reversal_clawbacks_are_immutable
before update or delete on billing_private.payment_reversal_clawbacks
for each row execute function billing_private.reject_immutable_mutation();

alter table billing_private.payment_reversals enable row level security;
alter table billing_private.payment_reversal_clawbacks enable row level security;
revoke all on billing_private.payment_reversals,
  billing_private.payment_reversal_clawbacks from public, anon, authenticated;
grant select on billing_private.payment_reversals,
  billing_private.payment_reversal_clawbacks to service_role;
```
Match 20260715170000: enable RLS, do NOT force it, create no policies.

### Step 8: The clawback primitive
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql
DEPENDS: Append-only reversal evidence tables

First, the honest counter — do NOT reuse `lifetime_expired_microcredits`, which `public.my_billing_snapshot()` shows the customer as expiry:
```sql
alter table public.credit_accounts
  add column lifetime_reversed_microcredits bigint not null default 0
    check (lifetime_reversed_microcredits >= 0);
```
(`grant select on public.credit_accounts to authenticated` is table-wide at 202607140001:3679, so the new column is visible to the owner with no further grant. Intentional: money taken back should be visible to the person it was taken from.)

```sql
create or replace function billing_private.claw_back_lot_credits(
  p_clawback_id uuid,
  p_lot_id uuid,
  p_amount_microcredits bigint
)
returns bigint
language plpgsql security definer set search_path = ''
```
Body, modelled directly on `expire_account_credit_lots` (202607140001:1987):
1. Validate `p_clawback_id is not null`, `p_amount_microcredits > 0`, else `22023`.
2. `select * into v_clawback from billing_private.payment_reversal_clawbacks where id = p_clawback_id;` not found -> `23503`. It must already exist: its id IS the ledger idempotency key, so the evidence row is written before the balance moves.
3. `v_key := 'lot.clawback:' || p_clawback_id::text;` (13 + 36 = 49 chars, inside credit_ledger's 8..300 bound).
4. Idempotent replay check, in the style of `capture_credits` (202607140001:2266-2274): `select * into v_existing from public.credit_ledger where account_id = v_clawback.account_id and idempotency_key = v_key; if found then return -v_existing.available_delta_microcredits; end if;`
5. Lock in the global order — account first, then the lot: `perform 1 from public.credit_accounts where id = v_clawback.account_id for update;` then `select * into v_lot from public.credit_grant_lots where id = p_lot_id and account_id = v_clawback.account_id for update;` not found -> `23503`.
6. `v_recovered := least(p_amount_microcredits, v_lot.available_microcredits); if v_recovered <= 0 then return 0; end if;` — NEVER touch `reserved_microcredits`. Reserved credit is pinned by `credit_reservation_allocations` and by `check (available + reserved <= total)`; taking it would corrupt an in-flight generation. Whatever is reserved is picked up later by the settlement sweep once it is released.
7. `update public.credit_grant_lots set available_microcredits = available_microcredits - v_recovered where id = v_lot.id;`
8. `update public.credit_accounts set available_microcredits = available_microcredits - v_recovered, lifetime_reversed_microcredits = lifetime_reversed_microcredits + v_recovered, version = version + 1 where id = v_clawback.account_id;`
9. `insert into public.credit_ledger (account_id, lot_id, entry_type, available_delta_microcredits, idempotency_key, reference_type, reference_id, metadata) values (v_clawback.account_id, v_lot.id, 'refund', -v_recovered, v_key, 'payment_reversal', v_clawback.reversal_id::text, jsonb_build_object('clawback_id', p_clawback_id, 'target_microcredits', v_clawback.target_microcredits));` — `'refund'` is already in the deployed `entry_type` allowlist (202607140001:274) and is literally what this is; the sign distinguishes a refund GRANT (positive, written by grant_credits) from a refund CLAWBACK (negative).
10. `return v_recovered;`

`revoke all on function billing_private.claw_back_lot_credits(uuid, uuid, bigint) from public, anon, authenticated; grant execute ... to service_role;`

Comment above the function: the account balance floor is deliberately not removed. `credit_accounts.available_microcredits >= 0` and `credit_grant_lots.available_microcredits >= 0` are load-bearing CHECKs that `reserve_credits` cross-verifies; a negative balance would have no lot to back it and would trip 'Credit lot balance does not reconcile with account balance'. Credit already spent is a write-off recorded on the reversal row, not a synthetic debt on the account.

### Step 9: The reversal reconciliation RPC
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql
DEPENDS: The clawback primitive

```sql
create or replace function public.easyfield_account_reconcile_reversal_event(
  p_provider text, p_provider_event_id text, p_provider_delivery_id text,
  p_raw_body_sha256 text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
```
Structure copies `easyfield_account_reconcile_payment_event` (202607150005:162) exactly: outer block records the event, an INNER SUBTRANSACTION does all materialisation, and `exception when others` re-locks the event and finishes it as `'failed'` with `left(sqlerrm, 4000)` so an operator has evidence, returning `jsonb_build_object('processed', false, 'replayed', false, 'retryable', true)`.

1. `select * into v_record from billing_private.record_payment_event(p_provider, p_provider_event_id, p_provider_delivery_id, 'payment/reversed', p_raw_body_sha256, p_payload);`
2. Open the inner block. `select * into v_event from public.payment_events where id = v_record.payment_event_id for update;`
3. REPLAY: `if v_event.status = 'processed' then select * into v_reversal from billing_private.payment_reversals where reversal_payment_event_id = v_event.id; if not found then raise exception 'Processed reversal event has no evidence row' using errcode = 'P0001'; end if; return jsonb_build_object('processed', true, 'replayed', true, 'reversalId', v_reversal.id, 'claimType', v_reversal.claim_type, 'reversalType', v_reversal.reversal_type, 'entitlementAction', v_reversal.entitlement_action, 'clawbackRecoveredMicrocredits', 0); end if;`  `if v_event.status = 'ignored' then raise exception 'Payment event is already terminal' using errcode = '55000'; end if;`
4. RESOLVE THE ORIGINAL — refuse, never assume. `v_reversed_ref := v_event.payload->>'reversedPaymentReference'; select * into v_original from public.payment_events where provider = v_event.provider and provider_event_id = v_reversed_ref for update;` If not found -> `raise exception 'Reversal does not reference a known payment' using errcode = '23503';`. If `v_original.status <> 'processed' or v_original.event_type <> 'payment/received' or v_original.id = v_event.id` -> `raise exception 'Reversal references a payment that was never settled' using errcode = '42501';`.
5. RESOLVE THE OPERATION FROM OUR OWN RECORDS. `select * into v_claim from billing_private.payment_entitlement_claims where payment_event_id = v_original.id;` not found -> `raise exception 'Reversed payment funded no commercial entitlement' using errcode = '23503';` — this is the deliberate refusal for a renewal-funded payment, which today has no claim row because nothing charges renewals yet. It leaves the event `failed` and surfaces as `reversal-unresolved`.
6. AMOUNTS. `v_reversed_micros := (v_event.payload->'total'->>'minorUnits')::numeric * 10000;` require `v_event.payload->'total'->>'exponent' = '2'` and `v_event.payload->'total'->>'currency' = v_original.payload->'total'->>'currency'`, else `42501`. `v_original_micros := (v_original.payload->'total'->>'minorUnits')::numeric * 10000;` Under the `for update` already held on `v_original`: `select coalesce(sum(reversed_amount_currency_micros), 0) into v_prior from billing_private.payment_reversals where reversed_payment_event_id = v_original.id;` `if v_reversed_micros <= 0 or v_prior + v_reversed_micros > v_original_micros then raise exception 'Reversal exceeds the amount actually paid' using errcode = '42501'; end if;` `v_full := (v_prior + v_reversed_micros = v_original_micros);`
7. `v_reversal_type := v_event.payload->>'reversalType';` `v_hostile := v_reversal_type in ('chargeback','dispute_lost');` `v_terminates := v_full or v_hostile;` — one variable, one place, for the policy in `risks`.
8. RESOLVE CUSTOMER AND TARGETS, locking in the payment path's order: `checkout_intents` / `partner_purchase_intents` (by `v_claim.claim_id`, `for update`) -> `billing_customers` (`for update`) -> `subscriptions` -> `subscription_grant_schedule` -> `credit_accounts`/`credit_grant_lots`.
9. PER-CLAIM-TYPE TARGET LOTS.
   - `partner_lifetime`: no lots (`included_microcredits = 0` is a table CHECK). `v_target := 0`.
   - `credit_pack` / `auto_reload`, and `subscription` with `billing_interval = 'monthly'`: exactly one lot, `select * from public.credit_grant_lots where checkout_intent_id = v_claim.claim_id for update`. Not found -> `raise exception 'Reversed purchase has no credit lot' using errcode = '23503';`
   - `subscription` with `billing_interval = 'annual'`: the lots are NOT reachable by `checkout_intent_id`. `select lot.* from public.subscription_grant_schedule as sched join public.credit_grant_lots as lot on lot.id = sched.granted_lot_id where sched.annual_checkout_intent_id = v_claim.claim_id and sched.status = 'granted' order by sched.grant_number for update of lot`.
10. PER-LOT TARGET, ceiling-divided so a partial refund never leaves the customer holding more credit than they still paid for: `v_lot_target := ((v_lot.total_microcredits::numeric * v_reversed_micros / v_original_micros)::numeric)` rounded up via `ceil(...)::bigint`, clamped to `v_lot.total_microcredits`. For a full reversal this is exactly `total_microcredits`. `v_target := sum(v_lot_target)`.
11. TWO PASSES UNDER ONE SET OF LOCKS. Pass 1 (read-only, locks already held) computes `v_recoverable := sum(least(v_lot_target, v_lot.available_microcredits))`. Then insert the `payment_reversals` row with `clawback_target_microcredits = v_target`, `initial_clawback_recovered_microcredits = v_recoverable`, `initial_clawback_shortfall_microcredits = v_target - v_recoverable`, and `entitlement_action` per step 12. Pass 2 inserts one `payment_reversal_clawbacks` row per lot and calls `billing_private.claw_back_lot_credits(clawback_id, lot_id, lot_target)`; assert the returned total equals `v_recoverable` else `raise exception 'Clawback did not reconcile with its evidence' using errcode = 'P0001';`. Two passes, not a deferred FK: the evidence row must exist before the balance moves, and the locks make the pre-pass numbers exact.
12. ENTITLEMENT ACTION.
   - `partner_lifetime` and `v_terminates`: `perform billing_private.revoke_partner_entitlement(v_customer_id, case when v_hostile then 'chargeback' else 'refunded' end, 'payment reversal ' || v_reversal_type || ' ' || v_event.provider || ':' || (v_event.payload->>'id'));` The reason is DETERMINISTIC and derived only from immutable signed evidence — that is what makes the deployed function's conditional idempotency (`status = p_terminal_status AND revocation_reason = v_reason`) actually hold on a redelivery. `entitlement_action = 'partner_revoked'`.
   - `partner_lifetime` and not `v_terminates`: no revocation; `entitlement_action = 'partner_retained'`.
   - `subscription` and `v_terminates`: `update public.subscriptions set status = 'canceled', entitlement_ends_at = clock_timestamp(), cancel_at_period_end = true where id = v_subscription.id;` (permitted — `enforce_subscription_state_and_catalog` only re-checks the catalog for `new.status in ('trialing','active')` and only treats `old.status in ('canceled','expired')` as terminal). Do NOT rewrite `current_period_start`/`current_period_end`: they are the paid-period snapshot. For an annual plan also `update public.subscription_grant_schedule set status = 'cancelled' where annual_checkout_intent_id = v_claim.claim_id and status = 'pending';` — `pending` only, never `granting` (a grant is mid-flight), and permitted by `enforce_grant_schedule_terminal_state`. `entitlement_action = 'subscription_canceled'`.
   - `subscription` and not `v_terminates`: `entitlement_action = 'subscription_retained'`.
   - `credit_pack` / `auto_reload`: `entitlement_action = 'credits_only'`.
13. DELINQUENCY FLAG: `if v_hostile and (v_target - v_recoverable) > 0 then update public.billing_customers set status = 'delinquent' where id = v_customer_id and status = 'active'; end if;` — `'delinquent'` already exists (202607140001:81) and is tolerated by `is_active_partner` (202607150003:709); it marks, it does not silently punish. Never auto-set `'closed'`: that is a hard block in `create_partner_purchase_intent` and belongs to a human.
14. `perform billing_private.claim_payment_event(v_event.id, v_claim_id); perform billing_private.finish_payment_event(v_event.id, v_claim_id, 'processed', null);` — placed AFTER every assertion, exactly as the payment path does. Write NO `payment_entitlement_claims` row: a reversal claims no entitlement, and `protect_claimed_payment_event_terminal` only fires when one exists.
15. Return `jsonb_build_object('processed', true, 'replayed', false, 'reversalId', v_reversal_id, 'claimType', v_claim.claim_type, 'reversalType', v_reversal_type, 'entitlementAction', v_action, 'clawbackTargetMicrocredits', v_target, 'clawbackRecoveredMicrocredits', v_recoverable, 'clawbackShortfallMicrocredits', v_target - v_recoverable)`.

`revoke all on function public.easyfield_account_reconcile_reversal_event(text, text, text, text, jsonb) from public, anon, authenticated; grant execute ... to service_role;`

### Step 10: Scheduled settlement of clawback shortfalls
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql
DEPENDS: The reversal reconciliation RPC

A reversal cannot take reserved microcredits. When the in-flight generation later captures or releases, released credit returns to `available` and is still owed. Without a sweep, the customer keeps credit that was refunded — a real, provider-independent leak.

```sql
create or replace function billing_private.settle_reversal_clawbacks(p_limit integer default 500)
returns bigint
language plpgsql security definer set search_path = ''
```
For each `(reversal_id, lot_id)` whose `target_microcredits - sum(recovered_microcredits) > 0` and whose reversal `recorded_at > clock_timestamp() - interval '90 days'`, ordered by `reversal_id, lot_id`, `limit p_limit`: insert a NEW `payment_reversal_clawbacks` row for the outstanding amount and call `billing_private.claw_back_lot_credits(new_id, lot_id, outstanding)`. Each `(reversal, lot)` is attempted inside its own `begin ... exception when others then null; end;` so one bad row cannot stop the sweep — the same shape as `sweep_due_renewals` (202607290006:57-62). Return the total microcredits recovered. Ninety days is the bound: after that the shortfall is a settled write-off, not pending work.

Extend the allowlist forward-only, exactly as 202607290006 did:
```sql
create or replace function billing_private.run_maintenance(p_job text, p_limit integer default 1000)
```
— copy the deployed body from 202607290006:276-328, add `'settle_reversal_clawbacks'` as a fifth allowed job and a matching `elsif p_job = 'settle_reversal_clawbacks' then v_count := billing_private.settle_reversal_clawbacks(v_limit);` branch. Everything else (the `maintenance_runs` row written outside the exception block, the `least(greatest(coalesce(p_limit,1000),1),10000)` clamp, `v_count := -1` on failure) is unchanged.

```sql
create or replace function billing_private.maintenance_health() ...
```
— copy 202607290006:333-372 and add `('settle_reversal_clawbacks', 1800)` to the `values` list.

```sql
do $$
begin
  if exists (select 1 from cron.job where jobname = 'easyfield-settle-reversal-clawbacks') then
    perform cron.unschedule('easyfield-settle-reversal-clawbacks');
  end if;
end $$;

select cron.schedule(
  'easyfield-settle-reversal-clawbacks',
  '*/10 * * * *',
  $job$select billing_private.run_maintenance('settle_reversal_clawbacks', 500)$job$
);
```

`revoke all on function billing_private.settle_reversal_clawbacks(integer) from public, anon, authenticated; grant execute ... to service_role;`

### Step 11: Surface reversals in the operator console
FILE: supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql
DEPENDS: The reversal reconciliation RPC

`create or replace function billing_private.reversals_recent(p_limit integer default 25) returns jsonb language sql stable security definer set search_path = ''` — most recent reversals with `id, reversalType, claimType, entitlementAction, customerId, currencyCode, reversedAmountCurrencyMicros, fullReversal, clawbackTargetMicrocredits, outstandingMicrocredits (computed from payment_reversal_clawbacks), recordedAt`, ordered `recorded_at desc`, `limit least(greatest(coalesce(p_limit, 25), 1), 100)`. Same `coalesce(jsonb_agg(...), '[]'::jsonb)` shape as `due_renewals_blocked` (202607290006:78).

`create or replace function billing_private.operational_alerts() returns jsonb` — copy 202607290006:148-211 and add two counts and two alerts, appended after the existing ones so their order is stable:
- `v_unresolved_reversals := (select count(*) from public.payment_events where event_type = 'payment/reversed' and status = 'failed');` -> `severity 'critical'`, `code 'reversal-unresolved'`, message: 'A refund or chargeback could not be reconciled. Money has left the business and the entitlement it paid for may still be active.'
- `v_reversal_shortfall := (select count(*) from billing_private.payment_reversals r where r.recorded_at > clock_timestamp() - interval '90 days' and r.clawback_target_microcredits > (select coalesce(sum(c.recovered_microcredits), 0) from billing_private.payment_reversal_clawbacks c where c.reversal_id = r.id));` -> `severity 'warning'`, `code 'reversal-shortfall'`, message: 'Reversed payments funded credit that was already spent. The unrecovered amount is a write-off, not a customer debt.'

`create or replace function public.easyfield_admin_incidents(p_actor_user_id uuid, p_limit integer default 25) returns jsonb` — copy 202607290006:217-268 verbatim and add one key, `'reversals', billing_private.reversals_recent(v_limit)`, immediately after `'autoReloadDue'`. Keep `perform billing_private.require_active_admin(p_actor_user_id);` and `billing_private.clamp_admin_limit(p_limit)` unchanged.

`revoke all on function billing_private.reversals_recent(integer), billing_private.operational_alerts(), public.easyfield_admin_incidents(uuid, integer) from public, anon, authenticated; grant execute on function public.easyfield_admin_incidents(uuid, integer) to service_role;`

### Step 12: Document the new migration
FILE: supabase/migrations/README.md
DEPENDS: Surface reversals in the operator console

Append one bullet to the invariants list, in the existing dense voice: `202608060001_refund_and_chargeback_ingestion.sql` adds the provider-neutral reversal path. `record_payment_event(...)` now also accepts `payment/reversed`, validated by a separate closed-world allowlist that carries no operation reference: a reversal names only the provider's original payment id, and the affected operation is resolved from our own `payment_events` and `payment_entitlement_claims` or the event is refused. A full refund, a chargeback or a lost dispute revokes the Partner lifetime entitlement and cancels a subscription with its pending annual instalments; a partial refund claws back credit pro-rata (ceiling-rounded) and leaves access intact. Clawback never takes reserved microcredits and never drives a balance negative; the unrecovered remainder is an immutable write-off on `billing_private.payment_reversals`, retried against released credit every ten minutes by `settle_reversal_clawbacks`, and surfaced as `reversal-shortfall`. A reversal that cannot be resolved leaves the signed event `failed` and raises `reversal-unresolved` rather than guessing.

### Step 13: Record what makes the flag flippable, without flipping it
FILE: supabase/functions/easyfield-account/index.ts
DEPENDS: Document the new migration

DO NOT change `const PARTNER_REVERSAL_HANDLING_READY = false;` in this change. Replace only the comment above it (lines 30-34) with the now-exact preconditions, so the next engineer does not have to re-derive them:

```
// A lifetime entitlement must be revoked automatically on a verified refund or
// chargeback before the one-time Partner product may be sold. Flip this to true
// only when all six hold:
//   1. easyfield-billing-webhook is deployed with EASYFIELD_WEBHOOK_SECRET and
//      EASYFIELD_BILLING_PROVIDER_ID set for the chosen provider.
//   2. resolveBillingWebhookAdapter in _shared/billing_provider_adapter.ts has a
//      case for that provider: verifySignature over the raw bytes, and
//      toCanonicalEvent emitting kind:"reversal" for its refund AND its
//      chargeback/dispute-lost topics. Both topics, not just refunds.
//   3. Migration 202608060001 is applied, so
//      easyfield_account_reconcile_reversal_event exists and
//      revoke_partner_entitlement finally has a caller.
//   4. cron job easyfield-settle-reversal-clawbacks reports a recent success in
//      billing_private.maintenance_health().
//   5. A real reversal has been reconciled end to end in the provider's sandbox
//      and the partner_entitlements row moved off 'active'.
//   6. CI is migrated off assertCiAccountReleaseStructure. That gate REQUIRES
//      this constant to be false (scripts/release-account-config.mjs:359) while
//      assertProjectReleaseAccountConfig REQUIRES it to be true (:320) — they are
//      mutually exclusive on purpose, and a production release also needs
//      CUSTOMER_GENERATION_GATEWAY_READY. Flipping this alone breaks the CI build.
```
Also mirror preconditions 1-5 into `docs/LAUNCH_READINESS.md` under item 3, and tick `docs/ADR-002-subscriptions-and-credit-ledger.md` action item 8 from `[ ]` to `[x]` for the ingestion half only, with a one-line note that enabling the checkout still waits on the provider adapter.

## Tests
- supabase/functions/_shared/account_api_test.ts — append Deno tests (already re-run under node:test via tests/account-edge-api.test.mjs:12). (a) `parseReversalWebhook` accepts exactly one shape: assert the returned `reconciliationPayload` deep-equals `{type:"payment/reversed", id:"rv_1", reconciliationState:"ready", entitlementGrantAllowed:false, issues:[], reversalType:"chargeback", reversedPaymentReference:"pay_1", reversedAt:"2026-08-06T00:00:00.000Z", total:{currency:"USD",minorUnits:99900,exponent:2}, transactions:[{id:"rv_1",amount:{currency:"USD",minorUnits:99900,exponent:2}}]}`. (b) assertThrows for each of: an extra top-level key; `type:"payment.refunded"`; `reversalType:"partial"`; `exponent:3`; `minorUnits:0`; `reversalReference === reversedPaymentReference`; a missing `reversedAt`; an `operationReference` key (the parser must refuse a provider-restated operation id). (c) `parsePaymentWebhook` still throws on `type:"payment.reversed"` — the payment parser is not widened.
- supabase/functions/_shared/account_api_test.ts — `normalizeCanonicalEvent` re-parses rather than trusting the adapter: build a `CanonicalBillingWebhookEvent` with `amount.exponent = 3` and assert it throws, proving the adapter output is revalidated by the same parser as raw provider JSON.
- tests/billing-webhook-reversal-routing.test.mjs (NEW, SQL/source-text style) — read supabase/functions/easyfield-billing-webhook/index.ts and assert: `/resolveBillingWebhookAdapter\(/`; `/adapter\.verifySignature\(rawBody, request\.headers\)/`; `/throw new HttpError\(401, "Invalid webhook signature"\)/`; that an unhandled `toCanonicalEvent` throw returns 200 — `/ignored: true[\s\S]{0,40}200/` and `assert.doesNotMatch(source, /toCanonicalEvent[\s\S]{0,200}HttpError\(400/)`; `/easyfield_account_reconcile_reversal_event/`; `/easyfield_account_reconcile_payment_event/`; and `assert.doesNotMatch(source, /stripe|paddle|lemonsqueezy|paypal/i)` so no provider leaks into the router. Also read _shared/billing_provider_adapter.ts and assert `/BillingProviderNotSelectedError/`, `/canonical-hmac/`, and the same no-provider-name check.
- tests/payment-reversal-schema.test.mjs (NEW, modelled on tests/subscription-schema.test.mjs — same `withoutComments`/`normalize`/`extractTableFrom`/`extractFunctionFrom` helpers, exact-text assertions). Migration hygiene: `/^begin;/` and `/commit;$/`; the preflight lock line matches `/lock table public\.payment_events, public\.checkout_intents, billing_private\.partner_purchase_intents, public\.billing_customers, public\.subscriptions, public\.subscription_grant_schedule, public\.credit_accounts, public\.credit_grant_lots in share row exclusive mode;/` — the exact payment-path order; and every already-deployed migration file is asserted byte-unchanged in the properties this migration depends on (assert 202607140001 still contains `/v_event_type is distinct from 'payment\/received'/` and 202607150003 still contains `/p_terminal_status not in \('revoked', 'refunded', 'chargeback'\)/`).
- tests/payment-reversal-schema.test.mjs — evidence tables: `payment_reversals` contains exactly `/reversal_type text not null check \(reversal_type in \('refund','chargeback','dispute_lost'\)\)/`, `/entitlement_action text not null check \(entitlement_action in \('partner_revoked','partner_retained','subscription_canceled','subscription_retained','credits_only'\)\)/`, `/check \(full_reversal = \(reversed_amount_currency_micros = original_amount_currency_micros\)\)/`, `/check \(initial_clawback_recovered_microcredits \+ initial_clawback_shortfall_microcredits = clawback_target_microcredits\)/`, `/unique \(provider, provider_reversal_ref\)/`, and `/create unique index payment_reversals_one_full_per_payment on billing_private\.payment_reversals \(reversed_payment_event_id\) where full_reversal/`. Both new tables have a `reject_immutable_mutation` trigger and `enable row level security` with NO `force row level security` and NO `create policy` (matching 20260715170000).
- tests/payment-reversal-schema.test.mjs — record_payment_event widening is surgical: the replaced function body matches `/v_event_type not in \('payment\/received', 'payment\/reversed'\)/` and `/case v_event_type when 'payment\/received' then billing_private\.payment_reconciliation_payload_is_valid\(p_payload, v_event_type\) else billing_private\.payment_reversal_payload_is_valid\(p_payload\) end/`, and STILL matches the untouched invariants `/octet_length\(p_payload::text\) > 262144/`, `/'body:' \|\| p_raw_body_sha256/` and `/signed payment event id was replayed with different evidence/`.
- tests/payment-reversal-schema.test.mjs — the clawback never breaks the ledger: `claw_back_lot_credits` matches `/v_recovered := least\(p_amount_microcredits, v_lot\.available_microcredits\)/`, `/lifetime_reversed_microcredits = lifetime_reversed_microcredits \+ v_recovered/`, `/'lot\.clawback:' \|\| p_clawback_id::text/`, `/'refund', -v_recovered/`; and `assert.doesNotMatch(clawback, /reserved_microcredits/)` — reserved credit is never taken. Migration-wide: `assert.doesNotMatch(sql, /drop constraint[^;]*available_microcredits/)` and `assert.doesNotMatch(sql, /alter table public\.credit_accounts[^;]*drop/)` — the non-negative-balance CHECKs survive. The added column matches `/add column lifetime_reversed_microcredits bigint not null default 0 check \(lifetime_reversed_microcredits >= 0\)/` and the migration does NOT touch `lifetime_expired_microcredits`.
- tests/payment-reversal-schema.test.mjs — per-operation routing, asserted on the extracted body of `public.easyfield_account_reconcile_reversal_event`: it resolves the original by `/where provider = v_event\.provider and provider_event_id = v_reversed_ref for update/`; it refuses with `/reversal does not reference a known payment/`, `/reversal references a payment that was never settled/`, `/reversed payment funded no commercial entitlement/` and `/reversal exceeds the amount actually paid/`; it calls `/billing_private\.revoke_partner_entitlement\(/` with a deterministic reason `/'payment reversal ' \|\| v_reversal_type \|\| ' ' \|\| v_event\.provider \|\| ':' \|\| \(v_event\.payload->>'id'\)/`; it reaches annual lots through `/sched\.annual_checkout_intent_id = v_claim\.claim_id and sched\.status = 'granted'/` (NOT through `checkout_intent_id`) and cancels only `/status = 'cancelled' where annual_checkout_intent_id = v_claim\.claim_id and status = 'pending'/`; it sets `/status = 'canceled', entitlement_ends_at = clock_timestamp\(\)/` on the subscription without writing `current_period_start`/`current_period_end`; it sets `/status = 'delinquent'/` only under `v_hostile`; and `assert.doesNotMatch(rpc, /insert into billing_private\.payment_entitlement_claims/)` — a reversal claims no entitlement.
- tests/payment-reversal-schema.test.mjs — scheduling: `run_maintenance` allowlist is exactly `['expire_credit_reservations','expire_credit_lots','grant_due_annual_plan_credits','sweep_due_renewals','settle_reversal_clawbacks']` (assert.deepEqual on the parsed `not in (...)` list, so a sixth job cannot be added silently); `maintenance_health` includes `/\('settle_reversal_clawbacks', 1800\)/`; the cron block matches `/if exists \(select 1 from cron\.job where jobname = 'easyfield-settle-reversal-clawbacks'\) then perform cron\.unschedule/` followed by `/cron\.schedule\( 'easyfield-settle-reversal-clawbacks', '\*\/10 \* \* \* \*', \$job\$select billing_private\.run_maintenance\('settle_reversal_clawbacks', 500\)\$job\$ \)/`.
- tests/payment-reversal-schema.test.mjs — privileges, one assertion per new function, mirroring tests/subscription-schema.test.mjs:897-901: for each of `billing_private.payment_reversal_payload_is_valid(jsonb)`, `billing_private.claw_back_lot_credits(uuid, uuid, bigint)`, `billing_private.settle_reversal_clawbacks(integer)`, `billing_private.reversals_recent(integer)`, `public.easyfield_account_reconcile_reversal_event(text, text, text, text, jsonb)` assert a matching `/revoke all on function <sig> from public, anon, authenticated/`; assert `grant execute ... to service_role` for the two public-schema entry points; and assert every `create or replace function` in the migration carries `language plpgsql security definer set search_path = ''` (or `language sql stable security definer set search_path = ''` for the read-only ones).
- tests/account-edge-api.test.mjs — extend the existing 'paid products remain fail-closed' test (line 33) with `assert.match(source, /Flip this to true only when all six hold/)` and `assert.match(source, /assertCiAccountReleaseStructure/)`, so the six preconditions and the CI/release mutual exclusion cannot be deleted while the flag stays false. Leave the `PARTNER_REVERSAL_HANDLING_READY = false` assertions at lines 35 and 38 exactly as they are — this change must not flip the flag.
- tests/release-account-config.test.mjs — no change required; re-run it to prove the two-sided gate is untouched. Its fixtures at lines 207/243/266/410/420 already pin both the `false` (CI structure) and `true` (production release) branches, and they are the tests that must be rewritten in the LATER change that flips the flag.

## Risks
- Widening record_payment_event by editing 202607140001 in place. It is deployed to xtnaqwvayenfcqzqelmh with all 13 migrations applied; editing it rewrites history that install already replayed. GUARD: the new migration uses `create or replace` only, and tests/payment-reversal-schema.test.mjs asserts the deployed file still contains the original `v_event_type is distinct from 'payment/received'` text — so an in-place edit fails CI.
- Reusing payment_reconciliation_payload_is_valid for reversals. Its key allowlist has no `reversalType`/`reversedPaymentReference`/`reversedAt`, and its non-`payment/received` branch explicitly rejects `total` and `transactions` (202607150005:68-77), so every reversal would be silently refused as malformed. GUARD: a separate `payment_reversal_payload_is_valid(jsonb)`; the deployed validator is not touched, and a test asserts the reversal path calls the new one via the `case v_event_type` dispatch.
- Trusting a provider-supplied operationReference on the reversal. A provider that mis-attributes a refund would then revoke the wrong customer's lifetime entitlement or claw back a stranger's credit. GUARD: the canonical reversal event has NO operationReference field; the parser rejects the key outright; the operation is derived only from our own `payment_events` -> `payment_entitlement_claims`; and unresolvable reversals raise instead of guessing.
- revoke_partner_entitlement's conditional idempotency. It returns the existing row ONLY when both status AND reason match (202607150003:451-455); any other value raises 55000. A caller that built the reason from `clock_timestamp()`, a delivery id, or a free-text provider message would turn every webhook redelivery into a failed transaction and an infinite retry loop. GUARD: the reason is composed solely from immutable signed evidence — reversal type, provider, and the reversal event id — and a test pins that exact expression.
- Reaching annual-plan lots through credit_grant_lots.checkout_intent_id. The `credit_grant_lots_paid_source_shape` CHECK (202607140001:336-352) forces `annual_monthly_grant` lots to have a NULL checkout_intent_id, so that lookup silently returns zero rows and an annual refund would claw back nothing while still reporting success. GUARD: annual lots are reached through `subscription_grant_schedule.annual_checkout_intent_id` + `granted_lot_id`, and a test asserts the RPC contains that join and that the total clawed back reconciles with the recorded evidence (`'Clawback did not reconcile with its evidence'`).
- Clawing back reserved microcredits. `credit_reservation_allocations` pins reserved amounts per lot and `check (available + reserved <= total)` guards the lot; taking reserved credit would either violate the CHECK or leave a live reservation with no backing, and `capture_credits` would then raise 'Reservation allocations do not reconcile' on a customer's in-flight generation. GUARD: `least(target, lot.available_microcredits)` only, a test asserting the clawback function never mentions `reserved_microcredits`, and the ten-minute `settle_reversal_clawbacks` sweep to recover it once it is legitimately released.
- Allowing a negative balance to represent spent-then-refunded credit. It requires dropping `credit_accounts.available_microcredits >= 0` and `credit_grant_lots.available_microcredits >= 0`, both load-bearing: `reserve_credits` cross-checks account balance against lot balances and there is no negative lot for FIFO to consume, so the next reservation raises 'Credit lot balance does not reconcile with account balance'. GUARD: the recommendation is a recorded write-off, not a synthetic debt; the migration adds no `drop constraint`, and a test asserts it.
- Deadlocking against the payment path. Both RPCs touch payment_events, checkout_intents, partner_purchase_intents, billing_customers, subscriptions, subscription_grant_schedule and credit_accounts/credit_grant_lots; a different order between them deadlocks under concurrent webhook delivery. GUARD: the reversal RPC and the migration's DDL preflight both use the exact order established by easyfield_account_reconcile_payment_event, and the account->lots suborder inside claw_back_lot_credits matches expire_account_credit_lots and capture_credits. The DDL lock line is pinned by an exact-text test.
- 400-ing an event kind the product does not handle. Providers retry a 4xx on their own schedule — often for days — and the operator sees only a rising error rate with no record. GUARD: an unmapped `toCanonicalEvent` throw returns 200 with `ignored: true` and writes nothing; a signature failure is still 401 and a malformed body of a HANDLED kind is still 400, both asserted by tests.
- Revoking $999 lifetime access on a partial goodwill refund. GUARD: termination is one named boolean, `v_terminates := v_full or v_hostile`. A partial `refund` records evidence, claws back pro-rata and leaves access intact (`partner_retained` / `subscription_retained`); a `chargeback` or `dispute_lost` of any amount terminates, because the money was taken forcibly and the relationship is adversarial. The policy lives in that single expression and in the `entitlement_action` CHECK list, so changing it is one line and one migration, not an archaeology exercise.
- Flipping PARTNER_REVERSAL_HANDLING_READY in this change. `assertCiAccountReleaseStructure` (scripts/release-account-config.mjs:359) REQUIRES it to be false and `assertProjectReleaseAccountConfig` (:320) requires it to be true; they are mutually exclusive, a production release additionally requires CUSTOMER_GENERATION_GATEWAY_READY (still false), and flipping it alone breaks the CI build for a checkout that no deployed provider can complete anyway. GUARD: this change ships the ingestion path with the flag still false, records the six flip preconditions in the source comment, and tests/account-edge-api.test.mjs continues to assert `= false`.
- A reversal of a renewal charge. Renewals have no payment_entitlement_claims row today (nothing charges them yet), so the claim lookup finds nothing. GUARD: that path raises 'Reversed payment funded no commercial entitlement', the signed event is retained as `failed` with the reason, and `operational_alerts()` raises `reversal-unresolved` at critical severity — the honest outcome for money that left the business against a record we cannot yet resolve.

## Adversarial review
## Verdict

The spec is **not implementable as written**. Four blocking defects (one of them a filename collision that stops `supabase db push` before any SQL runs), three correctness bugs that produce permanent stuck states in realistic flows, one lock-order inversion that will deadlock against live generation traffic, and one section that silently reverts already-shipped work. The provider-agnosticism and the "refuse rather than fabricate" discipline are, by contrast, genuinely sound — I found no fabricated provider evidence.

---

## BLOCKING

### B1. The migration filename is already taken
`supabase/migrations/202608060001_checkout_abandonment_recovery.sql` exists (26 KB, committed). The spec names its new file `supabase/migrations/202608060001_refund_and_chargeback_ingestion.sql` — identical `202608060001` version prefix. Supabase derives the migration version from the leading digits; two files with the same version is a duplicate-version error. Pick a later stamp (e.g. `202608060002_`).

The spec's `currentState` also asserts "all 13 migrations applied" — there are **17** migration files plus README.

### B2. `payment_reversal_clawbacks.recovered_microcredits` can never be written correctly
The table is declared `recovered_microcredits bigint not null` **and** carries `payment_reversal_clawbacks_are_immutable` → `billing_private.reject_immutable_mutation()` (`202607140001_subscription_billing.sql:637`, which raises `55000` on any UPDATE or DELETE).

But step "The clawback primitive" #2 requires the row to **already exist** before `claw_back_lot_credits` runs ("its id IS the ledger idempotency key, so the evidence row is written before the balance moves"), and the recovered amount is only known **after** it runs. The row cannot be updated afterward. The spec never says what value is inserted. As written this is unimplementable.

Same hole, worse, in `settle_reversal_clawbacks`: "insert a NEW `payment_reversal_clawbacks` row for the outstanding amount and call `claw_back_lot_credits`" — recovered is unknowable at insert time there too.

**Fix:** either (a) compute `least(target, lot.available_microcredits)` under the already-held lot lock and insert it as `recovered_microcredits`, then have `claw_back_lot_credits` read `v_clawback.recovered_microcredits` and assert it still matches (making the function a pure applier); or (b) drop `recovered_microcredits` from the table and derive recovery from `public.credit_ledger` rows keyed `'lot.clawback:' || id`. Option (a) is closer to house style.

### B3. `full_reversal` CHECK contradicts the cumulative-full rule
DDL:
```sql
check (full_reversal = (reversed_amount_currency_micros = original_amount_currency_micros))
```
RPC step 6: `v_full := (v_prior + v_reversed_micros = v_original_micros);`

A second partial reversal that completes the total has `reversed_amount < original_amount` but `v_full = true` → the CHECK rejects the insert, the whole transaction fails, the event lands `failed`, and the provider retries forever. This is exactly the "partial refund then refund the remainder" case, which is common.

**Fix:** change the CHECK to `check (full_reversal = (prior_reversed + reversed = original))` — which requires persisting `prior_reversed_amount_currency_micros` on the row — or drop that CHECK and keep only the `payment_reversals_one_full_per_payment` partial unique index.

### B4. Second terminal reversal on the same entitlement/subscription is a permanent 55000
`billing_private.revoke_partner_entitlement` (`202607150003_partner_lifetime_access.sql:449-458`) returns the existing row only when `status = p_terminal_status AND revocation_reason = v_reason`; otherwise, if `v_entitlement.status <> 'active'`, it raises `55000`.

The spec's "GUARD" — a deterministic reason — only covers **redelivery of the same event**. It does not cover **two distinct reversal events**. Concrete scenario:

1. Provider posts a partial chargeback (`rv_1`, 40%). `v_hostile = true` → `v_terminates = true` → revoke with reason `...:rv_1`. Entitlement → `'chargeback'`.
2. Provider posts a second chargeback or the merchant refunds the remaining 60% (`rv_2`). `v_full` → `v_terminates = true` → revoke with reason `...:rv_2`. `status <> 'active'` → **55000**, transaction rolls back, `rv_2` recorded `failed`, its clawback never happens, provider retries indefinitely.

Identical shape for subscriptions. `billing_private.enforce_subscription_state_and_catalog` (`202607150001_harden_billing_state_transitions.sql:186-190`) raises `'A terminal subscription is immutable'` for `old.status in ('canceled','expired')` on any change outside `updated_at` — and step 12 writes `entitlement_ends_at = clock_timestamp()`, which always differs. Second terminal reversal → permanent failure.

**Fix:** before revoking, `select ... from public.partner_entitlements where customer_id = v_customer_id for update` and only call `revoke_partner_entitlement` when `status = 'active'`; otherwise set `entitlement_action = 'partner_revoked'` and move on. Same for `subscriptions`: guard `if v_subscription.status not in ('canceled','expired') then ... end if`.

---

## LOCK ORDER — the spec's own guard is wrong

### L1. Lots are locked before the account (inverts the global order)
The credit subsystem's documented order is **account → quote → reservation/lots** (`202607140001_subscription_billing.sql:2098-2099`), and every deployed mutator obeys it: `expire_account_credit_lots` locks `credit_accounts FOR UPDATE` at `:1997` **before** the lot loop at `:2003-2010`; `reserve_credits` locks the account at `:2109-2114` before touching lots; `easyfield_generation_reject_submission` (`202607290001_generation_settlement_lock_order.sql:37-39`) explicitly locks `credit_accounts` before the reservation, with a header comment saying why.

The spec's RPC step 9 selects the target lots `FOR UPDATE` with no prior lock on `public.credit_accounts`; `credit_accounts` is only locked later, **inside** `claw_back_lot_credits` (step 5). Effective order: **lots → account**. A concurrent `reserve_credits` / `capture_credits` / `expire_account_credit_lots` holds the account and wants a lot; the reversal holds the lot and wants the account. That is a textbook two-transaction deadlock against live generation traffic.

The risks section claims "the account→lots suborder inside `claw_back_lot_credits` matches `expire_account_credit_lots`" — true of the helper in isolation, false of the enclosing RPC.

**Fix:** in step 8, add `perform 1 from public.credit_accounts where customer_id = v_customer_id for update;` **before** any `credit_grant_lots` select, and state it in the migration's lock-order comment. Same in `settle_reversal_clawbacks`.

### L2. DDL preflight order does not match the only precedent
The only existing DDL preflight lock is `202607150003_partner_lifetime_access.sql:6-7`: `lock table public.checkout_intents, public.payment_events in share row exclusive mode;` — checkout_intents **first**. The spec puts `payment_events` first. Migrations don't run concurrently, so this is not a real deadlock, but the test the spec proposes would pin an order that contradicts the repo's only precedent. Also note the migration performs `alter table public.credit_accounts add column`, which needs ACCESS EXCLUSIVE — a lock upgrade from the SHARE ROW EXCLUSIVE taken in the preflight. Harmless here (SRE already excludes ROW EXCLUSIVE writers) but worth stating rather than leaving implicit.

---

## ALREADY DONE ELSEWHERE / WOULD REVERT SHIPPED WORK

### R1. `run_maintenance` — the spec would delete two live jobs
The spec says "copy the deployed body from `202607290006:276-328`, add `'settle_reversal_clawbacks'` as a **fifth** allowed job."

`202608060001_checkout_abandonment_recovery.sql:481-539` already redefined `run_maintenance` with **six** jobs:
```
'expire_credit_reservations', 'expire_credit_lots', 'grant_due_annual_plan_credits',
'sweep_due_renewals', 'close_unopened_checkouts', 'expire_stale_open_checkouts'
```
plus `elsif` branches for `close_unopened_checkouts` / `expire_stale_open_checkouts` and two cron entries (`easyfield-close-unopened-checkouts`, `easyfield-expire-stale-open-checkouts`, `:554/:560`). Copying the 202607290006 body would drop both branches; the two cron jobs would then raise `'Unknown maintenance job'` every hour.

The spec's proposed test — `assert.deepEqual` on a five-element allowlist — is also wrong and directly contradicts `tests/checkout-abandonment-recovery.test.mjs:256-284`, which already parses and pins that allowlist.

**Fix:** copy from `202608060001_checkout_abandonment_recovery.sql:481`, producing a **seven**-job allowlist.

### R2. `operational_alerts` — same problem
`202608060001_checkout_abandonment_recovery.sql:575-651` already redefined it and added `'checkout-unopened-not-swept'` and `'checkout-awaiting-reconciliation'`. Copying `202607290006:148-211` deletes both. `tests/checkout-abandonment-recovery.test.mjs:285-308` asserts every code is still present, so CI would catch it — but the spec instructs the implementer to write the failing version.

### R3. `maintenance_health` — not stale, but incomplete
`maintenance_health` was **not** redefined by 202608060001, so copying `202607290006:333-372` is safe. But its `values` list still omits `close_unopened_checkouts` and `expire_stale_open_checkouts`, so those two cron jobs are unmonitored today. Adding `('settle_reversal_clawbacks', 1800)` while leaving those out perpetuates the gap. Worth adding all three.

### R4. `easyfield_admin_incidents` — the spec is correct
Not redefined by 202608060001; copying `202607290006:217-268` and adding one `'reversals'` key is accurate.

---

## OPERATIONAL DEFECT

### O1. `settle_reversal_clawbacks` churns ~13,000 dead rows per unrecoverable shortfall
The sweep runs `*/10 * * * *` and re-attempts every `(reversal, lot)` with outstanding > 0 for 90 days. Credit that was spent is never coming back, so a permanently-unrecoverable shortfall generates a new append-only `payment_reversal_clawbacks` row every 10 minutes — 6/hr × 24 × 90 ≈ **12,960 rows**, each also appending a `credit_ledger` row… except it does not, because `claw_back_lot_credits` returns `0` before inserting a ledger row (step 6). So you get ~13k evidence rows recording zero recovery, and `payment_reversals_outstanding_idx` never shrinks.

**Fix:** the sweep candidate query must also require `lot.available_microcredits > 0`, and should skip a `(reversal, lot)` whose last attempt recovered 0 and whose lot balance is unchanged since.

---

## CORRECTNESS / SPECIFICATION GAPS

### G1. `toCanonicalEvent` throwing means "200 ack" — including for a malformed real payment
Step "Route the webhook function by event kind" #4 converts **any** throw from `adapter.toCanonicalEvent` into `200 {accepted:true, processed:false, ignored:true}`, and the proposed test explicitly forbids a 400 anywhere near that call. But `canonicalHmacWebhookAdapter.toCanonicalEvent` must read `amount`, `reversalType`, etc. to build a `CanonicalBillingWebhookEvent`; if any of those are malformed on a `type: "payment.completed"` body, it throws → **200 ack, nothing recorded, provider never retries, money silently lost**. That is strictly worse than today's `HttpError(400)` at `supabase/functions/easyfield-billing-webhook/index.ts:128`.

The seam doc's claim "a malformed body of a kind we DO handle is still 400" only holds if `toCanonicalEvent` is total over the known `type` values.

**Fix:** define two distinct failure modes in the seam. `UnhandledWebhookTopicError` (a named export from `billing_provider_adapter.ts`) → 200 ignored. **Every other throw** → `HttpError(400, "Webhook body is invalid")`. `canonicalHmacWebhookAdapter.toCanonicalEvent` must pass fields through unvalidated and let `normalizeCanonicalEvent` do all validation.

### G2. The reversal payload `id` regex does not match its sibling
The spec specifies `'^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$'` for `id` and `reversedPaymentReference` and calls it "the same pattern" as the deployed validator. The deployed `payment_reconciliation_payload_is_valid` uses `{0,199}` for `id` (`202607150005_atomic_payment_reconciliation.sql:48`) and `{0,299}` only for `subscriptionReference` (`:107`). TS-side `OPAQUE_REF_PATTERN` is `{0,299}` (`account_api.ts:15`), so a 250-char payment reference already passes the TS parser and is rejected by the DB — a pre-existing latent inconsistency. Pick one deliberately and say so; do not describe `{0,299}` as matching the sibling.

### G3. `exactKeys` does not require keys to be present
`account_api.ts:120-123` only checks that every **present** key is allowed. The spec's characterization "requires exact keys" is wrong. It happens not to matter — each field is separately validated and `parseIsoInstant(undefined)` returns `null`, which the explicit null check rejects — but the implementer should not rely on `exactKeys` for presence.

### G4. Pro-rata clawback arithmetic is wrong for annual partial refunds
Step 10 computes `ceil(lot.total_microcredits * v_reversed / v_original)` for **each granted** annual lot. A customer 3 months into an annual plan has 3 granted lots out of 12. A 25% partial refund then claws back 25% of each of the 3 granted lots — but 25% of the year's price is roughly the whole 3 months they actually received. The denominator should reflect what was granted, not what was paid, or the policy should be stated explicitly as "pro-rata against granted credit." As specified, the comment "so a partial refund never leaves the customer holding more credit than they still paid for" is not what the formula does.

### G5. `lifetime_reversed_microcredits` will not appear in the customer's snapshot
The spec justifies the new column with "money taken back should be visible to the person it was taken from," citing `grant select on public.credit_accounts to authenticated` (`202607140001_subscription_billing.sql:3679` — verified, table-wide, and `credit_accounts_select_own` at `:3624` scopes it). But the client reads `public.my_billing_snapshot()`, which builds an **explicit** `jsonb_build_object` listing `lifetime_expired_microcredits` at `:3484`. The spec does not update it, so the counter is invisible in the app. Either add the key there or drop the visibility rationale.

### G6. The evidence tables should probably FORCE RLS
The spec says "Match `20260715170000`: enable RLS, do NOT force it, create no policies." That matches `20260715170000_private_billing_rls_hardening.sql` and its stated reason. But the **most recent** precedent, `202608060001_checkout_abandonment_recovery.sql:79-80` and `:256-257`, uses `enable` **and** `force row level security` for its new private tables. The spec's proposed test asserting "NO `force row level security`" would codify the older of two live conventions. Resolve which is intended before pinning it in a test. (Note the per-table `revoke all ... from public, anon, authenticated` is redundant given `20260715170000:19`, but harmless and consistent with house style.)

---

## What the spec gets right

- **No fabricated provider evidence.** Reversal events carry no `operationReference`; the operation is resolved from `public.payment_events` → `billing_private.payment_entitlement_claims`; unresolvable reversals raise rather than guess. This is the cardinal rule and the spec honors it cleanly, including the deliberate refusal for renewal-funded payments.
- **All cited objects exist** with the stated names and signatures: `billing_private.revoke_partner_entitlement(uuid, text, text)` (`202607150003:420`, zero callers outside its own grants and `tests/subscription-schema.test.mjs:859/897/901` — confirmed), `payment_reconciliation_amount_is_valid(jsonb)` (`202607140001:3047`), `record_payment_event(text,text,text,text,text,jsonb)` (`:3225`, hard-fails on `v_event_type is distinct from 'payment/received'` at `:3256`), `claim_payment_event` / `finish_payment_event` (`:3356`/`:3399`), `subscription_grant_schedule.annual_checkout_intent_id` + `granted_lot_id` (`:511`/`:515`), `credit_ledger.entry_type` allows `'refund'` (`:271`), and `credit_grant_lots_paid_source_shape` (`:336-352`) really does force `annual_monthly_grant` lots to `checkout_intent_id is null`.
- **The `checkout_intent_id`-only trap for annual plans is real** and correctly identified; the `subscription_grant_schedule` join is the right route.
- **Not clawing back `reserved_microcredits`** is correct: `credit_reservation_allocations` pins them and `check (available + reserved <= total)` (`:225`) plus `reserve_credits`'s cross-check (`:2184`, `'Credit lot balance does not reconcile with account balance'`) would break.
- **Refusing to drop the non-negative balance CHECKs** is correct.
- **The two-sided CI/release gate** is exactly as described: `scripts/release-account-config.mjs:320` fails production while the flag is `false`, `:359` fails CI while it is not `false`. Not flipping the flag in this change is right.
- **`checkout_payment_event_is_verified` requires `event_type = 'payment/received'`** (`202607140001:688`), so widening `record_payment_event` cannot let a reversal complete a checkout. Confirmed.
- **`protect_payment_event_evidence`** (`:597`) permits exactly `status, attempt_count, processing_claim_id, processing_started_at, processed_at, last_error` to change — the reversal path writes a separate row and never touches the original event, which is correct.
- **`active → canceled` is permitted** by `enforce_subscription_state_and_catalog` (catalog re-check only fires for `new.status in ('trialing','active')`), and `pending → cancelled` by `enforce_grant_schedule_terminal_state`. Both verified.
- **Concurrent double-delivery of the *same* reversal is sound.** Both workers serialize on `record_payment_event`'s `select ... for update` of the `payment_events` row; the loser sees `status = 'processed'` and takes the replay branch. No double-grant, no double-revoke.
- **`docs/ADR-002-subscriptions-and-credit-ledger.md:221`** — `8. [ ] Add verified refund/chargeback events before enabling Partner checkout.` exists as claimed.