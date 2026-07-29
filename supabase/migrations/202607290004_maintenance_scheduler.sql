begin;

-- Maintenance scheduling.
--
-- Three functions in this schema are written to be called periodically and,
-- until now, nothing called them. The consequences are not subtle:
--
--   grant_due_annual_plan_credits  An annual subscriber pays for twelve monthly
--                                  instalments. Reconciliation schedules all
--                                  twelve but materialises only the first, so
--                                  instalments 2..12 never arrive.
--   expire_credit_reservations     A generation that never settles holds its
--                                  reservation forever, permanently subtracting
--                                  from the customer's available balance.
--   expire_credit_lots             Expired credit is never swept, so balances
--                                  and lot state drift from the product rules.
--
-- pg_cron runs inside the database, so the three database-only jobs need no
-- service-role key, no HTTP call, and no external worker to go wrong.
--
-- Everything here is additive: no existing function or table is altered.

create extension if not exists pg_cron;

-- -------------------------------------------------------------------------
-- Run history
-- -------------------------------------------------------------------------

-- A scheduler that dies silently is worse than one that was never installed,
-- because the system looks healthy. Every run records itself, so "when did this
-- last succeed" is answerable and staleness is detectable.
create table if not exists billing_private.maintenance_runs (
  id bigint generated always as identity primary key,
  job_name text not null check (char_length(job_name) between 1 and 80),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  processed_count bigint,
  error_text text,
  check (finished_at is null or finished_at >= started_at),
  -- A finished run is either a success with a count or a failure with a reason.
  check (finished_at is null or (processed_count is null) <> (error_text is null))
);

create index if not exists maintenance_runs_job_recent
  on billing_private.maintenance_runs (job_name, started_at desc);

alter table billing_private.maintenance_runs enable row level security;
alter table billing_private.maintenance_runs force row level security;

-- -------------------------------------------------------------------------
-- Runner
-- -------------------------------------------------------------------------

-- Dispatches by name from a fixed list rather than taking arbitrary SQL, so a
-- cron entry can never become an execution primitive.
--
-- A failure is caught and recorded instead of propagating. If it propagated,
-- the run row would roll back with it and the failure would leave no trace —
-- exactly the silence this table exists to prevent. The insert happens outside
-- the exception block, so it survives the inner rollback.
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
begin
  if p_job not in (
    'expire_credit_reservations',
    'expire_credit_lots',
    'grant_due_annual_plan_credits'
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
    else
      select count(*) into v_count from billing_private.grant_due_annual_plan_credits(v_limit);
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

-- -------------------------------------------------------------------------
-- Health, for the console
-- -------------------------------------------------------------------------

-- Reports each job's last success and last error. `stale` is the signal an
-- operator acts on: the job is overdue relative to its own cadence.
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
    ('expire_credit_lots', 900)
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

-- Surface it where an operator already looks. The incident queue is the screen
-- someone opens when something feels wrong; a dead scheduler belongs there
-- rather than in a place they would have to think to check.
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
    'maintenance', billing_private.maintenance_health(),
    'ambiguousCheckouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', intent.id,
        'customerId', intent.customer_id,
        'intentType', intent.intent_type,
        'planKey', intent.plan_key,
        'status', intent.status,
        'createdAt', to_jsonb(intent.created_at),
        'updatedAt', to_jsonb(intent.updated_at)
      ) order by intent.updated_at desc), '[]'::jsonb)
      from (
        select * from public.checkout_intents
        where status in ('failed', 'expired', 'cancelled')
        order by updated_at desc
        limit v_limit
      ) as intent
    ),
    'openCheckouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', intent.id,
        'customerId', intent.customer_id,
        'intentType', intent.intent_type,
        'status', intent.status,
        'createdAt', to_jsonb(intent.created_at)
      ) order by intent.created_at asc), '[]'::jsonb)
      from (
        select * from public.checkout_intents
        where status in ('created', 'open')
        order by created_at asc
        limit v_limit
      ) as intent
    ),
    'unresolvedRenewals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', attempt.id,
        'planKey', attempt.plan_key,
        'state', attempt.state,
        'createdAt', to_jsonb(attempt.created_at)
      ) order by attempt.created_at asc), '[]'::jsonb)
      from (
        select * from billing_private.renewal_attempts
        where state in ('scheduled', 'charging')
        order by created_at asc
        limit v_limit
      ) as attempt
    ),
    'pendingGrants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', grant_row.id,
        'subscriptionId', grant_row.subscription_id,
        'status', grant_row.status,
        'grantNumber', grant_row.grant_number,
        'scheduledFor', to_jsonb(grant_row.scheduled_for)
      ) order by grant_row.scheduled_for asc), '[]'::jsonb)
      from (
        select * from public.subscription_grant_schedule
        where status in ('pending', 'granting')
        order by scheduled_for asc
        limit v_limit
      ) as grant_row
    )
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Privileges
-- -------------------------------------------------------------------------

revoke all on billing_private.maintenance_runs from public, anon, authenticated;
revoke all on function billing_private.run_maintenance(text, integer) from public, anon, authenticated;
revoke all on function billing_private.maintenance_health() from public, anon, authenticated;
revoke all on function public.easyfield_admin_incidents(uuid, integer) from public, anon, authenticated;
grant execute on function public.easyfield_admin_incidents(uuid, integer) to service_role;

-- -------------------------------------------------------------------------
-- Schedule
-- -------------------------------------------------------------------------

-- Unscheduled first so re-running this migration cannot accumulate duplicate
-- entries. cron.unschedule raises when the job is absent, so each is guarded.
do $$
declare
  v_job text;
begin
  foreach v_job in array array[
    'easyfield-expire-reservations',
    'easyfield-grant-annual',
    'easyfield-expire-lots'
  ] loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;
end $$;

-- Reservations and annual grants run every minute: both directly affect what a
-- customer can spend right now. Lot expiry is a slower sweep.
select cron.schedule(
  'easyfield-expire-reservations',
  '* * * * *',
  $job$select billing_private.run_maintenance('expire_credit_reservations', 5000)$job$
);

select cron.schedule(
  'easyfield-grant-annual',
  '* * * * *',
  $job$select billing_private.run_maintenance('grant_due_annual_plan_credits', 1000)$job$
);

select cron.schedule(
  'easyfield-expire-lots',
  '*/5 * * * *',
  $job$select billing_private.run_maintenance('expire_credit_lots', 5000)$job$
);

commit;
