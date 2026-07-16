begin;

-- The webhook parser now preserves the signed subscription identity and paid
-- period in the provider-neutral evidence.  The shape remains deliberately
-- closed: no raw provider object, customer PII or caller-supplied grant amount
-- can enter the reconciliation transaction.
create or replace function billing_private.payment_reconciliation_payload_is_valid(
  p_payload jsonb,
  p_event_type text
)
returns boolean
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_issue jsonb;
  v_transaction jsonb;
  v_ready boolean;
  v_subscription_context_count integer;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_payload) as payload_keys(key_name)
      where key_name <> all (array[
        'type', 'id', 'reconciliationState', 'entitlementGrantAllowed', 'issues',
        'operationReference', 'subscriptionReference', 'periodStart', 'periodEnd',
        'total', 'transactions'
      ])
    )
    or not (p_payload ?& array[
      'type', 'reconciliationState', 'entitlementGrantAllowed', 'issues'
    ])
    or jsonb_typeof(p_payload->'type') <> 'string'
    or p_payload->>'type' is distinct from p_event_type
    or jsonb_typeof(p_payload->'reconciliationState') <> 'string'
    or p_payload->>'reconciliationState' not in ('ready', 'needs_reconciliation')
    or jsonb_typeof(p_payload->'entitlementGrantAllowed') <> 'boolean'
    or p_payload->'entitlementGrantAllowed' <> 'false'::jsonb
    or jsonb_typeof(p_payload->'issues') <> 'array'
    or jsonb_array_length(p_payload->'issues') > 64
  then
    return false;
  end if;

  if p_payload ? 'id' and (
    jsonb_typeof(p_payload->'id') <> 'string'
    or p_payload->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ) then
    return false;
  end if;
  for v_issue in select value from jsonb_array_elements(p_payload->'issues') loop
    if jsonb_typeof(v_issue) <> 'string'
      or (v_issue #>> '{}') !~ '^[a-z0-9_]{1,200}$'
    then
      return false;
    end if;
  end loop;

  v_ready := p_payload->>'reconciliationState' = 'ready';
  if (v_ready and jsonb_array_length(p_payload->'issues') <> 0)
    or (not v_ready and jsonb_array_length(p_payload->'issues') = 0)
  then
    return false;
  end if;

  if p_event_type <> 'payment/received' then
    if p_payload ?| array[
      'operationReference', 'subscriptionReference', 'periodStart', 'periodEnd',
      'total', 'transactions'
    ] or (v_ready and not (p_payload ? 'id'))
    then
      return false;
    end if;
    return true;
  end if;

  if not (p_payload ?& array[
      'id', 'operationReference', 'subscriptionReference', 'periodStart',
      'periodEnd', 'total', 'transactions'
    ])
    or jsonb_typeof(p_payload->'operationReference') <> 'string'
    or p_payload->>'operationReference'
      !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or not billing_private.payment_reconciliation_amount_is_valid(p_payload->'total')
    or jsonb_typeof(p_payload->'transactions') <> 'array'
    or (v_ready and jsonb_array_length(p_payload->'transactions') <> 1)
    or (not v_ready and jsonb_array_length(p_payload->'transactions') > 100)
  then
    return false;
  end if;

  v_subscription_context_count :=
    case when jsonb_typeof(p_payload->'subscriptionReference') = 'string' then 1 else 0 end
    + case when jsonb_typeof(p_payload->'periodStart') = 'string' then 1 else 0 end
    + case when jsonb_typeof(p_payload->'periodEnd') = 'string' then 1 else 0 end;
  if v_subscription_context_count not in (0, 3)
    or (
      v_subscription_context_count = 0
      and (
        jsonb_typeof(p_payload->'subscriptionReference') <> 'null'
        or jsonb_typeof(p_payload->'periodStart') <> 'null'
        or jsonb_typeof(p_payload->'periodEnd') <> 'null'
      )
    )
    or (
      v_subscription_context_count = 3
      and (
        p_payload->>'subscriptionReference' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$'
        or p_payload->>'periodStart'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
        or p_payload->>'periodEnd'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
      )
    )
  then
    return false;
  end if;

  for v_transaction in select value from jsonb_array_elements(p_payload->'transactions') loop
    if jsonb_typeof(v_transaction) <> 'object'
      or exists (
        select 1 from jsonb_object_keys(v_transaction) as transaction_keys(key_name)
        where key_name <> all (array['id', 'createdAt', 'amount', 'gatewayTransactionId'])
      )
      or (v_transaction ? 'id' and (
        jsonb_typeof(v_transaction->'id') <> 'string'
        or v_transaction->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      ))
      or (v_transaction ? 'gatewayTransactionId' and (
        jsonb_typeof(v_transaction->'gatewayTransactionId') <> 'string'
        or v_transaction->>'gatewayTransactionId'
          !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      ))
      or (v_transaction ? 'createdAt' and (
        jsonb_typeof(v_transaction->'createdAt') <> 'number'
        or v_transaction->>'createdAt' !~ '^[0-9]+$'
        or (v_transaction->>'createdAt')::numeric not between 1 and 9007199254740991
      ))
      or (v_transaction ? 'amount' and
        not billing_private.payment_reconciliation_amount_is_valid(v_transaction->'amount'))
      or (v_ready and (
        not (v_transaction ?& array['id', 'amount'])
        or v_transaction->>'id' is distinct from p_payload->>'id'
        or v_transaction->'amount' is distinct from p_payload->'total'
      ))
    then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

-- One service-role RPC owns the complete payment transition. PostgreSQL rolls
-- back the signed evidence, event claim, checkout completion, subscription,
-- entitlement, grant lot and ledger together if any assertion fails. A replay
-- observes the immutable global payment claim and returns without granting.
create or replace function public.easyfield_account_reconcile_payment_event(
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
  v_record record;
  v_event public.payment_events;
  v_claim billing_private.payment_entitlement_claims;
  v_claim_id uuid := extensions.gen_random_uuid();
  v_operation_id uuid;
  v_checkout public.checkout_intents;
  v_partner billing_private.partner_purchase_intents;
  v_has_checkout boolean := false;
  v_has_partner boolean := false;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_subscription_ref text;
  v_subscription public.subscriptions;
  v_has_subscription boolean := false;
  v_schedule public.subscription_grant_schedule;
  v_lot public.credit_grant_lots;
  v_user_id uuid;
  v_expected_period interval;
  v_purchase_kind text;
  v_granted_microcredits bigint := 0;
  v_failure text;
begin
  select * into v_record
  from billing_private.record_payment_event(
    p_provider,
    p_provider_event_id,
    p_provider_delivery_id,
    'payment/received',
    p_raw_body_sha256,
    p_payload
  );

  -- This inner block is a PostgreSQL subtransaction. If materialization fails,
  -- all claim/checkout/entitlement/grant writes below are rolled back together;
  -- the outer block can still retain the immutable signed event as `failed` so
  -- an operator has evidence and a later identical delivery can retry it.
  begin
  select event.* into v_event
  from public.payment_events as event
  where event.id = v_record.payment_event_id
  for update;
  if not found then
    raise exception 'Recorded payment event was not found' using errcode = 'P0001';
  end if;

  begin
    v_operation_id := (v_event.payload->>'operationReference')::uuid;
  exception when others then
    raise exception 'Payment operation reference is invalid' using errcode = '22023';
  end;
  v_subscription_ref := nullif(v_event.payload->>'subscriptionReference', '');
  if v_subscription_ref is not null then
    begin
      v_period_start := (v_event.payload->>'periodStart')::timestamptz;
      v_period_end := (v_event.payload->>'periodEnd')::timestamptz;
    exception when others then
      raise exception 'Payment subscription period is invalid' using errcode = '22023';
    end;
  end if;

  if v_event.status = 'processed' then
    select claim.* into v_claim
    from billing_private.payment_entitlement_claims as claim
    where claim.payment_event_id = v_event.id;
    if not found or v_claim.claim_id <> v_operation_id then
      raise exception 'Processed payment event has no matching commercial claim'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'processed', true,
      'replayed', true,
      'intentId', v_claim.claim_id,
      'purchaseKind', v_claim.claim_type,
      'grantedMicrocredits', 0
    );
  end if;
  if v_event.status = 'ignored' then
    raise exception 'Payment event is already terminal' using errcode = '55000';
  end if;

  select checkout.* into v_checkout
  from public.checkout_intents as checkout
  where checkout.id = v_operation_id
  for update;
  v_has_checkout := found;

  select partner.* into v_partner
  from billing_private.partner_purchase_intents as partner
  where partner.id = v_operation_id
  for update;
  v_has_partner := found;

  if v_has_checkout = v_has_partner then
    raise exception 'Payment operation does not identify exactly one checkout'
      using errcode = '23503';
  end if;

  if v_has_checkout then
    if v_checkout.provider is distinct from v_event.provider
      or v_checkout.provider_checkout_ref is null
      or v_checkout.checkout_url is null
      or v_checkout.status not in ('open', 'expired', 'cancelled', 'failed')
      or v_event.payload->'total'->>'currency' is distinct from v_checkout.currency_code
      or v_event.payload->'total'->>'exponent' is distinct from '2'
      or (v_event.payload->'total'->>'minorUnits')::numeric * 10000::numeric
        is distinct from v_checkout.amount_currency_micros::numeric
    then
      raise exception 'Payment does not reconcile with its checkout'
        using errcode = '42501';
    end if;

    if v_checkout.intent_type = 'subscription' then
      -- Serialize all first-subscription materialization for this customer so
      -- two distinct paid checkout UUIDs cannot both observe an empty active
      -- subscription set and commit concurrently.
      perform 1
      from public.billing_customers as customer
      where customer.id = v_checkout.customer_id
      for update;
      if not found then
        raise exception 'Checkout customer was not found' using errcode = '23503';
      end if;
      if v_subscription_ref is null or v_period_start is null or v_period_end is null then
        raise exception 'Subscription payment is missing its signed period'
          using errcode = '22023';
      end if;
      v_expected_period := case v_checkout.billing_interval
        when 'monthly' then interval '1 month'
        when 'annual' then interval '1 year'
        else null
      end;
      if v_expected_period is null
        or v_period_end is distinct from v_period_start + v_expected_period
        or v_period_start > clock_timestamp()
        or v_period_end <= clock_timestamp()
      then
        raise exception 'Subscription payment period does not match its checkout'
          using errcode = '42501';
      end if;
      select subscription.* into v_subscription
      from public.subscriptions as subscription
      where subscription.provider = v_checkout.provider
        and subscription.provider_subscription_ref = v_subscription_ref
      for update;
      v_has_subscription := found;
      if v_has_subscription and (
        v_subscription.customer_id <> v_checkout.customer_id
        or v_subscription.plan_key <> v_checkout.plan_key
        or v_subscription.billing_interval <> v_checkout.billing_interval
        or v_subscription.pricing_version <> v_checkout.pricing_version
        or v_subscription.currency_code <> v_checkout.currency_code
        or v_subscription.unit_amount_currency_micros <> v_checkout.amount_currency_micros
        or v_subscription.included_microcredits_per_grant
          <> v_checkout.monthly_grant_microcredits
        or v_subscription.status <> 'incomplete'
        or v_subscription.current_period_start is not null
        or v_subscription.current_period_end is not null
        or v_subscription.entitlement_ends_at is not null
        or v_subscription.annual_checkout_intent_id is not null
        or v_subscription.annual_renewal_attempt_id is not null
      ) then
        raise exception 'Subscription payment conflicts with its persisted subscription'
          using errcode = '23505';
      end if;
      if exists (
        select 1 from public.subscriptions as existing
        where existing.customer_id = v_checkout.customer_id
          and existing.status not in ('canceled', 'expired')
          and (not v_has_subscription or existing.id <> v_subscription.id)
      ) then
        raise exception 'Subscription payment conflicts with an existing subscription'
          using errcode = '23505';
      end if;
    elsif v_subscription_ref is not null or v_period_start is not null or v_period_end is not null then
      raise exception 'One-time payment must not contain subscription context'
        using errcode = '22023';
    end if;
  else
    if v_partner.provider is distinct from v_event.provider
      or v_partner.provider_checkout_ref is null
      or v_partner.checkout_url is null
      or v_partner.status not in ('open', 'expired', 'cancelled', 'failed')
      or v_event.payload->'total'->>'currency' is distinct from v_partner.currency_code
      or v_event.payload->'total'->>'exponent' is distinct from '2'
      or (v_event.payload->'total'->>'minorUnits')::numeric * 10000::numeric
        is distinct from v_partner.amount_currency_micros::numeric
      or v_subscription_ref is not null
      or v_period_start is not null
      or v_period_end is not null
    then
      raise exception 'Payment does not reconcile with its Partner checkout'
        using errcode = '42501';
    end if;
  end if;

  -- Claim and finish only after every signed-vs-catalog assertion succeeds.
  -- They still precede checkout completion because completion triggers verify
  -- the processed event; all writes remain in this one database transaction.
  perform billing_private.claim_payment_event(v_event.id, v_claim_id);
  perform billing_private.finish_payment_event(v_event.id, v_claim_id, 'processed', null);

  if v_has_partner then
    perform billing_private.set_partner_purchase_intent_state(
      v_partner.id,
      'completed',
      v_partner.provider_checkout_ref,
      v_partner.checkout_url,
      v_event.id,
      v_event.provider_event_id,
      v_partner.expires_at
    );
    v_purchase_kind := 'partner_lifetime';
  else
    update public.checkout_intents
    set status = 'completed',
        completed_at = clock_timestamp(),
        completed_payment_event_id = v_event.id,
        provider_payment_ref = v_event.provider_event_id,
        subscription_period_start = case
          when v_checkout.intent_type = 'subscription' then v_period_start else null end,
        subscription_period_end = case
          when v_checkout.intent_type = 'subscription' then v_period_end else null end
    where id = v_checkout.id
    returning * into v_checkout;

    select customer.user_id into v_user_id
    from public.billing_customers as customer
    where customer.id = v_checkout.customer_id;
    if not found then
      raise exception 'Checkout customer was not found' using errcode = '23503';
    end if;

    if v_checkout.intent_type = 'subscription' then
      if v_has_subscription then
        update public.subscriptions
        set status = 'active',
            current_period_start = v_period_start,
            current_period_end = v_period_end,
            entitlement_ends_at = v_period_end,
            cancel_at_period_end = false,
            provider_metadata = provider_metadata || jsonb_build_object(
              'initialCheckoutIntentId', v_checkout.id
            ),
            annual_checkout_intent_id = case
              when v_checkout.billing_interval = 'annual' then v_checkout.id else null end,
            annual_renewal_attempt_id = null
        where id = v_subscription.id
        returning * into v_subscription;
      else
        insert into public.subscriptions (
        customer_id,
        provider,
        provider_subscription_ref,
        plan_key,
        billing_interval,
        pricing_version,
        status,
        current_period_start,
        current_period_end,
        entitlement_ends_at,
        cancel_at_period_end,
        currency_code,
        unit_amount_currency_micros,
        included_microcredits_per_grant,
        provider_metadata,
        annual_checkout_intent_id,
        annual_renewal_attempt_id
      ) values (
        v_checkout.customer_id,
        v_checkout.provider,
        v_subscription_ref,
        v_checkout.plan_key,
        v_checkout.billing_interval,
        v_checkout.pricing_version,
        'active',
        v_period_start,
        v_period_end,
        v_period_end,
        false,
        v_checkout.currency_code,
        v_checkout.amount_currency_micros,
        v_checkout.monthly_grant_microcredits,
        jsonb_build_object('initialCheckoutIntentId', v_checkout.id),
        case when v_checkout.billing_interval = 'annual' then v_checkout.id else null end,
        null
        ) returning * into v_subscription;
      end if;

      if v_checkout.billing_interval = 'monthly' then
        v_lot := billing_private.grant_credits(
          v_user_id,
          v_checkout.monthly_grant_microcredits,
          'subscription',
          'paid:checkout:' || v_checkout.id::text,
          v_checkout.id::text,
          v_subscription.id,
          v_period_start,
          v_period_end,
          v_checkout.amount_currency_micros,
          v_checkout.currency_code,
          jsonb_build_object('payment_event_id', v_event.id),
          v_checkout.id,
          null
        );
      else
        perform billing_private.schedule_annual_plan_grants(
          v_subscription.id,
          v_period_start,
          v_checkout.monthly_grant_microcredits,
          12,
          interval '1 month'
        );
        select schedule.* into v_schedule
        from public.subscription_grant_schedule as schedule
        where schedule.subscription_id = v_subscription.id
          and schedule.period_anchor = v_period_start
          and schedule.grant_number = 1
        for update;
        if not found or v_schedule.status <> 'pending'
          or v_schedule.scheduled_for > clock_timestamp()
        then
          raise exception 'Initial annual grant was not scheduled as due'
            using errcode = 'P0001';
        end if;
        update public.subscription_grant_schedule
        set status = 'granting'
        where id = v_schedule.id;
        v_lot := billing_private.grant_credits(
          v_user_id,
          v_schedule.amount_microcredits,
          'annual_monthly_grant',
          v_schedule.idempotency_key,
          v_schedule.id::text,
          v_schedule.subscription_id,
          v_schedule.scheduled_for,
          v_schedule.lot_expires_at,
          null,
          null,
          jsonb_build_object(
            'schedule_id', v_schedule.id,
            'grant_number', v_schedule.grant_number,
            'period_anchor', v_schedule.period_anchor,
            'payment_event_id', v_event.id
          ),
          null,
          null
        );
        update public.subscription_grant_schedule
        set status = 'granted',
            granted_lot_id = v_lot.id,
            granted_at = clock_timestamp()
        where id = v_schedule.id;
      end if;
      v_purchase_kind := 'subscription';
      v_granted_microcredits := v_checkout.monthly_grant_microcredits;
    else
      v_lot := billing_private.grant_credits(
        v_user_id,
        v_checkout.credit_microcredits,
        v_checkout.intent_type,
        'paid:checkout:' || v_checkout.id::text,
        v_checkout.id::text,
        null,
        clock_timestamp(),
        null,
        v_checkout.amount_currency_micros,
        v_checkout.currency_code,
        jsonb_build_object('payment_event_id', v_event.id),
        v_checkout.id,
        null
      );
      v_purchase_kind := v_checkout.intent_type;
      v_granted_microcredits := v_checkout.credit_microcredits;
    end if;
  end if;

  return jsonb_build_object(
    'processed', true,
    'replayed', false,
    'intentId', v_operation_id,
    'purchaseKind', v_purchase_kind,
    'grantedMicrocredits', v_granted_microcredits
  );
  exception when others then
    v_failure := left(sqlerrm, 4000);
    select event.* into v_event
    from public.payment_events as event
    where event.id = v_record.payment_event_id
    for update;
    if found and v_event.status in ('received', 'failed') then
      begin
        perform billing_private.claim_payment_event(v_event.id, v_claim_id);
        perform billing_private.finish_payment_event(
          v_event.id,
          v_claim_id,
          'failed',
          coalesce(nullif(v_failure, ''), 'Payment reconciliation failed')
        );
      exception when others then
        -- Never turn a concurrent event claim into a second writer. The webhook
        -- still receives `processed = false` and retries later.
        null;
      end;
    end if;
    return jsonb_build_object(
      'processed', false,
      'replayed', false,
      'retryable', true
    );
  end;
end;
$$;

revoke all on function public.easyfield_account_reconcile_payment_event(
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.easyfield_account_reconcile_payment_event(
  text, text, text, text, jsonb
) to service_role;

commit;
