begin;

-- A local clock cannot prove that a hosted payment session stopped being
-- payable. Keep every ambiguous subscription intent inside the one-payable
-- boundary until signed merchant reconciliation proves payment or no payment.
-- Stop with an actionable error before replacing the old index if historical
-- data already contains more than one ambiguous operation for an account. It
-- is unsafe for a migration to guess which externally payable session lost.
do $$
begin
  if exists (
    select 1
    from public.checkout_intents
    where intent_type = 'subscription'
      and status in ('created', 'open', 'expired', 'cancelled', 'failed')
    group by customer_id
    having count(*) > 1
  ) then
    raise exception 'Cannot install checkout recovery: reconcile duplicate ambiguous subscription intents first'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from billing_private.partner_purchase_intents
    where status in ('created', 'open', 'expired', 'cancelled', 'failed')
    group by customer_id
    having count(*) > 1
  ) then
    raise exception 'Cannot install checkout recovery: reconcile duplicate ambiguous Partner intents first'
      using errcode = '55000';
  end if;
end;
$$;

drop index if exists public.checkout_intents_one_payable_subscription_per_customer;
create unique index checkout_intents_one_payable_subscription_per_customer
  on public.checkout_intents (customer_id)
  where intent_type = 'subscription'
    and status in ('created', 'open', 'expired', 'cancelled', 'failed');

drop index if exists billing_private.partner_purchase_intents_one_payable_session_per_customer;
create unique index partner_purchase_intents_one_payable_session_per_customer
  on billing_private.partner_purchase_intents (customer_id)
  where status in ('created', 'open', 'expired', 'cancelled', 'failed');

-- A paid/current subscription is managed through the billing portal. Charging
-- a second subscription checkout and discovering the conflict only during the
-- payment webhook would be too late.
create or replace function billing_private.reject_duplicate_active_subscription_checkout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.intent_type = 'subscription' and exists (
    select 1
    from public.subscriptions as subscription
    where subscription.customer_id = new.customer_id
      and subscription.status not in ('canceled', 'expired')
  ) then
    raise exception 'An existing subscription must be managed through the billing portal'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists easyfield_reject_duplicate_active_subscription_checkout
  on public.checkout_intents;
create trigger easyfield_reject_duplicate_active_subscription_checkout
before insert on public.checkout_intents
for each row execute function billing_private.reject_duplicate_active_subscription_checkout();

-- Main may restore an encrypted checkout operation after a restart, but it
-- must never guess payment truth from a mutable credit balance. This narrow
-- service-role RPC resolves one caller-owned idempotency key and normalizes
-- database states without exposing payment or provider references.
create or replace function public.easyfield_account_checkout_status(
  p_user_id uuid,
  p_purchase_kind text,
  p_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_checkout public.checkout_intents;
  v_partner billing_private.partner_purchase_intents;
  v_state text;
begin
  if p_user_id is null or p_request_id is null or p_purchase_kind is null
    or p_purchase_kind not in ('subscription', 'top-up', 'partner')
  then
    raise exception 'Invalid checkout account or request' using errcode = '22023';
  end if;

  select customer.id into v_customer_id
  from public.billing_customers as customer
  where customer.user_id = p_user_id;

  if not found then return null; end if;

  if p_purchase_kind in ('subscription', 'top-up') then
    select checkout.* into v_checkout
    from public.checkout_intents as checkout
    where checkout.customer_id = v_customer_id
      and checkout.idempotency_key = p_request_id::text
      and (
        (p_purchase_kind = 'subscription' and checkout.intent_type = 'subscription')
        or (p_purchase_kind = 'top-up' and checkout.intent_type = 'credit_pack')
      );

    if not found then return null; end if;
    v_state := case
      when v_checkout.status = 'created' then 'prepared'
      when v_checkout.status = 'open' then 'open'
      when v_checkout.status = 'completed' then 'completed'
      when v_checkout.status = 'reconciled_no_payment' then 'closed-unpaid'
      else 'awaiting-reconciliation'
    end;
    return jsonb_build_object(
      'version', 1,
      'kind', p_purchase_kind,
      'requestId', p_request_id,
      'intentId', v_checkout.id,
      'state', v_state,
      'terminal', v_state in ('completed', 'closed-unpaid'),
      'mayStartNewCheckout',
        v_state = 'closed-unpaid' or (v_state = 'completed' and p_purchase_kind = 'top-up'),
      'checkoutUrl', case when v_checkout.status = 'open' then v_checkout.checkout_url else null end,
      'providerExpiresAt', v_checkout.expires_at,
      'updatedAt', v_checkout.updated_at
    );
  end if;

  select intent.* into v_partner
  from billing_private.partner_purchase_intents as intent
  where intent.customer_id = v_customer_id
    and intent.idempotency_key = p_request_id::text;
  if not found then return null; end if;

  v_state := case
    when v_partner.status = 'created' then 'prepared'
    when v_partner.status = 'open' then 'open'
    when v_partner.status = 'completed' then 'completed'
    else 'awaiting-reconciliation'
  end;
  return jsonb_build_object(
    'version', 1,
    'kind', 'partner',
    'requestId', p_request_id,
    'intentId', v_partner.id,
    'state', v_state,
    'terminal', v_state = 'completed',
    'mayStartNewCheckout', false,
    'checkoutUrl', case when v_partner.status = 'open' then v_partner.checkout_url else null end,
    'providerExpiresAt', v_partner.expires_at,
    'updatedAt', v_partner.updated_at
  );
end;
$$;

revoke all on function public.easyfield_account_checkout_status(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.easyfield_account_checkout_status(uuid, text, uuid)
  to service_role;

commit;
