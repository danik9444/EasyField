begin;

-- A customer may have only one externally payable subscription checkout at a
-- time. Without this boundary, two different idempotency keys can both be
-- charged while only one subscription can be materialized.
create unique index if not exists checkout_intents_one_payable_subscription_per_customer
  on public.checkout_intents (customer_id)
  where intent_type = 'subscription' and status in ('created', 'open');

-- Narrow service-role RPC surface for the EasyField account Edge Function.
-- Desktop clients cannot execute these functions and cannot write billing
-- tables. Prices and grants continue to come exclusively from private catalog
-- triggers defined by the earlier billing migrations.

create or replace function public.easyfield_account_prepare_checkout(
  p_user_id uuid,
  p_purchase_kind text,
  p_plan_key text,
  p_billing_interval text,
  p_credit_microcredits bigint,
  p_idempotency_key text,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_checkout public.checkout_intents;
  v_partner billing_private.partner_purchase_intents;
begin
  if p_user_id is null
    or p_purchase_kind not in ('subscription', 'top-up', 'partner')
    or char_length(v_key) not between 8 and 240
    or char_length(v_provider) not between 2 and 40
    or not exists (
      select 1 from auth.users as auth_user
      where auth_user.id = p_user_id
        and auth_user.email_confirmed_at is not null
        and auth_user.deleted_at is null
        and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
    )
  then
    raise exception 'Invalid checkout account or request' using errcode = '22023';
  end if;

  select account.out_customer_id, account.out_account_id
  into v_customer_id, v_account_id
  from billing_private.ensure_billing_account(p_user_id) as account;

  if p_purchase_kind = 'partner' then
    if p_plan_key is not null or p_billing_interval is not null or p_credit_microcredits is not null then
      raise exception 'Partner checkout does not accept plan or credit inputs' using errcode = '22023';
    end if;
    select intent.* into v_partner
    from billing_private.partner_purchase_intents as intent
    where intent.customer_id = v_customer_id and intent.idempotency_key = v_key;
    if not found then
      v_partner := billing_private.create_partner_purchase_intent(
        p_user_id, v_key, v_provider, clock_timestamp() + interval '30 minutes'
      );
    elsif v_partner.provider <> v_provider then
      raise exception 'Checkout idempotency key was reused with different inputs' using errcode = '22000';
    end if;
    return jsonb_build_object(
      'intentId', v_partner.id,
      'purchaseKind', 'partner',
      'offerKey', 'partner',
      'amountMinorUnits', v_partner.amount_currency_micros / 10000,
      'currencyCode', v_partner.currency_code
    );
  end if;

  select checkout.* into v_checkout
  from public.checkout_intents as checkout
  where checkout.customer_id = v_customer_id and checkout.idempotency_key = v_key;
  if found then
    if v_checkout.provider <> v_provider
      or (p_purchase_kind = 'subscription' and (
        v_checkout.intent_type <> 'subscription'
        or v_checkout.plan_key is distinct from p_plan_key
        or v_checkout.billing_interval is distinct from p_billing_interval
      ))
      or (p_purchase_kind = 'top-up' and (
        v_checkout.intent_type <> 'credit_pack'
        or v_checkout.credit_microcredits is distinct from p_credit_microcredits
      ))
    then
      raise exception 'Checkout idempotency key was reused with different inputs' using errcode = '22000';
    end if;
  else
    if p_purchase_kind = 'subscription' then
      if p_plan_key is null or p_billing_interval not in ('monthly', 'annual') or p_credit_microcredits is not null then
        raise exception 'Invalid subscription checkout' using errcode = '22023';
      end if;
      -- Do not infer that a hosted session is unpayable from a local clock.
      -- Until a signed merchant cancellation/expiry event exists, an opened
      -- subscription intent remains the only payable intent for this customer.
      if exists (
        select 1 from public.checkout_intents as active_checkout
        where active_checkout.customer_id = v_customer_id
          and active_checkout.intent_type = 'subscription'
          and active_checkout.status in ('created', 'open')
      ) then
        raise exception 'A subscription checkout is already awaiting payment' using errcode = '55000';
      end if;
      insert into public.checkout_intents (
        customer_id, intent_type, plan_key, billing_interval, pricing_version,
        monthly_grant_microcredits, top_up_currency_micros_per_credit,
        minimum_top_up_currency_micros, idempotency_key, provider,
        amount_currency_micros, currency_code, credit_microcredits,
        expires_at
      ) values (
        v_customer_id, 'subscription', p_plan_key, p_billing_interval, 'catalog-pending',
        1, 1, 1, v_key, v_provider, 1, 'USD', 0,
        clock_timestamp() + interval '30 minutes'
      ) returning * into v_checkout;
    else
      if p_plan_key is not null or p_billing_interval is not null
        or p_credit_microcredits is null or p_credit_microcredits <= 0
      then
        raise exception 'Invalid top-up checkout' using errcode = '22023';
      end if;
      insert into public.checkout_intents (
        customer_id, intent_type, plan_key, billing_interval, pricing_version,
        monthly_grant_microcredits, top_up_currency_micros_per_credit,
        minimum_top_up_currency_micros, idempotency_key, provider,
        amount_currency_micros, currency_code, credit_microcredits,
        expires_at
      ) values (
        v_customer_id, 'credit_pack', null, null, 'catalog-pending',
        1, 1, 1, v_key, v_provider, 1, 'USD', p_credit_microcredits,
        clock_timestamp() + interval '30 minutes'
      ) returning * into v_checkout;
    end if;
  end if;

  if v_checkout.amount_currency_micros % 10000 <> 0 then
    raise exception 'Catalog price is not representable by the payment rail' using errcode = '22003';
  end if;
  return jsonb_build_object(
    'intentId', v_checkout.id,
    'purchaseKind', case when v_checkout.intent_type = 'subscription' then 'subscription' else 'top-up' end,
    'offerKey', case
      when v_checkout.intent_type = 'subscription'
        then 'subscription:' || v_checkout.plan_key || ':' || v_checkout.billing_interval
      else 'top-up:' || v_checkout.plan_key
    end,
    'amountMinorUnits', v_checkout.amount_currency_micros / 10000,
    'currencyCode', v_checkout.currency_code
  );
end;
$$;

create or replace function public.easyfield_account_open_checkout(
  p_user_id uuid,
  p_intent_id uuid,
  p_purchase_kind text,
  p_provider text,
  p_provider_checkout_ref text,
  p_checkout_url text,
  p_expires_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_checkout public.checkout_intents;
  v_partner billing_private.partner_purchase_intents;
  v_ref text := btrim(coalesce(p_provider_checkout_ref, ''));
  v_url text := btrim(coalesce(p_checkout_url, ''));
begin
  if p_user_id is null or p_intent_id is null
    or p_purchase_kind not in ('subscription', 'top-up', 'partner')
    or char_length(lower(btrim(coalesce(p_provider, '')))) not between 2 and 40
    or char_length(v_ref) not between 1 and 500
    or char_length(v_url) not between 10 and 4096
    or v_url !~ '^https://[^[:space:]]+$'
    or (p_expires_at is not null and p_expires_at <= clock_timestamp())
  then
    raise exception 'Invalid hosted checkout session' using errcode = '22023';
  end if;
  select customer.id into v_customer_id
  from public.billing_customers as customer where customer.user_id = p_user_id;
  if not found then raise exception 'Billing customer not found' using errcode = '23503'; end if;

  if p_purchase_kind = 'partner' then
    select intent.* into v_partner
    from billing_private.partner_purchase_intents as intent
    where intent.id = p_intent_id and intent.customer_id = v_customer_id for update;
    if not found or v_partner.provider <> lower(btrim(p_provider)) then
      raise exception 'Partner checkout does not belong to this account' using errcode = '42501';
    end if;
    if v_partner.status = 'open' then
      if v_partner.provider_checkout_ref is distinct from v_ref or v_partner.checkout_url is distinct from v_url then
        raise exception 'Hosted checkout retry returned different inputs' using errcode = '22000';
      end if;
      return true;
    end if;
    perform billing_private.set_partner_purchase_intent_state(
      p_intent_id, 'open', v_ref, v_url, null, null, coalesce(p_expires_at, v_partner.expires_at)
    );
    return true;
  end if;

  select checkout.* into v_checkout
  from public.checkout_intents as checkout
  where checkout.id = p_intent_id and checkout.customer_id = v_customer_id for update;
  if not found or v_checkout.provider <> lower(btrim(p_provider))
    or (p_purchase_kind = 'subscription') <> (v_checkout.intent_type = 'subscription')
  then
    raise exception 'Checkout does not belong to this account' using errcode = '42501';
  end if;
  if v_checkout.status = 'open' then
    if v_checkout.provider_checkout_ref is distinct from v_ref or v_checkout.checkout_url is distinct from v_url then
      raise exception 'Hosted checkout retry returned different inputs' using errcode = '22000';
    end if;
    return true;
  end if;
  if v_checkout.status <> 'created' then
    raise exception 'Checkout is no longer openable' using errcode = '55000';
  end if;
  update public.checkout_intents
  set provider_checkout_ref = v_ref,
      checkout_url = v_url,
      status = 'open',
      expires_at = coalesce(p_expires_at, expires_at)
  where id = p_intent_id;
  return true;
end;
$$;

create or replace function public.easyfield_account_set_auto_reload(
  p_user_id uuid,
  p_enabled boolean,
  p_trigger_below_microcredits bigint,
  p_reload_microcredits bigint,
  p_idempotency_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_plan_key text;
  v_payment_method_id uuid;
begin
  if p_user_id is null or p_enabled is null
    or char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 240
    or p_trigger_below_microcredits is null or p_trigger_below_microcredits < 0
    or p_reload_microcredits is null or p_reload_microcredits < 0
    or (p_enabled and p_reload_microcredits = 0)
  then
    raise exception 'Invalid auto-reload policy' using errcode = '22023';
  end if;
  select account.out_customer_id, account.out_account_id
  into v_customer_id, v_account_id
  from billing_private.ensure_billing_account(p_user_id) as account;

  if not p_enabled then
    insert into public.auto_reload_settings (
      account_id, enabled, trigger_below_microcredits, reload_microcredits
    ) values (v_account_id, false, 0, 0)
    on conflict (account_id) do update
      set enabled = false, trigger_below_microcredits = 0, reload_microcredits = 0;
    return true;
  end if;

  select subscription.plan_key into v_plan_key
  from public.subscriptions as subscription
  where subscription.customer_id = v_customer_id
    and subscription.status in ('trialing', 'active')
    and coalesce(subscription.entitlement_ends_at, subscription.current_period_end) > clock_timestamp()
  order by subscription.current_period_end desc nulls last, subscription.created_at desc
  limit 1;
  if not found then raise exception 'An active subscription is required' using errcode = '42501'; end if;

  select method.id into v_payment_method_id
  from billing_private.saved_payment_methods as method
  where method.customer_id = v_customer_id and method.status = 'active'
    and 'USD' = any(method.supported_currencies)
  order by method.updated_at desc, method.created_at desc
  limit 1;
  if not found then
    raise exception 'A reusable payment method is required before enabling auto-reload' using errcode = '42501';
  end if;

  insert into public.auto_reload_settings (
    account_id, enabled, trigger_below_microcredits, reload_microcredits,
    saved_payment_method_id, plan_key
  ) values (
    v_account_id, true, p_trigger_below_microcredits, p_reload_microcredits,
    v_payment_method_id, v_plan_key
  )
  on conflict (account_id) do update
    set enabled = true,
        trigger_below_microcredits = excluded.trigger_below_microcredits,
        reload_microcredits = excluded.reload_microcredits,
        saved_payment_method_id = excluded.saved_payment_method_id,
        plan_key = excluded.plan_key;
  return true;
end;
$$;

create or replace function public.easyfield_account_has_direct_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select billing_private.can_use_direct_provider_billing(p_user_id);
$$;

create or replace function public.easyfield_account_record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_provider_delivery_id text,
  p_raw_body_sha256 text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result record;
begin
  select * into v_result
  from billing_private.record_payment_event(
    p_provider,
    p_provider_event_id,
    p_provider_delivery_id,
    'payment/received',
    p_raw_body_sha256,
    p_payload
  );
  -- Recording signed evidence is deliberately separate from entitlement
  -- reconciliation. This function never marks an event processed and never
  -- grants credits merely because a webhook was accepted.
  return jsonb_build_object(
    'paymentEventId', v_result.payment_event_id,
    'eventStatus', v_result.event_status,
    'eventInserted', v_result.event_inserted,
    'deliveryInserted', v_result.delivery_inserted
  );
end;
$$;

revoke all on function public.easyfield_account_prepare_checkout(uuid, text, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.easyfield_account_open_checkout(uuid, uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.easyfield_account_set_auto_reload(uuid, boolean, bigint, bigint, text)
  from public, anon, authenticated;
revoke all on function public.easyfield_account_has_direct_access(uuid)
  from public, anon, authenticated;
revoke all on function public.easyfield_account_record_payment_event(text, text, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.easyfield_account_prepare_checkout(uuid, text, text, text, bigint, text, text)
  to service_role;
grant execute on function public.easyfield_account_open_checkout(uuid, uuid, text, text, text, text, timestamptz)
  to service_role;
grant execute on function public.easyfield_account_set_auto_reload(uuid, boolean, bigint, bigint, text)
  to service_role;
grant execute on function public.easyfield_account_has_direct_access(uuid)
  to service_role;
grant execute on function public.easyfield_account_record_payment_event(text, text, text, text, jsonb)
  to service_role;

commit;
