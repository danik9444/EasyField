-- Durable, provider-neutral control plane for metered customer generation.
--
-- This migration intentionally does not seed prices or enable the gateway.
-- A release must install a reviewed server-side pricing manifest whose keys
-- are resolved from validated request bodies by the generation data plane.

create table billing_private.generation_price_catalog (
  pricing_key text primary key check (char_length(pricing_key) between 3 and 240),
  model_id text not null check (char_length(model_id) between 1 and 200),
  action text not null check (char_length(action) between 1 and 120),
  family text not null check (family in ('jobs', 'veo', 'runway', 'aleph', 'suno', 'sounds')),
  create_path text not null check (create_path ~ '^/api/v1/[A-Za-z0-9_./-]+$'),
  poll_path text not null check (poll_path ~ '^/api/v1/[A-Za-z0-9_./-]+$'),
  customer_microcredits_per_unit bigint not null check (customer_microcredits_per_unit > 0),
  provider_cost_currency_micros_per_unit bigint not null
    check (provider_cost_currency_micros_per_unit >= 0),
  provider_cost_currency_code text not null check (provider_cost_currency_code ~ '^[A-Z]{3}$'),
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  maximum_units integer not null default 1 check (maximum_units between 1 and 100000),
  active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (family, create_path, pricing_key)
);

comment on table billing_private.generation_price_catalog is
  'Server-owned generation prices. Renderer estimates never authorize a reservation.';

create table billing_private.generation_gateway_jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  quote_id uuid not null unique references public.generation_billing_quotes(id) on delete restrict,
  reservation_id uuid unique references public.credit_reservations(id) on delete restrict,
  operation_key text not null check (char_length(operation_key) between 8 and 160),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  pricing_key text not null references billing_private.generation_price_catalog(pricing_key) on delete restrict,
  quantity_units integer not null check (quantity_units between 1 and 100000),
  family text not null check (family in ('jobs', 'veo', 'runway', 'aleph', 'suno', 'sounds')),
  create_path text not null check (create_path ~ '^/api/v1/[A-Za-z0-9_./-]+$'),
  poll_path text not null check (poll_path ~ '^/api/v1/[A-Za-z0-9_./-]+$'),
  model_id text not null check (char_length(model_id) between 1 and 200),
  action text not null check (char_length(action) between 1 and 120),
  status text not null default 'prepared' check (status in (
    'prepared', 'submitting', 'submission_ambiguous', 'accepted', 'running',
    'succeeded', 'failed', 'cancelled', 'reconciliation_required'
  )),
  provider_task_ref text check (provider_task_ref is null or char_length(provider_task_ref) between 1 and 500),
  provider_task_ref_sha256 text check (
    provider_task_ref_sha256 is null or provider_task_ref_sha256 ~ '^[0-9a-f]{64}$'
  ),
  provider_state text check (provider_state is null or char_length(provider_state) <= 120),
  provider_reported_microcredits bigint check (provider_reported_microcredits is null or provider_reported_microcredits >= 0),
  submitted_at timestamptz,
  accepted_at timestamptz,
  last_polled_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (customer_id, operation_key),
  unique (provider_task_ref_sha256),
  check ((provider_task_ref is null) = (provider_task_ref_sha256 is null)),
  check (status in ('prepared', 'submitting', 'submission_ambiguous', 'failed', 'cancelled') or provider_task_ref is not null),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (terminal_at is not null))
);

create index generation_gateway_jobs_customer_recovery_idx
  on billing_private.generation_gateway_jobs (customer_id, updated_at desc)
  where status in ('submitting', 'submission_ambiguous', 'accepted', 'running', 'reconciliation_required');

comment on table billing_private.generation_gateway_jobs is
  'One durable customer reservation and at most one upstream submission per operation key.';

create table billing_private.generation_gateway_events (
  id bigint generated always as identity primary key,
  gateway_job_id uuid not null references billing_private.generation_gateway_jobs(id) on delete restrict,
  event_type text not null check (event_type in (
    'prepared', 'submission_started', 'submission_ambiguous', 'accepted',
    'poll', 'captured', 'released', 'cancelled', 'reconciliation_required'
  )),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index generation_gateway_events_job_idx
  on billing_private.generation_gateway_events (gateway_job_id, created_at, id);

-- Defense in depth if the private schema is ever exposed accidentally. The
-- trusted service-role worker and SECURITY DEFINER functions remain the only
-- supported access paths; no public-client policies exist.
alter table billing_private.generation_price_catalog enable row level security;
alter table billing_private.generation_gateway_jobs enable row level security;
alter table billing_private.generation_gateway_events enable row level security;

create or replace function public.easyfield_generation_prepare(
  p_user_id uuid,
  p_operation_key text,
  p_request_sha256 text,
  p_pricing_key text,
  p_quantity_units integer
)
returns billing_private.generation_gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price billing_private.generation_price_catalog;
  v_quote public.generation_billing_quotes;
  v_reservation public.credit_reservations;
  v_existing billing_private.generation_gateway_jobs;
  v_job billing_private.generation_gateway_jobs;
  v_reservation_id uuid;
  v_customer_microcredits bigint;
  v_provider_cost bigint;
begin
  if p_user_id is null
    or char_length(btrim(coalesce(p_operation_key, ''))) not between 8 and 160
    or p_request_sha256 is null or p_request_sha256 !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_pricing_key, ''))) not between 3 and 240
    or p_quantity_units is null or p_quantity_units < 1
  then
    raise exception 'Invalid generation preparation' using errcode = '22023';
  end if;

  select * into v_price
  from billing_private.generation_price_catalog
  where pricing_key = btrim(p_pricing_key) and active
  for share;
  if not found or p_quantity_units > v_price.maximum_units then
    raise exception 'Generation price is not active for this request' using errcode = '42501';
  end if;
  if v_price.customer_microcredits_per_unit > 9223372036854775807 / p_quantity_units
    or v_price.provider_cost_currency_micros_per_unit > 9223372036854775807 / p_quantity_units
  then
    raise exception 'Generation price overflows the billing range' using errcode = '22003';
  end if;
  v_customer_microcredits := v_price.customer_microcredits_per_unit * p_quantity_units;
  v_provider_cost := v_price.provider_cost_currency_micros_per_unit * p_quantity_units;

  select j.* into v_existing
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id and j.operation_key = btrim(p_operation_key);
  if found then
    if v_existing.request_sha256 <> p_request_sha256
      or v_existing.pricing_key <> v_price.pricing_key
      or v_existing.quantity_units <> p_quantity_units
      or v_existing.family <> v_price.family
      or v_existing.create_path <> v_price.create_path
      or v_existing.poll_path <> v_price.poll_path
      or v_existing.model_id <> v_price.model_id
      or v_existing.action <> v_price.action
    then
      raise exception 'Generation operation key was reused with different inputs' using errcode = '22000';
    end if;
    return v_existing;
  end if;

  v_quote := billing_private.create_generation_quote(
    p_user_id,
    'gateway.quote:' || btrim(p_operation_key),
    p_request_sha256,
    v_price.model_id,
    v_price.action,
    v_customer_microcredits,
    v_provider_cost,
    v_price.provider_cost_currency_code,
    v_price.pricing_version,
    clock_timestamp() + interval '15 minutes'
  );

  if not v_quote.admin_bypass then
    v_reservation := billing_private.reserve_credits(
      p_user_id,
      v_quote.id,
      btrim(p_operation_key),
      'gateway.reserve:' || btrim(p_operation_key),
      clock_timestamp() + interval '24 hours'
    );
    v_reservation_id := v_reservation.id;
  end if;

  insert into billing_private.generation_gateway_jobs (
    customer_id, quote_id, reservation_id, operation_key, request_sha256,
    pricing_key, quantity_units, family, create_path, poll_path, model_id, action
  ) values (
    v_quote.customer_id, v_quote.id, v_reservation_id, btrim(p_operation_key),
    p_request_sha256, v_price.pricing_key, p_quantity_units, v_price.family,
    v_price.create_path, v_price.poll_path, v_price.model_id, v_price.action
  ) returning * into v_job;

  insert into billing_private.generation_gateway_events (
    gateway_job_id, event_type, request_sha256, metadata
  ) values (
    v_job.id, 'prepared', p_request_sha256,
    jsonb_build_object('pricing_key', v_price.pricing_key, 'quantity_units', p_quantity_units)
  );
  return v_job;
end;
$$;

create or replace function public.easyfield_generation_begin_submission(
  p_user_id uuid,
  p_operation_key text,
  p_request_sha256 text
)
returns table (
  gateway_job_id uuid,
  may_submit boolean,
  current_status text,
  provider_task_ref text,
  create_path text,
  poll_path text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
begin
  select j.* into v_job
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id and j.operation_key = btrim(p_operation_key)
  for update of j;
  if not found or v_job.request_sha256 <> p_request_sha256 then
    raise exception 'Generation operation was not found' using errcode = '23503';
  end if;

  if v_job.status = 'prepared' then
    update billing_private.generation_gateway_jobs
    set status = 'submitting', submitted_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_job.id
    returning * into v_job;
    insert into billing_private.generation_gateway_events (
      gateway_job_id, event_type, request_sha256
    ) values (v_job.id, 'submission_started', p_request_sha256);
    return query select v_job.id, true, v_job.status, v_job.provider_task_ref, v_job.create_path, v_job.poll_path;
    return;
  end if;

  -- Accepted work is replayed as its original task binding. Submitting or
  -- ambiguous work is never sent again because the first POST may have spent.
  return query select v_job.id, false, v_job.status, v_job.provider_task_ref, v_job.create_path, v_job.poll_path;
end;
$$;

create or replace function public.easyfield_generation_accept_submission(
  p_user_id uuid,
  p_operation_key text,
  p_request_sha256 text,
  p_provider_task_ref text
)
returns billing_private.generation_gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
  v_task text := nullif(btrim(p_provider_task_ref), '');
  v_task_sha text;
begin
  if v_task is null or char_length(v_task) > 500 then
    raise exception 'Invalid provider task binding' using errcode = '22023';
  end if;
  v_task_sha := encode(extensions.digest(v_task, 'sha256'), 'hex');
  select j.* into v_job
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id and j.operation_key = btrim(p_operation_key)
  for update of j;
  if not found or v_job.request_sha256 <> p_request_sha256 then
    raise exception 'Generation operation was not found' using errcode = '23503';
  end if;
  if v_job.status in ('accepted', 'running', 'succeeded', 'reconciliation_required') then
    if v_job.provider_task_ref_sha256 <> v_task_sha then
      raise exception 'Generation operation is already bound to another task' using errcode = '22000';
    end if;
    return v_job;
  end if;
  if v_job.status <> 'submitting' then
    raise exception 'Generation operation cannot accept a task in status %', v_job.status using errcode = '55000';
  end if;

  update billing_private.generation_gateway_jobs
  set status = 'accepted', provider_task_ref = v_task,
      provider_task_ref_sha256 = v_task_sha, accepted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = v_job.id
  returning * into v_job;
  insert into billing_private.generation_gateway_events (
    gateway_job_id, event_type, request_sha256,
    metadata
  ) values (
    v_job.id, 'accepted', p_request_sha256,
    jsonb_build_object('provider_task_ref_sha256', v_task_sha)
  );
  return v_job;
end;
$$;

create or replace function public.easyfield_generation_mark_ambiguous(
  p_user_id uuid,
  p_operation_key text,
  p_request_sha256 text
)
returns billing_private.generation_gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
begin
  select j.* into v_job
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id and j.operation_key = btrim(p_operation_key)
  for update of j;
  if not found or v_job.request_sha256 <> p_request_sha256 then
    raise exception 'Generation operation was not found' using errcode = '23503';
  end if;
  if v_job.status = 'submitting' then
    update billing_private.generation_gateway_jobs
    set status = 'submission_ambiguous', updated_at = clock_timestamp()
    where id = v_job.id
    returning * into v_job;
    insert into billing_private.generation_gateway_events (
      gateway_job_id, event_type, request_sha256
    ) values (v_job.id, 'submission_ambiguous', p_request_sha256);
  end if;
  return v_job;
end;
$$;

create or replace function public.easyfield_generation_reject_submission(
  p_user_id uuid,
  p_operation_key text,
  p_request_sha256 text
)
returns billing_private.generation_gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
  v_reservation public.credit_reservations;
  v_remaining bigint;
begin
  select j.* into v_job
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id and j.operation_key = btrim(p_operation_key)
  for update of j;
  if not found or v_job.request_sha256 <> p_request_sha256 then
    raise exception 'Generation operation was not found' using errcode = '23503';
  end if;
  if v_job.status = 'failed' then return v_job; end if;
  -- Only a definite application-level rejection may call this function. A
  -- timeout, disconnect or unclassified 5xx must use mark_ambiguous instead.
  if v_job.status <> 'submitting' or v_job.provider_task_ref is not null then
    raise exception 'Generation submission is not safely rejectable' using errcode = '55000';
  end if;
  if v_job.reservation_id is not null then
    select * into v_reservation from public.credit_reservations
    where id = v_job.reservation_id for update;
    v_remaining := v_reservation.amount_microcredits
      - v_reservation.captured_microcredits - v_reservation.released_microcredits;
    if v_remaining > 0 then
      perform billing_private.release_credits(
        v_job.reservation_id, 'gateway.reject:' || v_job.id::text,
        v_remaining, 'provider_rejected_before_acceptance'
      );
    end if;
  end if;
  update billing_private.generation_gateway_jobs
  set status = 'failed', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_job.id returning * into v_job;
  insert into billing_private.generation_gateway_events (
    gateway_job_id, event_type, request_sha256, metadata
  ) values (
    v_job.id, 'released', v_job.request_sha256,
    jsonb_build_object('reason', 'provider_rejected_before_acceptance', 'released_microcredits', v_remaining)
  );
  return v_job;
end;
$$;

create or replace function public.easyfield_generation_authorize_poll(
  p_user_id uuid,
  p_provider_task_ref text,
  p_poll_path text
)
returns billing_private.generation_gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
  v_task_sha text;
begin
  if char_length(btrim(coalesce(p_provider_task_ref, ''))) not between 1 and 500
    or p_poll_path is null or p_poll_path !~ '^/api/v1/[A-Za-z0-9_./-]+$'
  then
    raise exception 'Invalid generation poll' using errcode = '22023';
  end if;
  v_task_sha := encode(extensions.digest(btrim(p_provider_task_ref), 'sha256'), 'hex');
  select j.* into v_job
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id
    and j.provider_task_ref_sha256 = v_task_sha
    and j.poll_path = p_poll_path;
  if not found then
    -- Deliberately indistinguishable for missing and foreign tasks.
    raise exception 'Generation task was not found' using errcode = '23503';
  end if;
  return v_job;
end;
$$;

create or replace function public.easyfield_generation_record_poll(
  p_user_id uuid,
  p_provider_task_ref text,
  p_poll_path text,
  p_provider_state text,
  p_outcome text,
  p_reported_microcredits bigint default null
)
returns billing_private.generation_gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
  v_reservation public.credit_reservations;
  v_capture bigint;
  v_remaining bigint;
  v_state text := nullif(btrim(p_provider_state), '');
begin
  if p_outcome not in ('pending', 'succeeded', 'failed')
    or char_length(coalesce(v_state, '')) > 120
    or (p_reported_microcredits is not null and p_reported_microcredits < 0)
  then
    raise exception 'Invalid generation poll result' using errcode = '22023';
  end if;
  v_job := public.easyfield_generation_authorize_poll(p_user_id, p_provider_task_ref, p_poll_path);
  select * into v_job from billing_private.generation_gateway_jobs where id = v_job.id for update;
  if v_job.status in ('succeeded', 'failed') then return v_job; end if;
  if v_job.status not in ('accepted', 'running', 'reconciliation_required') then
    raise exception 'Generation task is not pollable in status %', v_job.status using errcode = '55000';
  end if;

  if p_outcome = 'pending' then
    update billing_private.generation_gateway_jobs
    set status = 'running', provider_state = v_state,
        last_polled_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_job.id returning * into v_job;
    insert into billing_private.generation_gateway_events (
      gateway_job_id, event_type, request_sha256, metadata
    ) values (
      v_job.id, 'poll', v_job.request_sha256,
      jsonb_build_object('outcome', p_outcome, 'provider_state', v_state)
    );
    return v_job;
  end if;

  if v_job.reservation_id is not null then
    select * into v_reservation from public.credit_reservations
    where id = v_job.reservation_id for update;
    v_remaining := v_reservation.amount_microcredits
      - v_reservation.captured_microcredits - v_reservation.released_microcredits;
  else
    v_remaining := 0;
  end if;

  if p_outcome = 'failed' then
    if v_remaining > 0 then
      perform billing_private.release_credits(
        v_job.reservation_id, 'gateway.fail:' || v_job.id::text, v_remaining, 'provider_failed'
      );
    end if;
    update billing_private.generation_gateway_jobs
    set status = 'failed', provider_state = v_state,
        provider_reported_microcredits = p_reported_microcredits,
        last_polled_at = clock_timestamp(), terminal_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = v_job.id returning * into v_job;
    insert into billing_private.generation_gateway_events (
      gateway_job_id, event_type, request_sha256, metadata
    ) values (
      v_job.id, 'released', v_job.request_sha256,
      jsonb_build_object('reason', 'provider_failed', 'released_microcredits', v_remaining)
    );
    return v_job;
  end if;

  if v_job.reservation_id is not null and v_remaining > 0 then
    -- The reviewed reservation is a hard customer ceiling. If the upstream
    -- reports more, EasyField absorbs/reconciles the overage rather than
    -- charging beyond approval.
    v_capture := least(coalesce(p_reported_microcredits, v_remaining), v_remaining);
    if v_capture > 0 then
      perform billing_private.capture_credits(
        v_job.reservation_id, 'gateway.success:' || v_job.id::text,
        v_capture, v_job.provider_task_ref
      );
    end if;
    if v_remaining - v_capture > 0 then
      perform billing_private.release_credits(
        v_job.reservation_id, 'gateway.remainder:' || v_job.id::text,
        v_remaining - v_capture, 'unused_approved_ceiling'
      );
    end if;
  end if;
  update billing_private.generation_gateway_jobs
  set status = 'succeeded', provider_state = v_state,
      provider_reported_microcredits = p_reported_microcredits,
      last_polled_at = clock_timestamp(), terminal_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = v_job.id returning * into v_job;
  insert into billing_private.generation_gateway_events (
    gateway_job_id, event_type, request_sha256, metadata
  ) values (
    v_job.id, 'captured', v_job.request_sha256,
    jsonb_build_object(
      'captured_microcredits', v_capture,
      'reported_microcredits', p_reported_microcredits,
      'customer_ceiling_applied', p_reported_microcredits is not null and p_reported_microcredits > v_remaining
    )
  );
  return v_job;
end;
$$;

create or replace function public.easyfield_generation_cancel_prepared(
  p_user_id uuid,
  p_operation_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job billing_private.generation_gateway_jobs;
  v_reservation public.credit_reservations;
  v_remaining bigint;
begin
  select j.* into v_job
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id and j.operation_key = btrim(p_operation_key)
  for update of j;
  if not found then return false; end if;
  if v_job.status <> 'prepared' then return false; end if;
  if v_job.reservation_id is not null then
    select * into v_reservation from public.credit_reservations
    where id = v_job.reservation_id for update;
    v_remaining := v_reservation.amount_microcredits
      - v_reservation.captured_microcredits - v_reservation.released_microcredits;
    if v_remaining > 0 then
      perform billing_private.release_credits(
        v_job.reservation_id, 'gateway.cancel:' || v_job.id::text, v_remaining, 'cancelled_before_submission'
      );
    end if;
  end if;
  update billing_private.generation_gateway_jobs
  set status = 'cancelled', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_job.id;
  insert into billing_private.generation_gateway_events (
    gateway_job_id, event_type, request_sha256
  ) values (v_job.id, 'cancelled', v_job.request_sha256);
  return true;
end;
$$;

create or replace function public.easyfield_generation_recovery_snapshot(p_user_id uuid)
returns table (
  operation_key text,
  family text,
  poll_path text,
  provider_task_ref text,
  status text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.operation_key, j.family, j.poll_path, j.provider_task_ref, j.status, j.updated_at
  from billing_private.generation_gateway_jobs j
  join public.billing_customers c on c.id = j.customer_id
  where c.user_id = p_user_id
    and j.status in ('submitting', 'submission_ambiguous', 'accepted', 'running', 'reconciliation_required')
  order by j.updated_at desc
  limit 500;
$$;

revoke all on table billing_private.generation_price_catalog from public, anon, authenticated;
revoke all on table billing_private.generation_gateway_jobs from public, anon, authenticated;
revoke all on table billing_private.generation_gateway_events from public, anon, authenticated;
grant select, insert, update, delete on table billing_private.generation_price_catalog to service_role;
grant select, insert, update, delete on table billing_private.generation_gateway_jobs to service_role;
grant select, insert on table billing_private.generation_gateway_events to service_role;
grant usage, select on sequence billing_private.generation_gateway_events_id_seq to service_role;

revoke all on function public.easyfield_generation_prepare(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.easyfield_generation_begin_submission(uuid, text, text) from public, anon, authenticated;
revoke all on function public.easyfield_generation_accept_submission(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.easyfield_generation_mark_ambiguous(uuid, text, text) from public, anon, authenticated;
revoke all on function public.easyfield_generation_reject_submission(uuid, text, text) from public, anon, authenticated;
revoke all on function public.easyfield_generation_authorize_poll(uuid, text, text) from public, anon, authenticated;
revoke all on function public.easyfield_generation_record_poll(uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.easyfield_generation_cancel_prepared(uuid, text) from public, anon, authenticated;
revoke all on function public.easyfield_generation_recovery_snapshot(uuid) from public, anon, authenticated;

grant execute on function public.easyfield_generation_prepare(uuid, text, text, text, integer) to service_role;
grant execute on function public.easyfield_generation_begin_submission(uuid, text, text) to service_role;
grant execute on function public.easyfield_generation_accept_submission(uuid, text, text, text) to service_role;
grant execute on function public.easyfield_generation_mark_ambiguous(uuid, text, text) to service_role;
grant execute on function public.easyfield_generation_reject_submission(uuid, text, text) to service_role;
grant execute on function public.easyfield_generation_authorize_poll(uuid, text, text) to service_role;
grant execute on function public.easyfield_generation_record_poll(uuid, text, text, text, text, bigint) to service_role;
grant execute on function public.easyfield_generation_cancel_prepared(uuid, text) to service_role;
grant execute on function public.easyfield_generation_recovery_snapshot(uuid) to service_role;
