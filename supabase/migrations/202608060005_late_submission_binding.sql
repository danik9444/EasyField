begin;

-- A late submission accept must still bind its task.
--
-- `easyfield_generation_accept_submission` (20260715175329) treats exactly one
-- status as bindable:
--
--     if v_job.status <> 'submitting' then
--       raise exception 'Generation operation cannot accept a task in status %'
--
-- The reconciler moves a job that has been `submitting` for too long to
-- `submission_ambiguous` — a status that means precisely "this database does
-- not know whether the provider accepted the work". That status is neither
-- `submitting` nor in the idempotent-return list, so it lands on the raise.
--
-- The consequence is the worst shape a billing bug can take. The submit call
-- that was merely slow returns with a real, provider-issued task reference.
-- The accept is refused with 55000. Nothing else persists that reference, so
-- it is discarded. The provider runs the job and bills EasyField for it, the
-- customer's reservation sits untouched until `expire_credit_reservations`
-- releases it a day later, and the operation is left permanently ambiguous
-- with no task to reconcile against. EasyField pays for work nobody receives.
--
-- The fix is to notice what the late accept actually is: `submission_ambiguous`
-- is a question, and a task reference is the answer to it. Binding resolves the
-- ambiguity instead of being blocked by it.
--
-- Nothing here weakens the one-task-per-operation guarantee. A job that already
-- carries a different reference still raises 22000 on the idempotent path, and
-- a job in any other status still raises 55000.

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
  v_was_ambiguous boolean;
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

  -- `submission_ambiguous` is the reconciler recording that it does not know
  -- whether the provider took the work. A task reference answers that, so it
  -- binds rather than being refused. Every other status still raises.
  if v_job.status not in ('submitting', 'submission_ambiguous') then
    raise exception 'Generation operation cannot accept a task in status %', v_job.status using errcode = '55000';
  end if;
  v_was_ambiguous := v_job.status = 'submission_ambiguous';

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
    -- Recorded distinctly: a binding that resolved an ambiguity is evidence
    -- the submit budget and the reconciler threshold are too close together,
    -- and that is only visible if it is written down when it happens.
    jsonb_build_object(
      'provider_task_ref_sha256', v_task_sha,
      'resolved_ambiguous_submission', v_was_ambiguous
    )
  );
  return v_job;
end;
$$;

revoke all on function public.easyfield_generation_accept_submission(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.easyfield_generation_accept_submission(uuid, text, text, text)
  to service_role;

commit;
