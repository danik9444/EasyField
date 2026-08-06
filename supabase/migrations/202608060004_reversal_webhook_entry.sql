begin;

-- The entry point a reversal webhook calls.
--
-- 202608060003 built `billing_private.reconcile_payment_reversal`, which takes
-- two internal `public.payment_events` ids. A webhook knows neither: it knows
-- the provider's own reference for the reversal and for the payment being
-- reversed. This migration is the translation, and it mirrors
-- `easyfield_account_reconcile_payment_event` (202607150005) — same argument
-- shape, same recording primitive, same replay semantics — so both webhook
-- paths behave identically from the edge function's point of view.
--
-- It resolves the original payment by (provider, provider_event_id). If that
-- payment was never recorded, it raises rather than guessing: a reversal of
-- something this database has never seen is not a reversal it can reason
-- about, and inventing one would revoke the wrong customer's access.
--
-- FIRST, THOUGH: `billing_private.record_payment_event` accepted exactly one
-- event type. Its gate reads `v_event_type is distinct from 'payment/received'`
-- and raises 22023 otherwise, so a reversal could not be recorded at all — the
-- dedup, delivery-tracking and replay-detection that every payment event goes
-- through were unreachable for reversals. Rather than add a second recording
-- path (and a second place for replay logic to drift), the existing one learns
-- the second type and validates each payload against its own shape.

-- -------------------------------------------------------------------------
-- Reversal payload shape
-- -------------------------------------------------------------------------

-- The sibling of `payment_reconciliation_payload_is_valid`, for the reversal
-- envelope the edge function normalises to. Keys are checked exactly, so an
-- unexpected field is a rejection rather than something silently carried into
-- an append-only evidence row.
create or replace function billing_private.payment_reversal_payload_is_valid(p_payload jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_total jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then return false; end if;
  if p_payload->>'type' is distinct from 'payment/reversed' then return false; end if;

  if (select count(*) from jsonb_object_keys(p_payload) as key
      where key not in ('type', 'id', 'reversedPaymentReference', 'reversalType', 'reason', 'total')) > 0
  then
    return false;
  end if;

  if jsonb_typeof(p_payload->'id') <> 'string'
    or char_length(p_payload->>'id') not between 1 and 300
    or jsonb_typeof(p_payload->'reversedPaymentReference') <> 'string'
    or char_length(p_payload->>'reversedPaymentReference') not between 1 and 300
    or p_payload->>'reversalType' not in ('refund', 'chargeback', 'dispute_lost')
    or jsonb_typeof(p_payload->'reason') <> 'string'
    or char_length(btrim(p_payload->>'reason')) not between 3 and 1000
  then
    return false;
  end if;

  -- A reversal that references itself would resolve to its own event row.
  if p_payload->>'id' = p_payload->>'reversedPaymentReference' then return false; end if;

  v_total := p_payload->'total';
  if jsonb_typeof(v_total) <> 'object'
    or (select count(*) from jsonb_object_keys(v_total) as key
        where key not in ('currency', 'minorUnits', 'exponent')) > 0
    or coalesce(v_total->>'currency', '') !~ '^[A-Z]{3}$'
    or jsonb_typeof(v_total->'minorUnits') <> 'number'
    or (v_total->>'minorUnits')::numeric <= 0
    or (v_total->>'minorUnits')::numeric <> trunc((v_total->>'minorUnits')::numeric)
    or (v_total->>'exponent') is distinct from '2'
  then
    return false;
  end if;

  return true;
end;
$$;

-- -------------------------------------------------------------------------
-- One recording path, two event types
-- -------------------------------------------------------------------------

-- Byte-for-byte the deployed body apart from the event-type gate and the
-- validator dispatch. Every dedup, replay and delivery guarantee is preserved,
-- including the 22000 raises that make replayed evidence a hard error.
create or replace function billing_private.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_provider_delivery_id text,
  p_event_type text,
  p_raw_body_sha256 text,
  p_payload jsonb
)
returns table (
  payment_event_id uuid,
  payment_delivery_id uuid,
  event_inserted boolean,
  delivery_inserted boolean,
  event_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(p_provider));
  v_event_id text := nullif(btrim(p_provider_event_id), '');
  v_delivery_id text := btrim(p_provider_delivery_id);
  v_event_type text := btrim(p_event_type);
  v_payload_event_id text;
  v_payload_hash text;
  v_event public.payment_events;
  v_delivery billing_private.payment_event_deliveries;
  v_payload_ok boolean;
begin
  v_payload_ok := case
    when v_event_type = 'payment/received'
      then billing_private.payment_reconciliation_payload_is_valid(p_payload, v_event_type)
    when v_event_type = 'payment/reversed'
      then billing_private.payment_reversal_payload_is_valid(p_payload)
    else false
  end;

  if v_provider is null or char_length(v_provider) not between 2 and 40
    or (v_event_id is not null and char_length(v_event_id) > 300)
    or char_length(coalesce(v_delivery_id, '')) not between 1 and 300
    or v_event_type not in ('payment/received', 'payment/reversed')
    or p_raw_body_sha256 is null or p_raw_body_sha256 !~ '^[0-9a-f]{64}$'
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 262144
    or not v_payload_ok
  then
    raise exception 'Invalid payment event' using errcode = '22023';
  end if;
  if p_payload ? 'id' then
    if jsonb_typeof(p_payload->'id') <> 'string'
      or char_length(p_payload->>'id') not between 1 and 300
      or (v_event_id is not null and p_payload->>'id' is distinct from v_event_id)
    then
      raise exception 'Signed payment event ID does not match its normalized payload'
        using errcode = '22000';
    end if;
    v_payload_event_id := p_payload->>'id';
    v_event_id := coalesce(v_event_id, v_payload_event_id);
  end if;
  -- The signed provider event ID is optional in the published schema. Derive a
  -- stable identity inside this trusted function when absent; no handler or
  -- renderer is allowed to choose a replacement identity.
  v_event_id := coalesce(v_event_id, 'body:' || p_raw_body_sha256);
  v_payload_hash := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');

  insert into public.payment_events (
    provider, provider_event_id, event_type, raw_body_sha256, payload_sha256, payload
  ) values (
    v_provider, v_event_id, v_event_type, p_raw_body_sha256, v_payload_hash, p_payload
  ) on conflict do nothing
  returning * into v_event;
  event_inserted := found;

  select * into v_event from public.payment_events
  where provider = v_provider and provider_event_id = v_event_id
  for update;
  if not found then
    select * into v_event from public.payment_events
    where provider = v_provider and raw_body_sha256 = p_raw_body_sha256
    for update;
  end if;
  if not found then
    raise exception 'Payment event deduplication conflict could not be resolved'
      using errcode = 'P0001';
  end if;
  if v_event.provider_event_id <> v_event_id
    or v_event.event_type <> v_event_type
    or v_event.raw_body_sha256 <> p_raw_body_sha256
    or v_event.payload_sha256 <> v_payload_hash
  then
    raise exception 'Signed payment event ID was replayed with different evidence'
      using errcode = '22000';
  end if;

  select * into v_delivery from billing_private.payment_event_deliveries
  where provider = v_provider and provider_delivery_id = v_delivery_id
  for update;
  if found then
    delivery_inserted := false;
  else
    insert into billing_private.payment_event_deliveries (
      payment_event_id, provider, provider_delivery_id, raw_body_sha256
    ) values (
      v_event.id, v_provider, v_delivery_id, p_raw_body_sha256
    ) on conflict do nothing
    returning * into v_delivery;
    delivery_inserted := found;

    if not found then
      -- Resolve a concurrent reuse of this transport ID first so conflicting
      -- evidence is rejected, then fall back to the one canonical delivery
      -- row already retained for this signed event.
      select * into v_delivery
      from billing_private.payment_event_deliveries
      where provider = v_provider and provider_delivery_id = v_delivery_id
      for update;
      if not found then
        select * into v_delivery
        from billing_private.payment_event_deliveries
        where payment_event_id = v_event.id
        for update;
      end if;
    end if;
  end if;
  if not found
    or v_delivery.provider <> v_provider
    or v_delivery.payment_event_id <> v_event.id
    or v_delivery.raw_body_sha256 <> p_raw_body_sha256
  then
    raise exception 'Payment delivery ID was replayed with different evidence'
      using errcode = '22000';
  end if;
  payment_event_id := v_event.id;
  payment_delivery_id := v_delivery.id;
  event_status := v_event.status;
  return next;
end;
$$;

-- -------------------------------------------------------------------------
-- The reversal entry point
-- -------------------------------------------------------------------------

create or replace function public.easyfield_account_reconcile_payment_reversal(
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
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_event record;
  v_reversed_ref text;
  v_original_id uuid;
  v_result jsonb;
begin
  -- Shape is enforced once, by the validator record_payment_event already
  -- runs. Re-checking it here would be a second place for the two to drift.
  if char_length(v_provider) not between 2 and 40
    or not billing_private.payment_reversal_payload_is_valid(p_payload)
  then
    raise exception 'Invalid reversal webhook' using errcode = '22023';
  end if;

  v_reversed_ref := p_payload->>'reversedPaymentReference';

  select * into v_event
  from billing_private.record_payment_event(
    v_provider, p_provider_event_id, p_provider_delivery_id,
    'payment/reversed', p_raw_body_sha256, p_payload
  );

  if v_event.event_status = 'processed' then
    return jsonb_build_object('processed', true, 'replayed', true, 'reversal', null);
  end if;

  select event.id into v_original_id
  from public.payment_events as event
  where event.provider = v_provider
    and event.provider_event_id = v_reversed_ref
    and event.event_type = 'payment/received';
  if not found then
    raise exception 'The reversed payment was never recorded' using errcode = '23503';
  end if;

  -- Minor units to micro-units: the catalog stores money in micros and the
  -- rail speaks cents, the same factor prepare_checkout divides by.
  v_result := billing_private.reconcile_payment_reversal(
    v_event.payment_event_id,
    v_original_id,
    p_payload->>'id',
    p_payload->>'reversalType',
    (p_payload->'total'->>'minorUnits')::bigint * 10000,
    btrim(p_payload->>'reason')
  );

  update public.payment_events
  set status = 'processed', processed_at = clock_timestamp()
  where id = v_event.payment_event_id
    and status <> 'processed';

  return jsonb_build_object(
    'processed', true,
    'replayed', not v_event.event_inserted,
    'reversal', v_result
  );
end;
$$;

revoke all on function billing_private.payment_reversal_payload_is_valid(jsonb)
  from public, anon, authenticated;
revoke all on function billing_private.record_payment_event(text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.easyfield_account_reconcile_payment_reversal(
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.easyfield_account_reconcile_payment_reversal(
  text, text, text, text, jsonb
) to service_role;

commit;
