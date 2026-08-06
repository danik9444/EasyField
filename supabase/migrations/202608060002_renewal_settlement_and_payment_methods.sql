begin;

-- Renewal settlement, and the payment method a renewal needs to exist at all.
--
-- Three defects, one consequence: a subscription can be sold but never renewed.
--
--   1. `billing_private.saved_payment_methods` has a service_role INSERT grant
--      (202607140001:3748) and no INSERT anywhere in the repository. Every gate
--      downstream reads from it: `sweep_due_renewals` requires
--      `saved_payment_method_id is not null` (202607290006:49),
--      `create_renewal_attempt` raises 42501 without one (202607140001:2905),
--      and `easyfield_account_set_auto_reload` refuses for the same reason
--      (202607150004:295). The reconciliation INSERT into `public.subscriptions`
--      (202607150005:424-460) never sets the column, so a paying customer's
--      subscription is born un-renewable and auto-reload is unreachable.
--
--   2. `finish_renewal_attempt` (202607140001:2986-3045) writes five outcome
--      columns and nothing else. It never advances `current_period_end` — the
--      only writers of that column in the entire schema are the first-purchase
--      paths — and never calls `grant_credits`. A successful renewal charge
--      therefore records a provider document reference while the customer's
--      access lapses and no credits arrive.
--
--   3. The renewal path was fully designed and then never wired.
--      `credit_grant_lots.renewal_attempt_id` with its unique key and
--      `credit_grant_lots_paid_source_shape`, the renewal branch inside
--      `grant_credits` (202607140001:1844-1866) with its
--      `'paid:renewal:' || attempt_id` idempotency key, the renewal branch of
--      `annual_subscription_paid_source_is_valid` (806-822), and
--      `subscriptions.annual_renewal_attempt_id` all exist and have no caller.
--      This migration supplies the caller rather than inventing a mechanism.
--
-- ORDERING IS LOAD-BEARING, IN TWO PLACES.
--
-- (a) The period must advance BEFORE credits are granted. `grant_credits`
--     validates `current_period_start = p_granted_at` and
--     `current_period_end = p_expires_at` against the subscription row it reads
--     (202607140001:1904-1913). Granting first fails; there is no ordering in
--     which both succeed except period-then-grant.
--
-- (b) LOCK ORDER. `grant_due_annual_plan_credits` runs every minute and states
--     its order at 202607140001:2782 — "subscription -> schedule -> customer ->
--     account". Customer is locked AFTER subscription. Any renewal path that
--     locked `billing_customers` first would deadlock against that job the
--     moment an annual instalment came due, and on the webhook path a deadlock
--     aborts the subtransaction and files a *paid* event as `failed`. So this
--     migration locks subscriptions -> renewal_attempts and lets `grant_credits`
--     reach customer and account beneath, matching the deployed job exactly.
--     `finish_renewal_attempt` is rewritten for the same reason: its deployed
--     body takes the attempt lock first, which inverts against settle.
--
-- WHO OWNS THE TERMINAL WRITE. The renewal worker does, not the webhook. Both
-- could finish a `charging` attempt, and if the webhook won the race with the
-- provider's event id while the worker held the adapter's own document id,
-- `finish_renewal_attempt` would raise 'Renewal result retry has different
-- inputs' (22000) on a renewal that had in fact settled correctly. Rather than
-- teach two writers to agree, only one writes. A renewal payment event that
-- arrives anyway is left for the operator queue, and `settle_succeeded_renewals`
-- below repairs any attempt that reached 'succeeded' without settling.

-- -------------------------------------------------------------------------
-- The global one-payment-one-operation anchor learns about renewals
-- -------------------------------------------------------------------------

-- `payment_entitlement_claims` (202607150003:59-70) is the only cross-table
-- guarantee that one payment funds one operation, and its CHECK predates
-- renewals. Constraint DDL does not fire the row-level immutability trigger.
alter table billing_private.payment_entitlement_claims
  drop constraint payment_entitlement_claims_claim_type_check;
alter table billing_private.payment_entitlement_claims
  add constraint payment_entitlement_claims_claim_type_check check (
    claim_type in (
      'subscription', 'credit_pack', 'auto_reload',
      'partner_lifetime', 'subscription_renewal'
    )
  );

-- -------------------------------------------------------------------------
-- A saved payment method can finally be written
-- -------------------------------------------------------------------------

create or replace function billing_private.register_saved_payment_method(
  p_customer_id uuid,
  p_provider text,
  p_provider_payment_method_ref text,
  p_display_name text,
  p_last_four text,
  p_expiry_month integer,
  p_expiry_year integer,
  p_status text,
  p_supported_currencies text[]
)
returns billing_private.saved_payment_methods
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_ref text := btrim(coalesce(p_provider_payment_method_ref, ''));
  v_name text := btrim(coalesce(p_display_name, ''));
  v_status text := lower(btrim(coalesce(p_status, 'active')));
  v_currencies text[] := coalesce(p_supported_currencies, '{}'::text[]);
  v_existing billing_private.saved_payment_methods;
  v_method billing_private.saved_payment_methods;
begin
  if p_customer_id is null
    or char_length(v_provider) not between 2 and 40
    or char_length(v_ref) not between 1 and 500
    or char_length(v_name) not between 1 and 120
    or coalesce(p_last_four, '') !~ '^[0-9]{4}$'
    or v_status not in ('active', 'inactive', 'expired', 'unknown')
    or (p_expiry_month is null) <> (p_expiry_year is null)
    or (p_expiry_month is not null and p_expiry_month not between 1 and 12)
    or (p_expiry_year is not null and p_expiry_year not between 2000 and 9999)
    or coalesce(array_length(v_currencies, 1), 0) not between 1 and 20
    or array_position(v_currencies, null) is not null
    or exists (select 1 from unnest(v_currencies) as code where code !~ '^[A-Z]{3}$')
  then
    raise exception 'Invalid saved payment method' using errcode = '22023';
  end if;

  -- A vault token is a claim about a relationship with a provider, and this
  -- database does not take such a claim on trust. Refuse unless this customer
  -- has actually completed a payment with the same provider.
  if not exists (
    select 1 from public.checkout_intents as checkout
    where checkout.customer_id = p_customer_id
      and checkout.provider = v_provider
      and checkout.status = 'completed'
  ) and not exists (
    select 1 from billing_private.partner_purchase_intents as partner
    where partner.customer_id = p_customer_id
      and partner.provider = v_provider
      and partner.status = 'completed'
  ) then
    raise exception 'A saved payment method requires a completed payment with the same provider'
      using errcode = '42501';
  end if;

  perform 1 from public.billing_customers as customer
  where customer.id = p_customer_id for update;
  if not found then
    raise exception 'Billing customer not found' using errcode = '23503';
  end if;

  select method.* into v_existing
  from billing_private.saved_payment_methods as method
  where method.provider = v_provider and method.provider_payment_method_ref = v_ref
  for update;

  -- Re-pointing a vault token at a different customer would let one account's
  -- card fund another's renewal.
  if found and v_existing.customer_id <> p_customer_id then
    raise exception 'Saved payment method belongs to another customer' using errcode = '42501';
  end if;

  insert into billing_private.saved_payment_methods (
    customer_id, provider, provider_payment_method_ref, display_name,
    last_four, expiry_month, expiry_year, status, supported_currencies
  ) values (
    p_customer_id, v_provider, v_ref, v_name,
    p_last_four, p_expiry_month, p_expiry_year, v_status, v_currencies
  )
  on conflict (provider, provider_payment_method_ref) do update
  set display_name = excluded.display_name,
      last_four = excluded.last_four,
      expiry_month = excluded.expiry_month,
      expiry_year = excluded.expiry_year,
      status = excluded.status,
      supported_currencies = excluded.supported_currencies
  returning * into v_method;

  return v_method;
end;
$$;

-- Neither wrapper ever returns provider_payment_method_ref. The vault token is
-- the credential; it stays server-side.
create or replace function public.easyfield_account_register_payment_method(
  p_user_id uuid,
  p_provider text,
  p_provider_payment_method_ref text,
  p_display_name text,
  p_last_four text,
  p_expiry_month integer default null,
  p_expiry_year integer default null,
  p_status text default 'active',
  p_supported_currencies text[] default array['USD']::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_method billing_private.saved_payment_methods;
begin
  if p_user_id is null then
    raise exception 'Invalid account' using errcode = '22023';
  end if;
  select account.out_customer_id into v_customer_id
  from billing_private.ensure_billing_account(p_user_id) as account;

  v_method := billing_private.register_saved_payment_method(
    v_customer_id, p_provider, p_provider_payment_method_ref, p_display_name,
    p_last_four, p_expiry_month, p_expiry_year, p_status, p_supported_currencies
  );

  return jsonb_build_object(
    'savedPaymentMethodId', v_method.id,
    'displayName', v_method.display_name,
    'lastFour', v_method.last_four,
    'expiryMonth', v_method.expiry_month,
    'expiryYear', v_method.expiry_year,
    'status', v_method.status,
    'supportedCurrencies', to_jsonb(v_method.supported_currencies)
  );
end;
$$;

create or replace function public.easyfield_account_select_subscription_payment_method(
  p_user_id uuid,
  p_saved_payment_method_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_subscription public.subscriptions;
  v_method billing_private.saved_payment_methods;
begin
  if p_user_id is null then
    raise exception 'Invalid account' using errcode = '22023';
  end if;
  select account.out_customer_id into v_customer_id
  from billing_private.ensure_billing_account(p_user_id) as account;

  select subscription.* into v_subscription
  from public.subscriptions as subscription
  where subscription.customer_id = v_customer_id
    and subscription.status not in ('canceled', 'expired')
  order by subscription.created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'No renewable subscription' using errcode = '23503';
  end if;

  if p_saved_payment_method_id is null then
    update public.subscriptions
    set saved_payment_method_id = null
    where id = v_subscription.id;
    return jsonb_build_object(
      'subscriptionId', v_subscription.id,
      'savedPaymentMethodId', null,
      'renewalEnabled', false
    );
  end if;

  select method.* into v_method
  from billing_private.saved_payment_methods as method
  where method.id = p_saved_payment_method_id
    and method.customer_id = v_customer_id
    and method.status = 'active'
  for update;
  if not found then
    raise exception 'Saved payment method is not usable for this subscription'
      using errcode = '42501';
  end if;

  -- The same predicate create_renewal_attempt enforces (202607140001:2914).
  -- Failing here means the customer learns now, not at renewal time.
  if not (v_subscription.currency_code = any(v_method.supported_currencies)) then
    raise exception 'Saved payment method does not support the subscription currency'
      using errcode = '42501';
  end if;

  update public.subscriptions
  set saved_payment_method_id = v_method.id
  where id = v_subscription.id;

  return jsonb_build_object(
    'subscriptionId', v_subscription.id,
    'savedPaymentMethodId', v_method.id,
    'renewalEnabled', true
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Settlement: the one place a renewal becomes an entitlement
-- -------------------------------------------------------------------------

-- Safe to call any number of times, by any caller, in any order. It never
-- infers that money moved; it requires the evidence standard the schema already
-- chose for renewals (202607140001:1847-1856, 809-821).
create or replace function billing_private.settle_renewal_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt billing_private.renewal_attempts;
  v_subscription public.subscriptions;
  v_subscription_id uuid;
  v_user_id uuid;
  v_lot public.credit_grant_lots;
  v_already_granted boolean := false;
  v_period_advanced boolean := false;
  v_granted bigint := 0;
begin
  if p_attempt_id is null then
    raise exception 'Renewal attempt is required' using errcode = '22023';
  end if;

  -- Unlocked probe purely to learn the lock target, so the locks below can be
  -- taken in the canonical subscription-first order.
  select attempt.subscription_id into v_subscription_id
  from billing_private.renewal_attempts as attempt
  where attempt.id = p_attempt_id;
  if not found then
    raise exception 'Renewal attempt not found' using errcode = '23503';
  end if;

  select subscription.* into v_subscription
  from public.subscriptions as subscription
  where subscription.id = v_subscription_id
  for update;
  if not found then
    raise exception 'Renewal subscription not found' using errcode = '23503';
  end if;

  select attempt.* into v_attempt
  from billing_private.renewal_attempts as attempt
  where attempt.id = p_attempt_id
  for update;

  if v_attempt.state <> 'succeeded' or v_attempt.provider_document_ref is null then
    raise exception 'Only a succeeded renewal with provider evidence may settle'
      using errcode = '55000';
  end if;

  if v_subscription.status in ('canceled', 'expired') then
    raise exception 'A terminal subscription cannot be settled; refund the renewal'
      using errcode = '55000';
  end if;

  if v_subscription.current_period_start is not distinct from v_attempt.period_start
    and v_subscription.current_period_end is not distinct from v_attempt.period_end
  then
    v_period_advanced := false;
  elsif v_subscription.current_period_start >= v_attempt.period_end then
    -- A later paid period already superseded this one.
    v_period_advanced := false;
  elsif v_subscription.current_period_end is not distinct from v_attempt.period_start then
    update public.subscriptions
    set
      -- Only 'trialing' is promoted. Overwriting 'past_due' or 'paused' here
      -- would silently clear a delinquency this function did not resolve.
      status = case when v_subscription.status = 'trialing' then 'active' else v_subscription.status end,
      current_period_start = v_attempt.period_start,
      current_period_end = v_attempt.period_end,
      entitlement_ends_at = v_attempt.period_end,
      -- Both period columns and both annual paid-source columns must move in
      -- ONE statement (apply_subscription_catalog_snapshot, 202607140001:1053).
      annual_checkout_intent_id = null,
      annual_renewal_attempt_id =
        case when v_subscription.billing_interval = 'annual' then v_attempt.id else null end
    where id = v_subscription.id
    returning * into v_subscription;
    v_period_advanced := true;
  else
    raise exception 'Renewal period does not continue the subscription period'
      using errcode = '55000';
  end if;

  select customer.user_id into v_user_id
  from public.billing_customers as customer
  where customer.id = v_subscription.customer_id;

  if v_subscription.billing_interval = 'monthly' then
    select lot.* into v_lot
    from public.credit_grant_lots as lot
    where lot.renewal_attempt_id = v_attempt.id;
    v_already_granted := found;

    -- The metadata argument must be byte-identical across every caller:
    -- grant_credits folds it into request_sha256 (202607140001:1874-1885) and
    -- raises 22000 if two callers disagree. No timestamp, no event id.
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
    -- grant_credits hard-refuses an annual subscription on the 'subscription'
    -- source path (202607140001:1908). An annual renewal buys twelve monthly
    -- instalments instead, and deliberately does not materialise the first one
    -- inline: sweep_due_renewals runs with a one-day lead, so scheduled_for can
    -- be in the future and grant_due_annual_plan_credits correctly refuses it.
    -- The already-scheduled cron materialises it the minute it falls due.
    perform billing_private.schedule_annual_plan_grants(
      v_subscription.id,
      v_attempt.period_start,
      v_subscription.included_microcredits_per_grant,
      12,
      interval '1 month'
    );
    v_granted := 0;
  end if;

  return jsonb_build_object(
    'renewalAttemptId', v_attempt.id,
    'subscriptionId', v_subscription.id,
    'billingInterval', v_subscription.billing_interval,
    'periodAdvanced', v_period_advanced,
    'grantedMicrocredits', v_granted,
    'currentPeriodEnd', to_jsonb(v_subscription.current_period_end)
  );
end;
$$;

-- -------------------------------------------------------------------------
-- finish_renewal_attempt now settles in the same transaction
-- -------------------------------------------------------------------------

-- Identical signature, so every existing caller and grant is unaffected. Two
-- changes to the deployed body (202607140001:2986-3045): the lock order is
-- subscription-first so it cannot invert against settle, and a success settles
-- before returning. Every validation and error message is preserved.
--
-- A settle failure PROPAGATES. finish and settle share one transaction, so the
-- attempt rolls back to 'charging' and the worker may safely call finish again
-- with the same inputs. Swallowing it would produce precisely the "money moved,
-- entitlement did not" state the rest of this schema exists to prevent.
create or replace function billing_private.finish_renewal_attempt(
  p_attempt_id uuid,
  p_claim_id uuid,
  p_result_state text,
  p_provider_document_ref text default null,
  p_provider_transaction_ref text default null,
  p_provider_status integer default null,
  p_failure_reason text default null
)
returns billing_private.renewal_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt billing_private.renewal_attempts;
  v_subscription_id uuid;
  v_document_ref text := nullif(btrim(p_provider_document_ref), '');
  v_transaction_ref text := nullif(btrim(p_provider_transaction_ref), '');
  v_reason text := nullif(btrim(p_failure_reason), '');
begin
  if p_claim_id is null or p_result_state is null
    or p_result_state not in ('succeeded', 'failed', 'unknown')
    or (p_result_state = 'succeeded' and v_document_ref is null)
    or (p_result_state in ('failed', 'unknown') and v_reason is null)
    or char_length(coalesce(v_document_ref, '')) > 500
    or char_length(coalesce(v_transaction_ref, '')) > 500
    or char_length(coalesce(v_reason, '')) > 2000
  then
    raise exception 'Invalid renewal result' using errcode = '22023';
  end if;

  select attempt.subscription_id into v_subscription_id
  from billing_private.renewal_attempts as attempt
  where attempt.id = p_attempt_id;
  if not found then
    raise exception 'Renewal attempt not found' using errcode = '23503';
  end if;

  perform 1 from public.subscriptions as subscription
  where subscription.id = v_subscription_id for update;

  select * into v_attempt from billing_private.renewal_attempts
  where id = p_attempt_id for update;
  if not found then
    raise exception 'Renewal attempt not found' using errcode = '23503';
  end if;
  if v_attempt.charge_claim_id <> p_claim_id then
    raise exception 'Renewal result does not own the charge claim' using errcode = '42501';
  end if;
  if v_attempt.state = p_result_state then
    if v_attempt.provider_document_ref is not distinct from v_document_ref
      and v_attempt.provider_transaction_ref is not distinct from v_transaction_ref
      and v_attempt.provider_status is not distinct from p_provider_status
      and v_attempt.failure_reason is not distinct from v_reason
    then
      -- Repairs a half-applied outcome when a caller retries after losing the
      -- response: the attempt is already terminal but may never have settled.
      if v_attempt.state = 'succeeded' then
        perform billing_private.settle_renewal_attempt(v_attempt.id);
      end if;
      return v_attempt;
    end if;
    raise exception 'Renewal result retry has different inputs' using errcode = '22000';
  end if;
  if v_attempt.state <> 'charging' then
    raise exception 'Renewal attempt is not awaiting its single result' using errcode = '55000';
  end if;
  update billing_private.renewal_attempts
  set state = p_result_state,
      provider_document_ref = v_document_ref,
      provider_transaction_ref = v_transaction_ref,
      provider_status = p_provider_status,
      failure_reason = v_reason
  where id = p_attempt_id returning * into v_attempt;

  if v_attempt.state = 'succeeded' then
    perform billing_private.settle_renewal_attempt(v_attempt.id);
    select * into v_attempt from billing_private.renewal_attempts where id = p_attempt_id;
  end if;

  return v_attempt;
end;
$$;

-- -------------------------------------------------------------------------
-- Self-healing sweeper
-- -------------------------------------------------------------------------

-- A worker that dies between the terminal write and its commit, or an operator
-- who marks an attempt succeeded by hand, leaves a paid renewal with no
-- entitlement. Settling is idempotent, so re-running it costs nothing and
-- closes the window without anyone noticing it was open.
create or replace function billing_private.settle_succeeded_renewals(
  p_limit integer default 200
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 10000);
  v_settled bigint := 0;
  v_row record;
begin
  for v_row in
    select attempt.id
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
    order by attempt.created_at
    limit v_limit
  loop
    begin
      perform billing_private.settle_renewal_attempt(v_row.id);
      v_settled := v_settled + 1;
    exception when others then
      -- One unsettleable attempt must not stall the rest. The operational
      -- alert below reports anything that stays unsettled.
      null;
    end;
  end loop;
  return v_settled;
end;
$$;

-- Seven jobs. The two checkout sweepers added by
-- 202608060001_checkout_abandonment_recovery.sql are live on hourly cron
-- entries; dropping them from this allowlist would make both raise 22023 every
-- hour, forever.
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
    'expire_stale_open_checkouts',
    'settle_succeeded_renewals'
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
    elsif p_job = 'settle_succeeded_renewals' then
      v_count := billing_private.settle_succeeded_renewals(v_limit);
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
  if exists (select 1 from cron.job where jobname = 'easyfield-settle-renewals') then
    perform cron.unschedule('easyfield-settle-renewals');
  end if;
end $$;

select cron.schedule(
  'easyfield-settle-renewals',
  '*/10 * * * *',
  $job$select billing_private.run_maintenance('settle_succeeded_renewals', 200)$job$
);

-- -------------------------------------------------------------------------
-- Alerting
-- -------------------------------------------------------------------------

-- Extends the definition installed by 202608060001, preserving the split
-- checkout alerts. The unsettled predicate is deliberately the SAME query the
-- sweeper uses: an attempt the sweeper will never pick up must not raise an
-- alert nobody can clear, because protect_renewal_attempt_origin makes a
-- terminal attempt immutable.
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

  return v_alerts;
end;
$$;

-- -------------------------------------------------------------------------
-- Privileges
-- -------------------------------------------------------------------------

revoke all on function billing_private.register_saved_payment_method(
  uuid, text, text, text, text, integer, integer, text, text[]
) from public, anon, authenticated;
revoke all on function billing_private.settle_renewal_attempt(uuid)
  from public, anon, authenticated;
revoke all on function billing_private.settle_succeeded_renewals(integer)
  from public, anon, authenticated;
revoke all on function billing_private.finish_renewal_attempt(
  uuid, uuid, text, text, text, integer, text
) from public, anon, authenticated;

revoke all on function public.easyfield_account_register_payment_method(
  uuid, text, text, text, text, integer, integer, text, text[]
) from public, anon, authenticated;
grant execute on function public.easyfield_account_register_payment_method(
  uuid, text, text, text, text, integer, integer, text, text[]
) to service_role;

revoke all on function public.easyfield_account_select_subscription_payment_method(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.easyfield_account_select_subscription_payment_method(uuid, uuid)
  to service_role;

commit;
