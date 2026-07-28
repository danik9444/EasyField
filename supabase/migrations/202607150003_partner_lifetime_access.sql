begin;

-- Keep the completed-checkout backfill and installation of the global claim
-- trigger atomic with respect to payment/checkout writers. Reads continue, but
-- no payment can complete in the gap between the backfill and trigger creation.
lock table public.checkout_intents, public.payment_events
in share row exclusive mode;

-- Partner is a paid, lifetime commercial entitlement. It is deliberately not
-- a platform role: purchasing it must never confer administrator or support
-- authority. The private offer catalog is the only authority for its price and
-- capabilities, and the zero-credit invariant prevents this purchase from
-- entering the EasyField credit ledger.
create table billing_private.partner_offer_catalog (
  offer_key text primary key
    check (offer_key = lower(btrim(offer_key)) and char_length(offer_key) between 1 and 80),
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  one_time_price_currency_micros bigint not null check (one_time_price_currency_micros > 0),
  included_microcredits bigint not null default 0 check (included_microcredits = 0),
  lifetime_access boolean not null default true check (lifetime_access),
  all_model_access boolean not null default true check (all_model_access),
  raw_provider_pricing_access boolean not null default true check (raw_provider_pricing_access),
  direct_provider_billing boolean not null default true check (direct_provider_billing),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

insert into billing_private.partner_offer_catalog (
  offer_key,
  pricing_version,
  currency_code,
  one_time_price_currency_micros,
  included_microcredits,
  lifetime_access,
  all_model_access,
  raw_provider_pricing_access,
  direct_provider_billing
) values (
  'partner_lifetime',
  'partner-2026-07-15',
  'USD',
  999000000,
  0,
  true,
  true,
  true,
  true
);

create trigger partner_offer_catalog_is_immutable
before update or delete on billing_private.partner_offer_catalog
for each row execute function billing_private.reject_immutable_mutation();

-- Payment evidence may fund only one commercial operation across both the
-- existing subscription/credit checkout table and the new one-time entitlement
-- purchase table. This shared immutable claim closes the cross-table replay
-- surface that two independent UNIQUE constraints would leave open.
create table billing_private.payment_entitlement_claims (
  payment_event_id uuid primary key references public.payment_events(id) on delete restrict,
  provider text not null
    check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_payment_ref text not null check (char_length(provider_payment_ref) between 1 and 300),
  claim_type text not null
    check (claim_type in ('subscription', 'credit_pack', 'auto_reload', 'partner_lifetime')),
  claim_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_payment_ref),
  unique (claim_type, claim_id)
);

insert into billing_private.payment_entitlement_claims (
  payment_event_id,
  provider,
  provider_payment_ref,
  claim_type,
  claim_id
)
select
  checkout.completed_payment_event_id,
  checkout.provider,
  checkout.provider_payment_ref,
  checkout.intent_type,
  checkout.id
from public.checkout_intents as checkout
where checkout.status = 'completed';

create trigger payment_entitlement_claims_are_immutable
before update or delete on billing_private.payment_entitlement_claims
for each row execute function billing_private.reject_immutable_mutation();

-- The base payment-event guard makes events backing checkout_intents terminal.
-- Partner purchases live in a separate private table, so this companion guard
-- gives every globally claimed payment event the same terminal guarantee.
create or replace function billing_private.protect_claimed_payment_event_terminal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'processed'
    and exists (
      select 1
      from billing_private.payment_entitlement_claims as claim
      where claim.payment_event_id = old.id
    )
    and (
      new.status <> 'processed'
      or new.processed_at is distinct from old.processed_at
    )
  then
    raise exception 'A payment event backing a commercial entitlement is terminal'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger payment_events_claimed_event_is_terminal
before update on public.payment_events
for each row execute function billing_private.protect_claimed_payment_event_terminal();

create or replace function billing_private.claim_standard_checkout_payment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and tg_op = 'INSERT' then
    if new.completed_payment_event_id is null or new.provider_payment_ref is null then
      raise exception 'A completed checkout requires payment evidence' using errcode = '22023';
    end if;
    insert into billing_private.payment_entitlement_claims (
      payment_event_id,
      provider,
      provider_payment_ref,
      claim_type,
      claim_id
    ) values (
      new.completed_payment_event_id,
      new.provider,
      new.provider_payment_ref,
      new.intent_type,
      new.id
    );
  elsif new.status = 'completed' and old.status is distinct from 'completed' then
    if new.completed_payment_event_id is null or new.provider_payment_ref is null then
      raise exception 'A completed checkout requires payment evidence' using errcode = '22023';
    end if;
    insert into billing_private.payment_entitlement_claims (
      payment_event_id,
      provider,
      provider_payment_ref,
      claim_type,
      claim_id
    ) values (
      new.completed_payment_event_id,
      new.provider,
      new.provider_payment_ref,
      new.intent_type,
      new.id
    );
  end if;
  return new;
end;
$$;

create trigger checkout_intents_claim_payment_event
after insert or update on public.checkout_intents
for each row execute function billing_private.claim_standard_checkout_payment_event();

-- This intent is intentionally separate from plan_catalog and checkout_intents:
-- there is no billing interval, recurring subscription, top-up rate or credit
-- grant. Provider session fields remain private and are never selectable by an
-- authenticated desktop client.
create table billing_private.partner_purchase_intents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  offer_key text not null references billing_private.partner_offer_catalog(offer_key) on delete restrict,
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount_currency_micros bigint not null check (amount_currency_micros > 0),
  included_microcredits bigint not null check (included_microcredits = 0),
  lifetime_access boolean not null check (lifetime_access),
  all_model_access boolean not null check (all_model_access),
  raw_provider_pricing_access boolean not null check (raw_provider_pricing_access),
  direct_provider_billing boolean not null check (direct_provider_billing),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 240),
  provider text not null
    check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_checkout_ref text check (
    provider_checkout_ref is null or char_length(provider_checkout_ref) between 1 and 500
  ),
  checkout_url text check (
    checkout_url is null
    or (checkout_url ~ '^https://[^[:space:]]+$' and char_length(checkout_url) <= 4096)
  ),
  status text not null default 'created'
    check (status in ('created', 'open', 'completed', 'expired', 'cancelled', 'failed')),
  completed_payment_event_id uuid references public.payment_events(id) on delete restrict,
  provider_payment_ref text
    check (provider_payment_ref is null or char_length(provider_payment_ref) between 1 and 300),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (customer_id, idempotency_key),
  unique (provider, provider_checkout_ref),
  unique (completed_payment_event_id),
  unique (provider, provider_payment_ref),
  check (expires_at > created_at),
  check (
    (
      status = 'completed'
      and completed_at is not null
      and completed_payment_event_id is not null
      and provider_payment_ref is not null
    )
    or
    (
      status <> 'completed'
      and completed_at is null
      and completed_payment_event_id is null
      and provider_payment_ref is null
    )
  )
);

-- A customer must never have two simultaneously payable Partner sessions.
-- The account-row lock in create_partner_purchase_intent serializes normal
-- creation, while this partial unique index remains the database-level backstop
-- for any future trusted adapter that writes through a different code path.
create unique index partner_purchase_intents_one_payable_session_per_customer
  on billing_private.partner_purchase_intents (customer_id)
  where status in ('created', 'open');

create or replace function billing_private.apply_partner_purchase_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_offer billing_private.partner_offer_catalog;
begin
  if tg_op = 'INSERT' then
    select offer.* into v_offer
    from billing_private.partner_offer_catalog as offer
    where offer.offer_key = new.offer_key and offer.active;
    if not found then
      raise exception 'Active partner offer not found' using errcode = '23503';
    end if;
    if new.status <> 'created'
      or new.completed_at is not null
      or new.completed_payment_event_id is not null
      or new.provider_payment_ref is not null
    then
      raise exception 'A partner purchase must start without payment evidence'
        using errcode = '22023';
    end if;
    new.pricing_version := v_offer.pricing_version;
    new.currency_code := v_offer.currency_code;
    new.amount_currency_micros := v_offer.one_time_price_currency_micros;
    new.included_microcredits := v_offer.included_microcredits;
    new.lifetime_access := v_offer.lifetime_access;
    new.all_model_access := v_offer.all_model_access;
    new.raw_provider_pricing_access := v_offer.raw_provider_pricing_access;
    new.direct_provider_billing := v_offer.direct_provider_billing;
    return new;
  end if;

  if (to_jsonb(new) - array[
      'provider_checkout_ref', 'checkout_url', 'status', 'expires_at',
      'completed_payment_event_id', 'provider_payment_ref', 'completed_at', 'updated_at'
    ]) is distinct from (to_jsonb(old) - array[
      'provider_checkout_ref', 'checkout_url', 'status', 'expires_at',
      'completed_payment_event_id', 'provider_payment_ref', 'completed_at', 'updated_at'
    ])
  then
    raise exception 'Partner purchase identity, price and capabilities are immutable'
      using errcode = '55000';
  end if;

  if old.status = 'completed' and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'A verified partner purchase is terminal' using errcode = '55000';
  end if;
  if old.status in ('expired', 'cancelled', 'failed')
    and new.status is distinct from old.status
    and new.status <> 'completed'
  then
    raise exception 'A closed partner purchase cannot be reopened' using errcode = '55000';
  end if;
  if new.status = 'created' and old.status <> 'created' then
    raise exception 'A partner purchase cannot return to created' using errcode = '55000';
  end if;
  if new.status in ('open', 'completed') and (
    new.provider_checkout_ref is null or new.checkout_url is null
  ) then
    raise exception 'An open partner purchase requires its hosted checkout identity'
      using errcode = '22023';
  end if;
  if new.status = 'completed' and not billing_private.checkout_payment_event_is_verified(
    new.id,
    new.provider,
    new.completed_payment_event_id,
    new.provider_payment_ref,
    new.amount_currency_micros,
    new.currency_code
  ) then
    raise exception 'Partner entitlement payment does not reconcile' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger partner_purchase_catalog_snapshot
before insert or update on billing_private.partner_purchase_intents
for each row execute function billing_private.apply_partner_purchase_snapshot();

create trigger partner_purchase_touch_updated_at
before update on billing_private.partner_purchase_intents
for each row execute function billing_private.touch_updated_at();

create or replace function billing_private.claim_partner_purchase_payment_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    insert into billing_private.payment_entitlement_claims (
      payment_event_id,
      provider,
      provider_payment_ref,
      claim_type,
      claim_id
    ) values (
      new.completed_payment_event_id,
      new.provider,
      new.provider_payment_ref,
      'partner_lifetime',
      new.id
    );
  end if;
  return new;
end;
$$;

create trigger a_partner_purchase_claim_payment_event
after update on billing_private.partner_purchase_intents
for each row execute function billing_private.claim_partner_purchase_payment_event();

-- Only this safe entitlement projection is own-readable. Purchase provider,
-- checkout, payment-event and idempotency fields remain in billing_private.
create table public.partner_entitlements (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.billing_customers(id) on delete restrict,
  offer_key text not null references billing_private.partner_offer_catalog(offer_key) on delete restrict,
  purchase_intent_id uuid not null unique
    references billing_private.partner_purchase_intents(id) on delete restrict,
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  status text not null default 'active'
    check (status in ('active', 'revoked', 'refunded', 'chargeback')),
  included_microcredits bigint not null check (included_microcredits = 0),
  lifetime_access boolean not null check (lifetime_access),
  all_model_access boolean not null check (all_model_access),
  raw_provider_pricing_access boolean not null check (raw_provider_pricing_access),
  direct_provider_billing boolean not null check (direct_provider_billing),
  starts_at timestamptz not null,
  ends_at timestamptz check (ends_at is null),
  revoked_at timestamptz,
  revocation_reason text check (
    revocation_reason is null or char_length(revocation_reason) between 3 and 1000
  ),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (status = 'active' and revoked_at is null and revocation_reason is null)
    or
    (status <> 'active' and revoked_at is not null and revocation_reason is not null)
  )
);

create or replace function billing_private.protect_partner_entitlement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Partner entitlements cannot be deleted' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['status', 'revoked_at', 'revocation_reason', 'updated_at'])
    is distinct from (to_jsonb(old) - array['status', 'revoked_at', 'revocation_reason', 'updated_at'])
  then
    raise exception 'Partner entitlement origin and capabilities are immutable'
      using errcode = '55000';
  end if;
  if old.status <> 'active' and new.status is distinct from old.status then
    raise exception 'A terminal partner entitlement cannot be reactivated or rewritten'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger partner_entitlements_protect_origin
before update or delete on public.partner_entitlements
for each row execute function billing_private.protect_partner_entitlement();

create trigger partner_entitlements_touch_updated_at
before update on public.partner_entitlements
for each row execute function billing_private.touch_updated_at();

-- Refunds, chargebacks and policy revocations must remove direct-provider
-- access immediately, but must never delete or rewrite the paid origin. This
-- server-only transition is one-way and idempotent for an identical replay.
create or replace function billing_private.revoke_partner_entitlement(
  p_customer_id uuid,
  p_terminal_status text,
  p_reason text
)
returns public.partner_entitlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entitlement public.partner_entitlements;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_customer_id is null
    or p_terminal_status is null
    or p_terminal_status not in ('revoked', 'refunded', 'chargeback')
    or char_length(v_reason) not between 3 and 1000
  then
    raise exception 'A valid terminal Partner status and reason are required'
      using errcode = '22023';
  end if;

  select entitlement.* into v_entitlement
  from public.partner_entitlements as entitlement
  where entitlement.customer_id = p_customer_id
  for update;
  if not found then
    raise exception 'Partner entitlement not found' using errcode = '23503';
  end if;

  if v_entitlement.status = p_terminal_status
    and v_entitlement.revocation_reason = v_reason
  then
    return v_entitlement;
  end if;
  if v_entitlement.status <> 'active' then
    raise exception 'A terminal Partner entitlement cannot be rewritten'
      using errcode = '55000';
  end if;

  update public.partner_entitlements
  set
    status = p_terminal_status,
    revoked_at = clock_timestamp(),
    revocation_reason = v_reason
  where id = v_entitlement.id
  returning * into v_entitlement;
  return v_entitlement;
end;
$$;

create or replace function billing_private.activate_partner_lifetime_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_claim billing_private.payment_entitlement_claims;
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select claim.* into v_event_claim
  from billing_private.payment_entitlement_claims as claim
  where claim.payment_event_id = new.completed_payment_event_id
    and claim.claim_type = 'partner_lifetime'
    and claim.claim_id = new.id;
  if not found then
    raise exception 'Partner payment evidence was not claimed for this purchase'
      using errcode = '42501';
  end if;

  insert into public.partner_entitlements (
    customer_id,
    offer_key,
    purchase_intent_id,
    pricing_version,
    status,
    included_microcredits,
    lifetime_access,
    all_model_access,
    raw_provider_pricing_access,
    direct_provider_billing,
    starts_at,
    ends_at
  ) values (
    new.customer_id,
    new.offer_key,
    new.id,
    new.pricing_version,
    'active',
    new.included_microcredits,
    new.lifetime_access,
    new.all_model_access,
    new.raw_provider_pricing_access,
    new.direct_provider_billing,
    new.completed_at,
    null
  );
  return new;
end;
$$;

create trigger b_partner_purchase_activate_entitlement
after update on billing_private.partner_purchase_intents
for each row execute function billing_private.activate_partner_lifetime_entitlement();

create or replace function billing_private.create_partner_purchase_intent(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_expires_at timestamptz default (clock_timestamp() + interval '30 minutes')
)
returns billing_private.partner_purchase_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_existing billing_private.partner_purchase_intents;
  v_intent billing_private.partner_purchase_intents;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_provider text := lower(btrim(coalesce(p_provider, '')));
begin
  if char_length(v_key) not between 8 and 240
    or char_length(v_provider) not between 2 and 40
    or p_expires_at is null
    or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '24 hours'
  then
    raise exception 'Invalid partner purchase intent' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = p_user_id
      and auth_user.email_confirmed_at is not null
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
  ) then
    raise exception 'Partner checkout requires an active confirmed account'
      using errcode = '42501';
  end if;

  select account.out_customer_id, account.out_account_id
  into v_customer_id, v_account_id
  from billing_private.ensure_billing_account(p_user_id) as account;

  if exists (
    select 1 from public.partner_entitlements as entitlement
    where entitlement.customer_id = v_customer_id
  ) then
    raise exception 'A lifetime Partner entitlement already exists for this customer'
      using errcode = '23505';
  end if;
  if exists (
    select 1
    from public.billing_customers as customer
    where customer.id = v_customer_id and customer.status = 'closed'
  ) then
    raise exception 'A closed billing customer cannot start Partner checkout'
      using errcode = '42501';
  end if;

  select intent.* into v_existing
  from billing_private.partner_purchase_intents as intent
  where intent.customer_id = v_customer_id and intent.idempotency_key = v_key;
  if found then
    if v_existing.provider <> v_provider or v_existing.expires_at <> p_expires_at then
      raise exception 'Partner purchase idempotency key was reused with different inputs'
        using errcode = '22000';
    end if;
    return v_existing;
  end if;
  if exists (
    select 1
    from billing_private.partner_purchase_intents as intent
    where intent.customer_id = v_customer_id
      and intent.status in ('created', 'open')
  ) then
    raise exception 'A Partner checkout is already in progress for this customer'
      using errcode = '23505';
  end if;

  insert into billing_private.partner_purchase_intents (
    customer_id,
    offer_key,
    pricing_version,
    currency_code,
    amount_currency_micros,
    included_microcredits,
    lifetime_access,
    all_model_access,
    raw_provider_pricing_access,
    direct_provider_billing,
    idempotency_key,
    provider,
    status,
    expires_at
  ) values (
    v_customer_id,
    'partner_lifetime',
    'snapshot-by-trigger',
    'USD',
    1,
    0,
    true,
    true,
    true,
    true,
    v_key,
    v_provider,
    'created',
    p_expires_at
  ) returning * into v_intent;
  return v_intent;
end;
$$;

create or replace function billing_private.set_partner_purchase_intent_state(
  p_intent_id uuid,
  p_status text,
  p_provider_checkout_ref text default null,
  p_checkout_url text default null,
  p_completed_payment_event_id uuid default null,
  p_provider_payment_ref text default null,
  p_expires_at timestamptz default null
)
returns billing_private.partner_purchase_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent billing_private.partner_purchase_intents;
  v_completed_at timestamptz;
begin
  if p_intent_id is null
    or p_status not in ('open', 'completed', 'expired', 'cancelled', 'failed')
  then
    raise exception 'Invalid partner purchase state' using errcode = '22023';
  end if;
  select intent.* into v_intent
  from billing_private.partner_purchase_intents as intent
  where intent.id = p_intent_id
  for update;
  if not found then
    raise exception 'Partner purchase intent not found' using errcode = '23503';
  end if;

  v_completed_at := case when p_status = 'completed' then clock_timestamp() else null end;
  update billing_private.partner_purchase_intents
  set
    status = p_status,
    provider_checkout_ref = coalesce(nullif(btrim(p_provider_checkout_ref), ''), provider_checkout_ref),
    checkout_url = coalesce(nullif(btrim(p_checkout_url), ''), checkout_url),
    completed_payment_event_id = case when p_status = 'completed' then p_completed_payment_event_id else null end,
    provider_payment_ref = case when p_status = 'completed' then nullif(btrim(p_provider_payment_ref), '') else null end,
    completed_at = v_completed_at,
    expires_at = coalesce(p_expires_at, expires_at)
  where id = p_intent_id
  returning * into v_intent;
  return v_intent;
end;
$$;

-- An active partner requires a currently usable auth identity and the immutable
-- paid entitlement. No platform role participates in this predicate.
create or replace function billing_private.is_active_partner(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users as auth_user
    join public.billing_customers as customer on customer.user_id = auth_user.id
    join public.partner_entitlements as entitlement on entitlement.customer_id = customer.id
    where auth_user.id = p_user_id
      and auth_user.email_confirmed_at is not null
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
      and customer.status in ('active', 'delinquent')
      and entitlement.status = 'active'
      and entitlement.lifetime_access
      and entitlement.ends_at is null
      and entitlement.included_microcredits = 0
      and entitlement.all_model_access
      and entitlement.raw_provider_pricing_access
      and entitlement.direct_provider_billing
  );
$$;

create or replace function billing_private.can_use_direct_provider_billing(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select billing_private.is_active_admin(p_user_id)
    or billing_private.is_active_partner(p_user_id);
$$;

-- Admin and paid Partner accounts share only this direct-provider billing path.
-- The quote remains an immutable raw-cost record, has no plan, bypasses credit
-- reservation, and intentionally performs no blocked-model lookup.
create or replace function billing_private.create_direct_provider_generation_quote(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text,
  p_model_id text,
  p_action text,
  p_provider_credit_microcredits bigint,
  p_provider_cost_currency_micros bigint,
  p_provider_cost_currency_code text,
  p_pricing_version text,
  p_expires_at timestamptz
)
returns public.generation_billing_quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_existing public.generation_billing_quotes;
  v_quote public.generation_billing_quotes;
  v_currency text := upper(btrim(p_provider_cost_currency_code));
begin
  if not billing_private.can_use_direct_provider_billing(p_user_id) then
    raise exception 'Direct provider billing requires an active privileged entitlement'
      using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 200
    or p_request_sha256 is null or p_request_sha256 !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_model_id, ''))) not between 1 and 200
    or char_length(btrim(coalesce(p_action, ''))) not between 1 and 120
    or char_length(btrim(coalesce(p_pricing_version, ''))) not between 1 and 120
    or p_provider_credit_microcredits is null or p_provider_credit_microcredits <= 0
    or p_provider_cost_currency_micros is null or p_provider_cost_currency_micros < 0
    or v_currency is null or v_currency !~ '^[A-Z]{3}$'
    or p_expires_at is null or p_expires_at <= clock_timestamp()
  then
    raise exception 'Invalid direct-provider generation quote' using errcode = '22023';
  end if;

  select account.out_customer_id, account.out_account_id
  into v_customer_id, v_account_id
  from billing_private.ensure_billing_account(p_user_id) as account;

  select quote.* into v_existing
  from public.generation_billing_quotes as quote
  where quote.customer_id = v_customer_id
    and quote.idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.request_sha256 <> p_request_sha256
      or v_existing.model_id <> btrim(p_model_id)
      or v_existing.action <> btrim(p_action)
      or v_existing.customer_microcredits <> p_provider_credit_microcredits
      or v_existing.provider_cost_currency_micros <> p_provider_cost_currency_micros
      or v_existing.provider_cost_currency_code <> v_currency
      or v_existing.pricing_version <> btrim(p_pricing_version)
      or v_existing.plan_key is not null
      or not v_existing.admin_bypass
      or v_existing.expires_at <> p_expires_at
    then
      raise exception 'Direct quote idempotency key was reused with different inputs'
        using errcode = '22000';
    end if;
    return v_existing;
  end if;

  insert into public.generation_billing_quotes (
    customer_id,
    idempotency_key,
    request_sha256,
    model_id,
    action,
    customer_microcredits,
    provider_cost_currency_micros,
    provider_cost_currency_code,
    pricing_version,
    plan_key,
    admin_bypass,
    expires_at
  ) values (
    v_customer_id,
    btrim(p_idempotency_key),
    p_request_sha256,
    btrim(p_model_id),
    btrim(p_action),
    p_provider_credit_microcredits,
    p_provider_cost_currency_micros,
    v_currency,
    btrim(p_pricing_version),
    null,
    true,
    p_expires_at
  ) returning * into v_quote;
  return v_quote;
end;
$$;

alter table public.partner_entitlements enable row level security;
alter table public.partner_entitlements force row level security;

create policy partner_entitlements_select_own on public.partner_entitlements
for select to authenticated using (billing_private.owns_customer(customer_id));

revoke all on billing_private.partner_offer_catalog,
  billing_private.payment_entitlement_claims,
  billing_private.partner_purchase_intents
from public, anon, authenticated;
revoke all on public.partner_entitlements from public, anon, authenticated;

grant select (
  id,
  customer_id,
  offer_key,
  pricing_version,
  status,
  included_microcredits,
  lifetime_access,
  all_model_access,
  raw_provider_pricing_access,
  direct_provider_billing,
  starts_at,
  ends_at,
  revoked_at,
  created_at,
  updated_at
) on public.partner_entitlements to authenticated;

grant select on billing_private.partner_offer_catalog,
  billing_private.payment_entitlement_claims,
  billing_private.partner_purchase_intents,
  public.partner_entitlements
to service_role;

revoke all on function billing_private.create_partner_purchase_intent(uuid, text, text, timestamptz)
from public, anon, authenticated;
revoke all on function billing_private.protect_claimed_payment_event_terminal()
from public, anon, authenticated;
revoke all on function billing_private.claim_standard_checkout_payment_event()
from public, anon, authenticated;
revoke all on function billing_private.apply_partner_purchase_snapshot()
from public, anon, authenticated;
revoke all on function billing_private.claim_partner_purchase_payment_event()
from public, anon, authenticated;
revoke all on function billing_private.protect_partner_entitlement()
from public, anon, authenticated;
revoke all on function billing_private.revoke_partner_entitlement(uuid, text, text)
from public, anon, authenticated;
revoke all on function billing_private.activate_partner_lifetime_entitlement()
from public, anon, authenticated;
revoke all on function billing_private.set_partner_purchase_intent_state(
  uuid, text, text, text, uuid, text, timestamptz
) from public, anon, authenticated;
revoke all on function billing_private.is_active_partner(uuid)
from public, anon, authenticated;
revoke all on function billing_private.can_use_direct_provider_billing(uuid)
from public, anon, authenticated;
revoke all on function billing_private.create_direct_provider_generation_quote(
  uuid, text, text, text, text, bigint, bigint, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function billing_private.create_partner_purchase_intent(uuid, text, text, timestamptz)
to service_role;
grant execute on function billing_private.set_partner_purchase_intent_state(
  uuid, text, text, text, uuid, text, timestamptz
) to service_role;
grant execute on function billing_private.revoke_partner_entitlement(uuid, text, text)
to service_role;
grant execute on function billing_private.is_active_partner(uuid)
to service_role;
grant execute on function billing_private.can_use_direct_provider_billing(uuid)
to service_role;
grant execute on function billing_private.create_direct_provider_generation_quote(
  uuid, text, text, text, text, bigint, bigint, text, text, timestamptz
) to service_role;

comment on table public.partner_entitlements is
  'Own-readable safe lifetime Partner capability. Payment and provider evidence remain private.';
comment on function billing_private.create_direct_provider_generation_quote(
  uuid, text, text, text, text, bigint, bigint, text, text, timestamptz
) is
  'Creates a no-ledger, all-model provider-cost quote only for a server-confirmed admin or paid Partner entitlement.';

commit;
