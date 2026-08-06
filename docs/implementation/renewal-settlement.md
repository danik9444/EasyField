# Provider-agnostic subscription renewals: saved-payment-method write path, atomic + idempotent renewal settlement (period advance + credit grant anchored to renewal_attempt_id), and webhook routing for renewal payments.

## Current state
VERIFIED — both audited defects are real, plus the webhook gap. Corrections to the brief are noted.

(a) CONFIRMED. `billing_private.saved_payment_methods` is created at `supabase/migrations/202607140001_subscription_billing.sql:89`. A repo-wide grep for `saved_payment_method` matches only 4 migrations + `tests/subscription-schema.test.mjs`. There is no INSERT anywhere. The only privilege is `grant insert, update on billing_private.saved_payment_methods to service_role` (202607140001_subscription_billing.sql:3748) — a grant with no caller. Consequences, all confirmed by reading:
  - `sweep_due_renewals` requires `subscription.saved_payment_method_id is not null` (202607290006_renewal_and_alerting.sql:49) → the sweep loop can never yield a row.
  - `create_renewal_attempt` independently raises `42501` when `v_subscription.saved_payment_method_id is null` (202607140001:2905) and again when no `active` method supports the currency (202607140001:2914).
  - The reconciliation INSERT into `public.subscriptions` (202607150005_atomic_payment_reconciliation.sql:424-460) lists 17 columns and omits `saved_payment_method_id` entirely; the UPDATE branch (409-422) never sets it either. So even a paying customer's subscription is born un-renewable.
  - Auto-reload: `public.easyfield_account_set_auto_reload` raises `'A reusable payment method is required before enabling auto-reload'` (202607150004_account_edge_api.sql:295-297), and the `auto_reload_settings` table CHECK requires `saved_payment_method_id is not null` when enabled (202607140001:488). Auto-reload is therefore unreachable for the same single reason. `billing_private.auto_reload_due()` can only ever return rows once a method exists.
  - `billing_private.due_renewals_blocked()` (202607290006:78) exists precisely to report this, and today every renewing subscription qualifies.

(b) CONFIRMED and more precise than the brief. `billing_private.finish_renewal_attempt` (202607140001:2986-3045) writes ONLY `state, provider_document_ref, provider_transaction_ref, provider_status, failure_reason`. It never touches `public.subscriptions` and never calls `grant_credits`. Grep for assignments to `current_period_end` across all migrations: the only writers are the first-purchase paths in `easyfield_account_reconcile_payment_event` (202607150005:411 UPDATE branch and :451 INSERT branch). Nothing else in the repo advances a period. A successful renewal charge therefore records a provider document reference and nothing else; the customer's period lapses and no credits arrive.

The intended anchor is unambiguous and already fully built — the renewal path was designed and then never wired:
  - `public.credit_grant_lots.renewal_attempt_id` + `credit_grant_lots_renewal_attempt_key unique (renewal_attempt_id)` + `credit_grant_lots_paid_source_shape` allowing `source_type = 'subscription' and num_nonnulls(checkout_intent_id, renewal_attempt_id) = 1` (202607140001:331-353).
  - `billing_private.grant_credits` has a complete, unused renewal branch (202607140001:1843-1868) that derives `v_idempotency_key := 'paid:renewal:' || p_renewal_attempt_id::text`, forces `v_source_ref`, `v_currency_amount_micros` and `v_currency` from the attempt, and demands `v_renewal.state = 'succeeded' and v_renewal.provider_document_ref is not null and v_renewal.period_start = p_granted_at and v_renewal.period_end = p_expires_at`.
  - CRITICAL ORDERING, discovered by reading 202607140001:1903-1935: for `source_type='subscription'` grant_credits additionally requires `v_subscription.billing_interval = 'monthly'`, `status in ('trialing','active')`, `current_period_start = p_granted_at` and `current_period_end = p_expires_at`. The subscription period MUST be advanced BEFORE grant_credits is called, not after.
  - `billing_private.annual_subscription_paid_source_is_valid` (202607140001:743-826) has the parallel unused renewal branch (806-822), and `subscriptions.annual_renewal_attempt_id` / `subscription_grant_schedule.annual_renewal_attempt_id` with unique keys exist for exactly this.

MONTHLY vs ANNUAL are genuinely different and must not be conflated:
  - Monthly renewal → one `credit_grant_lots` row, `source_type='subscription'`, `renewal_attempt_id` set, `granted_at = attempt.period_start`, `expires_at = attempt.period_end`.
  - Annual renewal → grants NOTHING directly. It must call `billing_private.schedule_annual_plan_grants(subscription_id, attempt.period_start, included_microcredits_per_grant, 12, interval '1 month')`, which requires `p_period_anchor = v_subscription.current_period_start` (202607140001:2669) — again, advance first — and which itself cancels the previous anchor's still-`pending` rows (202607140001:2699-2703). The twelve instalments are then materialised by the already-scheduled `easyfield-grant-annual` cron (`grant_due_annual_plan_credits`, every minute). `grant_credits` REFUSES an annual subscription on the `'subscription'` source path, so calling it for an annual renewal is a bug.

(c) CONFIRMED. `public.easyfield_account_reconcile_payment_event` (202607150005:255-270) resolves `operationReference` against `public.checkout_intents` and `billing_private.partner_purchase_intents` only, and raises `'Payment operation does not identify exactly one checkout'` with errcode `23503` when `v_has_checkout = v_has_partner`. A renewal payment (whose `operationReference` is a `renewal_attempts.id`) hits that raise, the subtransaction rolls back, and the event is stored `failed`. No parsing change is needed though: `parsePaymentWebhook` (supabase/functions/_shared/account_api.ts:357) already accepts any UUID `operationReference` and already carries `subscriptionReference`/`periodStart`/`periodEnd`, and `billing_private.payment_reconciliation_payload_is_valid` already validates that triple (202607150005:94-119). Only the SQL router is missing a third branch.

Additional constraints found that the fix must respect:
  - `billing_private.apply_subscription_catalog_snapshot` UPDATE branch (202607140001:1030-1091) makes `pricing_version, currency_code, unit_amount_currency_micros, included_microcredits_per_grant` IMMUTABLE on update, and (1053-1064) forbids changing `annual_*_id` unless `current_period_start`/`current_period_end` change in the same statement — the renewal update must change both together.
  - `billing_private.enforce_subscription_state_and_catalog` (202607150001:185-225) rejects any update leaving a `trialing`/`active` row whose snapshot differs from the ACTIVE catalog, and makes `canceled`/`expired` rows immutable.
  - `billing_private.protect_renewal_attempt_origin` (202607140001:657-686) permits mutating exactly `state, charge_attempt_count, charge_claim_id, charge_claimed_at, provider_document_ref, provider_transaction_ref, provider_status, failure_reason, updated_at`, and makes `succeeded|failed|unknown` terminal.
  - `billing_private.payment_entitlement_claims` (202607150003_partner_lifetime_access.sql:59-70) is the global one-payment-one-operation anchor, with `unique (payment_event_id)` and `unique (claim_type, claim_id)`, but its `claim_type` CHECK currently allows only `('subscription','credit_pack','auto_reload','partner_lifetime')`. It must gain `'subscription_renewal'`.
  - No payment provider is chosen. `supabase/functions/_shared/morning.ts` is explicitly marked `@deprecated Research scaffold only ... not an approved payment processor`, is imported by nothing but its own test, and must not be wired in.

## Seam
Exactly one seam, in TypeScript, in `/Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/functions/_shared/billing_contracts.ts`. Everything above it ships; below it nothing exists until a provider is chosen.

```ts
export interface SavedMethodBillingAdapter {
  readonly provider: BillingProviderId;
  /** Vault lookup. Feeds easyfield_account_register_payment_method. */
  listSavedPaymentMethods(search: SavedPaymentMethodSearch): Promise<SavedPaymentMethodPage>;
  /** The only outbound money call. MUST NOT retry internally. */
  chargeSavedPaymentMethod(
    request: SavedPaymentMethodChargeRequest,
  ): Promise<SavedPaymentMethodChargeResult>;
}

export class BillingAdapterNotConfiguredError extends Error {
  constructor(readonly provider: BillingProviderId) {
    super("No payment provider adapter is configured");
    this.name = "BillingAdapterNotConfiguredError";
  }
}

export function resolveSavedMethodBillingAdapter(
  provider: BillingProviderId,
): SavedMethodBillingAdapter {
  throw new BillingAdapterNotConfiguredError(provider);
}
```

`SavedPaymentMethodChargeRequest`, `SavedPaymentMethodChargeResult`, `SavedPaymentMethod`, `SavedPaymentMethodPage` and `SavedPaymentMethodSearch` already exist in that file (lines 51-124) and are unchanged — they are already provider-neutral and already state `operationId` is "Stable renewal-attempt ID, persisted before calling the provider" and `automaticRetryAllowed: false`.

What the adapter must return:
- `listSavedPaymentMethods` → `SavedPaymentMethodPage` whose items give `{ id (provider token ref), displayName, lastFour, expiryMonth?, expiryYear?, state, supportedCurrencies }`. These map 1:1 onto `public.easyfield_account_register_payment_method`.
- `chargeSavedPaymentMethod` → exactly one of `{state:"succeeded", providerDocumentId, providerTransactionId?}`, `{state:"failed", definitive:true, reason, providerStatus?}`, `{state:"unknown", definitive:false, reason, nextAction:"reconcile_before_retry", providerStatus?}`. These map 1:1 onto `finish_renewal_attempt(p_result_state = 'succeeded'|'failed'|'unknown', p_provider_document_ref, p_provider_transaction_ref, p_provider_status, p_failure_reason)`.

The second half of the seam — "here is the provider's payment evidence" — is the EXISTING webhook: `supabase/functions/easyfield-billing-webhook/index.ts` → `parsePaymentWebhook` → `public.easyfield_account_reconcile_payment_event`. No new inbound seam is created; the renewal branch is added inside the existing SQL router. The provider requirement (documentation only, no code): a renewal `payment.completed` body must set `operationReference` to the renewal-attempt UUID and must include `subscriptionReference`, `periodStart` and `periodEnd`.

No other file may name a provider, an endpoint, a signature scheme, or a card field.

## Steps

### Step 1: Create the forward-only migration shell and declare the canonical renewal lock order
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql

NEW FILE. Nothing in supabase/migrations/ is edited. Opens `begin;`, closes `commit;`. Header comment states the two defects verbatim (a renewal can never enqueue; a succeeded renewal grants nothing) and declares the canonical lock order that every function below takes, top-down, without exception:

  public.billing_customers -> public.subscriptions -> billing_private.renewal_attempts -> public.subscription_grant_schedule -> public.credit_accounts -> public.credit_grant_lots

This is the same prefix `easyfield_account_reconcile_payment_event` already uses (customer -> subscription) and the same suffix `grant_due_annual_plan_credits` already uses (subscription -> schedule -> account, via grant_credits). `billing_private.claim_renewal_attempt` stays a leaf-only lock on renewal_attempts and is left untouched.

No new extension. No DROP of any table, column or constraint other than the one CHECK named in step 2.

### Step 2: Widen the global payment claim to admit a renewal
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql

`billing_private.payment_entitlement_claims` is the only cross-table one-payment-one-operation anchor and its claim_type CHECK excludes renewals. Constraint DDL does not fire the row-level `payment_entitlement_claims_are_immutable` trigger, so this is safe.

  alter table billing_private.payment_entitlement_claims
    drop constraint payment_entitlement_claims_claim_type_check;
  alter table billing_private.payment_entitlement_claims
    add constraint payment_entitlement_claims_claim_type_check check (
      claim_type in (
        'subscription', 'credit_pack', 'auto_reload',
        'partner_lifetime', 'subscription_renewal'
      )
    );

The auto-generated name `payment_entitlement_claims_claim_type_check` follows the same `<table>_<column>_check` convention already relied on by the deployed `alter table public.checkout_intents drop constraint checkout_intents_status_check;` in 202607150001_harden_billing_state_transitions.sql:8. Exact status value: `subscription_renewal`. With `unique (claim_type, claim_id)` this makes `('subscription_renewal', renewal_attempt_id)` a one-shot global anchor: a second, distinct payment event for the same attempt is rejected by the database rather than double-granted.

### Step 3: Create the saved-payment-method write path (private)
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql

`create or replace function billing_private.register_saved_payment_method(p_customer_id uuid, p_provider text, p_provider_payment_method_ref text, p_display_name text, p_last_four text, p_expiry_month integer, p_expiry_year integer, p_status text, p_supported_currencies text[]) returns billing_private.saved_payment_methods language plpgsql security definer set search_path = ''`.

Body, in order:
1. Normalise: `v_provider text := lower(btrim(coalesce(p_provider,'')))`, `v_ref text := btrim(coalesce(p_provider_payment_method_ref,''))`, `v_name text := btrim(coalesce(p_display_name,''))`, `v_status text := lower(btrim(coalesce(p_status,'active')))`, `v_currencies text[] := coalesce(p_supported_currencies, '{}'::text[])`.
2. Validate, raising `'Invalid saved payment method' using errcode = '22023'` on any failure: provider 2..40 chars; ref 1..500; name 1..120; `p_last_four ~ '^[0-9]{4}$'`; `v_status in ('active','inactive','expired','unknown')`; `(p_expiry_month is null) = (p_expiry_year is null)`; when present, month 1..12 and year 2000..9999; `array_length(v_currencies,1) between 1 and 20`; `array_position(v_currencies, null) is null`; every element matches `^[A-Z]{3}$` (check with `not exists (select 1 from unnest(v_currencies) as code where code !~ '^[A-Z]{3}$')`).
3. Evidence guard — nothing fabricates a provider relationship. Refuse unless this customer has actually transacted with this provider:
   if not exists (select 1 from public.checkout_intents as checkout where checkout.customer_id = p_customer_id and checkout.provider = v_provider and checkout.status = 'completed')
     and not exists (select 1 from billing_private.partner_purchase_intents as partner where partner.customer_id = p_customer_id and partner.provider = v_provider and partner.status = 'completed')
   then raise exception 'A saved payment method requires a completed payment with the same provider' using errcode = '42501'; end if;
4. Lock the customer first (top of the canonical order): `perform 1 from public.billing_customers as customer where customer.id = p_customer_id for update;` raise `'Billing customer not found' using errcode = '23503'` when not found.
5. Resolve any existing row by the provider identity: `select * into v_existing from billing_private.saved_payment_methods where provider = v_provider and provider_payment_method_ref = v_ref for update;`. If found and `v_existing.customer_id <> p_customer_id`, raise `'Saved payment method belongs to another customer' using errcode = '42501'` — never re-point a vault token at a different customer.
6. Insert or update only the descriptive columns:
   insert into billing_private.saved_payment_methods (customer_id, provider, provider_payment_method_ref, display_name, last_four, expiry_month, expiry_year, status, supported_currencies) values (...)
   on conflict (provider, provider_payment_method_ref) do update set display_name = excluded.display_name, last_four = excluded.last_four, expiry_month = excluded.expiry_month, expiry_year = excluded.expiry_year, status = excluded.status, supported_currencies = excluded.supported_currencies
   returning * into v_method;
7. `return v_method;`

Privileges: `revoke all on function billing_private.register_saved_payment_method(uuid, text, text, text, text, integer, integer, text, text[]) from public, anon, authenticated;` (schema default privileges already grant execute to service_role).

### Step 4: Expose the write path and the subscription attach as service-role RPCs
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql
DEPENDS: Create the saved-payment-method write path (private)

Two public wrappers, both `language plpgsql security definer set search_path = ''`, both returning jsonb that NEVER contains `provider_payment_method_ref`.

(1) `create or replace function public.easyfield_account_register_payment_method(p_user_id uuid, p_provider text, p_provider_payment_method_ref text, p_display_name text, p_last_four text, p_expiry_month integer default null, p_expiry_year integer default null, p_status text default 'active', p_supported_currencies text[] default array['USD']::text[]) returns jsonb`.
Body: `select account.out_customer_id into v_customer_id from billing_private.ensure_billing_account(p_user_id) as account;` then `v_method := billing_private.register_saved_payment_method(v_customer_id, p_provider, p_provider_payment_method_ref, p_display_name, p_last_four, p_expiry_month, p_expiry_year, p_status, p_supported_currencies);` then return `jsonb_build_object('savedPaymentMethodId', v_method.id, 'displayName', v_method.display_name, 'lastFour', v_method.last_four, 'expiryMonth', v_method.expiry_month, 'expiryYear', v_method.expiry_year, 'status', v_method.status, 'supportedCurrencies', to_jsonb(v_method.supported_currencies))`.

(2) `create or replace function public.easyfield_account_select_subscription_payment_method(p_user_id uuid, p_saved_payment_method_id uuid) returns jsonb`.
Lock order: billing_customers -> subscriptions -> saved_payment_methods.
Body: resolve customer via `ensure_billing_account`; `perform 1 from public.billing_customers where id = v_customer_id for update;`; select the single non-terminal subscription `where customer_id = v_customer_id and status not in ('canceled','expired') order by created_at desc limit 1 for update` (raise `'No renewable subscription' using errcode = '23503'` if none). When `p_saved_payment_method_id is null`, `update public.subscriptions set saved_payment_method_id = null where id = v_subscription.id` and return `jsonb_build_object('subscriptionId', v_subscription.id, 'savedPaymentMethodId', null, 'renewalEnabled', false)`. Otherwise require `select * into v_method from billing_private.saved_payment_methods where id = p_saved_payment_method_id and customer_id = v_customer_id and status = 'active' for update;` (raise 42501 `'Saved payment method is not usable for this subscription'` when not found) and additionally require `v_subscription.currency_code = any(v_method.supported_currencies)` — this is the exact predicate `create_renewal_attempt` enforces at 202607140001:2914, so failing here rather than at sweep time is the point. Then `update public.subscriptions set saved_payment_method_id = v_method.id where id = v_subscription.id;` and return `jsonb_build_object('subscriptionId', v_subscription.id, 'savedPaymentMethodId', v_method.id, 'renewalEnabled', true)`.
The existing `apply_subscription_catalog_snapshot` UPDATE branch (202607140001:1065-1071) independently re-verifies method ownership; this wrapper does not weaken it.

Privileges for both: `revoke all on function ... from public, anon, authenticated;` then `grant execute on function ... to service_role;`.

### Step 5: Add billing_private.settle_renewal_attempt — the one idempotent completion
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql

`create or replace function billing_private.settle_renewal_attempt(p_attempt_id uuid) returns jsonb language plpgsql security definer set search_path = ''`. This is the whole of defect (b)'s fix. It is safe to call any number of times, from any caller, in any order.

Declarations: v_attempt billing_private.renewal_attempts; v_subscription public.subscriptions; v_customer_id uuid; v_user_id uuid; v_lot public.credit_grant_lots; v_existing_lot public.credit_grant_lots; v_already_granted boolean := false; v_period_advanced boolean := false; v_granted bigint := 0;

1. `if p_attempt_id is null then raise exception 'Renewal attempt is required' using errcode = '22023'; end if;`
2. Unlocked probe to learn the lock targets: `select attempt.subscription_id into v_subscription_id from billing_private.renewal_attempts as attempt where attempt.id = p_attempt_id;` raise `'Renewal attempt not found' using errcode='23503'` if not found. Then `select subscription.customer_id into v_customer_id from public.subscriptions as subscription where subscription.id = v_subscription_id;` raise 23503 if not found.
3. Take locks in canonical order: `perform 1 from public.billing_customers as customer where customer.id = v_customer_id for update;` then `select subscription.* into v_subscription from public.subscriptions as subscription where subscription.id = v_subscription_id for update;` then `select attempt.* into v_attempt from billing_private.renewal_attempts as attempt where attempt.id = p_attempt_id for update;`.
4. Evidence gate — this function never infers payment: `if v_attempt.state <> 'succeeded' or v_attempt.provider_document_ref is null then raise exception 'Only a succeeded renewal with provider evidence may settle' using errcode = '55000'; end if;` This is exactly the evidence standard the schema already chose for renewals (grant_credits 202607140001:1847-1856 and annual_subscription_paid_source_is_valid 202607140001:809-821).
5. `if v_subscription.status in ('canceled','expired') then raise exception 'A terminal subscription cannot be settled; refund the renewal' using errcode = '55000'; end if;` (the `subscriptions_state_guard` trigger would reject the update anyway; failing here names the reason).
6. Period advance, idempotent and forward-only:
   if v_subscription.current_period_start is not distinct from v_attempt.period_start
      and v_subscription.current_period_end is not distinct from v_attempt.period_end then
     v_period_advanced := false;                     -- already this period
   elsif v_subscription.current_period_start >= v_attempt.period_end then
     v_period_advanced := false;                     -- a later paid period superseded it
   elsif v_subscription.current_period_end is not distinct from v_attempt.period_start then
     update public.subscriptions
     set status = 'active',
         current_period_start = v_attempt.period_start,
         current_period_end   = v_attempt.period_end,
         entitlement_ends_at  = v_attempt.period_end,
         annual_checkout_intent_id  = null,
         annual_renewal_attempt_id  = case when v_subscription.billing_interval = 'annual' then v_attempt.id else null end
     where id = v_subscription.id
     returning * into v_subscription;
     v_period_advanced := true;
   else
     raise exception 'Renewal period does not continue the subscription period' using errcode = '55000';
   end if;
   Both annual paid-source columns move in the SAME statement as both period columns, which is what `apply_subscription_catalog_snapshot` (202607140001:1053-1064) demands; and `annual_subscription_paid_source_is_valid` then passes because state is already 'succeeded', the document ref is set, plan/pricing/amount/currency are unchanged, and `create_renewal_attempt` built `period_end = period_start + interval '1 year'` for annual (202607140001:2919-2920). Setting `annual_checkout_intent_id = null` releases the first-purchase checkout from `subscriptions_annual_checkout_intent_key`, and `subscriptions_annual_paid_source_shape` is satisfied because exactly one of the pair is non-null for annual and both are null for monthly.
7. Entitlement, split by interval — never conflated:
   select customer.user_id into v_user_id from public.billing_customers as customer where customer.id = v_subscription.customer_id;
   if v_subscription.billing_interval = 'monthly' then
     select lot.* into v_existing_lot from public.credit_grant_lots as lot where lot.renewal_attempt_id = v_attempt.id;
     v_already_granted := found;
     v_lot := billing_private.grant_credits(
       v_user_id,
       v_subscription.included_microcredits_per_grant,
       'subscription',
       'paid:renewal:' || v_attempt.id::text,
       v_attempt.id::text,
       v_subscription.id,
       v_attempt.period_start,
       v_attempt.period_end,
       v_attempt.amount_currency_micros,
       v_attempt.currency_code,
       jsonb_build_object('renewal_attempt_id', v_attempt.id),
       null,
       v_attempt.id
     );
     v_granted := case when v_already_granted then 0 else v_lot.total_microcredits end;
   else
     perform billing_private.schedule_annual_plan_grants(
       v_subscription.id,
       v_attempt.period_start,
       v_subscription.included_microcredits_per_grant,
       12,
       interval '1 month'
     );
     v_granted := 0;
   end if;
   The metadata argument MUST be exactly `jsonb_build_object('renewal_attempt_id', v_attempt.id)` and MUST NOT contain clock_timestamp(), a payment_event_id, or anything else that differs between the two callers — grant_credits folds metadata into `request_sha256` (202607140001:1874-1885) and raises `'Grant idempotency key was reused with different inputs'` (22000) if two callers disagree.
   The annual branch deliberately does NOT grant instalment 1 inline (unlike the first-purchase path at 202607150005:502-521): `sweep_due_renewals` runs with a 1-day lead, so `scheduled_for` can be in the future and `grant_due_annual_plan_credits` correctly refuses `scheduled_for > clock_timestamp()`. The already-scheduled `easyfield-grant-annual` cron materialises it the minute it falls due.
8. Return: `jsonb_build_object('renewalAttemptId', v_attempt.id, 'subscriptionId', v_subscription.id, 'billingInterval', v_subscription.billing_interval, 'periodAdvanced', v_period_advanced, 'grantedMicrocredits', v_granted, 'currentPeriodEnd', to_jsonb(v_subscription.current_period_end))`.

Privileges: `revoke all on function billing_private.settle_renewal_attempt(uuid) from public, anon, authenticated;`

### Step 6: Replace finish_renewal_attempt so a success settles in the same transaction
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql
DEPENDS: Add billing_private.settle_renewal_attempt — the one idempotent completion

`create or replace function billing_private.finish_renewal_attempt(p_attempt_id uuid, p_claim_id uuid, p_result_state text, p_provider_document_ref text default null, p_provider_transaction_ref text default null, p_provider_status integer default null, p_failure_reason text default null) returns billing_private.renewal_attempts` — IDENTICAL signature, so every existing caller and grant is unaffected. Copy the deployed body from 202607140001:2986-3045 verbatim, with two changes:

CHANGE 1 — lock order. The deployed body opens with `select * into v_attempt from billing_private.renewal_attempts where id = p_attempt_id for update;`, which would invert against settle's customer -> subscription -> attempt order and deadlock two workers. The replacement first does the unlocked probe (`attempt.subscription_id`, then `subscription.customer_id`), then `perform 1 from public.billing_customers ... for update`, then `select ... from public.subscriptions ... for update`, then `select * into v_attempt from billing_private.renewal_attempts where id = p_attempt_id for update`. All existing validation and error messages (`'Renewal attempt not found'` 23503, `'Renewal result does not own the charge claim'` 42501, `'Renewal result retry has different inputs'` 22000, `'Renewal attempt is not awaiting its single result'` 55000) are preserved byte-for-byte.

CHANGE 2 — settle on success, in two places:
  a) In the idempotent early-return branch (`v_attempt.state = p_result_state` with identical inputs): before `return v_attempt;`, add `if v_attempt.state = 'succeeded' then perform billing_private.settle_renewal_attempt(v_attempt.id); end if;`. This repairs a half-applied outcome when a caller retries after losing the response.
  b) After the terminal UPDATE: `if v_attempt.state = 'succeeded' then perform billing_private.settle_renewal_attempt(v_attempt.id); end if;` then re-select the attempt into v_attempt before returning.

Errors from settle deliberately PROPAGATE. Because finish + settle share one transaction, a settle failure rolls the attempt back to `charging`, so the worker may safely call finish again with the same inputs and it will take the normal path, not the retry path. Swallowing the error would produce exactly the 'money moved, entitlement did not' state the schema exists to prevent.

Privileges: re-issue `revoke all on function billing_private.finish_renewal_attempt(uuid, uuid, text, text, text, integer, text) from public, anon, authenticated;`

### Step 7: Route a renewal payment through the webhook reconciler
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql
DEPENDS: Add billing_private.settle_renewal_attempt — the one idempotent completion

`create or replace function public.easyfield_account_reconcile_payment_event(p_provider text, p_provider_event_id text, p_provider_delivery_id text, p_raw_body_sha256 text, p_payload jsonb) returns jsonb` — same signature. Copy 202607150005:162-586 verbatim and make exactly four edits. Everything else, including the outer failure handler that retains the event as `failed`, is unchanged.

EDIT 1 — new declarations: `v_attempt billing_private.renewal_attempts;`, `v_has_renewal boolean := false;`, `v_settlement jsonb;`.

EDIT 2 — three-way routing. Keep the two existing `for update` selects exactly as written (202607150005:255-265) and insert an UNLOCKED third probe immediately after them:
  select attempt.* into v_attempt from billing_private.renewal_attempts as attempt where attempt.id = v_operation_id;
  v_has_renewal := found;
Replace `if v_has_checkout = v_has_partner then` with:
  if (v_has_checkout::integer + v_has_partner::integer + v_has_renewal::integer) <> 1 then
    raise exception 'Payment operation does not identify exactly one billable operation' using errcode = '23503';
  end if;
Because the checkout and partner probes found nothing on the renewal path, they took no locks, so the renewal branch is free to acquire customer -> subscription -> attempt in canonical order.

EDIT 3 — renewal assertion branch, added as a final `elsif v_has_renewal then` on the existing `if v_has_checkout ... else (partner) ...` chain (restructure to `if v_has_checkout then ... elsif v_has_partner then <existing partner body> else <renewal body> end if;`):
  select subscription.customer_id into v_customer_id from public.subscriptions as subscription where subscription.id = v_attempt.subscription_id;
  if not found then raise exception 'Renewal payment has no subscription' using errcode = '23503'; end if;
  perform 1 from public.billing_customers as customer where customer.id = v_customer_id for update;
  select subscription.* into v_subscription from public.subscriptions as subscription where subscription.id = v_attempt.subscription_id for update;
  select attempt.* into v_attempt from billing_private.renewal_attempts as attempt where attempt.id = v_operation_id for update;
  if v_subscription.provider is distinct from v_event.provider
    or v_event.payload->'total'->>'currency' is distinct from v_attempt.currency_code
    or v_event.payload->'total'->>'exponent' is distinct from '2'
    or (v_event.payload->'total'->>'minorUnits')::numeric * 10000::numeric is distinct from v_attempt.amount_currency_micros::numeric
    or v_subscription_ref is distinct from v_subscription.provider_subscription_ref
    or v_period_start is distinct from v_attempt.period_start
    or v_period_end is distinct from v_attempt.period_end
  then raise exception 'Payment does not reconcile with its renewal attempt' using errcode = '42501'; end if;
  if v_attempt.state = 'scheduled' then raise exception 'Renewal payment arrived for an unclaimed charge' using errcode = '55000'; end if;
  if v_attempt.state in ('failed', 'unknown') then raise exception 'Renewal payment contradicts a terminal renewal outcome' using errcode = '55000'; end if;
The signed subscription triple is therefore MANDATORY for a renewal payment, binding the evidence to the exact period. The two raises leave the event `failed` and visible, which is correct: money against a terminal or unclaimed attempt is a human's problem, and `protect_renewal_attempt_origin` makes 'failed'/'unknown' irreversible by design.

EDIT 4 — entitlement branch, added after the existing `perform billing_private.claim_payment_event(...)` / `finish_payment_event(..., 'processed', null)` pair, as a new arm of the `if v_has_partner then ... else ... end if;` chain:
  elsif v_has_renewal then
    insert into billing_private.payment_entitlement_claims (payment_event_id, provider, provider_payment_ref, claim_type, claim_id)
    values (v_event.id, v_event.provider, v_event.provider_event_id, 'subscription_renewal', v_attempt.id);
    if v_attempt.state = 'charging' then
      perform billing_private.finish_renewal_attempt(
        v_attempt.id,
        v_attempt.charge_claim_id,
        'succeeded',
        v_event.provider_event_id,
        nullif(v_event.payload->'transactions'->0->>'gatewayTransactionId', ''),
        null,
        null
      );
    end if;
    v_settlement := billing_private.settle_renewal_attempt(v_attempt.id);
    v_purchase_kind := 'subscription_renewal';
    v_granted_microcredits := (v_settlement->>'grantedMicrocredits')::bigint;
finish_renewal_attempt is called ONLY under `state = 'charging'`. When the synchronous adapter result already set 'succeeded' with its own document ref, calling finish again with the webhook's ref would hit the `'Renewal result retry has different inputs'` (22000) branch and break every well-behaved provider; skipping straight to settle is both correct and a no-op.

Redelivery of the SAME event needs no new code: the pre-existing `if v_event.status = 'processed'` branch (202607150005:235-250) already finds the claim, asserts `v_claim.claim_id = v_operation_id`, and returns `{processed:true, replayed:true, grantedMicrocredits:0}` — the claim row this branch adds satisfies it. A SECOND, distinct payment event for the same attempt violates `unique (claim_type, claim_id)`, rolls the subtransaction back, and stores the event as `failed`.

Privileges: re-issue `revoke all on function public.easyfield_account_reconcile_payment_event(text, text, text, text, jsonb) from public, anon, authenticated;` and `grant execute ... to service_role;`

### Step 8: Add the self-healing settle sweeper, extend run_maintenance and maintenance_health, schedule it
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql
DEPENDS: Add billing_private.settle_renewal_attempt — the one idempotent completion

`create or replace function billing_private.settle_succeeded_renewals(p_limit integer default 200) returns bigint language plpgsql security definer set search_path = ''`. Clamp `v_limit := least(greatest(coalesce(p_limit, 200), 1), 5000)`. Loop over attempt ids where settlement is provably missing:
  select attempt.id from billing_private.renewal_attempts as attempt
  join public.subscriptions as subscription on subscription.id = attempt.subscription_id
  where attempt.state = 'succeeded'
    and attempt.provider_document_ref is not null
    and subscription.status not in ('canceled','expired')
    and (
      (subscription.billing_interval = 'monthly'
        and not exists (select 1 from public.credit_grant_lots as lot where lot.renewal_attempt_id = attempt.id))
      or
      (subscription.billing_interval = 'annual'
        and not exists (select 1 from public.subscription_grant_schedule as schedule where schedule.annual_renewal_attempt_id = attempt.id))
    )
  order by attempt.period_start asc
  limit v_limit
Each iteration runs `begin perform billing_private.settle_renewal_attempt(v_id); v_settled := v_settled + 1; exception when others then null; end;` so one unsettleable attempt cannot stop the sweep — the same per-row isolation `sweep_due_renewals` already uses (202607290006:57-62). Return v_settled.

`create or replace function billing_private.run_maintenance(p_job text, p_limit integer default 1000) returns bigint` — copy the 202607290006:276-328 body and extend the allowlist to EXACTLY these five names, in this order: 'expire_credit_reservations', 'expire_credit_lots', 'grant_due_annual_plan_credits', 'sweep_due_renewals', 'settle_succeeded_renewals'. Dispatch the new one with `v_count := billing_private.settle_succeeded_renewals(v_limit);`. Keep the allowlist an allowlist — no arbitrary SQL.

`create or replace function billing_private.maintenance_health()` — copy 202607290006:333-372 and add `('settle_succeeded_renewals', 900)` to the `(values ...)` list.

Cron, guarded exactly like 202607290006:374-385:
  do $$ begin if exists (select 1 from cron.job where jobname = 'easyfield-settle-renewals') then perform cron.unschedule('easyfield-settle-renewals'); end if; end $$;
  select cron.schedule('easyfield-settle-renewals', '*/5 * * * *', $job$select billing_private.run_maintenance('settle_succeeded_renewals', 200)$job$);
No cron entry makes an HTTP call or holds a service-role key — the charge itself stays outside the database, as 202607290004's header argues.

Privileges: `revoke all on function billing_private.settle_succeeded_renewals(integer) from public, anon, authenticated;` and re-issue the existing revokes for run_maintenance and maintenance_health.

### Step 9: Add the renewal-unsettled operational alert
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql
DEPENDS: Add billing_private.settle_renewal_attempt — the one idempotent completion

`create or replace function billing_private.operational_alerts() returns jsonb` — copy 202607290006:148-211 and add one counter and one alert. New declaration `v_unsettled integer;`.
  select count(*) into v_unsettled
  from billing_private.renewal_attempts as attempt
  join public.subscriptions as subscription on subscription.id = attempt.subscription_id
  where attempt.state = 'succeeded'
    and attempt.updated_at < clock_timestamp() - interval '15 minutes'
    and (
      (subscription.billing_interval = 'monthly'
        and not exists (select 1 from public.credit_grant_lots as lot where lot.renewal_attempt_id = attempt.id))
      or
      (subscription.billing_interval = 'annual'
        and not exists (select 1 from public.subscription_grant_schedule as schedule where schedule.annual_renewal_attempt_id = attempt.id))
    );
  if v_unsettled > 0 then
    v_alerts := v_alerts || jsonb_build_object('severity', 'critical', 'code', 'renewal-unsettled', 'count', v_unsettled,
      'message', 'A renewal was charged but its period and credits were never applied.');
  end if;
Place it immediately after the existing `renewal-stuck-charging` alert so the two money-moved failures sit together. The existing `renewal-blocked` warning is left unchanged; once step 4 ships it should trend to zero on its own, which is the observable proof the fix worked.
Privileges: re-issue `revoke all on function billing_private.operational_alerts() from public, anon, authenticated;`

### Step 10: Expose the three provider-agnostic worker RPCs
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/202608060001_renewal_settlement_and_payment_methods.sql
DEPENDS: Replace finish_renewal_attempt so a success settles in the same transaction

All three `security definer set search_path = ''`, `revoke all ... from public, anon, authenticated`, `grant execute ... to service_role`.

(1) `create or replace function public.easyfield_billing_next_renewal_charges(p_limit integer default 25) returns jsonb`. `v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100)`. Returns `coalesce(jsonb_agg(... order by attempt.period_start asc), '[]'::jsonb)` over:
  select attempt.id, attempt.amount_currency_micros, attempt.currency_code, attempt.plan_key,
         method.provider, method.provider_payment_method_ref
  from billing_private.renewal_attempts as attempt
  join public.subscriptions as subscription on subscription.id = attempt.subscription_id
  join billing_private.saved_payment_methods as method on method.id = attempt.saved_payment_method_id
  where attempt.state = 'scheduled'
    and subscription.status in ('trialing','active')
    and not subscription.cancel_at_period_end
    and method.status = 'active'
    and attempt.currency_code = any(method.supported_currencies)
    and attempt.amount_currency_micros % 10000 = 0
  order by attempt.period_start asc
  limit v_limit
Each element: `jsonb_build_object('operationId', id, 'provider', provider, 'paymentMethodId', provider_payment_method_ref, 'amount', jsonb_build_object('currency', currency_code, 'minorUnits', amount_currency_micros / 10000, 'exponent', 2), 'description', 'EasyField ' || plan_key || ' renewal')`. The `cancel_at_period_end` and `status` predicates are the fail-closed guard for a customer who cancelled AFTER the attempt was enqueued — `create_renewal_attempt` checked it once, this re-checks it immediately before the charge. `% 10000 = 0` refuses rather than rounding money. This is the only place `provider_payment_method_ref` ever leaves the database, and only to service_role.

(2) `create or replace function public.easyfield_billing_claim_renewal_charge(p_attempt_id uuid, p_claim_id uuid) returns jsonb` — `v_attempt := billing_private.claim_renewal_attempt(p_attempt_id, p_claim_id);` returns `jsonb_build_object('operationId', v_attempt.id, 'state', v_attempt.state, 'chargeClaimId', v_attempt.charge_claim_id)`. Unchanged semantics: one claim, ever; a second call raises 55000.

(3) `create or replace function public.easyfield_billing_finish_renewal_charge(p_attempt_id uuid, p_claim_id uuid, p_result_state text, p_provider_document_ref text default null, p_provider_transaction_ref text default null, p_provider_status integer default null, p_failure_reason text default null) returns jsonb` — delegates to `billing_private.finish_renewal_attempt(...)` (which now settles) and returns `jsonb_build_object('operationId', v_attempt.id, 'state', v_attempt.state, 'periodEnd', to_jsonb(v_attempt.period_end))`.

### Step 11: Declare the adapter seam in the shared billing contracts
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/functions/_shared/billing_contracts.ts

APPEND ONLY — no existing type is edited. Add `SavedMethodBillingAdapter`, `BillingAdapterNotConfiguredError` and `resolveSavedMethodBillingAdapter` exactly as written in the seam section. `resolveSavedMethodBillingAdapter` unconditionally throws; there is no registry, no env lookup, no dynamic import and no fallback. Do not import, re-export or reference `./morning.ts` — it is a deprecated research scaffold and is not an approved processor.

### Step 12: Add the provider-agnostic renewal worker (everything except the charge)
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/functions/_shared/renewal_worker.ts

NEW FILE. Pure, dependency-free, unit-testable functions plus one adapter call.

  export interface RenewalChargeTask { readonly operationId: string; readonly provider: string; readonly paymentMethodId: string; readonly amount: MoneyAmount; readonly description: string; }
  export interface RenewalFinishArgs { readonly p_attempt_id: string; readonly p_claim_id: string; readonly p_result_state: 'succeeded'|'failed'|'unknown'; readonly p_provider_document_ref: string|null; readonly p_provider_transaction_ref: string|null; readonly p_provider_status: number|null; readonly p_failure_reason: string|null; }

  export function parseRenewalChargeTasks(value: unknown): readonly RenewalChargeTask[]  — validates the JSON returned by easyfield_billing_next_renewal_charges: array; each element an object with exactly the five keys; operationId a UUID; provider matching /^[a-z][a-z0-9_-]{1,39}$/; paymentMethodId a non-empty string <= 500 chars; amount.currency /^[A-Z]{3}$/, amount.exponent === 2, amount.minorUnits a safe integer >= 1. Throws TypeError otherwise.

  export function toFinishArgs(task: RenewalChargeTask, claimId: string, result: SavedPaymentMethodChargeResult): RenewalFinishArgs — the total mapping, with no provider knowledge:
    result.state === 'succeeded'  -> { p_result_state:'succeeded', p_provider_document_ref: result.providerDocumentId, p_provider_transaction_ref: result.providerTransactionId ?? null, p_provider_status: null, p_failure_reason: null }
    result.state === 'failed'     -> { p_result_state:'failed',    p_provider_document_ref: null, p_provider_transaction_ref: null, p_provider_status: result.providerStatus ?? null, p_failure_reason: result.reason }
    result.state === 'unknown'    -> { p_result_state:'unknown',   p_provider_document_ref: null, p_provider_transaction_ref: null, p_provider_status: result.providerStatus ?? null, p_failure_reason: result.reason }
    It must also throw when `result.operationId !== task.operationId` — a provider result for a different operation is never applied. These branches mirror finish_renewal_attempt's validation exactly (succeeded requires a document ref; failed/unknown require a reason).

  export async function chargeOneRenewal(task, claimId, adapter): Promise<RenewalFinishArgs> — calls `adapter.chargeSavedPaymentMethod({operationId: task.operationId, paymentMethodId: task.paymentMethodId, amount: task.amount, description: task.description, notificationUrl})` inside try/catch; ANY thrown error becomes `{state:'unknown', reason:'transport_error'}` mapped through toFinishArgs. A charge whose outcome is unobserved is never reported as failed.

### Step 13: Add the renewal worker Edge Function that refuses until a provider exists
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/functions/easyfield-renewal-worker/index.ts

NEW FILE, modelled on easyfield-billing-webhook/index.ts (same HttpError class, same `json()` helper, same `requiredEnv`, same `supabaseBaseUrl()`, same service-role RPC POST shape, same no-store headers).

Flow: POST only; authenticate with a shared secret header compared in constant time (reuse the `EASYFIELD_WEBHOOK_SECRET`-style pattern with a distinct `EASYFIELD_RENEWAL_WORKER_SECRET`); read provider id from `EASYFIELD_BILLING_PROVIDER_ID` validated against /^[a-z][a-z0-9_-]{1,39}$/; call `resolveSavedMethodBillingAdapter(provider)` BEFORE any RPC — it throws `BillingAdapterNotConfiguredError`, which the handler maps to `503 {"error":"renewal-charging-unavailable"}`. That 503 is the honest, visible stop: the worker is complete and deployable, and it refuses instead of pretending.

After a provider exists, the rest of the loop is already written: POST `/rest/v1/rpc/easyfield_billing_next_renewal_charges` -> `parseRenewalChargeTasks` -> for each task generate a claim UUID with `crypto.randomUUID()` -> POST `easyfield_billing_claim_renewal_charge` (skip the task on any non-2xx; a claim that did not commit must never be charged) -> `chargeOneRenewal` -> POST `easyfield_billing_finish_renewal_charge` with `toFinishArgs(...)`. Never retry a charge inside one invocation and never re-claim; `claim_renewal_attempt` enforces that server-side anyway.

The file must contain no provider name, no provider hostname, and no card field.

### Step 14: Document the new invariants
FILE: /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/migrations/README.md
DEPENDS: Route a renewal payment through the webhook reconciler

Append one bullet in the existing style, after the 202607290001 bullet:

`202608060001_renewal_settlement_and_payment_methods.sql` gives renewals the write path and the settlement they never had. `billing_private.register_saved_payment_method(...)` is the first and only writer of `billing_private.saved_payment_methods`; it refuses a token for a customer with no completed payment at the same provider, and never re-points a token at a second customer. A renewal that reaches `state = 'succeeded'` with a provider document reference now settles in the same transaction that records it: the subscription period advances forward-only to the attempt's exact `period_start`/`period_end`, and a monthly renewal creates one `credit_grant_lots` row anchored to `renewal_attempt_id` while an annual renewal creates the next twelve `subscription_grant_schedule` instalments instead — never both. Settlement is idempotent from every caller, keyed on `paid:renewal:<attempt>` and `credit_grant_lots_renewal_attempt_key`, and its grant metadata is derived solely from the attempt id so two callers can never disagree on `request_sha256`. The webhook reconciler routes `operationReference` against renewal attempts as a third billable operation, requires the signed subscription reference and both period bounds to match the attempt, claims the payment globally as `('subscription_renewal', attempt_id)`, and refuses a payment against an unclaimed or terminal attempt rather than reviving it. `settle_succeeded_renewals` runs every five minutes so a charged-but-unapplied renewal repairs itself, and `operational_alerts()` reports `renewal-unsettled` when it cannot. Charging a saved method remains the one unimplemented step: `resolveSavedMethodBillingAdapter` throws until a payment provider is chosen.

## Tests
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — NEW. Reuse the exact `withoutComments`/`normalize`/`readBalanced`/`extractFunctionFrom` helpers from tests/subscription-schema.test.mjs. Reads 202608060001_renewal_settlement_and_payment_methods.sql. Asserts: file starts /^begin;/ and ends /commit;$/; every new function body matches /language plpgsql security definer set search_path = ''/ (or /language sql .* security definer/ where applicable); a `revoke all on function` line exists for each of register_saved_payment_method, settle_renewal_attempt, settle_succeeded_renewals, finish_renewal_attempt, run_maintenance, maintenance_health, operational_alerts, and a matching `grant execute ... to service_role` for each of the five `public.easyfield_*` functions and for nothing else.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts the claim_type revision is exact: /drop constraint payment_entitlement_claims_claim_type_check/ appears before /add constraint payment_entitlement_claims_claim_type_check/, and the new list is exactly `claim_type in ( 'subscription', 'credit_pack', 'auto_reload', 'partner_lifetime', 'subscription_renewal' )` after normalization — proving no previously-valid value was dropped.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts the lock order inside `billing_private.settle_renewal_attempt` by index comparison on the normalized body: indexOf('public.billing_customers as customer where customer.id = v_customer_id for update') < indexOf('from public.subscriptions as subscription where subscription.id = v_subscription_id for update') < indexOf('from billing_private.renewal_attempts as attempt where attempt.id = p_attempt_id for update'). Same three-index assertion against the replaced `billing_private.finish_renewal_attempt` body, proving the deployed body's attempt-first lock was inverted deliberately.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts settlement is period-first, grant-second and interval-split: in the settle_renewal_attempt body, indexOf('update public.subscriptions') < indexOf('billing_private.grant_credits'); the grant call passes `'paid:renewal:' || v_attempt.id::text`, `v_attempt.period_start`, `v_attempt.period_end`, a null 12th argument and `v_attempt.id` as the 13th; the metadata argument is exactly `jsonb_build_object('renewal_attempt_id', v_attempt.id)` and the body does NOT match /clock_timestamp\(\)[^;]*metadata|payment_event_id/; the monthly arm is guarded by `if v_subscription.billing_interval = 'monthly' then`; the else arm calls `billing_private.schedule_annual_plan_grants(` with literal `12,` and `interval '1 month'` and the annual arm contains no `grant_credits` call.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts settle is idempotent and forward-only: the body contains all three branch predicates `v_subscription.current_period_start is not distinct from v_attempt.period_start`, `v_subscription.current_period_start >= v_attempt.period_end`, and `v_subscription.current_period_end is not distinct from v_attempt.period_start`, plus the fall-through `raise exception 'renewal period does not continue the subscription period' using errcode = '55000'`; and the evidence gate `v_attempt.state <> 'succeeded' or v_attempt.provider_document_ref is null`.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts finish_renewal_attempt settles on both success paths: the replaced body contains `perform billing_private.settle_renewal_attempt` exactly twice, and its signature is byte-identical to the deployed one (`(p_attempt_id uuid, p_claim_id uuid, p_result_state text, p_provider_document_ref text default null, p_provider_transaction_ref text default null, p_provider_status integer default null, p_failure_reason text default null)`), and it still contains the four original error strings 'renewal attempt not found', 'renewal result does not own the charge claim', 'renewal result retry has different inputs', 'renewal attempt is not awaiting its single result'.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts webhook routing: the replaced `public.easyfield_account_reconcile_payment_event` body contains `(v_has_checkout::integer + v_has_partner::integer + v_has_renewal::integer) <> 1`; the renewal assertion block compares all of `v_subscription_ref is distinct from v_subscription.provider_subscription_ref`, `v_period_start is distinct from v_attempt.period_start`, `v_period_end is distinct from v_attempt.period_end`; it raises for `v_attempt.state = 'scheduled'` and for `v_attempt.state in ('failed', 'unknown')` with errcode '55000'; it inserts into billing_private.payment_entitlement_claims with the literal `'subscription_renewal', v_attempt.id`; and indexOf("if v_attempt.state = 'charging' then") < indexOf('perform billing_private.finish_renewal_attempt') < indexOf('billing_private.settle_renewal_attempt') — proving finish is never called on an already-succeeded attempt.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts the scheduler contract: run_maintenance's allowlist array is exactly ['expire_credit_reservations','expire_credit_lots','grant_due_annual_plan_credits','sweep_due_renewals','settle_succeeded_renewals']; maintenance_health's values list contains ('settle_succeeded_renewals', 900); the cron entry is `cron.schedule( 'easyfield-settle-renewals', '*/5 * * * *', ...run_maintenance('settle_succeeded_renewals', 200)...)` and is preceded by its `cron.unschedule('easyfield-settle-renewals')` guard; operational_alerts contains the literal code 'renewal-unsettled' with severity 'critical'; and the migration contains no `pg_net`, no `net.http_post` and no 'service_role_key' string.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-settlement-migration.test.mjs — asserts forward-only and provider-neutral: the deployed 202607140001_subscription_billing.sql and 202607150005_atomic_payment_reconciliation.sql are read and asserted UNCHANGED in the two respects that matter — 202607140001's finish_renewal_attempt body does NOT match /settle_renewal_attempt/, and 202607150005 still matches /payment operation does not identify exactly one checkout/; and the new migration text does not match /stripe|paddle|morning|greeninvoice|card_number|cvv/i.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/tests/renewal-worker.test.mjs — NEW. Uses the tests/account-edge-api.test.mjs Deno-shim pattern (collect `Deno.test` registrations, replay them through node:test) to import ../supabase/functions/_shared/renewal_worker_test.ts. Then adds source-text assertions: easyfield-renewal-worker/index.ts matches /resolveSavedMethodBillingAdapter\(/ and /renewal-charging-unavailable/ and does NOT match /stripe|paddle|morning/i; billing_contracts.ts matches /class BillingAdapterNotConfiguredError/ and its resolveSavedMethodBillingAdapter body matches /throw new BillingAdapterNotConfiguredError/ with no `return` statement; and renewal_worker.ts does not import ./morning.ts.
- /Users/twistmedia/Desktop/EasyField/.claude/worktrees/project-status-launch-readiness-976e81/supabase/functions/_shared/renewal_worker_test.ts — NEW Deno tests: (1) parseRenewalChargeTasks accepts one exact well-formed task and returns amount.exponent === 2; (2) it throws for a non-UUID operationId, for exponent !== 2, for minorUnits === 0, for a fractional minorUnits, and for an extra unknown key; (3) toFinishArgs maps a succeeded result to exactly {p_result_state:'succeeded', p_provider_document_ref:'doc-1', p_provider_transaction_ref:null, p_provider_status:null, p_failure_reason:null} when providerTransactionId is absent; (4) toFinishArgs maps a definitive failure to p_result_state 'failed' with p_provider_document_ref null and p_failure_reason equal to the reason; (5) toFinishArgs maps an ambiguous result to p_result_state 'unknown' — asserting explicitly that it is NOT 'failed'; (6) toFinishArgs throws when result.operationId differs from task.operationId; (7) chargeOneRenewal with an adapter whose chargeSavedPaymentMethod rejects returns p_result_state 'unknown' and p_failure_reason 'transport_error', never 'failed'; (8) resolveSavedMethodBillingAdapter('anything') throws BillingAdapterNotConfiguredError.

## Risks
- Double-grant on webhook redelivery. Guarded four deep: public.payment_events is deduplicated on (provider, provider_event_id) AND (provider, raw_body_sha256) so the same body yields one row; the pre-existing `v_event.status = 'processed'` branch returns {replayed:true, grantedMicrocredits:0} without re-entering the entitlement code; billing_private.payment_entitlement_claims has unique (payment_event_id) and unique (claim_type, claim_id) so a SECOND distinct event for the same attempt is rejected and the event is stored `failed` rather than granted; and grant_credits derives idempotency_key = 'paid:renewal:<attempt>' with credit_grant_lots_renewal_attempt_key unique (renewal_attempt_id), so even a direct double call returns the existing lot. Verify by test: the settle body must read the existing lot BEFORE calling grant_credits and report grantedMicrocredits 0 when one was already present.
- Metadata drift between the two settlement callers is the one way idempotency can be silently broken. grant_credits folds `metadata` into request_sha256 (202607140001:1874-1885) and raises 22000 'Grant idempotency key was reused with different inputs' on mismatch. Because settle_renewal_attempt is the SINGLE place that calls grant_credits for a renewal, and its metadata is `jsonb_build_object('renewal_attempt_id', v_attempt.id)` with no timestamp and no payment_event_id, both the synchronous and the webhook path produce byte-identical inputs. Guard: never add a field to that object, and the test asserts the literal.
- Lock-order inversion between finish_renewal_attempt (deployed: renewal_attempts first) and settle (customer -> subscription -> attempt) would deadlock two workers. Guard: finish_renewal_attempt is REPLACED to take the canonical prefix before touching renewal_attempts, and the test asserts the three indices are increasing in both function bodies. claim_renewal_attempt is left alone because it is a leaf-only lock and acquires nothing else.
- Granting before advancing the period silently fails. grant_credits demands current_period_start = p_granted_at and current_period_end = p_expires_at for source_type='subscription' (202607140001:1911-1912), so the UPDATE must precede the call. Guard: the test asserts indexOf('update public.subscriptions') < indexOf('grant_credits') inside settle_renewal_attempt.
- Conflating annual with monthly. grant_credits REFUSES an annual subscription on the 'subscription' path (202607140001:1908), and schedule_annual_plan_grants REFUSES unless period_anchor equals the freshly advanced current_period_start (202607140001:2669). Guard: the two arms are mutually exclusive on billing_interval, the annual arm contains no grant_credits call, and the annual arm relies on the already-deployed easyfield-grant-annual cron rather than granting instalment 1 inline — which would violate grant_due_annual_plan_credits' own `scheduled_for <= clock_timestamp()` rule whenever the sweep charges within its 1-day lead.
- The 1-day sweep lead means a renewal can settle up to 24h before the old period ends, so two live lots briefly overlap. This is benign and must not be 'fixed' by clamping: credit_grant_lots_fifo_idx orders by (expires_at asc nulls last, granted_at, id), so the older lot — whose expires_at equals the new period_start — is always spent first and nothing is lost. Documented rather than guarded.
- A catalog price revision bricks every renewal. enforce_subscription_state_and_catalog (202607150001:200-221) rejects ANY update leaving a trialing/active subscription whose snapshot differs from the active catalog, and apply_subscription_catalog_snapshot (202607140001:1045-1052) makes the snapshot columns immutable on update — so settle would raise for every in-flight subscriber. This is already mitigated upstream: the price-revision migrations (20260715154941, 202607290002) take ACCESS EXCLUSIVE locks and refuse while any non-terminal subscription, unresolved renewal or pending grant exists. Guard: do not weaken that preflight; the renewal-unsettled alert catches it within 15 minutes if someone does.
- A customer cancels after the attempt is enqueued but before the charge. create_renewal_attempt checks cancel_at_period_end once (202607140001:2907) and nothing rechecks it. Guard: easyfield_billing_next_renewal_charges re-asserts `subscription.status in ('trialing','active') and not subscription.cancel_at_period_end and method.status = 'active'` immediately before the charge is offered to the worker. settle deliberately does NOT re-check it — if money moved anyway, the customer gets the period they paid for.
- An ambiguous charge ('unknown') is terminal by design (protect_renewal_attempt_origin, 202607140001:679-683), so a later webhook proving payment cannot revive it. Guard: the reconciler raises 55000 'Renewal payment contradicts a terminal renewal outcome', the signed event is retained as `failed` evidence, and renewal-stuck-charging / renewal-unsettled put it in front of an operator. Nothing auto-recovers, and nothing pretends the charge failed.
- A settle failure inside finish_renewal_attempt rolls the attempt back to 'charging', leaving money moved and no record of success. This is intentional — swallowing the error would produce a permanent silent loss — and it is recoverable: the worker may call finish again with identical inputs and take the normal (not the retry) path. The existing renewal-stuck-charging alert fires after one hour, and settle_succeeded_renewals repairs anything that did commit as succeeded. Guard: do not wrap the settle call in an exception block.
- Leaking provider_payment_method_ref. It is returned by exactly one function, easyfield_billing_next_renewal_charges, granted to service_role only, and never by easyfield_account_register_payment_method or my_billing_snapshot. Guard: the test asserts the register RPC's returned jsonb_build_object contains no provider_payment_method_ref key, and that only the five named public functions carry a grant to service_role.
- Registering a payment method for a customer who never paid, or re-pointing a vault token at a different customer. Guarded by the completed-checkout/partner-purchase existence check (42501) and by the (provider, provider_payment_method_ref) ownership assertion before the upsert (42501). Neither can be satisfied by caller-supplied data alone.
- Wiring the deprecated Morning scaffold. supabase/functions/_shared/morning.ts is a research-only file explicitly marked not an approved processor. Guard: resolveSavedMethodBillingAdapter has no registry and unconditionally throws, and the tests assert neither renewal_worker.ts, easyfield-renewal-worker/index.ts nor the migration mentions any provider name.

## Adversarial review
## Verdict

The spec's **diagnosis** is accurate — I re-verified all three defects against the source and they are real. The **implementation plan** is not shippable as written: it collides with a migration already in the tree, deletes two live cron jobs, will not compile, and introduces a genuine deadlock against an every-minute deployed job while claiming to be lock-order-consistent.

---

## Blockers

### B1 — Migration version collision (hard stop)
`supabase/migrations/202608060001_checkout_abandonment_recovery.sql` already exists (670 lines, untracked in the worktree but present and clearly intended to ship). The spec's file is `202608060001_renewal_settlement_and_payment_methods.sql`. Supabase derives the migration version from the leading numeric prefix, so both files claim version `202608060001`. Renumber to `202608060002_…` and re-check the ordering assumptions below, which depend on the abandonment migration landing first.

### B2 — Lock order is inverted against `easyfield-grant-annual`; this is a reachable deadlock
The spec declares `billing_customers -> subscriptions -> renewal_attempts -> subscription_grant_schedule -> credit_accounts -> credit_grant_lots` and justifies it as "the same suffix `grant_due_annual_plan_credits` already uses (subscription -> schedule -> account, via grant_credits)".

That is false, and the omission is exactly the bug. `supabase/migrations/202607140001_subscription_billing.sql:2782-2783` states the deployed order in a comment:

> `-- Global order for annual work is subscription -> schedule -> customer -> account, matching schedule creation and avoiding schedule/account races.`

And the code does it: `subscriptions … for update` (2784-2787), `subscription_grant_schedule … for update skip locked` (2792-2795), then `billing_customers … for update` reached through `grant_credits` → `ensure_billing_account` (`202607140001:1431-1434`). **Customer is locked after subscription, not before.** This runs every minute (`202607290004:281-285`).

Concrete deadlock, monthly-agnostic, annual path:
- Settle advances an annual period; instalment 1 has `scheduled_for = period_start`, immediately due.
- **Session A** — `settle_succeeded_renewals` retry (or the webhook renewal branch): holds `billing_customers(C)`, waits on `subscriptions(S)`.
- **Session B** — `easyfield-grant-annual`: holds `subscriptions(S)`, waits on `billing_customers(C)` inside `ensure_billing_account`.
- Postgres deadlock. On the webhook path this aborts the subtransaction and stores a **paid** event as `failed`.

The spec's other precedent is real but unreachable: `easyfield_account_reconcile_payment_event` does lock customer→subscription (`202607150005:290-293`, `314-318`), but only for an `incomplete` subscription with null periods, and `202607150005:339-347` forbids a second non-terminal subscription per customer — so it can never run concurrently with the annual cron on the same customer. The renewal path removes that accidental protection.

**Correction:** adopt `subscriptions -> renewal_attempts -> subscription_grant_schedule -> billing_customers -> credit_accounts -> credit_grant_lots`, matching the deployed annual path, and keep `finish_renewal_attempt`'s existing attempt-first probe only after taking `subscriptions`. If customer-first is genuinely wanted, this migration must *also* replace `grant_due_annual_plan_credits` — which the spec's own scope statement ("No DROP of any table, column or constraint other than the one CHECK") forbids.

### B3 — `v_customer_id` is undeclared; the reconciler will not compile
The declaration block at `202607150005:174-195` contains no `v_customer_id`. EDIT 1 adds only `v_attempt`, `v_has_renewal`, `v_settlement`, but EDIT 3 writes `select subscription.customer_id into v_customer_id`. Add the declaration.

### B4 — EDIT 4 is syntactically invalid
The target is `if v_has_partner then … else <checkout body> end if;` (`202607150005:376-549`). You cannot append `elsif v_has_renewal then` after an `else`. EDIT 3 says "restructure"; EDIT 4 does not, and states the arm as an `elsif` appended to that chain. Must become `if v_has_partner then … elsif v_has_renewal then … else … end if;`.

### B5 — Rewriting `run_maintenance` deletes two live cron jobs
The spec says copy `202607290006:276-328` and extend the allowlist to "EXACTLY these five names", plus a test asserting exactly five. But the current definition is `202608060001_checkout_abandonment_recovery.sql:481-539` with a **six**-name allowlist adding `close_unopened_checkouts` and `expire_stale_open_checkouts`, both wired to live cron entries (`easyfield-close-unopened-checkouts` `'7 * * * *'` and `easyfield-expire-stale-open-checkouts` `'22 * * * *'`, lines 554-564). Applying the spec makes both raise `22023` hourly forever, and the test would enshrine it. The allowlist must be **seven**.

### B6 — Same problem for `operational_alerts()`
The spec says copy `202607290006:148-211`. The current body is `202608060001_checkout_abandonment_recovery.sql:575+`, which deliberately split the `checkout-abandoned` alert. Copying the older body silently reverts that work. Base off the newer definition.

(`maintenance_health()` *is* still the `202607290006:333-372` version, so that instruction is correct — but note the two checkout jobs were never added to its values list, so adding `('settle_succeeded_renewals', 900)` while leaving them out is inconsistent.)

---

## Substantive

**S1 — `needs_reconciliation` payloads are accepted as payment evidence.** `payment_reconciliation_payload_is_valid` permits `reconciliationState = 'needs_reconciliation'` (`202607150005:38, 61-66`) with up to 100 transactions, and the router never checks it. The spec's renewal branch would call `finish_renewal_attempt(…, 'succeeded', …)` and settle on a payload the provider itself flagged as unreconciled. For checkouts this is pre-existing; here it is **new code**, so the branch should require `v_event.payload->>'reconciliationState' = 'ready'`. Related: `payload->'transactions'->0->>'gatewayTransactionId'` only has a defined meaning when `ready` (exactly one transaction, `202607150005:88`).

**S2 — Worker/webhook race raises a hard `22000` on a correctly-settled renewal.** If the webhook lands while the attempt is `charging`, the spec finishes it with `v_event.provider_event_id` as `provider_document_ref`. The worker then calls `easyfield_billing_finish_renewal_charge` with the adapter's own `providerDocumentId`; `finish_renewal_attempt` (`202607140001:3029-3037`) takes the `v_attempt.state = p_result_state` path, sees a different ref, and raises `Renewal result retry has different inputs`. Money settled, credits granted, worker sees a 5xx — and neither `renewal_worker.ts` nor the edge function as specced handles it. Decide explicitly: either the webhook does not finish a `charging` attempt (let the worker own the terminal write; `settle_succeeded_renewals` catches abandonment), or the worker treats this specific error as success.

**S3 — `renewal-unsettled` can become a permanently unclearable critical alert, and its predicate disagrees with the sweeper's.** Settle refuses on `status in ('canceled','expired')` and the sweeper swallows the exception. The sweeper query filters `subscription.status not in ('canceled','expired')`; the alert query does **not**. Such an attempt satisfies the alert forever — `protect_renewal_attempt_origin` (`202607140001:659-686`) makes terminal attempts immutable, so nothing can clear it. Either align the two predicates or add an explicit recorded-resolution row.

**S4 — Unconditional `status = 'active'` in the period advance.** Correct for `trialing`. But an attempt whose subscription drifted to `past_due` or `paused` between enqueue and settle is silently promoted to `active`, clearing a delinquency nothing else set. State the intent or use `case when v_subscription.status = 'trialing' then 'active' else v_subscription.status end`.

**S5 — The seam's stated return shapes are incomplete.** `ChargeResultBase` (`billing_contracts.ts:87-92`) requires `provider` and `automaticRetryAllowed: false` on *every* variant; `AmbiguousChargeResult` requires `definitive: false`, `nextAction`, and a closed five-literal `reason` union (110-119), not `string`. The spec's three shapes omit all of these, and `chargeOneRenewal`'s synthesized `{state:'unknown', reason:'transport_error'}` will not typecheck — nor will it satisfy `toFinishArgs`'s own `result.operationId !== task.operationId` check without an `operationId`.

---

## Verified sound

- **Every named table, column, constraint and status value exists exactly as cited.** `saved_payment_methods` (`202607140001:89-105`), `renewal_attempts` with states `scheduled|charging|succeeded|failed|unknown` (137-164), `credit_grant_lots.renewal_attempt_id` + `credit_grant_lots_renewal_attempt_key` + `credit_grant_lots_paid_source_shape` (610-633), `subscriptions_annual_renewal_attempt_key` + `subscriptions_annual_paid_source_shape` (424-443), `subscription_grant_schedule.annual_renewal_attempt_id` (511-512), `payment_entitlement_claims` with all three uniques (`202607150003:58-69`).
- **Step 2 (claim_type widening) is correct.** `payment_entitlement_claims_claim_type_check` is the right auto-generated name for an inline column CHECK, and DDL does not fire `payment_entitlement_claims_are_immutable` (`202607150003:88-89`).
- **Period-before-grant ordering is genuinely mandatory**, exactly as argued: `grant_credits` demands `billing_interval = 'monthly'`, `status in ('trialing','active')`, `included_microcredits_per_grant = p_amount_microcredits`, `current_period_start = p_granted_at`, `current_period_end = p_expires_at` (`202607140001:1904-1913`). The 13-argument positional call maps correctly onto the signature at 1715-1728.
- **Idempotency of the grant is real.** The `(account_id, idempotency_key)` lookup precedes the mutable snapshot check (`202607140001:1888-1896`) and `unique (account_id, idempotency_key)` exists (line 224), so a repeat settle after a further period advance returns the existing lot instead of raising. The metadata-drift risk is correctly identified — `request_sha256` folds `metadata` (1874-1885).
- **Monthly/annual must not be conflated, and the spec gets it right.** `grant_credits` hard-refuses annual on the `'subscription'` path (1908); `schedule_annual_plan_grants` requires `p_period_anchor = current_period_start` (2670-2673) and is genuinely idempotent at the same anchor via its early return (2608-2663). Declining to grant instalment 1 inline is also right: `grant_due_annual_plan_credits` refuses `scheduled_for > clock_timestamp()` (2796-2799), which the 1-day sweep lead (`202607290006:31,51`) makes reachable.
- **The annual UPDATE passes its guards.** `annual_subscription_paid_source_is_valid`'s renewal branch (`202607140001:806-822`) is satisfied, and moving both period columns and both `annual_*` columns in one statement satisfies `apply_subscription_catalog_snapshot` (1053-1064).
- **All three claimed defects are real** — no INSERT into `saved_payment_methods` anywhere (only the caller-less grant at `202607140001:3748`); `finish_renewal_attempt` (2986-3049) writes only the five outcome columns; the router raises at `202607150005:267-270`.
- **No fabricated provider evidence anywhere in the spec.** The evidence gate mirrors the schema's own standard (`202607140001:1847-1852`, `809-813`), and `resolveSavedMethodBillingAdapter` throwing unconditionally is the correct seam. `morning.ts:16-17` is marked deprecated/not-approved and is correctly left alone.
- **RLS is `enable`, never `force`** (`20260715170000:1-14`, with an explicit "Do not FORCE RLS" comment), so the security-definer read path works.
- **`parsePaymentWebhook` already carries the subscription triple** (`supabase/functions/_shared/account_api.ts:357-399`) — the claim that no TS parsing change is needed is correct.
- **Test helpers exist:** `withoutComments` (44), `normalize` (50), `readBalanced` (54), `extractFunctionFrom` (160) in `tests/subscription-schema.test.mjs`; the Deno shim pattern at `tests/account-edge-api.test.mjs:5-15`.

## Nits
- Cited spans are slightly off: `finish_renewal_attempt` is 2986-**3049** (not 3045); the `grant_credits` renewal branch is 1844-1866 (not 1843-1868). Immaterial.
- The README bullet: `202607290001` is indeed the last migration bullet (`supabase/migrations/README.md:26`), but the abandonment migration has no bullet either — coordinate the two additions.