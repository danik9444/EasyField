# Customer generation data plane: server-side metered gateway (catalog -> quote -> reserve -> submit -> poll -> capture/release), upload proxy, crash recovery, and the release/CI changes needed to flip CUSTOMER_GENERATION_GATEWAY_READY

> ## READ THE ADVERSARIAL REVIEW FIRST — this plan does not apply as written
>
> The review at the end of this document found two blockers that would break
> `main` on merge and five correctness defects. Do not implement a stage
> without reading it. The corrections, in short:
>
> 1. **Renumber every migration.** The spec starts at `202608060001`, which is
>    taken. `202608060001`–`202608060005` are all now committed. Start at
>    `202608060006`.
> 2. **The `run_maintenance` allowlist is EIGHT, not five.** It is currently
>    `expire_credit_reservations, expire_credit_lots,
>    grant_due_annual_plan_credits, sweep_due_renewals,
>    close_unopened_checkouts, expire_stale_open_checkouts,
>    settle_succeeded_renewals` — seven — and Stage E adds its own. Copying the
>    spec's five-name list makes three live cron jobs raise `22023` hourly for
>    ever. Copy the body from `202608060002`, not from `202607290006`.
> 3. **`operational_alerts` must be based on `202608060003`.** Copying an older
>    body silently deletes the checkout, renewal and reversal alerts added
>    since.
> 4. **The Wave-1 manifest is 24 rows, not 25.** The literal `25` appears in
>    four assertions and would abort the seeding migration.
> 5. **`P0001` is not a synonym for insufficient credit.**
>    `billing_private.reserve_credits` raises it for `Insufficient EasyField
>    credits` *and* for `Credit lot balance does not reconcile with account
>    balance` — verified against the live database, both with an explicit
>    `using errcode = 'P0001'`. Mapping the code to `402 Buy more credits`
>    turns a ledger-corruption alarm into a routine upsell, silently and
>    permanently. Give the corruption raise a distinct code (`XX001
>    data_corrupted` fits) in a forward-only migration before writing any
>    wrapper that discriminates on `P0001`. **NOT YET DONE.**
> 6. **Late submission binding — DONE.** Stage E's ambiguity threshold and
>    `accept_submission`'s status gate could orphan paid provider work. The
>    status gate is fixed in `202608060005_late_submission_binding.sql`. What
>    remains from that finding: Stage E's Pass 1 threshold must be strictly
>    greater than the submit timeout plus the accept-retry budget (the spec's
>    2 minutes against a 60 s submit budget is too tight — use >= 10 minutes),
>    and the returned `providerTaskRef` should be written to evidence *before*
>    the state transition is attempted.
> 7. **Handle `23505` and `55000`** in the prepare wrapper. Two concurrent
>    creates with the same operation key both miss the unlocked existence check
>    and the loser gets an unhandled unique violation on a legitimately
>    idempotent retry.
> 8. **Do not fold four different `42501` causes into one outcome.** "Customer
>    not entitled" and "server catalog is broken" need different outcomes, or a
>    resolver bug that mints an uncatalogued pricing key is indistinguishable
>    from an unsubscribed user and nothing alerts.
>
> The review also lists eight factual errors in this document's own citations
> (line numbers, key counts, and an `EXTRACTORS` map that has no `jobs` entry).
> Verify every citation before relying on it.
>
> ---
>
> ## Verified 2026-08-06: where the price manifest actually comes from
>
> Stage B1 needs a checked-in manifest, and the blocking question was whether
> real provider costs could be obtained at all without inventing them. They can.
>
> The upstream pricing feed is **public, unauthenticated and live**. Confirmed
> by direct request:
>
> ```
> POST https://${CLOUD_API_HOST}/client/v1/model-pricing/page
> {"pageNum":1,"pageSize":100,"modelDescription":"","interfaceType":""}
> ```
>
> `CLOUD_API_HOST` is the base64-encoded default in `plugin/main.cjs:110-127`.
> It is written that way — and left that way here — because
> `tests/provider-neutral-branding.test.mjs` scans `src`, `plugin`, `scripts`,
> `tests` **and `docs`** for the supplier's name. The published privacy policy
> at `website/public/privacy/` names it in full, which is where the GDPR
> Article 13(1)(e) obligation is actually discharged; `website/` is outside the
> scanned roots.
>
> (`src/services/providerGateway.ts:88` builds exactly this; the dev proxy path
> `/provider/client/v1/model-pricing/page` strips `/provider` per
> `vite.config.ts:46`. It is POST — a GET returns
> `{"code":404,"msg":"GET request not supported"}`.)
>
> What came back on 2026-08-06:
>
> - **404 rows, 5 pages at `pageSize=100`.**
> - Page 1 breakdown: 21 image, 45 video, 30 chat, 4 music.
> - **Every row carried a usable `usdPrice`** (100/100 on page 1).
> - `creditUnit` values seen: `per image`, `per second`, `per video`,
>   `per million tokens`, `per milion tokens` *(sic — the upstream typo is real
>   and a parser must tolerate it)*, `per million`, and **empty string**.
>
> A row looks like:
>
> ```json
> { "modelDescription": "Qwen image 3.0 Pro, output, 2K", "interfaceType": "image",
>   "creditPrice": "12", "creditUnit": "per image", "usdPrice": "0.06",
>   "discountRate": 20.0, "anchor": "https://${CLOUD_SITE_HOST}/qwen-image-3?..." }
> ```
>
> So `generation_price_catalog.provider_cost_currency_micros_per_unit` is
> `usdPrice × 1_000_000` — a public, re-verifiable fact, not an invention.
>
> **What is still NOT derivable, and must not be guessed:**
> `customer_microcredits_per_unit` is what EasyField *charges*, which is a
> margin decision, not an upstream fact. `src/data/pricing.ts` already applies a
> multiplier to the same live rows (`:59`), and `CREDIT_USD = 0.005` fixes the
> credit's value, so the rule exists — but committing it to the server catalog
> makes it authoritative and hard to change (the catalog has an immutability
> trigger and every change is a forward-only migration). Decide the markup
> deliberately before seeding, not as a side effect of implementing Stage B2.
>
> Two further cautions from the same fetch:
>
> - `discountRate` is present and non-zero (20% on the sampled rows). A
>   manifest that snapshots a discounted price silently bakes in a promotion.
>   Record whether `usdPrice` is the discounted or list figure.
> - The empty and misspelled `creditUnit` values mean the unit cannot be used as
>   a join key without normalisation. `parsePricingPage`
>   (`providerGateway.ts:63`) already dedupes on
>   `modelDescription|unit` lowercased — reuse that, do not re-derive it.

## Current state
All four audit findings CONFIRMED, with two corrections.

VERIFIED AS STATED.
(1) supabase/functions/easyfield-account/index.ts:530-556 - isGenerationGateway matches the four prefixes, calls authenticate() at :540, calls classifyGenerationGatewayRequest only to map method-not-allowed->405 and anything else->404, then unconditionally returns json({error:"Generation gateway is not configured", code:"generation-gateway-unavailable"}, 503). CUSTOMER_GENERATION_GATEWAY_READY (:30) is never read on this path; it gates only handleCheckout (:349), handleAutoReload (:441) and handleServiceCapabilities (:513-514). Two separate code paths, exactly as audited.
(2) supabase/functions/_shared/generation_gateway.ts is 115 lines of pure classification. CREATE_ROUTES has 6 entries, POLL_ROUTES 5. requireGenerationOperationId enforces /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/. No pricing, no fetch, no credential.
(3) Live DB xtnaqwvayenfcqzqelmh: generation_price_catalog 0 rows, generation_gateway_jobs 0, generation_gateway_events 0.
(4) Grep across the tree: the nine RPCs appear only in the two migrations and tests/generation-gateway-control-plane.test.mjs. No caller.

CORRECTION A - the real RPC names and contracts (20260715175329_generation_gateway_control_plane.sql, three of them replaced by 202607290001_generation_settlement_lock_order.sql). All are plpgsql security definer set search_path = '' with revoke all from public/anon/authenticated and grant execute to service_role.
- easyfield_generation_prepare(uuid p_user_id, text p_operation_key, text p_request_sha256, text p_pricing_key, integer p_quantity_units) returns billing_private.generation_gateway_jobs. :126 selects the active catalog row FOR SHARE; refuses if inactive or p_quantity_units > maximum_units (42501); overflow-guards both per-unit prices (22003); replays an existing (customer_id, operation_key) row only if sha/pricing_key/quantity/family/paths/model/action all match, else 22000; calls billing_private.create_generation_quote(..., clock_timestamp() + interval '15 minutes'); if NOT quote.admin_bypass calls billing_private.reserve_credits(..., clock_timestamp() + interval '24 hours'); inserts the job row (status 'prepared') and a 'prepared' event.
- easyfield_generation_begin_submission(uuid, text, text) returns table(gateway_job_id uuid, may_submit boolean, current_status text, provider_task_ref text, create_path text, poll_path text). FOR UPDATE OF j; 23503 on not-found or sha mismatch; only 'prepared' -> 'submitting' returns may_submit=true. Everything else returns may_submit=false, deliberately, because a first POST may already have spent.
- easyfield_generation_accept_submission(uuid, text, text, text p_provider_task_ref) returns the job row. Computes v_task_sha = encode(extensions.digest(v_task,'sha256'),'hex'); idempotent when already accepted/running/succeeded/reconciliation_required with the SAME sha, 22000 on a different sha; 55000 if status is not 'submitting'.
- easyfield_generation_mark_ambiguous(uuid, text, text) - 'submitting' -> 'submission_ambiguous'. Never releases credit.
- easyfield_generation_reject_submission(uuid, text, text) - only from 'submitting' with provider_task_ref IS NULL, else 55000. Releases the full remaining reservation with reason 'provider_rejected_before_acceptance' and sets status 'failed'.
- easyfield_generation_authorize_poll(uuid, text p_provider_task_ref, text p_poll_path) returns the job row. Matches on (customer.user_id, provider_task_ref_sha256, poll_path); 23503 is deliberately indistinguishable for missing and foreign tasks.
- easyfield_generation_record_poll(uuid, text, text, text p_provider_state, text p_outcome, bigint p_reported_microcredits default null). p_outcome in ('pending','succeeded','failed'). 'pending' -> 'running'. 'failed' -> release remaining, terminal 'failed'. 'succeeded' -> v_capture := least(coalesce(p_reported_microcredits, v_remaining), v_remaining), capture_credits, then release_credits('unused_approved_ceiling') for any remainder, terminal 'succeeded'. Returns early and idempotently when already succeeded/failed.
- easyfield_generation_cancel_prepared(uuid, text) returns boolean. Only from 'prepared'; releases with 'cancelled_before_submission'.
- easyfield_generation_recovery_snapshot(uuid) returns table(operation_key, family, poll_path, provider_task_ref, status, updated_at). language sql stable. Nonterminal statuses only, limit 500.
So the audit's guessed names are right except the full prefixes: easyfield_generation_begin_submission / _accept_submission / _reject_submission (not begin_submission/accept/reject).

CORRECTION B - what actually breaks on the flag flip is NOT scripts/release-account-config.mjs:314-322. Those three regexes are the PRODUCTION gate (assertProjectReleaseAccountConfig) and they FAIL WHILE fail-closed; flipping the flag and deleting the 503 body SATISFIES them. The breakage is in assertCiAccountReleaseStructure at :356 (requires CUSTOMER_GENERATION_GATEWAY_READY = false), :359 (requires PARTNER_REVERSAL_HANDLING_READY = false, still true so still passes), and :362 (requires the literal code: 'generation-gateway-unavailable'). Two of those three invert. .github/workflows/ci.yml:56 runs `release:validate-account -- --ci-structure-test` on every push and PR, and three artifact-builder steps (:76, :89, :105) set EASYFIELD_ACCOUNT_STRUCTURE_TEST: '1', so all four CI steps break the moment the flag flips. Also breaking: tests/release-account-config.test.mjs:206-248 and :265-275 (fixtures + the deepEqual on the returned shape at :221), and tests/account-edge-api.test.mjs:20 which asserts the literal generation-gateway-unavailable.

WHAT ALREADY WORKS AND MUST NOT BE REBUILT.
- Client transport is done. plugin/main.cjs:1803/1809 proxies /provider and /provider-upload; proxy() at :614 detects Authorization: Bearer __easyfield_account__ (:619), enforces bridge origin + token, then at :670-682 rewrites the target to `${gatewayRoot}/gateway/${proxyKind}${targetPath}` with the Supabase access token. proxyKind is literally 'provider' / 'provider-upload', which is byte-identical to the prefixes classifyGenerationGatewayRequest expects.
- Durable identity is done. src/services/providerGateway.ts:155-166 sends X-EasyField-Operation-Id; src/services/run.ts:426 sets gatewayOperationId: job.id and :340/:1056/:1417 derive :child:N / :angle:N / :foley:N suffixes. All conform to the 8..160 operation_key check.
- The client already has the exact submission-ambiguity semantics the RPCs need: providerGateway.ts:197-203 classifies a code-less 408/425/5xx as 'submission-uncertain' and NEVER retries it; CREATE_RETRYABLE = {429,433,455,502,503,504} only fires when the body carries a numeric `code`. This is load-bearing for the response contract below.
- Settlement lock order is fixed and proven: gateway_jobs (FOR UPDATE OF j) -> credit_accounts (FOR UPDATE) -> credit_reservations (FOR UPDATE) -> capture/release. tests/generation-gateway-control-plane.test.mjs:56-83 asserts the ordering by string offset.

REAL GAPS BEYOND THE AUDIT.
- billing_private.generation_gateway_events has NO immutability trigger. Confirmed against the live DB: zero triggers on either gateway table, while every other append-only evidence table uses billing_private.reject_immutable_mutation().
- There IS a live price feed: POST {providerOrigin}/client/v1/model-pricing/page, unauthenticated, paginated (pageSize 100, up to 20 pages), fields modelDescription/interfaceType/creditPrice/creditUnit/usdPrice (src/services/providerGateway.ts:88-121). But it is keyed by human text and matched by fuzzy token search (livePrice(['google nano banana pro','1/2k'])). It is NOT safe as an authorization key. src/data/pricing.ts:15 FALLBACK_PRICE_DATE = '2026-07-11' dates the checked-in fallback tables, and priceSourceLabel() renders that as 'UPDATED 7/11'. Those reviewed fallback numbers, not the live feed, are the correct seed source.
- Scale, from the migration header and plan_catalog: 1 EasyField credit = 1,000,000 microcredits; money is integer currency micros; DIRECT_PROVIDER_CREDIT_USD = 0.005 so one provider credit = 5,000 currency micros. Worst customer rate is Studio's top_up_currency_micros_per_credit = 10000.
- create_generation_quote checks `btrim(p_model_id) = any(v_plan.blocked_model_ids)` and starter blocks 'bytedance/seedance-2', so generation_price_catalog.model_id MUST be the exact provider model string.
- billing_private.reserve_credits raises 'Insufficient EasyField credits' with errcode P0001, which PostgREST returns as HTTP 400 and the existing serviceRpc() collapses to a generic 400. The data plane needs a typed outcome instead of parsing Postgres error text.
- /api/v1/chat/credit is classified as kind 'credits' but must never be forwarded: upstream it returns EasyField's own aggregate provider balance.
- /client/v1/model-pricing/page is not in CREATE_ROUTES or POLL_ROUTES, so account customers get 404 from fetchModelPrices() (src/App.tsx:510). Correct - customers must be priced in EasyField credits from the server catalog - but it means the panel's estimate for a customer account is fallback-only until a server manifest endpoint exists.

## Seam
TWO seams. The payment-provider seam is the one that stays unimplemented; the generation-provider seam is implemented but must stay swappable.

SEAM 1 (stays unimplemented until a payment provider is chosen). The generation data plane never calls it. Credits enter an account ONLY through billing_private.grant_credits(...), which today is reachable through a completed checkout or an admin action. The unimplemented functions are, verbatim:

  // supabase/functions/easyfield-account/index.ts:270
  async function createHostedSession(config: CheckoutAdapterConfig, input: {
    readonly operationId: string; readonly offerKey: string;
    readonly purchaseKind: HostedCheckoutExpectation["purchaseKind"];
    readonly amountMinorUnits?: number; readonly currencyCode?: string;
    readonly user: AuthUser;
  }): Promise<VerifiedHostedCheckoutSession>

  // supabase/functions/_shared/account_api.ts
  export function verifyHostedCheckoutSession(
    payload: unknown, expected: HostedCheckoutExpectation, checkoutHosts: ReadonlySet<string>
  ): VerifiedHostedCheckoutSession   // { checkoutUrl, checkoutReference, expiresAt }

The HTTP shape they speak is already provider-neutral (operationId, variantId, offerKey, purchaseKind, amount{currency,minorUnits,exponent}, successUrl, cancelUrl, notificationUrl, idempotency-key header). What is missing is only the concrete service behind EASYFIELD_CHECKOUT_API_URL and the signature verifier in easyfield-billing-webhook. CONSEQUENCE FOR THIS PLAN: every stage below is shippable and end-to-end testable with zero payment-provider code, by funding a test account with billing_private.grant_credits(...). Do not introduce any Stripe/Paddle/PayPal name, variant id, price id, or webhook shape anywhere in this work.

SEAM 2 (implemented here, but isolated so the AI provider can be swapped). Exactly one new module may know an upstream host, path or credential. Everything else in the data plane depends only on these types.

  // supabase/functions/_shared/generation_provider_adapter.ts
  export interface ProviderCreateResult {
    readonly outcome: "accepted" | "rejected" | "ambiguous";
    readonly providerTaskRef: string | null;   // non-null IFF outcome === "accepted"
    readonly upstreamStatus: number;
    readonly bodyBytes: Uint8Array;            // verbatim, returned to the client unmodified
  }
  export interface ProviderPollResult {
    readonly outcome: "pending" | "succeeded" | "failed";
    readonly providerState: string | null;         // <= 120 chars, else null
    readonly providerCreditMicros: number | null;  // provider credits x 1e6, evidence only
    readonly upstreamStatus: number;
    readonly bodyBytes: Uint8Array;
  }
  export interface ProviderUploadResult { readonly upstreamStatus: number; readonly bodyBytes: Uint8Array; }
  export interface GenerationProviderAdapter {
    submit(input: { readonly createPath: string; readonly family: GenerationFamily;
                    readonly bodyBytes: Uint8Array; readonly idempotencyKey: string }): Promise<ProviderCreateResult>;
    poll(input: { readonly pollPath: string; readonly family: GenerationFamily;
                  readonly providerTaskRef: string }): Promise<ProviderPollResult>;
    upload(input: { readonly bodyBytes: Uint8Array }): Promise<ProviderUploadResult>;
  }
  export interface UpstreamProviderConfig {
    readonly apiOrigin: string; readonly uploadOrigin: string; readonly token: string;
  }
  export function parseUpstreamProviderConfig(env: Record<string, string | undefined>): UpstreamProviderConfig;
  export function createUpstreamProviderAdapter(config: UpstreamProviderConfig): GenerationProviderAdapter;

MANDATORY CLASSIFICATION RULE for submit(): outcome is "accepted" only when the parsed body has code === 200 AND a non-empty data.taskId. It is "rejected" only when the body carries a numeric `code` that is not 200 AND data.taskId is absent. EVERY other case - transport throw, non-JSON body, missing code on a 408/425/5xx, a 200 with no taskId - is "ambiguous". Fail closed toward ambiguous; never toward rejected. This mirrors src/services/providerGateway.ts:181-206 exactly and is the invariant that prevents refunding work the provider actually did.

## Steps

### Step 1: Stage A1 - harden the deployed gateway evidence tables and constrain the pricing key
FILE: supabase/migrations/202608060001_generation_gateway_evidence_hardening.sql

New forward-only migration; begin; ... commit;. Do NOT edit 20260715175329.

lock table billing_private.generation_price_catalog, billing_private.generation_gateway_jobs, billing_private.generation_gateway_events in access exclusive mode;

1. create trigger generation_gateway_events_are_immutable before update or delete on billing_private.generation_gateway_events for each row execute function billing_private.reject_immutable_mutation();  -- the table is append-only evidence and today has zero triggers.
2. alter table billing_private.generation_price_catalog add column unit_kind text not null default 'request' check (unit_kind in ('request','second','thousand_characters'));
3. alter table billing_private.generation_price_catalog add constraint generation_price_catalog_key_shape check (pricing_key ~ '^[a-z]+:[A-Za-z0-9._/-]{1,120}:[A-Za-z0-9=,.-]{1,80}$');  -- safe: the table is empty. Locks pricing_key to family:model_id:variant so a resolver bug cannot mint a novel key shape.
4. create table billing_private.generation_price_catalog_revisions (id bigint generated always as identity primary key, pricing_version text not null check (char_length(pricing_version) between 1 and 120), pricing_key text not null, action text not null check (action in ('inserted','activated','deactivated')), customer_microcredits_per_unit bigint not null, provider_cost_currency_micros_per_unit bigint not null, reason text not null check (char_length(reason) between 3 and 400), created_at timestamptz not null default clock_timestamp()); create index generation_price_catalog_revisions_version_idx on billing_private.generation_price_catalog_revisions (pricing_version, pricing_key); create trigger generation_price_catalog_revisions_are_immutable before update or delete on ... execute function billing_private.reject_immutable_mutation(); alter table ... enable row level security;
5. create table billing_private.generation_provider_cost_observations (id bigint generated always as identity primary key, gateway_job_id uuid not null unique references billing_private.generation_gateway_jobs(id) on delete restrict, provider_credit_micros bigint not null check (provider_credit_micros >= 0), quoted_provider_cost_currency_micros bigint not null check (quoted_provider_cost_currency_micros >= 0), provider_cost_currency_code text not null check (provider_cost_currency_code ~ '^[A-Z]{3}$'), observed_at timestamptz not null default clock_timestamp()); + immutability trigger + enable row level security.
6. revoke all on both new tables from public, anon, authenticated; grant select, insert to service_role; grant usage, select on both identity sequences to service_role.

### Step 2: Stage A2 - typed prepare wrapper so insufficient credit is not a generic 400
FILE: supabase/migrations/202608060002_generation_prepare_operation.sql
DEPENDS: Stage A1

begin; ... commit;. reserve_credits raises P0001 for 'Insufficient EasyField credits' and create_generation_quote raises 42501 for a missing entitlement; PostgREST flattens both to HTTP 400/403 and the edge function must not parse Postgres message text.

create or replace function public.easyfield_generation_prepare_operation(p_user_id uuid, p_operation_key text, p_request_sha256 text, p_pricing_key text, p_quantity_units integer) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job billing_private.generation_gateway_jobs;
begin
  begin
    v_job := public.easyfield_generation_prepare(p_user_id, p_operation_key, p_request_sha256, p_pricing_key, p_quantity_units);
  exception
    when sqlstate 'P0001' then return jsonb_build_object('outcome','insufficient_credits');
    when sqlstate '42501' then return jsonb_build_object('outcome','not_entitled');
    when sqlstate '22000' then return jsonb_build_object('outcome','conflict');
    when sqlstate '22023' or sqlstate '22003' then return jsonb_build_object('outcome','invalid');
  end;
  return jsonb_build_object('outcome','prepared','gatewayJobId',v_job.id,'status',v_job.status,'createPath',v_job.create_path,'pollPath',v_job.poll_path,'providerTaskRef',v_job.provider_task_ref);
end; $$;

The inner block is a subtransaction, so a raise rolls back the quote/reservation/job insert cleanly and leaves no orphan row. Never widen the handler to `when others`; an unexpected sqlstate must still propagate.

revoke all on function public.easyfield_generation_prepare_operation(uuid, text, text, text, integer) from public, anon, authenticated; grant execute ... to service_role;

### Step 3: Stage A3 - upload authorization, balance, and provider-cost evidence RPCs
FILE: supabase/migrations/202608060003_generation_gateway_support_rpcs.sql
DEPENDS: Stage A1

begin; ... commit;. Three functions, all plpgsql security definer set search_path = '', all revoked from public/anon/authenticated and granted to service_role only.

1. create table billing_private.generation_upload_grants (id bigint generated always as identity primary key, customer_id uuid not null references public.billing_customers(id) on delete restrict, usage_day date not null, bytes bigint not null check (bytes between 1 and 26214400), created_at timestamptz not null default clock_timestamp()); create index generation_upload_grants_customer_day_idx on billing_private.generation_upload_grants (customer_id, usage_day); + reject_immutable_mutation trigger + enable row level security + service_role grants.

2. public.easyfield_generation_authorize_upload(p_user_id uuid, p_request_bytes bigint) returns jsonb. Body: reject p_request_bytes outside 1..26214400 with 22023. Resolve customer via public.billing_customers. Compute v_admin := billing_private.is_active_admin(p_user_id). If not v_admin, require BOTH (a) the identical catalog-backed active-subscription predicate used by billing_private.create_generation_quote (join public.subscriptions to billing_private.plan_catalog on plan_key and active, status in ('trialing','active'), coalesce(entitlement_ends_at, current_period_end) > clock_timestamp(), pricing_version/currency/unit amount/included grant all matching the catalog) and (b) exists (select 1 from public.credit_accounts where customer_id = v_customer_id and available_microcredits > 0). Failing either returns jsonb_build_object('allowed', false, 'reason', 'not_entitled'). Then lock the account row: perform 1 from public.credit_accounts where customer_id = v_customer_id for update (this is the head of the established lock order and keeps two concurrent uploads from both passing the cap). Sum today's bytes; v_daily_cap constant bigint := 2147483648. If sum + p_request_bytes > v_daily_cap return jsonb_build_object('allowed', false, 'reason', 'daily_limit'). Else insert the grant row and return jsonb_build_object('allowed', true, 'remainingDailyBytes', v_daily_cap - sum - p_request_bytes).

3. public.easyfield_generation_balance(p_user_id uuid) returns bigint, language sql stable security definer. Returns coalesce((select a.available_microcredits from public.credit_accounts a join public.billing_customers c on c.id = a.customer_id where c.user_id = p_user_id), 0). Serves /api/v1/chat/credit locally so EasyField's own upstream balance is never disclosed.

4. public.easyfield_generation_record_provider_cost(p_user_id uuid, p_provider_task_ref text, p_poll_path text, p_provider_credit_micros bigint) returns boolean. Authorizes via v_job := public.easyfield_generation_authorize_poll(p_user_id, p_provider_task_ref, p_poll_path) so ownership rules are not duplicated. Reads the catalog row for v_job.pricing_key, computes v_quoted := price.provider_cost_currency_micros_per_unit * v_job.quantity_units, then insert into billing_private.generation_provider_cost_observations (gateway_job_id, provider_credit_micros, quoted_provider_cost_currency_micros, provider_cost_currency_code) values (v_job.id, p_provider_credit_micros, v_quoted, price.provider_cost_currency_code) on conflict (gateway_job_id) do nothing; return true. This is margin evidence only and MUST NOT touch any reservation.

### Step 4: Stage B1 - the reviewed price manifest (data, checked in, not generated at build time)
FILE: supabase/pricing/generation-price-manifest.v1.json
DEPENDS: Stage A1

A JSON array of rows. Source of truth is the reviewed fallback tables in src/data/pricing.ts dated FALLBACK_PRICE_DATE = '2026-07-11' (IMAGE_FALLBACK, FLUX_FALLBACK, and the suno/sounds fallbacks at :524/:530). NOT the live feed: that feed is keyed by human text and fuzzy-matched, so it can never authorize a charge.

Conversion, exactly:
  customer_microcredits_per_unit          = round(providerCredits * 1000000)
  provider_cost_currency_micros_per_unit  = round(providerCredits * 5000)      // 1 provider credit = $0.005 = 5000 currency micros
  provider_cost_currency_code             = 'USD'
  pricing_version                         = 'generation-2026-08-06-v1'
That is a flat 1 EasyField credit per 1 provider credit. At the WORST customer rate in the catalog (Studio, top_up_currency_micros_per_credit = 10000) it yields exactly 2x provider cost; every other plan is better.

WAVE 1 SCOPE - unit_kind 'request' and maximum_units 1 only. No per-second video rows; those land in a later manifest revision once unit_kind 'second' is exercised. Wave 1 rows (family, create_path, poll_path, model_id, action, variant, providerCredits):
  jobs /api/v1/jobs/createTask /api/v1/jobs/recordInfo gpt-image-2-text-to-image image.create res=1K 6 | res=2K 10 | res=4K 16
  same, gpt-image-2-image-to-image image.edit res=1K 6 | res=2K 10 | res=4K 16
  nano-banana-pro image.create res=1K 18 | res=2K 18 | res=4K 24
  nano-banana-2 image.create res=1K 8 | res=2K 12 | res=4K 18
  nano-banana-2-lite image.create default 4
  seedream/5-lite-text-to-image image.create default 5.5 ; seedream/5-lite-image-to-image image.edit default 5.5
  seedream/4.5-text-to-image image.create default 6.5 ; seedream/4.5-edit image.edit default 6.5
  wan/2-7-image image.create res=1K 4.8 | res=2K 4.8 | res=4K 12
  qwen2/text-to-image image.create default 5.6 ; qwen2/image-edit image.edit default 5.6
  suno /api/v1/generate /api/v1/generate/record-info suno-v5 audio.music default 12
  sounds /api/v1/generate/sounds /api/v1/generate/record-info suno-sounds audio.sfx default 2.5

pricing_key = `${family}:${model_id}:${variant}`, e.g. jobs:nano-banana-pro:res=4K, jobs:qwen2/image-edit:default, sounds:suno-sounds:default.

model_id MUST be byte-identical to the string passed to job(...) in src/data/providerModels.ts, because billing_private.create_generation_quote enforces plan_catalog.blocked_model_ids against it (starter blocks 'bytedance/seedance-2').

### Step 5: Stage B2 - seed the catalog inert
FILE: supabase/migrations/202608060004_generation_price_manifest_v1.sql
DEPENDS: Stage B1

begin; ... commit;. Literal INSERT statements transcribed from the manifest - the migration must not read a file.

lock table billing_private.generation_price_catalog in access exclusive mode;

Preflight, fail closed: if exists (select 1 from billing_private.generation_price_catalog) then raise exception 'Generation price catalog is not empty; write a forward-only revision instead' using errcode = '55000'; end if;

insert into billing_private.generation_price_catalog (pricing_key, model_id, action, family, create_path, poll_path, customer_microcredits_per_unit, provider_cost_currency_micros_per_unit, provider_cost_currency_code, pricing_version, maximum_units, unit_kind, active) values (...);   -- active is LEFT AT THE COLUMN DEFAULT false. Nothing can be charged until Stage G1.

Post-insert invariants, each raising 55000 on failure:
  get diagnostics v_inserted = row_count; if v_inserted <> 25 then raise ...
  margin floor: if exists (select 1 from billing_private.generation_price_catalog where pricing_version = 'generation-2026-08-06-v1' and customer_microcredits_per_unit / 100 < provider_cost_currency_micros_per_unit * 2) then raise exception 'A generation price does not clear the 2x floor at the lowest plan credit rate' ...   -- customer_microcredits/100 is the revenue in currency micros at 10000 micros per credit.
  if exists (select 1 from billing_private.generation_price_catalog where active) then raise exception 'Wave-1 prices must be seeded inert' ...
  every create_path/poll_path pair must be one of the six/five pairs in _shared/generation_gateway.ts; assert with an explicit IN list.

insert into billing_private.generation_price_catalog_revisions (pricing_version, pricing_key, action, customer_microcredits_per_unit, provider_cost_currency_micros_per_unit, reason) select pricing_version, pricing_key, 'inserted', customer_microcredits_per_unit, provider_cost_currency_micros_per_unit, 'Wave-1 reviewed manifest derived from FALLBACK_PRICE_DATE 2026-07-11 at 1 EasyField credit per provider credit' from billing_private.generation_price_catalog;

### Step 6: Stage B3 - the server-side authoritative price resolver
FILE: supabase/functions/_shared/generation_pricing.ts
DEPENDS: Stage B2

Pure module. No Deno, no fetch, no credential, mirroring the discipline of _shared/account_api.ts.

export interface PricedGenerationRequest {
  readonly pricingKey: string; readonly quantityUnits: number;
  readonly modelId: string; readonly unitKind: "request" | "second" | "thousand_characters";
}
export function canonicalJson(value: unknown): string;
export function resolvePricedGenerationRequest(family: GenerationFamily, createPath: string, body: unknown): PricedGenerationRequest;

canonicalJson: recursive, object keys sorted by UTF-16 code unit, arrays order-preserved, rejects undefined / functions / non-finite numbers / depth > 12 / more than 4096 nodes, no whitespace. This is what gets SHA-256'd into request_sha256, and it must be byte-stable across the prepare / begin / accept / reject calls of one operation - compute it ONCE per request and thread the digest through.

Internal, frozen:
  interface PricedDimension { readonly key: string; readonly field: string; readonly allowed: readonly string[]; readonly fallback: string }
  interface PricedModelSpec { readonly modelId: string; readonly family: GenerationFamily; readonly createPath: string; readonly unitKind: ...; readonly maximumUnits: number; readonly dimensions: readonly PricedDimension[] }
  const PRICED_MODELS: ReadonlyMap<string, PricedModelSpec>   // keyed by `${family}:${modelId}`

Algorithm:
  1. family 'jobs': body must be a plain object with EXACTLY the keys {model, input}; model a string; input a plain object. Any extra top-level key -> throw. Dedicated families: body is the flat object; modelId comes from the spec, not the body.
  2. spec = PRICED_MODELS.get(`${family}:${modelId}`); miss -> throw TypeError("unpriceable-request").
  3. spec.createPath must equal the createPath argument, else throw. (Defence against a route/model mismatch.)
  4. For each dimension in declaration order: read input[field]; if absent use fallback; if the value is not a string in `allowed` -> throw. Never coerce, never default silently on a present-but-unknown value.
  5. variant = dimensions.map(d => `${d.key}=${value}`).join(",") || "default".
  6. pricingKey = `${family}:${modelId}:${variant}`; assert it matches /^[a-z]+:[A-Za-z0-9._\/-]{1,120}:[A-Za-z0-9=,.-]{1,80}$/ (same regex as the DB constraint) else throw.
  7. quantityUnits: wave 1 is always 1. The signature already carries unitKind so wave 2 can add a per-spec units(body) reader without a breaking change.

The exact `field` names per model (e.g. which key carries resolution for nano-banana-pro vs qwen2) MUST be transcribed from src/data/imageModelConfig.ts and the builders in src/data/providerModels.ts:80-200, not invented. A test (below) asserts every PRICED_MODELS modelId appears verbatim in providerModels.ts.

Throw, never return a fallback price. An unpriceable request is a 422 and no upstream call.

### Step 7: Stage C - the upstream provider adapter (Seam 2)
FILE: supabase/functions/_shared/generation_provider_adapter.ts
DEPENDS: Stage B3

The ONLY module in the data plane that knows an upstream host or holds the provider credential. Implements the interfaces given in the Seam section.

parseUpstreamProviderConfig(env): reads EASYFIELD_GENERATION_API_ORIGIN, EASYFIELD_GENERATION_UPLOAD_ORIGIN, EASYFIELD_GENERATION_API_TOKEN. Each origin must parse as a URL with protocol 'https:', no username/password/port/search/hash, and pathname '/'. Token: 1..8192 chars matching /^[\x21-\x7e]+$/ (same shape validateDirectCloudCredential enforces in plugin/main.cjs:2327). Throw on anything else; the caller turns that into a 503 with NO body `code`.

createUpstreamProviderAdapter(config):
  submit(): fetch(`${apiOrigin}${createPath}`, {method:'POST', redirect:'error', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json', accept:'application/json', 'idempotency-key': idempotencyKey}, body: bodyBytes}). Read at most MAX_UPSTREAM_RESPONSE_BYTES = 4*1024*1024 into bodyBytes. Parse defensively; apply the mandatory classification rule from the Seam section. providerTaskRef must additionally match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/ (the TASK_PATTERN already in generation_gateway.ts) or the result degrades to "ambiguous".
  poll(): fetch(`${apiOrigin}${pollPath}?taskId=${encodeURIComponent(providerTaskRef)}`, GET, same auth). Per-family extraction transcribed from src/services/providerGateway.ts:643-701 EXTRACTORS - jobs: data.state 'success'/'fail'; veo and aleph: successFlag 1 done, 2|3 failed; runway: state 'success'/'fail'; suno and sounds: status 'SUCCESS' with audio urls present, /FAILED|ERROR|EXCEPTION/ failed. Anything else is "pending". providerState = the raw state string truncated to 120 chars. providerCreditMicros = round(data.creditsConsumed * 1e6) when finite and >= 0, else null.
  upload(): fetch(`${uploadOrigin}/api/file-base64-upload`, POST, same auth, body forwarded verbatim).
  All three: redirect:'error', an AbortSignal with a 60s (submit/upload) or 30s (poll) timeout, and no upstream header is ever copied back to the client except content-type.

Add MAX_GENERATION_CREATE_BYTES = 256 * 1024 and MAX_GENERATION_UPLOAD_BYTES = 24 * 1024 * 1024 as exports here. MAX_ACCOUNT_REQUEST_BYTES (64 KB) must NOT be reused - and readJson() must NOT be used, because the gateway needs raw bytes for canonicalization and verbatim forwarding.

### Step 8: Stage D - the orchestrator: quote -> reserve -> submit -> accept/reject/ambiguous
FILE: supabase/functions/_shared/generation_gateway_data_plane.ts
DEPENDS: Stage C

export interface GenerationGatewayDeps {
  readonly adapter: GenerationProviderAdapter;
  readonly rpc: <T>(name: string, body: Record<string, unknown>) => Promise<T>;
  readonly userId: string;
}
export async function handleGenerationGateway(request: Request, path: string, deps: GenerationGatewayDeps): Promise<Response>;

CREATE flow (route.kind === "create"):
 1. bodyBytes = raw body, reject > MAX_GENERATION_CREATE_BYTES with 413.
 2. parsed = JSON.parse(utf8, fatal); canonical = canonicalJson(parsed); requestSha256 = hex(await crypto.subtle.digest("SHA-256", utf8(canonical))).
 3. priced = resolvePricedGenerationRequest(route.family, route.createPath, parsed). Throw -> 422 body {"code":422,"msg":"This model or option is not available on your plan"}.
 4. rpc easyfield_generation_prepare_operation {p_user_id, p_operation_key: route.operationId, p_request_sha256, p_pricing_key: priced.pricingKey, p_quantity_units: priced.quantityUnits}. Map outcome: insufficient_credits -> 402 {"code":402,...}; not_entitled -> 403 {"code":403,...}; conflict -> 409 {"code":409,...}; invalid -> 400 {"code":400,...}.
 5. rpc easyfield_generation_begin_submission {p_user_id, p_operation_key, p_request_sha256}. PostgREST returns a one-row array; take [0].
    - may_submit === false && current_status in ('accepted','running') -> 200 {"code":200,"data":{"taskId": provider_task_ref}}. This is the replay path that makes a retried create safe.
    - may_submit === false && current_status in ('submitting','submission_ambiguous') -> 503 with NO `code` key: {"msg":"The submission outcome is unknown; check Activity before generating again."}.
    - may_submit === false && current_status in ('succeeded','failed','cancelled','reconciliation_required') -> 409 {"code":409,...}.
 6. result = await adapter.submit({createPath: route.createPath, family: route.family, bodyBytes, idempotencyKey: route.operationId}).
 7. accepted: rpc easyfield_generation_accept_submission {..., p_provider_task_ref}. Retry that RPC once on a transport failure. If it still fails, return 503 WITH NO `code` and leave the job in 'submitting' for the reconciler - never swallow it.
    rejected: rpc easyfield_generation_reject_submission {...} (releases the reservation), then return result.upstreamStatus with result.bodyBytes verbatim.
    ambiguous: rpc easyfield_generation_mark_ambiguous {...}, then 503 with NO `code`.
 8. On the accepted path return result.upstreamStatus with result.bodyBytes verbatim so the client parses the real taskId.

THE `code` RULE IS LOAD-BEARING. src/services/providerGateway.ts:197 classifies a code-less 408/425/5xx as 'submission-uncertain' and never retries. A 503 that DOES carry {"code":503} is in CREATE_RETRYABLE and would be re-POSTed, double-charging. Every ambiguous response from this module must omit `code`.

POLL flow (route.kind === "poll"):
 1. rpc easyfield_generation_authorize_poll {p_user_id, p_provider_task_ref: route.taskId, p_poll_path: route.pollPath}; a raise -> 404 {"code":404,...}.
 2. result = await adapter.poll(...). On transport failure return 503 {"code":503} - polls ARE safely retryable (POLL_RETRYABLE includes 503) and carry no charge.
 3. rpc easyfield_generation_record_poll {p_user_id, p_provider_task_ref, p_poll_path, p_provider_state: result.providerState, p_outcome: result.outcome, p_reported_microcredits: null}.
    ALWAYS null. p_reported_microcredits is denominated in CUSTOMER microcredits (it is compared to the reservation remainder); the provider's creditsConsumed is in provider credits and is not the customer price. null makes v_capture := least(coalesce(null, v_remaining), v_remaining) = v_remaining, i.e. charge exactly the quoted price. Passing the provider number here would undercharge by roughly the whole margin.
 4. If result.outcome !== 'pending' && result.providerCreditMicros != null: rpc easyfield_generation_record_provider_cost {...}. Best-effort; a failure here must not change the HTTP result.
 5. Return result.upstreamStatus with result.bodyBytes verbatim.

CREDITS flow (route.kind === "credits"): NEVER forward. micros = rpc easyfield_generation_balance {p_user_id}; return 200 {"code":200,"data": Math.floor(micros / 1000000)}. Forwarding would disclose EasyField's own aggregate upstream balance to every customer.

UPLOAD flow (route.kind === "upload"): bodyBytes, reject > MAX_GENERATION_UPLOAD_BYTES with 413. rpc easyfield_generation_authorize_upload {p_user_id, p_request_bytes: bodyBytes.byteLength}; allowed=false -> 403 {"code":403,...} with reason-specific msg. Then adapter.upload and return verbatim. The customer never holds the provider credential; the adapter attaches it server-side, exactly as plugin/main.cjs proxy() does for the direct path.

No Postgres message text, provider host, upstream header, or stack ever reaches the client.

### Step 9: Stage D2 - wire the data plane into the edge function and flip the delivery gate
FILE: supabase/functions/easyfield-account/index.ts
DEPENDS: Stage D

Add at the top: import { handleGenerationGateway } from "../_shared/generation_gateway_data_plane.ts"; and import { createUpstreamProviderAdapter, parseUpstreamProviderConfig } from "../_shared/generation_provider_adapter.ts";

Replace the block at :534-556 with:
  if (isGenerationGateway) {
    const { user } = await authenticate(request);
    if (!CUSTOMER_GENERATION_GATEWAY_READY) throw new HttpError(503, "Generation is not available yet");
    let adapter;
    try { adapter = createUpstreamProviderAdapter(parseUpstreamProviderConfig(generationEnvRecord())); }
    catch { return json({ error: "Generation is temporarily unavailable" }, 503); }   // no `code` key
    return await handleGenerationGateway(request, path, { adapter, rpc: serviceRpc, userId: user.id });
  }
The route classification (405 / 404 mapping) moves inside handleGenerationGateway so the allowlist behaviour is preserved byte-for-byte and stays unit-testable.

Add generationEnvRecord() alongside envRecord() returning the three EASYFIELD_GENERATION_* variables. Do NOT add them to envRecord(), which feeds parseCheckoutAdapterConfig.

This is the ONLY place where delivery becomes gated by the flag rather than unconditionally closed - which is the specific defect the audit found. Keep the flag at false in this step; Stage G flips it.

Deploy note: set EASYFIELD_GENERATION_API_ORIGIN / _UPLOAD_ORIGIN / _API_TOKEN as Supabase function secrets. They must never appear in plugin/account-config.json, which is validated by validateReleaseAccountConfig and only allows the five fields supabaseUrl/anonKey/accountApiUrl/oauthProviders/checkoutHosts.

### Step 10: Stage E - server-side reconciliation of stuck submissions
FILE: supabase/migrations/202608060005_generation_reconciliation_maintenance.sql
DEPENDS: Stage A1

begin; ... commit;.

1. create or replace function billing_private.reconcile_generation_submissions(p_limit integer default 1000) returns setof uuid language plpgsql security definer set search_path = ''. Two passes, each `select id ... for update skip locked limit v_limit` then update + append the matching event. It touches ONLY generation_gateway_jobs and generation_gateway_events - no credit_accounts, no credit_reservations, so it takes exactly one lock class and cannot deadlock with settlement.
   Pass 1: status = 'submitting' and submitted_at < clock_timestamp() - interval '2 minutes' -> status 'submission_ambiguous', event 'submission_ambiguous'.
   Pass 2: status = 'submission_ambiguous' and updated_at < clock_timestamp() - interval '24 hours' -> status 'reconciliation_required', event 'reconciliation_required'.
   It MUST NOT release credit in either pass. An ambiguous POST may have spent real money upstream; only human/admin reconciliation, or a later successful poll, may settle it. This is the same refusal-to-assume the harden_billing_state_transitions migration establishes.

2. create or replace function billing_private.run_maintenance(p_job text, p_limit integer default 1000) - full re-creation extending the allowlist to ('expire_credit_reservations','expire_credit_lots','grant_due_annual_plan_credits','sweep_due_renewals','reconcile_generation_submissions'), adding the branch `select count(*) into v_count from billing_private.reconcile_generation_submissions(v_limit);`. Preserve the existing structure exactly: the maintenance_runs insert stays OUTSIDE the exception block, and the handler records sqlstate/sqlerrm and returns -1.

3. create or replace function billing_private.maintenance_health() adding ('reconcile_generation_submissions', 300) to the expected VALUES list.

4. do $$ begin if exists (select 1 from cron.job where jobname = 'easyfield-reconcile-generation') then perform cron.unschedule('easyfield-reconcile-generation'); end if; end $$;
   select cron.schedule('easyfield-reconcile-generation', '* * * * *', $job$select billing_private.run_maintenance('reconcile_generation_submissions', 2000)$job$);

5. create or replace function public.easyfield_admin_incidents(uuid, integer) - full re-creation adding a 'generationReconciliation' key: jobs with status in ('submission_ambiguous','reconciliation_required') ordered by updated_at desc limit v_limit, exposing id, customerId, operationKey, status, pricingKey, updatedAt; plus 'expiredGatewayReservations': nonterminal jobs (status in 'accepted','running','submission_ambiguous','reconciliation_required') joined to public.credit_reservations where the reservation expires_at < clock_timestamp(). The second list is the alarm for the leak described in Risks. Keep every existing key.

6. revoke all on function billing_private.reconcile_generation_submissions(integer) from public, anon, authenticated; and re-issue grant execute on public.easyfield_admin_incidents(uuid, integer) to service_role.

### Step 11: Stage F - crash recovery surfaced to the client
FILE: supabase/functions/easyfield-account/index.ts
DEPENDS: Stage D2

Add a GET-only route /generation-recovery beside /direct-access and /service-capabilities (extend both the method guard at :557 and the allowlist at :563).

async function handleGenerationRecovery(user: AuthUser): Promise<Response> - if (!CUSTOMER_GENERATION_GATEWAY_READY) return json({ operations: [] }); rows = await serviceRpc<unknown[]>("easyfield_generation_recovery_snapshot", { p_user_id: user.id }); validate each row against an exact key set {operation_key, family, poll_path, provider_task_ref, status, updated_at} and the six family / nine status enums, drop anything else, cap at 500, return { operations: [...] } with camelCased keys.

Deliberately a sibling account route, NOT a /gateway/* route: the renderer reaches account endpoints through plugin/account-service.cjs IPC, whereas /gateway/* is only reachable through the plugin's streaming proxy (plugin/main.cjs:1803). Reusing the account channel avoids touching proxy().

Then in plugin/account-service.cjs, fetch /generation-recovery in the same refresh cycle as fetchServiceCapabilities (:812) with the same strict key/shape validation, and add it to the snapshot so the renderer's job center can resume polling accepted tasks after a crash that lost the local SQLite ledger. The server binding (provider_task_ref, unique on its sha256) is the durable record; the local ledger is a cache.

Grant already exists - easyfield_generation_recovery_snapshot(uuid) is granted to service_role by the deployed migration. No new migration needed.

### Step 12: Stage G1 - activate the prices
FILE: supabase/migrations/202608060006_activate_generation_prices_v1.sql
DEPENDS: Stage E

begin; ... commit;. Ships in the SAME release as the flag flip, and only after Stages A-F are deployed and green.

lock table billing_private.generation_price_catalog in access exclusive mode;

Preflight, all fail-closed with 55000:
  exactly 25 rows exist at pricing_version 'generation-2026-08-06-v1';
  none is currently active;
  every row re-passes the 2x floor (customer_microcredits_per_unit / 100 >= provider_cost_currency_micros_per_unit * 2);
  every row's unit_kind = 'request' and maximum_units = 1.

update billing_private.generation_price_catalog set active = true, updated_at = clock_timestamp() where pricing_version = 'generation-2026-08-06-v1'; get diagnostics v_updated = row_count; if v_updated <> 25 then raise ...

insert into billing_private.generation_price_catalog_revisions (..., action, reason) select ..., 'activated', 'Wave-1 activation alongside the metered data plane release' from ... where pricing_version = 'generation-2026-08-06-v1';

Keeping activation in its own migration means a rollback is one more forward-only migration setting active = false, with no code deploy and no price rewrite.

### Step 13: Stage G2 - flip the flag and migrate the release gates
FILE: scripts/release-account-config.mjs
DEPENDS: Stage G1

THE FLIP: supabase/functions/easyfield-account/index.ts:30 becomes `const CUSTOMER_GENERATION_GATEWAY_READY = true;` and the literal `code: "generation-gateway-unavailable"` disappears with the old 503 block (already removed in Stage D2). PARTNER_REVERSAL_HANDLING_READY stays false.

WHAT BREAKS AND THE FIX. The audit pointed at :314-322, but those are the PRODUCTION gate in assertProjectReleaseAccountConfig and they fail WHILE fail-closed - the flip satisfies them. The actual inversion is in assertCiAccountReleaseStructure at :356 and :362, both of which REQUIRE the fail-closed strings. :359 (partner) still holds. .github/workflows/ci.yml:56 plus the three EASYFIELD_ACCOUNT_STRUCTURE_TEST: '1' builder steps (:76, :89, :105) all break on the same push.

Edits, in order:
1. Add near PRODUCTION_BUILDERS (:16):
   const GENERATION_DATA_PLANE_IMPORT = 'import { handleGenerationGateway } from "../_shared/generation_gateway_data_plane.ts"'
   const GENERATION_DATA_PLANE_CALL = 'handleGenerationGateway(request, path, {'
2. Replace the :314-319 block in assertProjectReleaseAccountConfig with a flag check plus a POSITIVE wiring check, so the production gate keeps meaning instead of becoming vacuous:
   if (/const\s+CUSTOMER_GENERATION_GATEWAY_READY\s*=\s*false\b/.test(accountFunctionSource)) fail('Customer generation gateway is still fail-closed; production release is blocked')
   if (!accountFunctionSource.includes(GENERATION_DATA_PLANE_IMPORT) || !accountFunctionSource.includes(GENERATION_DATA_PLANE_CALL)) fail('Customer generation is enabled without its metered data plane; production release is blocked')
   Leave the PARTNER check at :320-322 untouched.
3. In assertCiAccountReleaseStructure, DELETE the :356 and :362 assertions and insert the same positive wiring pair. Keep the live-config refusal (:343-346), the partner assertion (:359-361) and the PRODUCTION_BUILDERS loop (:366-374) exactly as they are.
4. Change the return to Object.freeze({ customerGenerationMetered: true, partnerCheckoutBlocked: true, productionBuildersGated: true }).
5. Rewrite the docstring at :335-341: the mode is now valid because there is no account config and paid checkout stays blocked, not because generation is fail-closed.

WHY THE MODE IS STILL SAFE: a CI-structure artifact has no plugin/account-config.json, so accountApiUrl is absent and account-service.cjs never configures - the gateway is unreachable from that build regardless of the flag.

PRECONDITIONS FOR THE FLIP, all mandatory:
 (a) Stages A1-A3, B2, D2, E deployed to xtnaqwvayenfcqzqelmh and listed by list_migrations;
 (b) EASYFIELD_GENERATION_API_ORIGIN / _UPLOAD_ORIGIN / _API_TOKEN set as function secrets and parseUpstreamProviderConfig succeeds;
 (c) Stage G1 applied - select count(*) from billing_private.generation_price_catalog where active returns 25;
 (d) billing_private.maintenance_health() reports stale = false for reconcile_generation_submissions;
 (e) one end-to-end rehearsal on an account funded solely by billing_private.grant_credits: create -> accept -> poll pending -> poll success, ending with credit_ledger showing exactly the quoted capture and generation_gateway_jobs.status = 'succeeded';
 (f) a rehearsed insufficient-credit create returning 402 with the reservation never created;
 (g) all tests below green.
NOTE: this flip does NOT make plans sellable. handleCheckout at :349 also requires a configured checkout adapter, and PARTNER_REVERSAL_HANDLING_READY remains false, so assertProjectReleaseAccountConfig still blocks a production build. Selling stays behind Seam 1.

### Step 14: Stage G3 - update the CI workflow assertion text
FILE: .github/workflows/ci.yml
DEPENDS: Stage G2

Rename the step at :55-56 from 'Verify deliberately blocked account-release structure' to 'Verify non-sellable CI account structure'. The command (npm run release:validate-account -- --ci-structure-test) and the three EASYFIELD_ACCOUNT_STRUCTURE_TEST: '1' builder steps at :76, :89 and :105 are unchanged - they pass again once Stage G2 lands. Also update the console.log at scripts/release-account-config.mjs:420 from 'paid checkout remains fail-closed and production builders remain gated' to 'metered generation is wired, paid checkout remains fail-closed and production builders remain gated'.

## Tests
- tests/generation-price-manifest.test.mjs - SQL-text assertions over supabase/migrations/202608060004_generation_price_manifest_v1.sql. Assert: /^begin;/ and /commit;$/ after normalization; `in access exclusive mode`; the preflight `if exists (select 1 from billing_private.generation_price_catalog) then raise`; that the INSERT column list does NOT contain the word `active` (rows must land inert); exactly 25 VALUES tuples; the literal margin guard `customer_microcredits_per_unit / 100 < provider_cost_currency_micros_per_unit * 2`; `if v_inserted <> 25 then`; pricing_version literal 'generation-2026-08-06-v1'. Then, for at least these six rows, the EXACT integers: ('jobs:nano-banana-pro:res=4K', 24000000, 120000), ('jobs:gpt-image-2-text-to-image:res=1K', 6000000, 30000), ('jobs:seedream/5-lite-text-to-image:default', 5500000, 27500), ('jobs:wan/2-7-image:res=1K', 4800000, 24000), ('suno:suno-v5:default', 12000000, 60000), ('sounds:suno-sounds:default', 2500000, 12500). Finally assert the mutated-table set is exactly ['billing_private.generation_price_catalog','billing_private.generation_price_catalog_revisions'] using the same [...sql.matchAll(/\b(?:insert into|update)\s+((?:public|billing_private)\.[a-z_][a-z0-9_]*)/g)] technique as creator-annual-price-migration.test.mjs:63.
- tests/generation-gateway-evidence-hardening.test.mjs - over 202608060001. Assert `create trigger generation_gateway_events_are_immutable before update or delete on billing_private.generation_gateway_events for each row execute function billing_private.reject_immutable_mutation()`; the same trigger on generation_price_catalog_revisions and generation_provider_cost_observations; the pricing_key shape constraint regex literal `^[a-z]+:[A-Za-z0-9._/-]{1,120}:[A-Za-z0-9=,.-]{1,80}$`; `add column unit_kind text not null default 'request' check (unit_kind in ('request','second','thousand_characters'))`; `enable row level security` on all three new tables; and for each new table a `revoke all on ... from public, anon, authenticated` with no `authenticated` appearing in any grant line.
- tests/generation-prepare-operation.test.mjs - over 202608060002. Assert the four exact exception handlers `when sqlstate 'P0001' then return jsonb_build_object('outcome','insufficient_credits')`, `'42501'` -> 'not_entitled', `'22000'` -> 'conflict', `'22023'` -> 'invalid'; assert the source does NOT contain `when others`; assert `language plpgsql`, `security definer`, `set search_path = ''`; assert revoke from all three roles and grant execute to service_role only.
- tests/generation-gateway-support-rpcs.test.mjs - over 202608060003. Assert easyfield_generation_authorize_upload locks the credit account BEFORE summing the day's bytes (indexOf('for update') < indexOf('sum(') within the function body, same offset technique as generation-gateway-control-plane.test.mjs:56-83); assert the literal daily cap `2147483648`; assert the entitlement predicate includes `status in ('trialing', 'active')` and `available_microcredits > 0`; assert easyfield_generation_record_provider_cost contains `public.easyfield_generation_authorize_poll(` and contains NEITHER `capture_credits` NOR `release_credits`; assert easyfield_generation_balance is `language sql` and `stable`.
- tests/generation-reconciliation-maintenance.test.mjs - over 202608060005. Assert the allowlist line lists all five job names including 'reconcile_generation_submissions'; assert the maintenance_runs INSERT precedes the inner `begin` (offset comparison) so a failure still leaves a row; assert the exact cron entry `select cron.schedule( 'easyfield-reconcile-generation', '* * * * *'` and the guarded unschedule; assert `('reconcile_generation_submissions', 300)` in maintenance_health; assert reconcile_generation_submissions contains `for update skip locked`, both interval literals `interval '2 minutes'` and `interval '24 hours'`, and contains NEITHER `release_credits` NOR `capture_credits` NOR `credit_accounts`; assert easyfield_admin_incidents still contains all five pre-existing keys plus 'generationReconciliation' and 'expiredGatewayReservations'.
- supabase/functions/_shared/generation_pricing_test.ts (Deno, same style as generation_gateway_test.ts) - canonicalJson sorts keys recursively and is byte-identical for two differently-ordered equivalent objects; it throws on depth 13, on 4097 nodes, on NaN, on undefined. resolvePricedGenerationRequest returns pricingKey 'jobs:nano-banana-pro:res=4K' for {model:'nano-banana-pro',input:{<resolution field>:'4K'}}; throws on an unknown model; throws on a known model with an out-of-enum resolution (must NOT silently fall back); throws when the body has an extra top-level key beyond {model,input}; throws when createPath does not match the spec; every returned pricingKey matches the DB regex; quantityUnits === 1 for every wave-1 spec.
- tests/generation-pricing-registry.test.mjs (Node) - read src/data/providerModels.ts and supabase/functions/_shared/generation_pricing.ts. Assert every modelId in PRICED_MODELS appears verbatim inside a job('...') call (or, for suno/sounds, that its create_path is one of CREATE_ROUTES' keys). Assert the manifest JSON, the seed migration's VALUES, and PRICED_MODELS agree on the exact same set of pricing keys and on unit_kind - a three-way cross-check so a resolver edit cannot silently mint a key with no catalog row. Assert every create_path/poll_path pair in the manifest equals the pair in CREATE_ROUTES in _shared/generation_gateway.ts.
- supabase/functions/_shared/generation_gateway_data_plane_test.ts (Deno) - with a stub adapter and a stub rpc. (1) A 503 emitted for submission_ambiguous, for the mark_ambiguous path, and for a failed accept_submission each parse to an object with NO `code` property - assert `!('code' in body)` explicitly, because a `code` would put it in CREATE_RETRYABLE and cause a double-charge. (2) begin_submission returning may_submit=false with status 'accepted' yields 200 {code:200,data:{taskId}} matching the stub's provider_task_ref. (3) record_poll is always called with p_reported_microcredits === null. (4) An adapter submit returning a 500 with no body code is classified ambiguous and calls mark_ambiguous, never reject_submission. (5) A definite rejection calls reject_submission and returns the upstream status and bytes verbatim. (6) The credits route never calls adapter and returns Math.floor(micros/1e6). (7) A create body over MAX_GENERATION_CREATE_BYTES is 413 and no RPC fires. (8) An unpriceable body is 422 and neither prepare_operation nor adapter.submit fires. (9) prepare_operation outcome 'insufficient_credits' returns 402 and adapter.submit is never called.
- supabase/functions/_shared/generation_provider_adapter_test.ts (Deno) - parseUpstreamProviderConfig rejects an http origin, an origin with a port, a path, credentials, or a token with a space; the submit classifier returns 'accepted' only for code===200 with a TASK_PATTERN-valid taskId, 'rejected' only for a numeric non-200 code with no taskId, and 'ambiguous' for a transport throw, a non-JSON body, a 500 with no code, and a 200 with no taskId; per-family poll extraction matches the EXTRACTORS table (veo successFlag 1/2/3, runway state, suno SUCCESS + urls, jobs state success/fail).
- tests/release-account-config.test.mjs - UPDATE the existing file. Replace the fixtures at :206/:244/:265 so the account-function fixture contains `const CUSTOMER_GENERATION_GATEWAY_READY = true`, the data-plane import line and the handleGenerationGateway call. Change the deepEqual at :221 to { customerGenerationMetered: true, partnerCheckoutBlocked: true, productionBuildersGated: true }. Add two NEW cases: assertCiAccountReleaseStructure fails when the data-plane import is absent even though the flag is true; and assertProjectReleaseAccountConfig fails when the flag is true but handleGenerationGateway is not called - the regression that would let a flipped flag ship without a metered path.
- tests/account-edge-api.test.mjs - UPDATE line 20: replace the assertion on /generation-gateway-unavailable/ with assertions that the gateway branch is gated by CUSTOMER_GENERATION_GATEWAY_READY, that it calls handleGenerationGateway, and that authenticate(request) still precedes every gateway branch so the endpoint can never become an unauthenticated capability probe.
- tests/generation-gateway-control-plane.test.mjs - EXTEND, do not rewrite. Add a case asserting that _shared/generation_gateway_data_plane.ts calls all nine RPCs by their exact deployed names (easyfield_generation_prepare_operation, _begin_submission, _accept_submission, _reject_submission, _mark_ambiguous, _authorize_poll, _record_poll, _cancel_prepared, _recovery_snapshot), closing the audit's 'nine RPCs with no caller' finding with a permanent regression test.
- tests/pricing.test.ts - EXTEND. Assert FALLBACK_PRICE_DATE is still '2026-07-11' and that every fallback credit value the wave-1 manifest was derived from is unchanged, so a silent edit to src/data/pricing.ts cannot drift away from the deployed server catalog without a failing test.

## Risks
- Double-charging via a retried create. src/services/providerGateway.ts:409 retries when the response body carries a numeric `code` in CREATE_RETRYABLE {429,433,455,502,503,504}. Any 503 this gateway emits for an ambiguous or in-flight submission that includes a `code` key WILL be re-POSTed upstream. GUARD: every ambiguous/blocked response omits `code` entirely, and generation_gateway_data_plane_test.ts asserts `!('code' in body)` for all three such paths. Reinforced in depth by easyfield_generation_begin_submission, which returns may_submit=false for anything other than 'prepared'.
- Refunding work the provider actually did. Classifying a timeout or a code-less 5xx as 'rejected' would call easyfield_generation_reject_submission and release the customer's credits for a job that is running and billing upstream. GUARD: the adapter's classifier is fail-closed toward 'ambiguous' (only code===200+taskId is accepted, only a numeric non-200 code with no taskId is rejected), the reject RPC itself refuses unless status='submitting' AND provider_task_ref IS NULL (55000), and reconcile_generation_submissions never releases credit - it only escalates to 'reconciliation_required' for a human.
- Undercharging by ~the whole margin. p_reported_microcredits in easyfield_generation_record_poll is CUSTOMER microcredits and is compared to the reservation remainder; the provider's creditsConsumed is in provider credits, roughly 1x the customer number but denominated differently and, for a cheap provider job, far lower after any future margin change. Passing it would make v_capture := least(providerNumber, remaining) and silently undercharge. GUARD: always pass null so v_capture = v_remaining = the quoted price; the provider number is recorded separately via easyfield_generation_record_provider_cost; a Deno test asserts the null.
- Free work through reservation expiry. easyfield_generation_prepare reserves for 24 hours and expire_credit_reservations runs every minute; a job still 'accepted' at T+24h has its credits released, so a later successful poll finds v_remaining = 0 and captures nothing. GUARD: 24h vastly exceeds the client's 12-minute poll timeout, so this only bites an abandoned job; and Stage E adds 'expiredGatewayReservations' to easyfield_admin_incidents so the condition is visible rather than silent. Do NOT paper over it by extending the reservation - that would hide a real stuck-job signal.
- A resolver/catalog divergence turning into a 500 loop. If resolvePricedGenerationRequest emits a pricing_key with no active catalog row, easyfield_generation_prepare raises 42501 and the customer sees a confusing 403 on a model the UI offered. GUARD: the three-way cross-check test (manifest JSON vs seed migration VALUES vs PRICED_MODELS), the DB-level pricing_key shape constraint, and the resolver's own assertion of the identical regex before it ever calls the RPC.
- Client-side estimates drifting from the server price. src/data/pricing.ts still shows fallback numbers dated 2026-07-11 and, for a customer account, /client/v1/model-pricing/page is 404 (not in CREATE_ROUTES), so the panel cannot refresh. A customer could be quoted one number in the UI and charged another. GUARD: the catalog is derived from those exact fallback values at a flat 1:1, the extended tests/pricing.test.ts pins them, and the estimate is never authority - only the server quote reserves. A server-served price manifest endpoint is the correct follow-up and should NOT be improvised inside this work.
- Seeding prices from the live feed. The public feed is unauthenticated and matched by fuzzy human-text tokens (livePrice(['google nano banana pro','1/2k'])); an upstream rename or a new row could silently repoint a pricing key. GUARD: the migration hard-codes reviewed literals, the feed is used only for an out-of-band drift report, and every seeded row is recorded in the append-only generation_price_catalog_revisions table with a reason.
- Turning the gateway into an open server-side request proxy. GUARD: classifyGenerationGatewayRequest stays the sole entry, its route maps stay closed, the upload route rejects any query string, polling accepts exactly one taskId parameter, and easyfield_generation_authorize_poll scopes by (user_id, task sha256, poll_path) with a deliberately indistinguishable 23503 for missing and foreign tasks. The data plane must never construct an upstream URL from client input - only from the catalog row's create_path/poll_path.
- Flipping the flag while thinking it enables selling. It does not: handleCheckout also needs a configured checkout adapter and PARTNER_REVERSAL_HANDLING_READY stays false, so assertProjectReleaseAccountConfig still blocks a production build at :320. GUARD: the flip is landed with the CI-structure gate migrated in the same commit, and the production gate keeps a POSITIVE data-plane wiring assertion so a future flag flip can never ship without handleGenerationGateway actually being called.
- Losing the provider-task binding on a crash between adapter.submit and accept_submission. The credits are reserved and the upstream job is running, but nothing records the task ref. GUARD: accept_submission is retried once, a persistent failure returns a code-less 503 and leaves the row in 'submitting', reconcile_generation_submissions escalates it to 'submission_ambiguous' after 2 minutes and 'reconciliation_required' after 24 hours, and the admin incidents feed surfaces it. The unique constraint on provider_task_ref_sha256 guarantees a recovered ref can never be bound to a second operation.

## Adversarial review
# Adversarial review — "dataplane" spec

Verdict: **not implementable as written.** Two blockers (filename collision, allowlist regression) would break `main` on merge; three correctness defects would lose customer money or orphan paid work; one arithmetic error is baked into four separate assertions. The parts I could not fault are named at the end.

---

## A. Blockers — the plan does not apply to this tree

**A1. Migration filename collides with a migration that already exists.**
Stage A1 specifies `supabase/migrations/202608060001_generation_gateway_evidence_hardening.sql`. `supabase/migrations/202608060001_checkout_abandonment_recovery.sql` is already committed (HEAD `0cdd8f7`, undeployed — `list_migrations` on `xtnaqwvayenfcqzqelmh` stops at `202607290006`). Supabase keys migrations by the numeric prefix; two files sharing `202608060001` is a duplicate version. Every subsequent stage number in the spec is off by one as a result. **Renumber the whole series to `202608060002…202608060007`.** The spec's "currentState" enumerates the deployed set and never noticed the repo has one more file than the database.

**A2. Stage E deletes two live cron jobs from the `run_maintenance` allowlist.**
Stage E says to re-create `billing_private.run_maintenance` "extending the allowlist to" **five** names. The current repo-HEAD allowlist is **six** (`supabase/migrations/202608060001_checkout_abandonment_recovery.sql:496-503`): `expire_credit_reservations, expire_credit_lots, grant_due_annual_plan_credits, sweep_due_renewals, close_unopened_checkouts, expire_stale_open_checkouts`. The spec's list omits the last two — and the same migration schedules them (`:554-564`). Applying Stage E as written makes `easyfield-close-unopened-checkouts` and `easyfield-expire-stale-open-checkouts` raise `22023 Unknown maintenance job` hourly, forever, with the failure buried in `maintenance_runs.error_text` and *not* visible in `maintenance_health()` (those two jobs were never added to its expected list at `202607290006:350-357`). The allowlist must become **seven**, and the dispatch chain must keep both `elsif` branches at `202608060001:513-516`.

**A3. The row count is wrong — 24, not 25.**
Count the Wave-1 manifest in Stage B1: gpt-image-2 t2i (3) + gpt-image-2 i2i (3) + nano-banana-pro (3) + nano-banana-2 (3) + nano-banana-2-lite (1) + seedream/5-lite ×2 (2) + seedream/4.5 ×2 (2) + wan/2-7-image (3) + qwen2 ×2 (2) + suno (1) + sounds (1) = **24**. The literal `25` appears in Stage B2 (`if v_inserted <> 25`), twice in Stage G1 (preflight + `v_updated <> 25`), in precondition (c), and in the test ("exactly 25 VALUES tuples"). As specified, Stage B2 raises `55000` and the migration aborts.

---

## B. Correctness defects

**B1. `P0001` is not a synonym for "insufficient credits."** *(Stage A2 — cardinal-sin adjacent)*
`billing_private.reserve_credits` raises `P0001` in two places: `202607140001_subscription_billing.sql:2149` (`Insufficient EasyField credits`) **and `:2184`** (`Credit lot balance does not reconcile with account balance`). The second is ledger corruption. The spec's blanket `when sqlstate 'P0001' then return jsonb_build_object('outcome','insufficient_credits')` converts a data-integrity alarm into a routine `402 Buy more credits` — permanently, silently, with the subtransaction rolling back the evidence. Also, any bare `raise exception` without `using errcode` anywhere in the call chain defaults to `P0001` and gets the same treatment.
**Fix:** discriminate on `sqlerrm` *inside the RPC where the raise is authored*, not in the wrapper — e.g. add a distinct errcode to `:2184` in a forward-only migration, or have the wrapper re-`raise` when `sqlerrm` is not the exact insufficient-credit string. Do not widen; narrow.

**B2. `accept_submission` can never bind a task once the reconciler has fired — and Stage E's 2-minute window is shorter than Stage C's submit budget.** *(Stages C + D step 7 + E — the most serious defect)*
`20260715175329:278` lists the idempotent-accept statuses as `('accepted','running','succeeded','reconciliation_required')`; `'submission_ambiguous'` is **not** among them, so `:284` raises `55000`. Concrete failure:

- Stage C gives `submit()` a 60 s `AbortSignal`; Stage D step 7 then calls `accept_submission` and *retries it once* on transport failure. Worst-case wall time from `begin_submission` to a successful `accept_submission` is comfortably over 120 s.
- Stage E Pass 1 flips `'submitting' → 'submission_ambiguous'` at **`submitted_at < clock_timestamp() - interval '2 minutes'`**, running every minute.
- The in-flight request then calls `accept_submission` with a **real, provider-issued taskId** and gets `55000`. Stage D step 7 only retries "transport failure", so this surfaces as a code-less 503 and the taskId is **discarded**. The upstream job runs and bills EasyField; the customer's reservation sits until `expire_credit_reservations` releases it at T+24 h. Free work, plus an unresolvable `reconciliation_required` row with no task reference.

Nothing in the plan ever persists `providerTaskRef` outside the state transition, so there is no recovery path. **Fix:** (a) raise Pass 1 to a threshold strictly greater than submit-timeout + accept-retry budget (≥ 10 min), (b) add `'submission_ambiguous'` to the idempotent-accept branch at `:278` in a forward-only migration so a late accept still binds, and (c) write the returned `providerTaskRef` to an append-only evidence row *before* attempting the state transition. Without (c) the spec's own risk bullet ("the unique constraint guarantees a recovered ref can never be bound to a second operation") is vacuous — there is nothing to recover from.

**B3. Concurrent create with the same operation key throws an unhandled `23505`.** *(Stage A2, idempotency)*
`easyfield_generation_prepare` reads the existing job with a **plain, unlocked** `select` (`20260715175329:141`), and `create_generation_quote` does the same for its idempotency key (`202607140001:1673`). Two concurrent creates carrying the same `X-EasyField-Operation-Id` (the plugin proxy at `plugin/main.cjs:679` streams; a client-side double-submit or two panel instances both reach the function) both miss, both `insert into public.generation_billing_quotes`, and the second hits `unique (customer_id, idempotency_key)` at `202607140001:200` → `23505`. The spec's handler list is `P0001 / 42501 / 22000 / 22023 / 22003` and it forbids widening, so `23505` escapes → `serviceRpc` maps 400/409 → `HttpError(400)` → the client sees a bare "billing request is not valid" on a *legitimately idempotent* retry. No double-grant (the transaction rolls back cleanly), but the idempotency claim is not actually delivered. **Fix:** add `when unique_violation then` and re-enter `easyfield_generation_prepare`, which will now find the committed row and replay it. Also, `55000` is unhandled and reachable via `:2140` ("Quote is not open").

**B4. `42501` conflates "customer not entitled" with "server catalog is broken."**
`easyfield_generation_prepare` raises `42501` when the catalog row is inactive or `quantity_units > maximum_units`; `create_generation_quote` raises `42501` for a missing plan entitlement (`202607140001:1665`) *and* for a blocked model (`:1670`). Stage A2 folds all four into `'not_entitled' → 403`. The spec's own Risk #5 (resolver/catalog divergence) is therefore undetectable: a resolver bug that mints an uncatalogued `pricing_key` is indistinguishable from an unsubscribed user, and nothing alerts. Return distinct outcomes (`not_entitled` vs `not_priced`) and put `not_priced` in `easyfield_admin_incidents`.

**B5. `easyfield_generation_authorize_upload` 500s for a user with no billing customer.** *(Stage A3 #2)*
The spec resolves `v_customer_id` from `public.billing_customers` but never handles the miss. A verified user who has never had `billing_private.ensure_billing_account` run has no row → `v_customer_id` is null → `perform 1 from public.credit_accounts where customer_id = null` locks nothing → the insert violates `customer_id not null` → `23502` → unhandled 500. Return `{allowed:false, reason:'not_entitled'}` on the miss, and note that the "lock the account before summing" ordering the spec (correctly) insists on is a no-op in exactly that case.

---

## C. Factual errors in the spec's own citations

| Spec claim | Reality |
|---|---|
| CI builder steps at `.github/workflows/ci.yml:76, :89, :105` | `EASYFIELD_ACCOUNT_STRUCTURE_TEST: '1'` is at **:90, :103, :119**. (The `--ci-structure-test` step at :55-56 is correct.) |
| Only `tests/account-edge-api.test.mjs:20` breaks on the flip | **`:34`** also asserts `/CUSTOMER_GENERATION_GATEWAY_READY = false/` and breaks. |
| Only `tests/release-account-config.test.mjs:206-248, :265-275` break | **`:407-415`** writes a fixture with flag `true`, partner `false`, and *no* data-plane wiring, asserting the throw matches `/refund and chargeback handling is still fail-closed/`. Stage G2 step 2 inserts the positive-wiring check *before* the partner check, so the message changes and the assertion fails. **`:417-423`** writes flag `true` + partner `true`, no wiring, and asserts **success** — with the new check it throws. Neither is in the spec's update list. |
| "Leave the PARTNER check at `:320-322` untouched" | The PARTNER check is `:320-322`; `return config` is `:323`. Off-by-one on the block being replaced (`:313-318`, not `:314-319`). |
| `easyfield_admin_incidents` has "five pre-existing keys" | The live definition (`202607290006:232-266`) has **nine**: `limit, alerts, maintenance, blockedRenewals, autoReloadDue, ambiguousCheckouts, openCheckouts, unresolvedRenewals, pendingGrants`. A re-creation that keeps only five silently deletes `alerts`, `blockedRenewals`, and `autoReloadDue` from the operator console. |
| "EXTRACTORS at `providerGateway.ts:643-701`… jobs: `data.state`" | `EXTRACTORS` is typed `Record<'veo'\|'runway'\|'aleph'\|'suno'\|'sounds', …>` — **there is no `jobs` entry.** Market `recordInfo` extraction lives elsewhere. The adapter's `jobs` poll semantics must be sourced from the real Market poll path, not from `EXTRACTORS`. |
| `model_id` "MUST be byte-identical to the string passed to `job(...)`" | Violated by the spec's own manifest: `suno-v5` and `suno-sounds` never appear in a `job()` call — suno/sounds bypass `job()` entirely. Harmless (nothing blocks them) but the stated invariant and its test are false as written. |

---

## D. Things the spec specifies that are already done

- Stage A1's immutability trigger on `generation_gateway_events` is genuinely missing — I confirmed zero non-internal triggers on all three gateway tables via `pg_trigger` on the live project. **Correctly identified, not already done.**
- Stage F's grant: `grant execute on function public.easyfield_generation_recovery_snapshot(uuid) to service_role` already exists (`20260715175329`, final block). The spec says so. ✓
- The settlement lock order (`jobs → credit_accounts → credit_reservations`) is already fixed by `202607290001` and already regression-tested by `tests/generation-gateway-control-plane.test.mjs:56-83`. Stage E correctly declines to touch it.

---

## E. Product hole the spec does not name

Wave 1 prices **image + music + SFX only**. `veo`, `runway`, `aleph`, all `kling/*`, `wan/2-7-*-video`, `hailuo/*`, `happyhorse-*`, `grok-imagine*`, `gemini-omni-video`, `seedream/5-pro-*` (`src/data/providerModels.ts:108-109`), `flux-2/*` (`:133`), `topaz/*`, `recraft/*`, `ideogram/*`, `elevenlabs/*`, `omnihuman-*` have **no catalog row**. `resolvePricedGenerationRequest` throws → Stage D returns 422. Because `plugin/main.cjs:679` rewrites *every* account-session request to `/gateway/*`, flipping `CUSTOMER_GENERATION_GATEWAY_READY` makes **all video generation and all audio-except-Suno fail with "not available on your plan"** for customer accounts, with no UI gating step anywhere in the plan. Either add a client-visible priced-model manifest and hide the rest, or state explicitly that Wave 1 ships a stills-and-music-only product.

Related, smaller: `job('gpt-image-2-text-to-image', …)` omits `resolution` entirely when unset (`providerModels.ts:87-88`). The spec's resolver "uses `fallback`" on an absent dimension — charging the 1K price (6 credits) for whatever the provider's own default resolution is. That is fail-*open* on price. An absent priced dimension should either be rejected or charged at the maximum, not the minimum.

---

## F. Where the spec is sound (briefly)

- **The `code`-key invariant is correct and load-bearing.** `src/services/providerGateway.ts:172` (`CREATE_RETRYABLE`) and `:412` (`isRetryable: e.code != null && …`) confirm a code-less 5xx is classified `submission-uncertain` at `:196-203` and never re-POSTed. The rule "every ambiguous response omits `code`" is exactly right, and the `!('code' in body)` assertion is the right test. The existing `HttpError` path in `index.ts:571-575` already emits `{error}` with no `code`, so Stage D2's 503s are safe by construction.
- **`p_reported_microcredits` must be `null`.** `202607290001:143` — `least(coalesce(p_reported_microcredits, v_remaining), v_remaining)` — confirms passing the provider's `creditsConsumed` (provider credits, not customer microcredits) would undercharge to the reservation floor. The reasoning is right.
- **Lock order is consistent, no deadlock introduced.** Prepare takes `{price_catalog FOR SHARE → credit_accounts → quotes → grant_lots}`; settlement takes `{gateway_jobs → credit_accounts → credit_reservations}`; Stage A3's upload takes `{credit_accounts}` only. No cycle. One operational note: Stage B2/G1 take `access exclusive` on `generation_price_catalog`, which conflicts with prepare's `FOR SHARE`; expect a brief convoy on a live system, not a deadlock.
- **The 2× margin floor arithmetic checks out.** `top_up_currency_micros_per_credit` for `studio` is `10000` (`202607140001:50`); `DIRECT_PROVIDER_CREDIT_USD = 0.005` (`src/data/pricing.ts:12`). `customer_microcredits/100 >= provider_cost*2` holds at exact equality for every listed row. Effective subscription rate for Studio is `129000000/12000 = 10750` micros/credit, so `10000` is genuinely the worst case.
- **The manifest numbers are correctly transcribed** from `IMAGE_FALLBACK` (`src/data/pricing.ts:78-87`), `musicRunEstimate` fallback `12` (`:524`), `soundEffectsRunEstimate` fallback `2.5` (`:530`). `FALLBACK_PRICE_DATE = '2026-07-11'` (`:15`). Refusing to seed from the fuzzy live feed (`:46`, `:106`) is the right call.
- **No fabricated provider evidence found.** The synthesized replay body (`{code:200,data:{taskId}}`) replays a real, previously provider-issued binding; the synthesized `/chat/credit` body reports EasyField's own ledger and correctly refuses to forward. The `idempotency-key` header the adapter sends is decorative — nothing in the safety argument depends on the provider honouring it, which is correct, but the spec should say so.
- **Seam 1 is left genuinely untouched.** No payment-provider name, variant id, price id, or webhook shape appears anywhere. `createHostedSession` (`supabase/functions/easyfield-account/index.ts:270`) and `verifyHostedCheckoutSession` are quoted accurately. The claim that the flag flip does not make plans sellable is **correct**: `assertProjectReleaseAccountConfig` still fails at `scripts/release-account-config.mjs:320` while `PARTNER_REVERSAL_HANDLING_READY` is false.

---

## G. One unverified assumption to prove before writing code

Six of the nine deployed RPCs are declared `returns billing_private.generation_gateway_jobs` — a composite type in a **non-exposed** schema, reached through PostgREST from an exposed `public` function. Not one has ever been called (`tests/generation-gateway-control-plane.test.mjs` asserts SQL text only). Before Stage D depends on `deps.rpc` returning a usable object from `accept_submission`, `mark_ambiguous`, `reject_submission`, `authorize_poll`, and `record_poll`, issue a single live `POST /rest/v1/rpc/easyfield_generation_authorize_poll` against `xtnaqwvayenfcqzqelmh` with the service key and confirm the shape. If PostgREST cannot render it, every one of those needs a `returns jsonb` wrapper, not just `prepare`.