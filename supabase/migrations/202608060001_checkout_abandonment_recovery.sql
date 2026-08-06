begin;

-- Checkout abandonment recovery.
--
-- `checkout_intents_one_payable_subscription_per_customer` keeps one payable
-- subscription intent per customer across the statuses
-- ('created', 'open', 'expired', 'cancelled', 'failed'). Only 'completed' and
-- 'reconciled_no_payment' sit outside it, and reaching either requires evidence
-- 202607150001 deliberately refuses to invent. Nothing moves an intent toward
-- them, so `expires_at` is written on every insert and never read.
--
-- The result is that a customer who closes the tab is blocked from subscribing
-- forever, not for the thirty minutes the timestamp implies.
-- `operational_alerts()` already names this: "Each one blocks that customer
-- from subscribing again until reconciled."
--
-- The instinct is a timeout sweeper. 202607150004 rejects that in writing —
-- "Do not infer that a hosted session is unpayable from a local clock" — and it
-- is right: a hosted session the customer can still pay must keep its slot, or
-- a second checkout gets opened and the customer is charged twice.
--
-- But that argument only covers intents a provider has actually seen. The
-- insert in `easyfield_account_prepare_checkout` writes status 'created' with
-- `provider_checkout_ref` and `checkout_url` both null;
-- `easyfield_account_open_checkout` is the only writer of either, and it sets
-- them in the same statement that moves the row to 'open'. So an aged 'created'
-- row with both columns still null proves that no hosted session was ever
-- created — there is nothing a provider could later report as paid, and closing
-- it locally invents nothing.
--
-- That splits abandonment into two honest cases:
--
--   never opened   Local fact, provable from this database alone. Closed here,
--                  automatically, releasing the customer's slot.
--   opened         A hosted session exists. Marked 'expired' so it stops
--                  looking healthy and enters a reconciliation queue, but it
--                  keeps its slot until the provider says what happened.
--
-- The second case is the seam the payment provider plugs into. Everything
-- around it is finished here.

-- -------------------------------------------------------------------------
-- Partner intents gain the same terminal state
-- -------------------------------------------------------------------------

-- `partner_purchase_intents` carries the identical one-payable index and the
-- identical deadlock, but has no 'reconciled_no_payment' state at all, so it
-- has no exit even with evidence in hand.
alter table billing_private.partner_purchase_intents
  drop constraint partner_purchase_intents_status_check;
alter table billing_private.partner_purchase_intents
  add constraint partner_purchase_intents_status_check check (
    status in (
      'created', 'open', 'completed', 'expired', 'cancelled', 'failed',
      'reconciled_no_payment'
    )
  );

create table billing_private.partner_no_payment_reconciliations (
  id uuid primary key default gen_random_uuid(),
  partner_purchase_intent_id uuid not null unique
    references billing_private.partner_purchase_intents(id) on delete restrict,
  provider text not null
    check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_reconciliation_ref text not null
    check (char_length(provider_reconciliation_ref) between 1 and 500),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  actor_ref text not null check (char_length(actor_ref) between 3 and 200),
  reason text not null check (char_length(reason) between 3 and 1000),
  reconciled_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_reconciliation_ref)
);

create trigger partner_no_payment_reconciliations_are_immutable
before update or delete on billing_private.partner_no_payment_reconciliations
for each row execute function billing_private.reject_immutable_mutation();

alter table billing_private.partner_no_payment_reconciliations enable row level security;
alter table billing_private.partner_no_payment_reconciliations force row level security;

-- The existing guard refuses every transition out of a closed partner state
-- except 'completed'. Widen it by exactly one edge — to 'reconciled_no_payment'
-- and only with recorded evidence — leaving every other refusal in place.
create or replace function billing_private.apply_partner_purchase_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer billing_private.partner_offer_catalog;
begin
  if tg_op = 'INSERT' then
    select offer.* into v_offer
    from billing_private.partner_offer_catalog as offer
    where offer.offer_key = new.offer_key and offer.active;
    if not found then
      raise exception 'Partner offer is not available' using errcode = '55000';
    end if;
    new.pricing_version := v_offer.pricing_version;
    new.currency_code := v_offer.currency_code;
    new.amount_currency_micros := v_offer.one_time_price_currency_micros;
    new.included_microcredits := v_offer.included_microcredits;
    new.lifetime_access := v_offer.lifetime_access;
    new.all_model_access := v_offer.all_model_access;
    new.raw_provider_pricing_access := v_offer.raw_provider_pricing_access;
    new.direct_provider_billing := v_offer.direct_provider_billing;
    return new;
  end if;

  if (to_jsonb(new) - array[
      'provider_checkout_ref', 'checkout_url', 'status', 'expires_at',
      'completed_payment_event_id', 'provider_payment_ref', 'completed_at', 'updated_at'
    ]) is distinct from (to_jsonb(old) - array[
      'provider_checkout_ref', 'checkout_url', 'status', 'expires_at',
      'completed_payment_event_id', 'provider_payment_ref', 'completed_at', 'updated_at'
    ])
  then
    raise exception 'Partner purchase identity, price and capabilities are immutable'
      using errcode = '55000';
  end if;

  if old.status in ('completed', 'reconciled_no_payment')
    and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
  then
    raise exception 'A verified partner purchase is terminal' using errcode = '55000';
  end if;

  if old.status in ('expired', 'cancelled', 'failed')
    and new.status is distinct from old.status
    and new.status <> 'completed'
  then
    if not (
      new.status = 'reconciled_no_payment'
      and exists (
        select 1
        from billing_private.partner_no_payment_reconciliations as reconciliation
        where reconciliation.partner_purchase_intent_id = new.id
          and reconciliation.provider = new.provider
      )
    ) then
      raise exception 'A closed partner purchase cannot be reopened' using errcode = '55000';
    end if;
  end if;

  if new.status = 'created' and old.status <> 'created' then
    raise exception 'A partner purchase cannot return to created' using errcode = '55000';
  end if;
  if new.status in ('open', 'completed') and (
    new.provider_checkout_ref is null or new.checkout_url is null
  ) then
    raise exception 'An open partner purchase requires its hosted checkout identity'
      using errcode = '22023';
  end if;
  if new.status = 'completed' and not billing_private.checkout_payment_event_is_verified(
    new.id,
    new.provider,
    new.completed_payment_event_id,
    new.provider_payment_ref,
    new.amount_currency_micros,
    new.currency_code
  ) then
    raise exception 'Partner entitlement payment does not reconcile' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function billing_private.reconcile_partner_without_payment(
  p_partner_purchase_intent_id uuid,
  p_provider_reconciliation_ref text,
  p_evidence_sha256 text,
  p_actor_ref text,
  p_reason text
)
returns billing_private.partner_purchase_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent billing_private.partner_purchase_intents;
begin
  if p_partner_purchase_intent_id is null
    or char_length(btrim(coalesce(p_provider_reconciliation_ref, ''))) not between 1 and 500
    or coalesce(p_evidence_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_actor_ref, ''))) not between 3 and 200
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000
  then
    raise exception 'Valid no-payment reconciliation evidence is required'
      using errcode = '22023';
  end if;

  select intent.* into v_intent
  from billing_private.partner_purchase_intents as intent
  where intent.id = p_partner_purchase_intent_id
  for update;

  if not found then
    raise exception 'Partner purchase intent not found' using errcode = '23503';
  end if;
  if v_intent.status not in ('failed', 'expired', 'cancelled')
    or v_intent.completed_payment_event_id is not null
    or v_intent.provider_payment_ref is not null
  then
    raise exception 'Only an unpaid closed partner purchase can be reconciled without payment'
      using errcode = '55000';
  end if;

  insert into billing_private.partner_no_payment_reconciliations (
    partner_purchase_intent_id, provider, provider_reconciliation_ref,
    evidence_sha256, actor_ref, reason
  ) values (
    v_intent.id, v_intent.provider, btrim(p_provider_reconciliation_ref),
    p_evidence_sha256, btrim(p_actor_ref), btrim(p_reason)
  );

  update billing_private.partner_purchase_intents
  set status = 'reconciled_no_payment'
  where id = v_intent.id
  returning * into v_intent;

  return v_intent;
end;
$$;

-- -------------------------------------------------------------------------
-- Local closure evidence
-- -------------------------------------------------------------------------

-- Deliberately not `checkout_no_payment_reconciliations`. That table means "a
-- provider stated this was not paid" and every row carries a provider
-- reference. These rows mean something weaker and different: "this database
-- can see that no hosted session was ever created". Recording them in the same
-- table would let a local inference be read later as merchant evidence.
create table billing_private.unopened_checkout_closures (
  id uuid primary key default gen_random_uuid(),
  checkout_intent_id uuid unique
    references public.checkout_intents(id) on delete restrict,
  partner_purchase_intent_id uuid unique
    references billing_private.partner_purchase_intents(id) on delete restrict,
  provider text not null
    check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  intent_created_at timestamptz not null,
  intent_age interval not null check (intent_age > interval '0'),
  closed_at timestamptz not null default clock_timestamp(),
  -- Exactly one subject, so a closure can never be attributed to both ledgers.
  check (num_nonnulls(checkout_intent_id, partner_purchase_intent_id) = 1)
);

create trigger unopened_checkout_closures_are_immutable
before update or delete on billing_private.unopened_checkout_closures
for each row execute function billing_private.reject_immutable_mutation();

alter table billing_private.unopened_checkout_closures enable row level security;
alter table billing_private.unopened_checkout_closures force row level security;

create index unopened_checkout_closures_recent
  on billing_private.unopened_checkout_closures (closed_at desc);

-- -------------------------------------------------------------------------
-- Close what was never opened
-- -------------------------------------------------------------------------

-- `p_min_age` is not the customer-facing 30-minute expiry. It is the window in
-- which `easyfield_account_open_checkout` could still legitimately be in
-- flight: the provider has created a session and this database has not been
-- told yet. Closing inside that window could orphan a real payable session, so
-- the default is a full day — orders of magnitude beyond any hosted-session
-- creation, and still far better than never.
create or replace function billing_private.close_unopened_checkouts(
  p_limit integer default 500,
  p_min_age interval default interval '24 hours'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 10000);
  v_min_age interval := greatest(coalesce(p_min_age, interval '24 hours'), interval '1 hour');
  v_cutoff timestamptz := clock_timestamp() - v_min_age;
  v_closed bigint := 0;
  v_row record;
begin
  for v_row in
    select checkout.id, checkout.provider, checkout.created_at
    from public.checkout_intents as checkout
    where checkout.status = 'created'
      and checkout.provider_checkout_ref is null
      and checkout.checkout_url is null
      and checkout.completed_payment_event_id is null
      and checkout.provider_payment_ref is null
      and checkout.created_at < v_cutoff
    order by checkout.created_at
    limit v_limit
    for update skip locked
  loop
    insert into billing_private.unopened_checkout_closures (
      checkout_intent_id, provider, intent_created_at, intent_age
    ) values (
      v_row.id, v_row.provider, v_row.created_at, clock_timestamp() - v_row.created_at
    );

    update public.checkout_intents
    set status = 'reconciled_no_payment'
    where id = v_row.id;

    v_closed := v_closed + 1;
  end loop;

  for v_row in
    select intent.id, intent.provider, intent.created_at
    from billing_private.partner_purchase_intents as intent
    where intent.status = 'created'
      and intent.provider_checkout_ref is null
      and intent.checkout_url is null
      and intent.completed_payment_event_id is null
      and intent.provider_payment_ref is null
      and intent.created_at < v_cutoff
    order by intent.created_at
    limit v_limit
    for update skip locked
  loop
    insert into billing_private.unopened_checkout_closures (
      partner_purchase_intent_id, provider, intent_created_at, intent_age
    ) values (
      v_row.id, v_row.provider, v_row.created_at, clock_timestamp() - v_row.created_at
    );

    update billing_private.partner_purchase_intents
    set status = 'reconciled_no_payment'
    where id = v_row.id;

    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;

-- -------------------------------------------------------------------------
-- Mark what was opened and went quiet
-- -------------------------------------------------------------------------

-- This does NOT release the customer's slot, and must not: a hosted session
-- exists and only its provider can say whether it was paid. 'expired' is the
-- honest name for what is known — the stated window has passed — and it moves
-- the row into the state from which `reconcile_checkout_without_payment` can
-- accept provider evidence. Until then the row is queued, not resolved.
create or replace function billing_private.expire_stale_open_checkouts(
  p_limit integer default 500,
  p_grace interval default interval '1 hour'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 10000);
  v_grace interval := greatest(coalesce(p_grace, interval '1 hour'), interval '5 minutes');
  v_cutoff timestamptz := clock_timestamp() - v_grace;
  v_expired bigint := 0;
  v_row record;
begin
  for v_row in
    select checkout.id
    from public.checkout_intents as checkout
    where checkout.status = 'open'
      and checkout.expires_at is not null
      and checkout.expires_at < v_cutoff
      and checkout.completed_payment_event_id is null
      and checkout.provider_payment_ref is null
    order by checkout.expires_at
    limit v_limit
    for update skip locked
  loop
    update public.checkout_intents set status = 'expired' where id = v_row.id;
    v_expired := v_expired + 1;
  end loop;

  for v_row in
    select intent.id
    from billing_private.partner_purchase_intents as intent
    where intent.status = 'open'
      and intent.expires_at < v_cutoff
      and intent.completed_payment_event_id is null
      and intent.provider_payment_ref is null
    order by intent.expires_at
    limit v_limit
    for update skip locked
  loop
    update billing_private.partner_purchase_intents set status = 'expired' where id = v_row.id;
    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end;
$$;

-- -------------------------------------------------------------------------
-- The provider seam
-- -------------------------------------------------------------------------

-- The queue a payment-provider adapter drains. It returns the provider name and
-- the provider's own session reference and nothing else about the customer,
-- because answering "was this session paid?" needs nothing else.
--
-- For each row the adapter asks its provider and then calls exactly one of:
--   paid     -> the existing verified-payment reconciliation path, which
--               requires a signed payment event
--   not paid -> billing_private.reconcile_checkout_without_payment(...) or
--               billing_private.reconcile_partner_without_payment(...) with the
--               provider's reconciliation reference and evidence digest
--
-- This function is the entire remaining dependency on the payment provider for
-- checkout abandonment. Nothing else here waits on that decision.
create or replace function billing_private.checkouts_awaiting_reconciliation(
  p_limit integer default 100
)
returns table (
  subject text,
  intent_id uuid,
  provider text,
  provider_checkout_ref text,
  status text,
  expires_at timestamptz,
  stale_for interval
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    'checkout'::text,
    checkout.id,
    checkout.provider,
    checkout.provider_checkout_ref,
    checkout.status,
    checkout.expires_at,
    clock_timestamp() - checkout.expires_at
  from public.checkout_intents as checkout
  where checkout.status in ('expired', 'cancelled', 'failed')
    and checkout.provider_checkout_ref is not null
    and checkout.completed_payment_event_id is null
    and not exists (
      select 1
      from billing_private.checkout_no_payment_reconciliations as done
      where done.checkout_intent_id = checkout.id
    )
  union all
  select
    'partner'::text,
    intent.id,
    intent.provider,
    intent.provider_checkout_ref,
    intent.status,
    intent.expires_at,
    clock_timestamp() - intent.expires_at
  from billing_private.partner_purchase_intents as intent
  where intent.status in ('expired', 'cancelled', 'failed')
    and intent.provider_checkout_ref is not null
    and intent.completed_payment_event_id is null
    and not exists (
      select 1
      from billing_private.partner_no_payment_reconciliations as done
      where done.partner_purchase_intent_id = intent.id
    )
  order by 7 desc
  limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

-- -------------------------------------------------------------------------
-- Scheduling
-- -------------------------------------------------------------------------

create or replace function billing_private.run_maintenance(
  p_job text,
  p_limit integer default 1000
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id bigint;
  v_count bigint := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 10000);
  v_result jsonb;
begin
  if p_job not in (
    'expire_credit_reservations',
    'expire_credit_lots',
    'grant_due_annual_plan_credits',
    'sweep_due_renewals',
    'close_unopened_checkouts',
    'expire_stale_open_checkouts'
  ) then
    raise exception 'Unknown maintenance job %', p_job using errcode = '22023';
  end if;

  insert into billing_private.maintenance_runs (job_name)
  values (p_job)
  returning id into v_run_id;

  begin
    if p_job = 'expire_credit_reservations' then
      select count(*) into v_count from billing_private.expire_credit_reservations(v_limit);
    elsif p_job = 'expire_credit_lots' then
      select count(*) into v_count from billing_private.expire_credit_lots(v_limit);
    elsif p_job = 'grant_due_annual_plan_credits' then
      select count(*) into v_count from billing_private.grant_due_annual_plan_credits(v_limit);
    elsif p_job = 'close_unopened_checkouts' then
      v_count := billing_private.close_unopened_checkouts(v_limit);
    elsif p_job = 'expire_stale_open_checkouts' then
      v_count := billing_private.expire_stale_open_checkouts(v_limit);
    else
      v_result := billing_private.sweep_due_renewals(v_limit);
      v_count := (v_result->>'enqueued')::bigint;
    end if;

    update billing_private.maintenance_runs
    set finished_at = clock_timestamp(), processed_count = v_count
    where id = v_run_id;
  exception when others then
    update billing_private.maintenance_runs
    set finished_at = clock_timestamp(), error_text = left(sqlstate || ': ' || sqlerrm, 2000)
    where id = v_run_id;
    v_count := -1;
  end;

  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'easyfield-close-unopened-checkouts') then
    perform cron.unschedule('easyfield-close-unopened-checkouts');
  end if;
  if exists (select 1 from cron.job where jobname = 'easyfield-expire-stale-open-checkouts') then
    perform cron.unschedule('easyfield-expire-stale-open-checkouts');
  end if;
end $$;

-- Hourly is ample for both. Neither races a customer: the local closure only
-- touches intents already a day old, and expiry only annotates a row whose
-- stated window has passed.
select cron.schedule(
  'easyfield-close-unopened-checkouts',
  '7 * * * *',
  $job$select billing_private.run_maintenance('close_unopened_checkouts', 500)$job$
);

select cron.schedule(
  'easyfield-expire-stale-open-checkouts',
  '22 * * * *',
  $job$select billing_private.run_maintenance('expire_stale_open_checkouts', 500)$job$
);

-- -------------------------------------------------------------------------
-- Alerting
-- -------------------------------------------------------------------------

-- The existing 'checkout-abandoned' alert counted every checkout open for over
-- a day as one undifferentiated problem needing a human. Most of those now
-- resolve themselves within the hour, and the ones that do not are a specific,
-- actionable queue. Splitting them stops a self-healing case from reading as an
-- incident, and stops the real one from hiding inside it.
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

  -- Already past the closure window the hourly sweeper enforces.
  select count(*) into v_unopened
  from public.checkout_intents as checkout
  where checkout.status = 'created'
    and checkout.provider_checkout_ref is null
    and checkout.created_at < clock_timestamp() - interval '26 hours';

  select count(*) into v_awaiting
  from billing_private.checkouts_awaiting_reconciliation(1000);

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
  if v_blocked > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'warning', 'code', 'renewal-blocked', 'count', v_blocked,
      'message', 'Subscriptions are due to renew with no usable payment method and will lapse.');
  end if;
  -- Past its own grace period, so the hourly sweeper should already have taken
  -- it. Still present means the sweeper is not doing its job.
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

  return v_alerts;
end;
$$;

-- -------------------------------------------------------------------------
-- Privileges
-- -------------------------------------------------------------------------

revoke all on function billing_private.close_unopened_checkouts(integer, interval)
  from public, anon, authenticated;
revoke all on function billing_private.expire_stale_open_checkouts(integer, interval)
  from public, anon, authenticated;
revoke all on function billing_private.checkouts_awaiting_reconciliation(integer)
  from public, anon, authenticated;
revoke all on function billing_private.reconcile_partner_without_payment(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function billing_private.reconcile_partner_without_payment(
  uuid, text, text, text, text
) to service_role;

commit;
