begin;

-- Renewal enqueueing, auto-reload detection, and one place that answers
-- "what is wrong right now".
--
-- billing_private.create_renewal_attempt has existed since the first migration
-- and nothing ever called it. A monthly subscriber's period therefore ends with
-- no attempt recorded anywhere: no charge, no credits, and — worse — no trace
-- that anything was due. The charge itself needs a payment provider, but
-- deciding that a renewal is due does not, and neither does making a
-- subscription that is about to lapse visible.
--
-- So this splits the work at the honest seam. Everything up to the provider
-- call happens here on a schedule; the provider call remains the one missing
-- piece, and what is waiting for it is now on screen instead of silent.

-- -------------------------------------------------------------------------
-- Renewal sweeping
-- -------------------------------------------------------------------------

-- Enqueues a renewal attempt for every subscription whose period ends within
-- the lead window and which has everything needed to charge.
--
-- create_renewal_attempt is idempotent — it returns the existing row when one
-- matches the current price snapshot — so re-running is safe and a duplicate
-- attempt is impossible. Its own guards are authoritative; anything it refuses
-- is counted as skipped rather than retried, because a refusal means the
-- subscription genuinely is not chargeable.
create or replace function billing_private.sweep_due_renewals(
  p_limit integer default 500,
  p_lead interval default interval '1 day'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_row record;
  v_created integer := 0;
  v_skipped integer := 0;
begin
  for v_row in
    select subscription.id, subscription.current_period_end
    from public.subscriptions as subscription
    where subscription.status in ('trialing', 'active')
      and not subscription.cancel_at_period_end
      and subscription.saved_payment_method_id is not null
      and subscription.current_period_end is not null
      and subscription.current_period_end <= clock_timestamp() + p_lead
    order by subscription.current_period_end asc
    limit v_limit
  loop
    -- One subscription that cannot be renewed must not stop the rest of the
    -- sweep, so each is attempted in its own block.
    begin
      perform billing_private.create_renewal_attempt(v_row.id, v_row.current_period_end);
      v_created := v_created + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('enqueued', v_created, 'skipped', v_skipped);
end;
$$;

-- -------------------------------------------------------------------------
-- What is waiting on a payment provider
-- -------------------------------------------------------------------------

-- A subscription about to lapse with no usable payment method cannot be
-- renewed by anything, so it will never appear as a renewal attempt. Without
-- this it simply expires and the customer loses access with no warning to
-- anyone. Reported separately from failures because the remedy is different:
-- these are not broken, they are unfinishable until a provider exists.
create or replace function billing_private.due_renewals_blocked(p_limit integer default 25)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'subscriptionId', blocked.id,
    'planKey', blocked.plan_key,
    'billingInterval', blocked.billing_interval,
    'periodEndsAt', to_jsonb(blocked.current_period_end),
    'reason', case
      when blocked.saved_payment_method_id is null then 'no saved payment method'
      else 'not chargeable'
    end
  ) order by blocked.current_period_end asc), '[]'::jsonb)
  from (
    select id, plan_key, billing_interval, current_period_end, saved_payment_method_id
    from public.subscriptions
    where status in ('trialing', 'active')
      and not cancel_at_period_end
      and current_period_end is not null
      and current_period_end <= clock_timestamp() + interval '7 days'
      and saved_payment_method_id is null
    order by current_period_end asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  ) as blocked;
$$;

-- Auto-reload is advertised in the UI and its settings can be saved, but no
-- worker acts on them. Detecting the trigger needs no provider; charging does.
-- Surfacing the accounts that have crossed their threshold turns a silently
-- dead feature into visible pending work.
create or replace function billing_private.auto_reload_due(p_limit integer default 25)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', due.account_id,
    'planKey', due.plan_key,
    'availableMicrocredits', due.available_microcredits::text,
    'triggerBelowMicrocredits', due.trigger_below_microcredits::text,
    'reloadMicrocredits', due.reload_microcredits::text,
    'hasSavedMethod', due.saved_payment_method_id is not null
  ) order by due.available_microcredits asc), '[]'::jsonb)
  from (
    select setting.account_id, setting.plan_key, setting.trigger_below_microcredits,
           setting.reload_microcredits, setting.saved_payment_method_id,
           credit_account.available_microcredits
    from public.auto_reload_settings as setting
    join public.credit_accounts as credit_account on credit_account.id = setting.account_id
    where setting.enabled
      and credit_account.available_microcredits < setting.trigger_below_microcredits
    order by credit_account.available_microcredits asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  ) as due;
$$;

-- -------------------------------------------------------------------------
-- One place that answers "what is wrong right now"
-- -------------------------------------------------------------------------

-- There is no paging system here and no external monitor. This is the closest
-- honest substitute: a single call that names everything currently wrong, with
-- a severity, so the console can lead with it and any future monitor has one
-- endpoint to poll rather than needing to know the whole schema.
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
  v_stuck integer;
  v_unresolved integer;
begin
  select count(*) into v_stale
  from jsonb_array_elements(billing_private.maintenance_health()) as job
  where (job->>'stale')::boolean;

  select count(*) into v_failing
  from jsonb_array_elements(billing_private.maintenance_health()) as job
  where job->>'lastError' is not null;

  select jsonb_array_length(billing_private.due_renewals_blocked(100)) into v_blocked;

  select count(*) into v_stuck
  from public.checkout_intents
  where status in ('created', 'open')
    and created_at < clock_timestamp() - interval '24 hours';

  select count(*) into v_unresolved
  from billing_private.renewal_attempts
  where state = 'charging'
    and created_at < clock_timestamp() - interval '1 hour';

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
  if v_stuck > 0 then
    v_alerts := v_alerts || jsonb_build_object(
      'severity', 'warning', 'code', 'checkout-abandoned', 'count', v_stuck,
      'message', 'Checkouts have been open for over a day. Each one blocks that customer from subscribing again until reconciled.');
  end if;

  return v_alerts;
end;
$$;

-- -------------------------------------------------------------------------
-- Surface it
-- -------------------------------------------------------------------------

create or replace function public.easyfield_admin_incidents(
  p_actor_user_id uuid,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := billing_private.clamp_admin_limit(p_limit);
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  return jsonb_build_object(
    'limit', v_limit,
    'alerts', billing_private.operational_alerts(),
    'maintenance', billing_private.maintenance_health(),
    'blockedRenewals', billing_private.due_renewals_blocked(v_limit),
    'autoReloadDue', billing_private.auto_reload_due(v_limit),
    'ambiguousCheckouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', intent.id, 'customerId', intent.customer_id,
        'intentType', intent.intent_type, 'planKey', intent.plan_key,
        'status', intent.status, 'createdAt', to_jsonb(intent.created_at),
        'updatedAt', to_jsonb(intent.updated_at)) order by intent.updated_at desc), '[]'::jsonb)
      from (select * from public.checkout_intents where status in ('failed','expired','cancelled')
            order by updated_at desc limit v_limit) as intent),
    'openCheckouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', intent.id, 'customerId', intent.customer_id,
        'intentType', intent.intent_type, 'status', intent.status,
        'createdAt', to_jsonb(intent.created_at)) order by intent.created_at asc), '[]'::jsonb)
      from (select * from public.checkout_intents where status in ('created','open')
            order by created_at asc limit v_limit) as intent),
    'unresolvedRenewals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', attempt.id, 'planKey', attempt.plan_key, 'state', attempt.state,
        'createdAt', to_jsonb(attempt.created_at)) order by attempt.created_at asc), '[]'::jsonb)
      from (select * from billing_private.renewal_attempts where state in ('scheduled','charging')
            order by created_at asc limit v_limit) as attempt),
    'pendingGrants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', grant_row.id, 'subscriptionId', grant_row.subscription_id,
        'status', grant_row.status, 'grantNumber', grant_row.grant_number,
        'scheduledFor', to_jsonb(grant_row.scheduled_for)) order by grant_row.scheduled_for asc), '[]'::jsonb)
      from (select * from public.subscription_grant_schedule where status in ('pending','granting')
            order by scheduled_for asc limit v_limit) as grant_row)
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Schedule the sweeper
-- -------------------------------------------------------------------------

-- Extends the runner's allowlist. It stays an allowlist rather than accepting
-- arbitrary SQL, so a cron entry can never become an execution primitive.
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
    'sweep_due_renewals'
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

-- Renewals are checked every five minutes with a one-day lead, so a period end
-- is never missed by a scheduler restart and the attempt exists well before the
-- customer's access would lapse.
create or replace function billing_private.maintenance_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'job', expected.job_name,
    'everRan', latest.started_at is not null,
    'lastRunAt', to_jsonb(latest.started_at),
    'lastSuccessAt', to_jsonb(success.started_at),
    'lastError', latest.error_text,
    'processedLastRun', latest.processed_count,
    'stale', (
      success.started_at is null
      or success.started_at < clock_timestamp() - (expected.max_age_seconds * interval '1 second')
    )
  ) order by expected.job_name), '[]'::jsonb)
  from (values
    ('expire_credit_reservations', 300),
    ('grant_due_annual_plan_credits', 300),
    ('expire_credit_lots', 900),
    ('sweep_due_renewals', 900)
  ) as expected(job_name, max_age_seconds)
  left join lateral (
    select started_at, error_text, processed_count
    from billing_private.maintenance_runs
    where job_name = expected.job_name
    order by started_at desc
    limit 1
  ) as latest on true
  left join lateral (
    select started_at
    from billing_private.maintenance_runs
    where job_name = expected.job_name and error_text is null and finished_at is not null
    order by started_at desc
    limit 1
  ) as success on true;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'easyfield-sweep-renewals') then
    perform cron.unschedule('easyfield-sweep-renewals');
  end if;
end $$;

select cron.schedule(
  'easyfield-sweep-renewals',
  '*/5 * * * *',
  $job$select billing_private.run_maintenance('sweep_due_renewals', 500)$job$
);

-- -------------------------------------------------------------------------
-- Privileges
-- -------------------------------------------------------------------------

revoke all on function billing_private.sweep_due_renewals(integer, interval) from public, anon, authenticated;
revoke all on function billing_private.due_renewals_blocked(integer) from public, anon, authenticated;
revoke all on function billing_private.auto_reload_due(integer) from public, anon, authenticated;
revoke all on function billing_private.operational_alerts() from public, anon, authenticated;
revoke all on function public.easyfield_admin_incidents(uuid, integer) from public, anon, authenticated;
grant execute on function public.easyfield_admin_incidents(uuid, integer) to service_role;

commit;
