begin;

-- Terminal payment evidence and entitlement snapshots must never be revived
-- after a catalog revision. These guards also force every workflow that moves
-- into a live state to match the current server-owned catalog.

alter table public.checkout_intents
  drop constraint checkout_intents_status_check;
alter table public.checkout_intents
  add constraint checkout_intents_status_check check (
    status in (
      'created', 'open', 'completed', 'expired', 'cancelled', 'failed',
      'reconciled_no_payment'
    )
  );

-- A failed/expired/cancelled checkout cannot be discarded on assumption. A
-- trusted adapter must first persist the provider reconciliation evidence that
-- proves no payment was captured. The evidence is append-only and server-only.
create table billing_private.checkout_no_payment_reconciliations (
  id uuid primary key default gen_random_uuid(),
  checkout_intent_id uuid not null unique
    references public.checkout_intents(id) on delete restrict,
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

create trigger checkout_no_payment_reconciliations_are_immutable
before update or delete on billing_private.checkout_no_payment_reconciliations
for each row execute function billing_private.reject_immutable_mutation();

create or replace function billing_private.enforce_checkout_state_and_catalog()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan billing_private.plan_catalog;
begin
  if old.status in ('completed', 'reconciled_no_payment')
    and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
  then
    raise exception 'A terminal reconciled checkout is immutable' using errcode = '55000';
  end if;

  -- A delayed, signed provider reconciliation may prove that a checkout marked
  -- failed/expired/cancelled was actually paid. It may move directly to
  -- completed, but can never be reopened for a second payment attempt.
  if old.status in ('expired', 'cancelled', 'failed')
    and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
  then
    if not (
      (
        new.status = 'completed'
        and billing_private.checkout_payment_event_is_verified(
          new.id,
          new.provider,
          new.completed_payment_event_id,
          new.provider_payment_ref,
          new.amount_currency_micros,
          new.currency_code
        )
      )
      or (
        new.status = 'reconciled_no_payment'
        and exists (
          select 1
          from billing_private.checkout_no_payment_reconciliations as reconciliation
          where reconciliation.checkout_intent_id = new.id
            and reconciliation.provider = new.provider
        )
      )
    )
    then
      raise exception 'A closed checkout requires verified payment or no-payment evidence'
        using errcode = '55000';
    end if;
  end if;

  if new.status in ('created', 'open', 'completed') then
    select plan.* into v_plan
    from billing_private.plan_catalog as plan
    where plan.plan_key = new.plan_key and plan.active;

    if not found
      or new.pricing_version is distinct from v_plan.pricing_version
      or new.currency_code is distinct from v_plan.currency_code
      or new.monthly_grant_microcredits is distinct from v_plan.monthly_grant_microcredits
      or new.top_up_currency_micros_per_credit
        is distinct from v_plan.top_up_currency_micros_per_credit
      or new.minimum_top_up_currency_micros
        is distinct from v_plan.minimum_top_up_currency_micros
    then
      raise exception 'Checkout snapshot does not match the active catalog'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

create or replace function billing_private.reconcile_checkout_without_payment(
  p_checkout_intent_id uuid,
  p_provider_reconciliation_ref text,
  p_evidence_sha256 text,
  p_actor_ref text,
  p_reason text
)
returns public.checkout_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkout_intents;
begin
  if p_checkout_intent_id is null
    or char_length(btrim(coalesce(p_provider_reconciliation_ref, ''))) not between 1 and 500
    or coalesce(p_evidence_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_actor_ref, ''))) not between 3 and 200
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000
  then
    raise exception 'Valid no-payment reconciliation evidence is required'
      using errcode = '22023';
  end if;

  select checkout.* into v_checkout
  from public.checkout_intents as checkout
  where checkout.id = p_checkout_intent_id
  for update;

  if not found then
    raise exception 'Checkout intent not found' using errcode = '23503';
  end if;
  if v_checkout.status not in ('failed', 'expired', 'cancelled')
    or v_checkout.completed_payment_event_id is not null
    or v_checkout.provider_payment_ref is not null
  then
    raise exception 'Only an unpaid closed checkout can be reconciled without payment'
      using errcode = '55000';
  end if;

  insert into billing_private.checkout_no_payment_reconciliations (
    checkout_intent_id,
    provider,
    provider_reconciliation_ref,
    evidence_sha256,
    actor_ref,
    reason
  ) values (
    v_checkout.id,
    v_checkout.provider,
    btrim(p_provider_reconciliation_ref),
    p_evidence_sha256,
    btrim(p_actor_ref),
    btrim(p_reason)
  );

  update public.checkout_intents
  set status = 'reconciled_no_payment'
  where id = v_checkout.id
  returning * into v_checkout;

  return v_checkout;
end;
$$;

revoke all on function billing_private.reconcile_checkout_without_payment(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function billing_private.reconcile_checkout_without_payment(
  uuid, text, text, text, text
) to service_role;

create or replace function billing_private.enforce_subscription_state_and_catalog()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan billing_private.plan_catalog;
begin
  if old.status in ('canceled', 'expired')
    and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
  then
    raise exception 'A terminal subscription is immutable' using errcode = '55000';
  end if;

  if new.status in ('trialing', 'active') then
    select plan.* into v_plan
    from billing_private.plan_catalog as plan
    where plan.plan_key = new.plan_key and plan.active;

    if not found
      or new.pricing_version is distinct from v_plan.pricing_version
      or new.currency_code is distinct from v_plan.currency_code
      or new.included_microcredits_per_grant
        is distinct from v_plan.monthly_grant_microcredits
      or new.unit_amount_currency_micros is distinct from case new.billing_interval
        when 'monthly' then v_plan.monthly_price_currency_micros
        when 'annual' then v_plan.annual_price_currency_micros
        else null
      end
    then
      raise exception 'Subscription snapshot does not match the active catalog'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

create or replace function billing_private.enforce_grant_schedule_terminal_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('granted', 'skipped', 'cancelled')
    and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
  then
    raise exception 'A terminal annual grant schedule is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger checkout_intents_state_guard
before update on public.checkout_intents
for each row execute function billing_private.enforce_checkout_state_and_catalog();

create trigger subscriptions_state_guard
before update on public.subscriptions
for each row execute function billing_private.enforce_subscription_state_and_catalog();

create trigger subscription_grants_state_guard
before update on public.subscription_grant_schedule
for each row execute function billing_private.enforce_grant_schedule_terminal_state();

commit;
