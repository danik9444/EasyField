begin;

-- Refunds and chargebacks.
--
-- `billing_private.revoke_partner_entitlement` (202607150003:449) is correct,
-- idempotent, and has never had a caller. A chargeback on the $999 Partner
-- lifetime product therefore leaves `partner_entitlements.status = 'active'`
-- for ever: the money goes back and the access does not. The same hole exists
-- for subscriptions and credit packs, where granted credit is simply kept.
--
-- This migration supplies the missing half: reversal evidence, a clawback
-- primitive, and one reconciliation entry point that decides what a reversal
-- means for each kind of operation.
--
-- WHAT IS NOT HERE. Nothing recognises a provider's reversal webhook, because
-- no provider is chosen and every provider signs and shapes one differently.
-- `reconcile_payment_reversal` is the seam: an adapter verifies a signature,
-- normalises the event, and calls this with the amount and a reference. That
-- adapter is the entire remaining dependency.
--
-- FOUR THINGS THAT ARE EASY TO GET WRONG, AND ARE GOT RIGHT HERE.
--
-- 1. LOCK ORDER. The credit subsystem's order is account -> quote ->
--    reservation/lots (202607140001:2098). `expire_account_credit_lots`,
--    `reserve_credits` and `easyfield_generation_reject_submission` all lock
--    `credit_accounts` before touching a lot. Clawback runs against live
--    generation traffic, so taking a lot first would deadlock against any
--    concurrent reserve or capture. The account is locked first, here, before
--    any lot is selected.
--
-- 2. A SECOND REVERSAL MUST NOT WEDGE. `revoke_partner_entitlement` raises
--    55000 when the entitlement is already non-active, and
--    `enforce_subscription_state_and_catalog` (202607150001:186) makes a
--    canceled subscription immutable. A partial chargeback followed by a
--    refund of the remainder is ordinary, and naively revoking twice would
--    roll the second one back, file a real reversal as `failed`, and leave the
--    provider retrying for ever. Both revocations are therefore guarded on the
--    entitlement still being live, and skipping is a recorded outcome.
--
-- 3. RECOVERY IS KNOWN BEFORE IT IS RECORDED. The evidence tables are
--    append-only (`reject_immutable_mutation`), so a row cannot be written
--    first and corrected afterwards. Each clawback computes
--    `least(target, lot.available_microcredits)` under the lot lock and writes
--    that figure as it inserts.
--
-- 4. PRO-RATA IS AGAINST GRANTED CREDIT, NOT AGAINST PRICE. A customer three
--    months into an annual plan has three of twelve lots. Taking 25% of the
--    price out of each granted lot would reclaim roughly everything they
--    actually received. The ratio is applied to what was granted.
--
-- Credit that has already been spent cannot be recovered. This migration does
-- not invent a negative balance to pretend otherwise: it records the shortfall
-- and reports it.

-- -------------------------------------------------------------------------
-- Evidence
-- -------------------------------------------------------------------------

create table billing_private.payment_reversals (
  id uuid primary key default gen_random_uuid(),
  -- The reversal's own provider event, and the payment it reverses. Both are
  -- real recorded events; neither is inferred.
  payment_event_id uuid not null unique references public.payment_events(id) on delete restrict,
  reversed_payment_event_id uuid not null references public.payment_events(id) on delete restrict,
  provider text not null
    check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_reversal_ref text not null check (char_length(provider_reversal_ref) between 1 and 300),
  reversal_type text not null check (reversal_type in ('refund', 'chargeback', 'dispute_lost')),
  claim_type text not null,
  claim_id uuid not null,
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  original_amount_currency_micros bigint not null check (original_amount_currency_micros > 0),
  -- What earlier reversals had already taken, so "is this now complete?" is a
  -- property of the row rather than a query someone has to remember to run.
  prior_reversed_amount_currency_micros bigint not null default 0
    check (prior_reversed_amount_currency_micros >= 0),
  reversed_amount_currency_micros bigint not null check (reversed_amount_currency_micros > 0),
  full_reversal boolean not null,
  entitlement_action text not null check (entitlement_action in (
    'partner_revoked', 'partner_already_terminal',
    'subscription_canceled', 'subscription_already_terminal',
    'none'
  )),
  -- What was actually recovered is NOT stored here. This table is append-only,
  -- and the figure is only known after the per-lot clawbacks have run, so a
  -- column would have to be written before it could be computed. It is derived
  -- from payment_reversal_clawbacks, which holds both the target and the
  -- recovery for every lot touched.
  reason text not null check (char_length(reason) between 3 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_reversal_ref),
  -- Cumulative, not per-row: a second partial reversal that completes the
  -- total IS full, and a CHECK comparing only this row's amount would reject
  -- exactly the refund-the-remainder case.
  check (full_reversal = (prior_reversed_amount_currency_micros + reversed_amount_currency_micros
                          = original_amount_currency_micros)),
  check (prior_reversed_amount_currency_micros + reversed_amount_currency_micros
         <= original_amount_currency_micros)
);

create trigger payment_reversals_are_immutable
before update or delete on billing_private.payment_reversals
for each row execute function billing_private.reject_immutable_mutation();

alter table billing_private.payment_reversals enable row level security;
alter table billing_private.payment_reversals force row level security;

create index payment_reversals_claim_idx
  on billing_private.payment_reversals (claim_type, claim_id);
create index payment_reversals_customer_recent_idx
  on billing_private.payment_reversals (customer_id, created_at desc);

-- Only one reversal may complete a given payment.
create unique index payment_reversals_one_full_per_payment
  on billing_private.payment_reversals (reversed_payment_event_id)
  where full_reversal;

create table billing_private.payment_reversal_clawbacks (
  id uuid primary key default gen_random_uuid(),
  payment_reversal_id uuid not null
    references billing_private.payment_reversals(id) on delete restrict,
  lot_id uuid not null references public.credit_grant_lots(id) on delete restrict,
  target_microcredits bigint not null check (target_microcredits >= 0),
  -- Computed under the lot lock immediately before this row is written. The
  -- table is append-only, so it can never be corrected later.
  recovered_microcredits bigint not null check (recovered_microcredits >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (payment_reversal_id, lot_id),
  check (recovered_microcredits <= target_microcredits)
);

create trigger payment_reversal_clawbacks_are_immutable
before update or delete on billing_private.payment_reversal_clawbacks
for each row execute function billing_private.reject_immutable_mutation();

alter table billing_private.payment_reversal_clawbacks enable row level security;
alter table billing_private.payment_reversal_clawbacks force row level security;

-- -------------------------------------------------------------------------
-- Clawback
-- -------------------------------------------------------------------------

-- Takes back up to `p_target_microcredits` from one lot and records what it
-- actually got. The caller MUST already hold the account lock; this function
-- deliberately does not take it, so that the account-before-lots order is
-- visible at the call site instead of being buried here.
create or replace function billing_private.claw_back_lot_credits(
  p_payment_reversal_id uuid,
  p_lot_id uuid,
  p_target_microcredits bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot public.credit_grant_lots;
  v_account public.credit_accounts;
  v_recovered bigint;
  v_clawback_id uuid;
begin
  if p_payment_reversal_id is null or p_lot_id is null
    or p_target_microcredits is null or p_target_microcredits < 0
  then
    raise exception 'Invalid clawback request' using errcode = '22023';
  end if;
  if p_target_microcredits = 0 then
    return 0;
  end if;

  select lot.* into v_lot
  from public.credit_grant_lots as lot
  where lot.id = p_lot_id
  for update;
  if not found then
    raise exception 'Credit lot not found' using errcode = '23503';
  end if;

  -- Reserved credit is committed to a generation that is already in flight.
  -- Taking it would make an accepted provider task unsettleable, so only
  -- available credit is recoverable.
  v_recovered := least(p_target_microcredits, v_lot.available_microcredits);

  insert into billing_private.payment_reversal_clawbacks (
    payment_reversal_id, lot_id, target_microcredits, recovered_microcredits
  ) values (
    p_payment_reversal_id, p_lot_id, p_target_microcredits, v_recovered
  )
  returning id into v_clawback_id;

  if v_recovered = 0 then
    return 0;
  end if;

  update public.credit_grant_lots
  set available_microcredits = available_microcredits - v_recovered
  where id = v_lot.id;

  update public.credit_accounts
  set available_microcredits = available_microcredits - v_recovered,
      version = version + 1
  where id = v_lot.account_id
  returning * into v_account;

  insert into public.credit_ledger (
    account_id, lot_id, entry_type,
    available_delta_microcredits, reserved_delta_microcredits,
    consumed_delta_microcredits, expired_delta_microcredits,
    idempotency_key, reference_type, reference_id, metadata
  ) values (
    v_lot.account_id, v_lot.id, 'refund',
    -v_recovered, 0, 0, 0,
    'reversal:clawback:' || v_clawback_id::text,
    'payment_reversal', p_payment_reversal_id,
    jsonb_build_object('clawback_id', v_clawback_id, 'lot_id', v_lot.id)
  );

  return v_recovered;
end;
$$;

-- -------------------------------------------------------------------------
-- Reconciliation
-- -------------------------------------------------------------------------

-- The one entry point. A provider adapter verifies its own signature, records
-- the reversal as a `public.payment_events` row, and calls this.
create or replace function billing_private.reconcile_payment_reversal(
  p_payment_event_id uuid,
  p_reversed_payment_event_id uuid,
  p_provider_reversal_ref text,
  p_reversal_type text,
  p_reversed_amount_currency_micros bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := lower(btrim(coalesce(p_reversal_type, '')));
  v_ref text := btrim(coalesce(p_provider_reversal_ref, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_claim billing_private.payment_entitlement_claims;
  v_existing billing_private.payment_reversals;
  v_reversal billing_private.payment_reversals;
  v_customer_id uuid;
  v_original bigint;
  v_prior bigint := 0;
  v_full boolean;
  v_terminates boolean;
  v_action text := 'none';
  v_entitlement public.partner_entitlements;
  v_subscription public.subscriptions;
  v_checkout public.checkout_intents;
  v_partner billing_private.partner_purchase_intents;
  v_attempt billing_private.renewal_attempts;
  v_granted bigint := 0;
  v_clawed bigint := 0;
  v_shortfall bigint := 0;
  v_lot record;
  v_target bigint;
begin
  if p_payment_event_id is null or p_reversed_payment_event_id is null
    or v_type not in ('refund', 'chargeback', 'dispute_lost')
    or char_length(v_ref) not between 1 and 300
    or char_length(v_reason) not between 3 and 1000
    or p_reversed_amount_currency_micros is null
    or p_reversed_amount_currency_micros <= 0
  then
    raise exception 'Invalid reversal' using errcode = '22023';
  end if;
  if p_payment_event_id = p_reversed_payment_event_id then
    raise exception 'A reversal cannot reverse itself' using errcode = '22023';
  end if;

  -- Redelivery of the same reversal is a no-op, not an error.
  select reversal.* into v_existing
  from billing_private.payment_reversals as reversal
  where reversal.payment_event_id = p_payment_event_id;
  if found then
    select
      coalesce(sum(clawback.recovered_microcredits), 0),
      coalesce(sum(clawback.target_microcredits - clawback.recovered_microcredits), 0)
    into v_clawed, v_shortfall
    from billing_private.payment_reversal_clawbacks as clawback
    where clawback.payment_reversal_id = v_existing.id;

    return jsonb_build_object(
      'reversalId', v_existing.id, 'duplicate', true,
      'fullReversal', v_existing.full_reversal,
      'entitlementAction', v_existing.entitlement_action,
      'clawedBackMicrocredits', v_clawed,
      'shortfallMicrocredits', v_shortfall
    );
  end if;

  -- Which operation did the reversed payment fund? Resolved from recorded
  -- evidence, never guessed: an unclaimed payment raises.
  select claim.* into v_claim
  from billing_private.payment_entitlement_claims as claim
  where claim.payment_event_id = p_reversed_payment_event_id;
  if not found then
    raise exception 'The reversed payment funded no known entitlement'
      using errcode = '23503';
  end if;

  if v_claim.claim_type = 'partner_lifetime' then
    select intent.* into v_partner
    from billing_private.partner_purchase_intents as intent
    where intent.id = v_claim.claim_id;
    if not found then raise exception 'Partner purchase not found' using errcode = '23503'; end if;
    v_customer_id := v_partner.customer_id;
    v_original := v_partner.amount_currency_micros;
  elsif v_claim.claim_type = 'subscription_renewal' then
    select attempt.* into v_attempt
    from billing_private.renewal_attempts as attempt
    where attempt.id = v_claim.claim_id;
    if not found then raise exception 'Renewal attempt not found' using errcode = '23503'; end if;
    select subscription.customer_id into v_customer_id
    from public.subscriptions as subscription where subscription.id = v_attempt.subscription_id;
    v_original := v_attempt.amount_currency_micros;
  else
    select checkout.* into v_checkout
    from public.checkout_intents as checkout
    where checkout.id = v_claim.claim_id;
    if not found then raise exception 'Checkout intent not found' using errcode = '23503'; end if;
    v_customer_id := v_checkout.customer_id;
    v_original := v_checkout.amount_currency_micros;
  end if;

  -- LOCK ORDER: account first, then lots. Reversed here, this deadlocks
  -- against any concurrent reserve_credits or capture_credits.
  perform 1 from public.credit_accounts as account
  where account.customer_id = v_customer_id for update;

  select coalesce(sum(reversal.reversed_amount_currency_micros), 0) into v_prior
  from billing_private.payment_reversals as reversal
  where reversal.reversed_payment_event_id = p_reversed_payment_event_id;

  if v_prior + p_reversed_amount_currency_micros > v_original then
    raise exception 'Reversals would exceed the original payment' using errcode = '22003';
  end if;

  v_full := (v_prior + p_reversed_amount_currency_micros = v_original);
  -- A chargeback or a lost dispute always ends access. A partial refund does
  -- not; a refund of the whole amount does.
  v_terminates := v_type in ('chargeback', 'dispute_lost') or v_full;

  if v_terminates and v_claim.claim_type = 'partner_lifetime' then
    select entitlement.* into v_entitlement
    from public.partner_entitlements as entitlement
    where entitlement.customer_id = v_customer_id
    for update;
    if found and v_entitlement.status = 'active' then
      perform billing_private.revoke_partner_entitlement(
        v_customer_id,
        case when v_type = 'refund' then 'refunded' else 'chargeback' end,
        'Payment reversed: ' || v_type || ' ' || v_ref
      );
      v_action := 'partner_revoked';
    else
      -- Already terminal from an earlier reversal. Revoking again raises
      -- 55000 and would roll this reversal back entirely.
      v_action := 'partner_already_terminal';
    end if;
  elsif v_terminates and v_claim.claim_type in ('subscription', 'subscription_renewal') then
    select subscription.* into v_subscription
    from public.subscriptions as subscription
    where subscription.customer_id = v_customer_id
      and subscription.status not in ('canceled', 'expired')
    order by subscription.created_at desc
    limit 1
    for update;
    if found then
      update public.subscriptions
      set status = 'canceled',
          entitlement_ends_at = clock_timestamp()
      where id = v_subscription.id;
      v_action := 'subscription_canceled';
    else
      v_action := 'subscription_already_terminal';
    end if;
  end if;

  insert into billing_private.payment_reversals (
    payment_event_id, reversed_payment_event_id, provider, provider_reversal_ref,
    reversal_type, claim_type, claim_id, customer_id,
    original_amount_currency_micros, prior_reversed_amount_currency_micros,
    reversed_amount_currency_micros, full_reversal, entitlement_action, reason
  ) values (
    p_payment_event_id, p_reversed_payment_event_id, v_claim.provider, v_ref,
    v_type, v_claim.claim_type, v_claim.claim_id, v_customer_id,
    v_original, v_prior, p_reversed_amount_currency_micros, v_full, v_action, v_reason
  )
  returning * into v_reversal;

  -- Clawback, pro-rata against what was GRANTED for this operation, not
  -- against the price. Three of twelve annual instalments granted means the
  -- ratio applies to those three, so a partial refund cannot reclaim more
  -- credit than the customer ever received.
  for v_lot in
    select lot.id, lot.total_microcredits
    from public.credit_grant_lots as lot
    where (
        (v_claim.claim_type in ('subscription', 'credit_pack', 'auto_reload')
          and lot.checkout_intent_id = v_claim.claim_id)
        or (v_claim.claim_type = 'subscription_renewal'
          and lot.renewal_attempt_id = v_claim.claim_id)
      )
    order by lot.granted_at, lot.id
  loop
    v_granted := v_granted + v_lot.total_microcredits;
  end loop;

  if v_granted > 0 then
    for v_lot in
      select lot.id, lot.total_microcredits
      from public.credit_grant_lots as lot
      where (
          (v_claim.claim_type in ('subscription', 'credit_pack', 'auto_reload')
            and lot.checkout_intent_id = v_claim.claim_id)
          or (v_claim.claim_type = 'subscription_renewal'
            and lot.renewal_attempt_id = v_claim.claim_id)
        )
      order by lot.granted_at, lot.id
    loop
      v_target := case
        when v_full then v_lot.total_microcredits
        else (v_lot.total_microcredits * p_reversed_amount_currency_micros) / v_original
      end;
      v_clawed := v_clawed + billing_private.claw_back_lot_credits(
        v_reversal.id, v_lot.id, v_target
      );
    end loop;
  end if;

  select
    coalesce(sum(clawback.recovered_microcredits), 0),
    coalesce(sum(clawback.target_microcredits - clawback.recovered_microcredits), 0)
  into v_clawed, v_shortfall
  from billing_private.payment_reversal_clawbacks as clawback
  where clawback.payment_reversal_id = v_reversal.id;

  return jsonb_build_object(
    'reversalId', v_reversal.id,
    'duplicate', false,
    'fullReversal', v_full,
    'entitlementAction', v_action,
    'clawedBackMicrocredits', v_clawed,
    'shortfallMicrocredits', v_shortfall
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Reporting
-- -------------------------------------------------------------------------

-- Credit that was already spent cannot be recovered by retrying, so there is
-- deliberately no sweeper that re-attempts a shortfall for ever. A shortfall
-- is a fact for an operator to act on — a negative-balance policy, a support
-- conversation — not a job.
create or replace function billing_private.reversal_shortfalls(p_limit integer default 100)
returns table (
  reversal_id uuid,
  customer_id uuid,
  reversal_type text,
  claim_type text,
  shortfall_microcredits bigint,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    reversal.id, reversal.customer_id, reversal.reversal_type, reversal.claim_type,
    sum(clawback.target_microcredits - clawback.recovered_microcredits)::bigint,
    reversal.created_at
  from billing_private.payment_reversals as reversal
  join billing_private.payment_reversal_clawbacks as clawback
    on clawback.payment_reversal_id = reversal.id
  group by reversal.id, reversal.customer_id, reversal.reversal_type,
           reversal.claim_type, reversal.created_at
  having sum(clawback.target_microcredits - clawback.recovered_microcredits) > 0
  order by reversal.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- Extends the definition installed by 202608060002. Every alert that migration
-- carries survives; copying an older body would silently delete the checkout
-- and renewal alerts added since.
create or replace function billing_private.operational_alerts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_alerts jsonb := '[]'::jsonb;
  v_stale integer;
  v_failing integer;
  v_blocked integer;
  v_unresolved integer;
  v_unopened integer;
  v_awaiting integer;
  v_unsettled integer;
  v_shortfalls integer;
begin
  select count(*) into v_stale
  from jsonb_array_elements(billing_private.maintenance_health()) as job
  where (job->>'stale')::boolean;

  select count(*) into v_failing
  from jsonb_array_elements(billing_private.maintenance_health()) as job
  where job->>'lastError' is not null;

  select jsonb_array_length(billing_private.due_renewals_blocked(100)) into v_blocked;

  select count(*) into v_unresolved
  from billing_private.renewal_attempts
  where state = 'charging'
    and created_at < clock_timestamp() - interval '1 hour';

  select count(*) into v_unopened
  from public.checkout_intents as checkout
  where checkout.status = 'created'
    and checkout.provider_checkout_ref is null
    and checkout.created_at < clock_timestamp() - interval '26 hours';

  select count(*) into v_awaiting
  from billing_private.checkouts_awaiting_reconciliation(1000);

  select count(*) into v_unsettled
  from billing_private.renewal_attempts as attempt
  join public.subscriptions as subscription
    on subscription.id = attempt.subscription_id
  where attempt.state = 'succeeded'
    and attempt.provider_document_ref is not null
    and subscription.status not in ('canceled', 'expired')
    and not exists (
      select 1 from public.credit_grant_lots as lot
      where lot.renewal_attempt_id = attempt.id
    )
    and subscription.current_period_end is distinct from attempt.period_end
    and attempt.created_at < clock_timestamp() - interval '30 minutes';

  select count(*) into v_shortfalls
  from billing_private.reversal_shortfalls(1000) as shortfall
  where shortfall.created_at > clock_timestamp() - interval '30 days';

  if v_stale > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'critical', 'code', 'maintenance-stale', 'count', v_stale,
      'message', 'Scheduled maintenance is overdue. Credit expiry, reservation release and annual instalments are not running.');
  end if;
  if v_failing > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'critical', 'code', 'maintenance-failing', 'count', v_failing,
      'message', 'A scheduled maintenance job is failing.');
  end if;
  if v_unresolved > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'critical', 'code', 'renewal-stuck-charging', 'count', v_unresolved,
      'message', 'A renewal has been mid-charge for over an hour. Money may have moved without an entitlement.');
  end if;
  if v_unsettled > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'critical', 'code', 'renewal-unsettled', 'count', v_unsettled,
      'message', 'A renewal was charged and proved, and the customer has neither the period nor the credits.');
  end if;
  if v_blocked > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'warning', 'code', 'renewal-blocked', 'count', v_blocked,
      'message', 'Subscriptions are due to renew with no usable payment method and will lapse.');
  end if;
  if v_unopened > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'warning', 'code', 'checkout-unopened-not-swept', 'count', v_unopened,
      'message', 'Checkouts that never reached a provider are past the closure window and still hold their customer''s slot.');
  end if;
  if v_awaiting > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'warning', 'code', 'checkout-awaiting-reconciliation', 'count', v_awaiting,
      'message', 'Hosted checkout sessions went quiet and need provider reconciliation. Each one blocks that customer from subscribing again.');
  end if;
  if v_shortfalls > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'warning', 'code', 'reversal-shortfall', 'count', v_shortfalls,
      'message', 'A payment was reversed and the credit it bought had already been spent. Recovery is not automatic.');
  end if;

  return v_alerts;
end;
$$;

-- -------------------------------------------------------------------------
-- Privileges
-- -------------------------------------------------------------------------

revoke all on function billing_private.claw_back_lot_credits(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function billing_private.reconcile_payment_reversal(
  uuid, uuid, text, text, bigint, text
) from public, anon, authenticated;
revoke all on function billing_private.reversal_shortfalls(integer)
  from public, anon, authenticated;

commit;
