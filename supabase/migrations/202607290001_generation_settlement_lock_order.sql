begin;

-- Credit balance mutations always lock the owning account before their
-- reservation. Gateway terminal paths must use that order too so they cannot
-- deadlock with reservation expiry or another settlement worker.

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
    where id = v_job.reservation_id;
    perform 1 from public.credit_accounts
    where id = v_reservation.account_id for update;
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
    where id = v_job.reservation_id;
    perform 1 from public.credit_accounts
    where id = v_reservation.account_id for update;
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
    where id = v_job.reservation_id;
    perform 1 from public.credit_accounts
    where id = v_reservation.account_id for update;
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

commit;
