begin;

-- EasyField billing uses integer microcredits and integer currency micros only.
-- 1 displayed EasyField credit = 1,000,000 microcredits.
-- 1 displayed currency unit (USD/EUR/...) = 1,000,000 currency micros.
create extension if not exists pgcrypto with schema extensions;

create schema if not exists billing_private;
revoke all on schema billing_private from public, anon, authenticated;
grant usage on schema billing_private to service_role;
alter default privileges in schema billing_private
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema billing_private
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema billing_private
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema billing_private
  revoke usage on types from public, anon, authenticated;
alter default privileges in schema billing_private
  grant execute on functions to service_role;

-- The control-plane catalog is the only authority for plan price, grant size,
-- top-up rate and model entitlement. Values are integer micros and mirror the
-- accepted product table; clients never supply or override them.
create table billing_private.plan_catalog (
  plan_key text primary key check (plan_key = lower(btrim(plan_key)) and char_length(plan_key) between 1 and 40),
  display_name text not null unique check (char_length(display_name) between 1 and 80),
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  monthly_price_currency_micros bigint not null check (monthly_price_currency_micros > 0),
  annual_price_currency_micros bigint not null check (annual_price_currency_micros > 0),
  monthly_grant_microcredits bigint not null check (monthly_grant_microcredits > 0),
  top_up_currency_micros_per_credit bigint not null check (top_up_currency_micros_per_credit > 0),
  minimum_top_up_currency_micros bigint not null check (minimum_top_up_currency_micros > 0),
  blocked_model_ids text[] not null default '{}'::text[],
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  check (array_position(blocked_model_ids, null) is null)
);

insert into billing_private.plan_catalog (
  plan_key, display_name, pricing_version, currency_code,
  monthly_price_currency_micros, annual_price_currency_micros,
  monthly_grant_microcredits, top_up_currency_micros_per_credit,
  minimum_top_up_currency_micros, blocked_model_ids
) values
  ('starter', 'Starter', 'billing-2026-07-15', 'USD', 15000000, 144000000, 800000000, 20000, 10000000, array['bytedance/seedance-2']::text[]),
  ('creator', 'Creator', 'billing-2026-07-15', 'USD', 30000000, 300000000, 2000000000, 15000, 10000000, '{}'::text[]),
  ('pro', 'Pro', 'billing-2026-07-15', 'USD', 60000000, 588000000, 5000000000, 12000, 10000000, '{}'::text[]),
  ('studio', 'Studio', 'billing-2026-07-15', 'USD', 129000000, 1188000000, 12000000000, 10000, 10000000, '{}'::text[]);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_normalized text,
  platform_role text not null default 'customer'
    check (platform_role in ('customer', 'support', 'admin')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (email_normalized is null or email_normalized = lower(btrim(email_normalized)))
);

create unique index profiles_email_normalized_key
  on public.profiles (email_normalized)
  where email_normalized is not null;

create table public.platform_role_audit (
  id bigint generated always as identity primary key,
  target_user_id uuid not null references auth.users(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  previous_role text,
  new_role text not null check (new_role in ('customer', 'support', 'admin')),
  reason text not null check (char_length(reason) between 3 and 500),
  created_at timestamptz not null default clock_timestamp()
);

create table public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  provider text not null default 'internal' check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_customer_ref text,
  status text not null default 'active' check (status in ('active', 'delinquent', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_customer_ref)
);

-- Reusable payment tokens and provider identifiers are never placed in a
-- public/RLS-readable table. Only the trusted billing adapter can read them.
create table billing_private.saved_payment_methods (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.billing_customers(id) on delete cascade,
  provider text not null check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_payment_method_ref text not null check (char_length(provider_payment_method_ref) between 1 and 500),
  display_name text not null check (char_length(display_name) between 1 and 120),
  last_four text not null check (last_four ~ '^[0-9]{4}$'),
  expiry_month integer check (expiry_month between 1 and 12),
  expiry_year integer check (expiry_year between 2000 and 9999),
  status text not null default 'active' check (status in ('active', 'inactive', 'expired', 'unknown')),
  supported_currencies text[] not null default '{}'::text[],
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_payment_method_ref),
  check ((expiry_month is null) = (expiry_year is null)),
  check (array_position(supported_currencies, null) is null)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  provider text not null check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_subscription_ref text not null,
  plan_key text not null references billing_private.plan_catalog(plan_key) on delete restrict,
  billing_interval text not null check (billing_interval in ('monthly', 'annual')),
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  status text not null check (status in ('incomplete', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  entitlement_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  unit_amount_currency_micros bigint not null check (unit_amount_currency_micros >= 0),
  included_microcredits_per_grant bigint not null default 0 check (included_microcredits_per_grant >= 0),
  saved_payment_method_id uuid references billing_private.saved_payment_methods(id) on delete restrict,
  provider_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_subscription_ref),
  check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);

create index subscriptions_customer_status_idx
  on public.subscriptions (customer_id, status, current_period_end desc);

-- A renewal row is created before external I/O. charge_attempt_count can only
-- move from zero to one; ambiguous/failed provider calls are never reclaimed
-- for an automatic second charge.
create table billing_private.renewal_attempts (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  saved_payment_method_id uuid not null references billing_private.saved_payment_methods(id) on delete restrict,
  plan_key text not null references billing_private.plan_catalog(plan_key) on delete restrict,
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount_currency_micros bigint not null check (amount_currency_micros > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  state text not null default 'scheduled' check (state in ('scheduled', 'charging', 'succeeded', 'failed', 'unknown')),
  charge_attempt_count smallint not null default 0 check (charge_attempt_count in (0, 1)),
  charge_claim_id uuid,
  charge_claimed_at timestamptz,
  provider_document_ref text check (provider_document_ref is null or char_length(provider_document_ref) between 1 and 500),
  provider_transaction_ref text check (provider_transaction_ref is null or char_length(provider_transaction_ref) between 1 and 500),
  provider_status integer,
  failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (subscription_id, period_start),
  check (period_end > period_start),
  check (
    (state = 'scheduled' and charge_attempt_count = 0 and charge_claim_id is null and charge_claimed_at is null)
    or
    (state <> 'scheduled' and charge_attempt_count = 1 and charge_claim_id is not null and charge_claimed_at is not null)
  )
);

create table public.credit_accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.billing_customers(id) on delete restrict,
  available_microcredits bigint not null default 0 check (available_microcredits >= 0),
  reserved_microcredits bigint not null default 0 check (reserved_microcredits >= 0),
  lifetime_granted_microcredits bigint not null default 0 check (lifetime_granted_microcredits >= 0),
  lifetime_consumed_microcredits bigint not null default 0 check (lifetime_consumed_microcredits >= 0),
  lifetime_expired_microcredits bigint not null default 0 check (lifetime_expired_microcredits >= 0),
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

-- Raw provider economics remain in this server-only table. Authenticated clients
-- receive only the customer_microcredits columns through column grants or the
-- safe snapshot function below.
create table public.generation_billing_quotes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  model_id text not null check (char_length(model_id) between 1 and 200),
  action text not null check (char_length(action) between 1 and 120),
  customer_microcredits bigint not null check (customer_microcredits > 0),
  provider_cost_currency_micros bigint not null check (provider_cost_currency_micros >= 0),
  provider_cost_currency_code text not null check (provider_cost_currency_code ~ '^[A-Z]{3}$'),
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  plan_key text references billing_private.plan_catalog(plan_key) on delete restrict,
  admin_bypass boolean not null default false,
  status text not null default 'open'
    check (status in ('open', 'reserved', 'partially_captured', 'captured', 'settled', 'released', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (customer_id, idempotency_key),
  check (expires_at > created_at),
  check ((admin_bypass and plan_key is null) or (not admin_bypass and plan_key is not null))
);

create index generation_billing_quotes_customer_expiry_idx
  on public.generation_billing_quotes (customer_id, expires_at desc);

create table public.credit_grant_lots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.credit_accounts(id) on delete restrict,
  subscription_id uuid references public.subscriptions(id) on delete restrict,
  source_type text not null
    check (source_type in ('subscription', 'annual_monthly_grant', 'credit_pack', 'auto_reload', 'promotion', 'refund', 'adjustment')),
  source_ref text,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 240),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  total_microcredits bigint not null check (total_microcredits > 0),
  available_microcredits bigint not null check (available_microcredits >= 0),
  reserved_microcredits bigint not null default 0 check (reserved_microcredits >= 0),
  granted_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (account_id, idempotency_key),
  check (available_microcredits + reserved_microcredits <= total_microcredits),
  check (expires_at is null or expires_at > granted_at)
);

create index credit_grant_lots_fifo_idx
  on public.credit_grant_lots (account_id, expires_at asc nulls last, granted_at, id)
  where available_microcredits > 0;

create table public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.credit_accounts(id) on delete restrict,
  quote_id uuid not null unique references public.generation_billing_quotes(id) on delete restrict,
  generation_job_key text not null check (char_length(generation_job_key) between 1 and 240),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 240),
  amount_microcredits bigint not null check (amount_microcredits > 0),
  captured_microcredits bigint not null default 0 check (captured_microcredits >= 0),
  released_microcredits bigint not null default 0 check (released_microcredits >= 0),
  status text not null default 'active'
    check (status in ('active', 'partially_captured', 'captured', 'released', 'expired', 'settled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (account_id, idempotency_key),
  check (captured_microcredits + released_microcredits <= amount_microcredits),
  check (expires_at > created_at)
);

create index credit_reservations_expiry_idx
  on public.credit_reservations (expires_at)
  where status in ('active', 'partially_captured');

create table public.credit_reservation_allocations (
  reservation_id uuid not null references public.credit_reservations(id) on delete restrict,
  lot_id uuid not null references public.credit_grant_lots(id) on delete restrict,
  reserved_microcredits bigint not null check (reserved_microcredits > 0),
  captured_microcredits bigint not null default 0 check (captured_microcredits >= 0),
  released_microcredits bigint not null default 0 check (released_microcredits >= 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (reservation_id, lot_id),
  check (captured_microcredits + released_microcredits <= reserved_microcredits)
);

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.credit_accounts(id) on delete restrict,
  lot_id uuid references public.credit_grant_lots(id) on delete restrict,
  reservation_id uuid references public.credit_reservations(id) on delete restrict,
  quote_id uuid references public.generation_billing_quotes(id) on delete restrict,
  entry_type text not null
    check (entry_type in ('grant', 'reserve', 'capture', 'release', 'expiration', 'refund', 'adjustment')),
  available_delta_microcredits bigint not null default 0,
  reserved_delta_microcredits bigint not null default 0,
  consumed_delta_microcredits bigint not null default 0,
  expired_delta_microcredits bigint not null default 0,
  currency_amount_micros bigint,
  currency_code text,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 300),
  reference_type text,
  reference_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (account_id, idempotency_key),
  check (
    available_delta_microcredits <> 0
    or reserved_delta_microcredits <> 0
    or consumed_delta_microcredits <> 0
    or expired_delta_microcredits <> 0
  ),
  check ((currency_amount_micros is null) = (currency_code is null)),
  check (currency_code is null or currency_code ~ '^[A-Z]{3}$')
);

create index credit_ledger_account_created_idx
  on public.credit_ledger (account_id, created_at desc, id desc);

create table public.checkout_intents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.billing_customers(id) on delete restrict,
  intent_type text not null check (intent_type in ('subscription', 'credit_pack', 'auto_reload')),
  plan_key text not null references billing_private.plan_catalog(plan_key) on delete restrict,
  billing_interval text check (billing_interval in ('monthly', 'annual')),
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  monthly_grant_microcredits bigint not null check (monthly_grant_microcredits > 0),
  top_up_currency_micros_per_credit bigint not null check (top_up_currency_micros_per_credit > 0),
  minimum_top_up_currency_micros bigint not null check (minimum_top_up_currency_micros > 0),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 240),
  provider text not null check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_checkout_ref text,
  checkout_url text,
  status text not null default 'created' check (status in ('created', 'open', 'completed', 'expired', 'cancelled', 'failed')),
  amount_currency_micros bigint not null check (amount_currency_micros > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  credit_microcredits bigint not null default 0 check (credit_microcredits >= 0),
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (customer_id, idempotency_key),
  unique (provider, provider_checkout_ref),
  check ((intent_type = 'subscription') = (billing_interval is not null))
);

-- Every grant created from a paid operation is anchored to exactly one
-- server-verified purchase record. Unique foreign keys make the payment source
-- one-shot even when multiple workers race; annual monthly grants keep their
-- existing one-to-one link through subscription_grant_schedule.granted_lot_id.
alter table public.credit_grant_lots
  add column checkout_intent_id uuid references public.checkout_intents(id) on delete restrict,
  add column renewal_attempt_id uuid references billing_private.renewal_attempts(id) on delete restrict,
  add constraint credit_grant_lots_checkout_intent_key unique (checkout_intent_id),
  add constraint credit_grant_lots_renewal_attempt_key unique (renewal_attempt_id),
  add constraint credit_grant_lots_paid_source_shape check (
    (
      source_type in ('credit_pack', 'auto_reload')
      and checkout_intent_id is not null
      and renewal_attempt_id is null
    )
    or
    (
      source_type = 'subscription'
      and num_nonnulls(checkout_intent_id, renewal_attempt_id) = 1
    )
    or
    (
      source_type not in ('subscription', 'credit_pack', 'auto_reload')
      and checkout_intent_id is null
      and renewal_attempt_id is null
    )
  );

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 300),
  event_type text not null check (char_length(event_type) between 1 and 200),
  raw_body_sha256 text not null check (raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processing_claim_id uuid,
  processing_started_at timestamptz,
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) between 1 and 4000),
  unique (provider, provider_event_id),
  unique (provider, raw_body_sha256),
  check (jsonb_typeof(payload) = 'object'),
  check (status <> 'processing' or (processing_claim_id is not null and processing_started_at is not null))
);

-- A checkout is only complete when it points at one immutable, reconciled
-- payment event. Subscription periods are captured on that same purchase
-- record so an annual grant can prove which paid year it belongs to.
alter table public.checkout_intents
  add column completed_payment_event_id uuid references public.payment_events(id) on delete restrict,
  add column provider_payment_ref text
    check (provider_payment_ref is null or char_length(provider_payment_ref) between 1 and 300),
  add column subscription_period_start timestamptz,
  add column subscription_period_end timestamptz,
  add constraint checkout_intents_completed_payment_event_key unique (completed_payment_event_id),
  add constraint checkout_intents_provider_payment_key unique (provider, provider_payment_ref),
  add constraint checkout_intents_completion_evidence_shape check (
    (
      status = 'completed'
      and completed_at is not null
      and completed_payment_event_id is not null
      and provider_payment_ref is not null
      and (
        (
          intent_type = 'subscription'
          and subscription_period_start is not null
          and subscription_period_end is not null
          and subscription_period_end > subscription_period_start
        )
        or
        (
          intent_type <> 'subscription'
          and subscription_period_start is null
          and subscription_period_end is null
        )
      )
    )
    or
    (
      status <> 'completed'
      and completed_at is null
      and completed_payment_event_id is null
      and provider_payment_ref is null
      and subscription_period_start is null
      and subscription_period_end is null
    )
  );

-- The active annual period carries exactly one paid origin. Unique keys make
-- each paid source one-shot at the subscription-period boundary.
-- Schedule rows retain a direct copy of that source after a later renewal
-- advances the mutable subscription row.
alter table public.subscriptions
  add column annual_checkout_intent_id uuid references public.checkout_intents(id) on delete restrict,
  add column annual_renewal_attempt_id uuid references billing_private.renewal_attempts(id) on delete restrict,
  add constraint subscriptions_annual_checkout_intent_key unique (annual_checkout_intent_id),
  add constraint subscriptions_annual_renewal_attempt_key unique (annual_renewal_attempt_id),
  add constraint subscriptions_annual_paid_source_shape check (
    (
      billing_interval = 'monthly'
      and annual_checkout_intent_id is null
      and annual_renewal_attempt_id is null
    )
    or
    (
      billing_interval = 'annual'
      and (
        (status = 'incomplete' and num_nonnulls(annual_checkout_intent_id, annual_renewal_attempt_id) <= 1)
        or
        (status <> 'incomplete' and num_nonnulls(annual_checkout_intent_id, annual_renewal_attempt_id) = 1)
      )
    )
  );

-- Delivery IDs are unsigned transport identifiers, while provider_event_id is
-- read from the signed body. Both are persisted so neither replay surface is
-- reusable, including when one signed event is delivered more than once.
create table billing_private.payment_event_deliveries (
  id uuid primary key default gen_random_uuid(),
  payment_event_id uuid not null references public.payment_events(id) on delete restrict,
  provider text not null check (provider = lower(btrim(provider)) and char_length(provider) between 2 and 40),
  provider_delivery_id text not null check (char_length(provider_delivery_id) between 1 and 300),
  raw_body_sha256 text not null check (raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_delivery_id),
  unique (payment_event_id)
);

create index payment_events_processing_idx
  on public.payment_events (status, received_at)
  where status in ('received', 'failed');

create table public.auto_reload_settings (
  account_id uuid primary key references public.credit_accounts(id) on delete cascade,
  enabled boolean not null default false,
  trigger_below_microcredits bigint not null default 0 check (trigger_below_microcredits >= 0),
  reload_microcredits bigint not null default 0 check (reload_microcredits >= 0),
  saved_payment_method_id uuid references billing_private.saved_payment_methods(id) on delete restrict,
  plan_key text references billing_private.plan_catalog(plan_key) on delete restrict,
  pricing_version text check (pricing_version is null or char_length(pricing_version) between 1 and 120),
  top_up_currency_micros_per_credit bigint check (top_up_currency_micros_per_credit is null or top_up_currency_micros_per_credit > 0),
  minimum_top_up_currency_micros bigint check (minimum_top_up_currency_micros is null or minimum_top_up_currency_micros > 0),
  reload_price_currency_micros bigint not null default 0 check (reload_price_currency_micros >= 0),
  -- NULL means the user chose no monthly auto-reload ceiling. EasyField never
  -- invents a product cap; a non-NULL value is an explicit user safety choice.
  max_reload_currency_micros_per_month bigint check (max_reload_currency_micros_per_month is null or max_reload_currency_micros_per_month > 0),
  current_month_spend_currency_micros bigint not null default 0 check (current_month_spend_currency_micros >= 0),
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  month_window_started_at timestamptz not null default date_trunc('month', clock_timestamp()),
  last_triggered_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (
    not enabled
    or (
      trigger_below_microcredits >= 0
      and reload_microcredits > 0
      and saved_payment_method_id is not null
      and plan_key is not null
      and pricing_version is not null
      and top_up_currency_micros_per_credit is not null
      and minimum_top_up_currency_micros is not null
      and reload_price_currency_micros > 0
      and (
        max_reload_currency_micros_per_month is null
        or max_reload_currency_micros_per_month >= reload_price_currency_micros
      )
    )
  )
);

create table public.subscription_grant_schedule (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  period_anchor timestamptz not null,
  pricing_version text not null check (char_length(pricing_version) between 1 and 120),
  grant_number integer not null check (grant_number between 1 and 120),
  scheduled_for timestamptz not null,
  amount_microcredits bigint not null check (amount_microcredits > 0),
  lot_expires_at timestamptz,
  annual_checkout_intent_id uuid references public.checkout_intents(id) on delete restrict,
  annual_renewal_attempt_id uuid references billing_private.renewal_attempts(id) on delete restrict,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 300),
  status text not null default 'pending' check (status in ('pending', 'granting', 'granted', 'skipped', 'cancelled')),
  granted_lot_id uuid unique references public.credit_grant_lots(id) on delete restrict,
  granted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (subscription_id, period_anchor, grant_number),
  check (num_nonnulls(annual_checkout_intent_id, annual_renewal_attempt_id) = 1),
  check (lot_expires_at is null or lot_expires_at > scheduled_for),
  check ((status = 'granted') = (granted_lot_id is not null and granted_at is not null))
);

create index subscription_grant_schedule_due_idx
  on public.subscription_grant_schedule (scheduled_for, id)
  where status = 'pending';

-- -------------------------------------------------------------------------
-- Trigger helpers and auth profile synchronization
-- -------------------------------------------------------------------------

create or replace function billing_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function billing_private.reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only; write a compensating entry instead', tg_table_name
    using errcode = '55000';
end;
$$;

create trigger plan_catalog_is_immutable
before update or delete on billing_private.plan_catalog
for each row execute function billing_private.reject_immutable_mutation();

create or replace function billing_private.protect_quote_economics()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Generation billing quotes cannot be deleted' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['status', 'updated_at'])
    is distinct from (to_jsonb(old) - array['status', 'updated_at'])
  then
    raise exception 'Generation quote economics and entitlement snapshots are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function billing_private.protect_allocation_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Credit reservation allocations cannot be deleted' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['captured_microcredits', 'released_microcredits'])
    is distinct from (to_jsonb(old) - array['captured_microcredits', 'released_microcredits'])
  then
    raise exception 'Credit reservation allocation origin is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function billing_private.protect_payment_event_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment event evidence cannot be deleted' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array[
      'status', 'attempt_count', 'processing_claim_id',
      'processing_started_at', 'processed_at', 'last_error'
    ]) is distinct from (to_jsonb(old) - array[
      'status', 'attempt_count', 'processing_claim_id',
      'processing_started_at', 'processed_at', 'last_error'
    ])
  then
    raise exception 'Payment event identity and signed evidence are immutable'
      using errcode = '55000';
  end if;
  if old.status = 'processed'
    and exists (
      select 1
      from public.checkout_intents c
      where c.completed_payment_event_id = old.id
        and c.status = 'completed'
    )
    and (
      new.status <> 'processed'
      or new.processed_at is distinct from old.processed_at
    )
  then
    raise exception 'A payment event backing a completed checkout is terminal'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function billing_private.protect_subscription_grant_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Annual subscription grant schedules cannot be deleted'
      using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['status', 'granted_lot_id', 'granted_at', 'updated_at'])
    is distinct from
    (to_jsonb(old) - array['status', 'granted_lot_id', 'granted_at', 'updated_at'])
  then
    raise exception 'Annual subscription grant paid origin is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function billing_private.protect_renewal_attempt_origin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Renewal attempts cannot be deleted' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array[
      'state', 'charge_attempt_count', 'charge_claim_id', 'charge_claimed_at',
      'provider_document_ref', 'provider_transaction_ref', 'provider_status',
      'failure_reason', 'updated_at'
    ]) is distinct from (to_jsonb(old) - array[
      'state', 'charge_attempt_count', 'charge_claim_id', 'charge_claimed_at',
      'provider_document_ref', 'provider_transaction_ref', 'provider_status',
      'failure_reason', 'updated_at'
    ])
  then
    raise exception 'Renewal attempt identity and price snapshot are immutable'
      using errcode = '55000';
  end if;
  if old.state in ('succeeded', 'failed', 'unknown')
    and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
  then
    raise exception 'A terminal renewal outcome is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function billing_private.checkout_payment_event_is_verified(
  p_checkout_id uuid,
  p_provider text,
  p_completed_payment_event_id uuid,
  p_provider_payment_ref text,
  p_amount_currency_micros bigint,
  p_currency_code text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event public.payment_events;
  v_minor_units numeric;
begin
  if p_checkout_id is null
    or p_completed_payment_event_id is null
    or p_provider_payment_ref is null
    or p_amount_currency_micros is null
    or p_amount_currency_micros <= 0
    or p_currency_code is null
  then
    return false;
  end if;

  select e.* into v_event
  from public.payment_events e
  where e.id = p_completed_payment_event_id;
  if not found
    or v_event.provider <> p_provider
    or v_event.status <> 'processed'
    or v_event.processed_at is null
    or v_event.event_type <> 'payment/received'
    or v_event.provider_event_id <> p_provider_payment_ref
    or v_event.payload->>'id' <> v_event.provider_event_id
    or v_event.payload->>'reconciliationState' <> 'ready'
    or v_event.payload->'entitlementGrantAllowed' <> 'false'::jsonb
    or v_event.payload->>'operationReference' <> p_checkout_id::text
    or v_event.payload->'total'->>'currency' <> p_currency_code
    or v_event.payload->'total'->>'exponent' <> '2'
    or v_event.payload->'total'->>'minorUnits' !~ '^[0-9]+$'
  then
    return false;
  end if;

  v_minor_units := (v_event.payload->'total'->>'minorUnits')::numeric;
  return v_minor_units * 10000::numeric = p_amount_currency_micros::numeric;
exception when others then
  return false;
end;
$$;

create or replace function billing_private.annual_subscription_paid_source_is_valid(
  p_subscription_id uuid,
  p_customer_id uuid,
  p_plan_key text,
  p_pricing_version text,
  p_amount_currency_micros bigint,
  p_currency_code text,
  p_grant_microcredits bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_annual_checkout_intent_id uuid,
  p_annual_renewal_attempt_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkout_intents;
  v_renewal billing_private.renewal_attempts;
begin
  if p_subscription_id is null
    or p_customer_id is null
    or p_period_start is null
    or p_period_end is null
    or p_period_end is distinct from p_period_start + interval '1 year'
    or num_nonnulls(p_annual_checkout_intent_id, p_annual_renewal_attempt_id) <> 1
  then
    return false;
  end if;

  if p_annual_checkout_intent_id is not null then
    select c.* into v_checkout
    from public.checkout_intents c
    where c.id = p_annual_checkout_intent_id;
    if not found
      or v_checkout.status <> 'completed'
      or v_checkout.intent_type <> 'subscription'
      or v_checkout.billing_interval <> 'annual'
      or v_checkout.customer_id <> p_customer_id
      or v_checkout.plan_key <> p_plan_key
      or v_checkout.pricing_version <> p_pricing_version
      or v_checkout.amount_currency_micros <> p_amount_currency_micros
      or v_checkout.currency_code <> p_currency_code
      or v_checkout.monthly_grant_microcredits <> p_grant_microcredits
      or v_checkout.subscription_period_start is distinct from p_period_start
      or v_checkout.subscription_period_end is distinct from p_period_end
      or not billing_private.checkout_payment_event_is_verified(
        v_checkout.id,
        v_checkout.provider,
        v_checkout.completed_payment_event_id,
        v_checkout.provider_payment_ref,
        v_checkout.amount_currency_micros,
        v_checkout.currency_code
      )
    then
      return false;
    end if;
    return true;
  end if;

  select r.* into v_renewal
  from billing_private.renewal_attempts r
  where r.id = p_annual_renewal_attempt_id;
  if not found
    or v_renewal.subscription_id <> p_subscription_id
    or v_renewal.state <> 'succeeded'
    or v_renewal.provider_document_ref is null
    or v_renewal.plan_key <> p_plan_key
    or v_renewal.pricing_version <> p_pricing_version
    or v_renewal.amount_currency_micros <> p_amount_currency_micros
    or v_renewal.currency_code <> p_currency_code
    or v_renewal.period_start is distinct from p_period_start
    or v_renewal.period_end is distinct from p_period_end
  then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function billing_private.apply_checkout_catalog_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan billing_private.plan_catalog;
  v_entitled_plan_key text;
  v_raw_expected_amount numeric;
  v_expected_amount numeric;
begin
  if new.intent_type is null
    or new.intent_type not in ('subscription', 'credit_pack', 'auto_reload')
  then
    raise exception 'Unknown checkout intent type' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array[
        'provider_checkout_ref', 'checkout_url', 'status',
        'expires_at', 'completed_at', 'completed_payment_event_id',
        'provider_payment_ref', 'subscription_period_start',
        'subscription_period_end', 'updated_at'
      ]) is distinct from (to_jsonb(old) - array[
        'provider_checkout_ref', 'checkout_url', 'status',
        'expires_at', 'completed_at', 'completed_payment_event_id',
        'provider_payment_ref', 'subscription_period_start',
        'subscription_period_end', 'updated_at'
      ])
    then
      raise exception 'Checkout pricing and purchase identity are immutable'
        using errcode = '55000';
    end if;
    if old.status = 'completed' and (
      new.status <> 'completed'
      or new.completed_at is distinct from old.completed_at
      or new.provider_checkout_ref is distinct from old.provider_checkout_ref
      or new.completed_payment_event_id is distinct from old.completed_payment_event_id
      or new.provider_payment_ref is distinct from old.provider_payment_ref
      or new.subscription_period_start is distinct from old.subscription_period_start
      or new.subscription_period_end is distinct from old.subscription_period_end
    ) then
      raise exception 'A verified completed checkout is immutable'
        using errcode = '55000';
    end if;
    if new.status = 'completed' and (
      new.completed_at is null
      or new.provider_checkout_ref is null
      or new.completed_payment_event_id is null
      or new.provider_payment_ref is null
    ) then
      raise exception 'A completed checkout requires verified completion evidence'
        using errcode = '22023';
    end if;
    if new.status <> 'completed' and (
      new.completed_at is not null
      or new.completed_payment_event_id is not null
      or new.provider_payment_ref is not null
      or new.subscription_period_start is not null
      or new.subscription_period_end is not null
    ) then
      raise exception 'Only a completed checkout may have completion evidence'
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
      raise exception 'Checkout completion is not backed by its processed payment event'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.intent_type = 'subscription' then
    if new.plan_key is null or new.billing_interval is null
      or new.billing_interval not in ('monthly', 'annual')
    then
      raise exception 'Subscription checkout requires a catalog plan and interval'
        using errcode = '22023';
    end if;
    select p.* into v_plan
    from billing_private.plan_catalog p
    where p.plan_key = new.plan_key and p.active;
  else
    if new.billing_interval is not null or new.credit_microcredits is null
      or new.credit_microcredits <= 0
    then
      raise exception 'Top-up checkout requires a positive credit amount and no subscription interval'
        using errcode = '22023';
    end if;
    select s.plan_key into v_entitled_plan_key
    from public.subscriptions s
    join billing_private.plan_catalog p on p.plan_key = s.plan_key and p.active
    where s.customer_id = new.customer_id
      and s.status in ('trialing', 'active')
      and coalesce(s.entitlement_ends_at, s.current_period_end) > clock_timestamp()
      and s.pricing_version = p.pricing_version
      and s.currency_code = p.currency_code
      and s.unit_amount_currency_micros = case s.billing_interval
        when 'monthly' then p.monthly_price_currency_micros
        else p.annual_price_currency_micros
      end
      and s.included_microcredits_per_grant = p.monthly_grant_microcredits
    order by s.current_period_end desc nulls last, s.created_at desc
    limit 1;
    if not found then
      raise exception 'An active plan entitlement is required for top-ups'
        using errcode = '42501';
    end if;
    if new.plan_key is not null and new.plan_key <> v_entitled_plan_key then
      raise exception 'Top-up plan does not match the active entitlement'
        using errcode = '42501';
    end if;
    new.plan_key := v_entitled_plan_key;
    select p.* into v_plan
    from billing_private.plan_catalog p
    where p.plan_key = v_entitled_plan_key and p.active;
  end if;

  if not found then
    raise exception 'Active billing plan not found' using errcode = '23503';
  end if;

  new.pricing_version := v_plan.pricing_version;
  new.currency_code := v_plan.currency_code;
  new.monthly_grant_microcredits := v_plan.monthly_grant_microcredits;
  new.top_up_currency_micros_per_credit := v_plan.top_up_currency_micros_per_credit;
  new.minimum_top_up_currency_micros := v_plan.minimum_top_up_currency_micros;

  if new.intent_type = 'subscription' then
    new.amount_currency_micros := case new.billing_interval
      when 'monthly' then v_plan.monthly_price_currency_micros
      else v_plan.annual_price_currency_micros
    end;
    new.credit_microcredits := v_plan.monthly_grant_microcredits;
  else
    v_raw_expected_amount := ceil(
      (new.credit_microcredits::numeric * v_plan.top_up_currency_micros_per_credit::numeric)
      / 1000000::numeric
    );
    -- Enforce the product minimum on the nominal plan-rate amount. Payment-rail
    -- cent rounding must never turn an under-minimum purchase into an accepted
    -- one (for example Pro 833 credits is $9.996, not a valid $10 top-up).
    if v_raw_expected_amount < v_plan.minimum_top_up_currency_micros then
      raise exception 'Top-up purchase is below the catalog minimum' using errcode = '22023';
    end if;
    -- The catalog is USD and the payment rail charges whole cents. Round the
    -- precise micro amount upward once more to the 10,000-micro cent quantum.
    v_expected_amount := ceil(v_raw_expected_amount / 10000::numeric) * 10000::numeric;
    if v_expected_amount > 9223372036854775807::numeric then
      raise exception 'Top-up amount exceeds integer range' using errcode = '22003';
    end if;
    new.amount_currency_micros := v_expected_amount::bigint;
  end if;
  if new.status = 'completed' and (
    new.completed_at is null
    or new.provider_checkout_ref is null
    or new.completed_payment_event_id is null
    or new.provider_payment_ref is null
  ) then
    raise exception 'A completed checkout requires verified completion evidence'
      using errcode = '22023';
  end if;
  if new.status <> 'completed' and (
    new.completed_at is not null
    or new.completed_payment_event_id is not null
    or new.provider_payment_ref is not null
    or new.subscription_period_start is not null
    or new.subscription_period_end is not null
  ) then
    raise exception 'Only a completed checkout may have completion evidence'
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
    raise exception 'Checkout completion is not backed by its processed payment event'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function billing_private.apply_subscription_catalog_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan billing_private.plan_catalog;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.customer_id is distinct from old.customer_id
      or new.provider is distinct from old.provider
      or new.provider_subscription_ref is distinct from old.provider_subscription_ref
    then
      raise exception 'Subscription provider and customer identity are immutable'
        using errcode = '55000';
    end if;
    if new.plan_key is distinct from old.plan_key
      or new.billing_interval is distinct from old.billing_interval
    then
      raise exception 'Plan and billing-interval changes require an approved plan-change policy'
        using errcode = '55000';
    end if;
    if new.pricing_version is distinct from old.pricing_version
      or new.currency_code is distinct from old.currency_code
      or new.unit_amount_currency_micros is distinct from old.unit_amount_currency_micros
      or new.included_microcredits_per_grant is distinct from old.included_microcredits_per_grant
    then
      raise exception 'Paid-period subscription pricing snapshots are immutable'
        using errcode = '55000';
    end if;
    if old.billing_interval = 'annual'
      and old.status <> 'incomplete'
      and (
        new.annual_checkout_intent_id is distinct from old.annual_checkout_intent_id
        or new.annual_renewal_attempt_id is distinct from old.annual_renewal_attempt_id
      )
      and new.current_period_start is not distinct from old.current_period_start
      and new.current_period_end is not distinct from old.current_period_end
    then
      raise exception 'An annual paid source may change only with its paid period'
        using errcode = '55000';
    end if;
    if new.saved_payment_method_id is not null and not exists (
      select 1 from billing_private.saved_payment_methods m
      where m.id = new.saved_payment_method_id and m.customer_id = new.customer_id
    ) then
      raise exception 'Saved payment method does not belong to the subscription customer'
        using errcode = '42501';
    end if;
    if new.billing_interval = 'annual'
      and new.status <> 'incomplete'
      and not billing_private.annual_subscription_paid_source_is_valid(
        new.id,
        new.customer_id,
        new.plan_key,
        new.pricing_version,
        new.unit_amount_currency_micros,
        new.currency_code,
        new.included_microcredits_per_grant,
        new.current_period_start,
        new.current_period_end,
        new.annual_checkout_intent_id,
        new.annual_renewal_attempt_id
      )
    then
      raise exception 'Annual subscription period is not backed by its paid source'
        using errcode = '42501';
    end if;
    return new;
  end if;

  select p.* into v_plan from billing_private.plan_catalog p
  where p.plan_key = new.plan_key;
  if not found or (new.status in ('trialing', 'active') and not v_plan.active) then
    raise exception 'Subscription plan is not active in the server catalog'
      using errcode = '42501';
  end if;
  if new.saved_payment_method_id is not null and not exists (
    select 1 from billing_private.saved_payment_methods m
    where m.id = new.saved_payment_method_id and m.customer_id = new.customer_id
  ) then
    raise exception 'Saved payment method does not belong to the subscription customer'
      using errcode = '42501';
  end if;
  new.pricing_version := v_plan.pricing_version;
  new.currency_code := v_plan.currency_code;
  new.unit_amount_currency_micros := case new.billing_interval
    when 'monthly' then v_plan.monthly_price_currency_micros
    when 'annual' then v_plan.annual_price_currency_micros
    else null
  end;
  new.included_microcredits_per_grant := v_plan.monthly_grant_microcredits;
  if new.billing_interval = 'annual'
    and new.status <> 'incomplete'
    and not billing_private.annual_subscription_paid_source_is_valid(
      new.id,
      new.customer_id,
      new.plan_key,
      new.pricing_version,
      new.unit_amount_currency_micros,
      new.currency_code,
      new.included_microcredits_per_grant,
      new.current_period_start,
      new.current_period_end,
      new.annual_checkout_intent_id,
      new.annual_renewal_attempt_id
    )
  then
    raise exception 'Annual subscription period is not backed by its paid source'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function billing_private.apply_auto_reload_catalog_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan billing_private.plan_catalog;
  v_customer_id uuid;
  v_raw_expected_amount numeric;
  v_expected_amount numeric;
begin
  if new.enabled is null then
    raise exception 'Auto-reload enabled state is required' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.account_id is distinct from old.account_id then
    raise exception 'Auto-reload account identity is immutable' using errcode = '55000';
  end if;

  -- Disabled rows may retain the last trusted snapshot for a future opt-in,
  -- but a caller cannot inject replacement economics while charging is off.
  if not new.enabled then
    if tg_op = 'UPDATE' then
      new.plan_key := old.plan_key;
      new.pricing_version := old.pricing_version;
      new.top_up_currency_micros_per_credit := old.top_up_currency_micros_per_credit;
      new.minimum_top_up_currency_micros := old.minimum_top_up_currency_micros;
      new.reload_price_currency_micros := old.reload_price_currency_micros;
      new.currency_code := old.currency_code;
    else
      new.plan_key := null;
      new.pricing_version := null;
      new.top_up_currency_micros_per_credit := null;
      new.minimum_top_up_currency_micros := null;
      new.reload_price_currency_micros := 0;
      new.currency_code := 'USD';
    end if;
    return new;
  end if;

  if new.reload_microcredits is null or new.reload_microcredits <= 0
    or new.saved_payment_method_id is null
  then
    raise exception 'Enabled auto-reload requires credits and a saved payment method'
      using errcode = '22023';
  end if;

  select a.customer_id, p
  into v_customer_id, v_plan
  from public.credit_accounts a
  join public.subscriptions s on s.customer_id = a.customer_id
  join billing_private.plan_catalog p on p.plan_key = s.plan_key and p.active
  where a.id = new.account_id
    and s.status in ('trialing', 'active')
    and coalesce(s.entitlement_ends_at, s.current_period_end) > clock_timestamp()
    and s.pricing_version = p.pricing_version
    and s.currency_code = p.currency_code
    and s.unit_amount_currency_micros = case s.billing_interval
      when 'monthly' then p.monthly_price_currency_micros
      else p.annual_price_currency_micros
    end
    and s.included_microcredits_per_grant = p.monthly_grant_microcredits
  order by s.current_period_end desc nulls last, s.created_at desc
  limit 1;
  if not found then
    raise exception 'An active catalog-backed plan is required for auto-reload'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from billing_private.saved_payment_methods m
    where m.id = new.saved_payment_method_id
      and m.customer_id = v_customer_id
      and m.status = 'active'
      and v_plan.currency_code = any(m.supported_currencies)
  ) then
    raise exception 'Saved payment method does not belong to the account or support its currency'
      using errcode = '42501';
  end if;

  v_raw_expected_amount := ceil(
    (new.reload_microcredits::numeric * v_plan.top_up_currency_micros_per_credit::numeric)
    / 1000000::numeric
  );
  if v_raw_expected_amount < v_plan.minimum_top_up_currency_micros then
    raise exception 'Auto-reload purchase is below the catalog minimum'
      using errcode = '22023';
  end if;
  v_expected_amount := ceil(v_raw_expected_amount / 10000::numeric) * 10000::numeric;
  if v_expected_amount > 9223372036854775807::numeric then
    raise exception 'Auto-reload amount exceeds integer range' using errcode = '22003';
  end if;

  new.plan_key := v_plan.plan_key;
  new.pricing_version := v_plan.pricing_version;
  new.top_up_currency_micros_per_credit := v_plan.top_up_currency_micros_per_credit;
  new.minimum_top_up_currency_micros := v_plan.minimum_top_up_currency_micros;
  new.reload_price_currency_micros := v_expected_amount::bigint;
  new.currency_code := v_plan.currency_code;
  if new.max_reload_currency_micros_per_month is not null
    and new.max_reload_currency_micros_per_month < new.reload_price_currency_micros
  then
    raise exception 'Auto-reload safety ceiling is below one reload purchase'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function billing_private.touch_updated_at();
create trigger billing_customers_touch_updated_at before update on public.billing_customers
for each row execute function billing_private.touch_updated_at();
create trigger subscriptions_touch_updated_at before update on public.subscriptions
for each row execute function billing_private.touch_updated_at();
create trigger subscriptions_catalog_snapshot
before insert or update on public.subscriptions
for each row execute function billing_private.apply_subscription_catalog_snapshot();
create trigger saved_payment_methods_touch_updated_at before update on billing_private.saved_payment_methods
for each row execute function billing_private.touch_updated_at();
create trigger renewal_attempts_touch_updated_at before update on billing_private.renewal_attempts
for each row execute function billing_private.touch_updated_at();
create trigger renewal_attempts_protect_origin
before update or delete on billing_private.renewal_attempts
for each row execute function billing_private.protect_renewal_attempt_origin();
create trigger credit_accounts_touch_updated_at before update on public.credit_accounts
for each row execute function billing_private.touch_updated_at();
create trigger generation_quotes_touch_updated_at before update on public.generation_billing_quotes
for each row execute function billing_private.touch_updated_at();
create trigger reservations_touch_updated_at before update on public.credit_reservations
for each row execute function billing_private.touch_updated_at();
create trigger checkout_intents_touch_updated_at before update on public.checkout_intents
for each row execute function billing_private.touch_updated_at();
create trigger auto_reload_touch_updated_at before update on public.auto_reload_settings
for each row execute function billing_private.touch_updated_at();
create trigger subscription_grants_touch_updated_at before update on public.subscription_grant_schedule
for each row execute function billing_private.touch_updated_at();
create trigger subscription_grants_protect_origin
before update or delete on public.subscription_grant_schedule
for each row execute function billing_private.protect_subscription_grant_origin();

create trigger generation_quotes_protect_economics
before update or delete on public.generation_billing_quotes
for each row execute function billing_private.protect_quote_economics();
create trigger reservation_allocations_protect_origin
before update or delete on public.credit_reservation_allocations
for each row execute function billing_private.protect_allocation_origin();
create trigger payment_events_protect_evidence
before update or delete on public.payment_events
for each row execute function billing_private.protect_payment_event_evidence();
create trigger payment_event_deliveries_are_immutable
before update or delete on billing_private.payment_event_deliveries
for each row execute function billing_private.reject_immutable_mutation();
create trigger checkout_intents_catalog_snapshot
before insert or update on public.checkout_intents
for each row execute function billing_private.apply_checkout_catalog_snapshot();
create trigger auto_reload_catalog_snapshot
before insert or update on public.auto_reload_settings
for each row execute function billing_private.apply_auto_reload_catalog_snapshot();

create trigger credit_ledger_is_immutable
before update or delete on public.credit_ledger
for each row execute function billing_private.reject_immutable_mutation();
create trigger platform_role_audit_is_immutable
before update or delete on public.platform_role_audit
for each row execute function billing_private.reject_immutable_mutation();

create or replace function billing_private.sync_profile_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email_normalized)
  values (new.id, nullif(lower(btrim(new.email)), ''))
  on conflict (user_id) do update
    set email_normalized = excluded.email_normalized;
  return new;
end;
$$;

drop trigger if exists easyfield_sync_profile_from_auth on auth.users;
create trigger easyfield_sync_profile_from_auth
after insert or update of email on auth.users
for each row execute function billing_private.sync_profile_from_auth();

-- Idempotent migration of existing users. No role is inferred from email; every
-- account remains a customer until a trusted bootstrap/server function changes it.
insert into public.profiles (user_id, email_normalized)
select id, nullif(lower(btrim(email)), '')
from auth.users
on conflict (user_id) do update
  set email_normalized = excluded.email_normalized;

-- -------------------------------------------------------------------------
-- RLS ownership predicates. They reveal only a boolean and cannot mutate data.
-- -------------------------------------------------------------------------

create or replace function billing_private.owns_customer(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.billing_customers c
    where c.id = p_customer_id and c.user_id = auth.uid()
  );
$$;

create or replace function billing_private.owns_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.credit_accounts a
    join public.billing_customers c on c.id = a.customer_id
    where a.id = p_account_id and c.user_id = auth.uid()
  );
$$;

create or replace function billing_private.owns_subscription(p_subscription_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.subscriptions s
    join public.billing_customers c on c.id = s.customer_id
    where s.id = p_subscription_id and c.user_id = auth.uid()
  );
$$;

create or replace function billing_private.owns_reservation(p_reservation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.credit_reservations r
    join public.credit_accounts a on a.id = r.account_id
    join public.billing_customers c on c.id = a.customer_id
    where r.id = p_reservation_id and c.user_id = auth.uid()
  );
$$;

-- -------------------------------------------------------------------------
-- Trusted account, role and quote operations
-- -------------------------------------------------------------------------

create or replace function billing_private.ensure_billing_account(
  p_user_id uuid,
  p_provider text default 'internal',
  p_provider_customer_ref text default null
)
returns table (out_customer_id uuid, out_account_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_provider text := lower(btrim(coalesce(p_provider, 'internal')));
begin
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Unknown auth user' using errcode = '23503';
  end if;
  if char_length(v_provider) not between 2 and 40 then
    raise exception 'Invalid billing provider' using errcode = '22023';
  end if;

  -- An empty SELECT ... FOR UPDATE cannot serialize first-use creation. The
  -- unique user_id upsert does: concurrent first requests wait, then both read
  -- the same durable customer row.
  insert into public.billing_customers (user_id, provider, provider_customer_ref)
  values (p_user_id, v_provider, nullif(btrim(p_provider_customer_ref), ''))
  on conflict (user_id) do nothing;

  select id into v_customer_id
  from public.billing_customers
  where user_id = p_user_id
  for update;
  if not found then
    raise exception 'Billing customer could not be ensured' using errcode = 'P0001';
  end if;

  if p_provider_customer_ref is not null and btrim(p_provider_customer_ref) <> '' then
    update public.billing_customers
    set provider = v_provider,
        provider_customer_ref = btrim(p_provider_customer_ref)
    where id = v_customer_id;
  end if;

  insert into public.credit_accounts (customer_id)
  values (v_customer_id)
  on conflict (customer_id) do nothing;

  select id into v_account_id
  from public.credit_accounts
  where customer_id = v_customer_id
  for update;

  return query select v_customer_id, v_account_id;
end;
$$;

create or replace function billing_private.is_active_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.user_id
    where p.user_id = p_user_id
      and p.platform_role = 'admin'
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())
  );
$$;

create or replace function billing_private.set_platform_role(
  p_target_user_id uuid,
  p_new_role text,
  p_reason text,
  p_actor_user_id uuid
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text;
  v_profile public.profiles;
begin
  perform pg_advisory_xact_lock(hashtextextended('easyfield.platform-role-mutation', 0));
  if p_new_role is null or p_new_role not in ('customer', 'support', 'admin') then
    raise exception 'Invalid platform role' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'A role-change reason is required' using errcode = '22023';
  end if;
  if p_actor_user_id is null
    or not billing_private.is_active_admin(p_actor_user_id)
  then
    raise exception 'Actor is not a platform admin' using errcode = '42501';
  end if;

  select platform_role into v_previous
  from public.profiles
  where user_id = p_target_user_id
  for update;
  if not found then
    raise exception 'Target profile does not exist' using errcode = '23503';
  end if;

  if v_previous = 'admin' and p_new_role <> 'admin' and (
    select count(*) from public.profiles where platform_role = 'admin'
  ) <= 1 then
    raise exception 'The final platform admin cannot be demoted' using errcode = '42501';
  end if;

  update public.profiles
  set platform_role = p_new_role
  where user_id = p_target_user_id
  returning * into v_profile;

  if v_previous is distinct from p_new_role then
    insert into public.platform_role_audit (
      target_user_id, actor_user_id, previous_role, new_role, reason
    ) values (
      p_target_user_id, p_actor_user_id, v_previous, p_new_role, btrim(p_reason)
    );
  end if;
  return v_profile;
end;
$$;

create or replace function billing_private.bootstrap_platform_admin(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(p_email)), '');
  v_user_id uuid;
  v_count integer;
  v_previous text;
begin
  perform pg_advisory_xact_lock(hashtextextended('easyfield.platform-role-mutation', 0));
  if v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'A valid normalized email is required' using errcode = '22023';
  end if;

  if exists (select 1 from public.profiles where platform_role = 'admin') then
    raise exception 'The first platform admin has already been bootstrapped'
      using errcode = '42501';
  end if;

  select count(*), min(id::text)::uuid
  into v_count, v_user_id
  from auth.users
  where lower(btrim(email)) = v_email;

  if v_count <> 1 then
    raise exception 'Expected exactly one auth user for %, found %', v_email, v_count
      using errcode = 'P0001';
  end if;
  if not exists (
    select 1
    from auth.users
    where id = v_user_id
      and email_confirmed_at is not null
      and deleted_at is null
      and (banned_until is null or banned_until <= clock_timestamp())
  ) then
    raise exception 'Auth user is not confirmed, was deleted, or is currently banned'
      using errcode = '42501';
  end if;

  insert into public.profiles (user_id, email_normalized)
  values (v_user_id, v_email)
  on conflict (user_id) do update set email_normalized = excluded.email_normalized;

  select platform_role into v_previous
  from public.profiles
  where user_id = v_user_id
  for update;

  update public.profiles
  set platform_role = 'admin'
  where user_id = v_user_id;

  insert into public.platform_role_audit (
    target_user_id, actor_user_id, previous_role, new_role, reason
  ) values (
    v_user_id, null, v_previous, 'admin',
    'One-time trusted database bootstrap by normalized auth email'
  );
  return v_user_id;
end;
$$;

create or replace function billing_private.create_generation_quote(
  p_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text,
  p_model_id text,
  p_action text,
  p_customer_microcredits bigint,
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
  v_plan billing_private.plan_catalog;
  v_admin_bypass boolean := false;
  v_currency text := upper(btrim(p_provider_cost_currency_code));
begin
  if char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 200
    or p_request_sha256 is null or p_request_sha256 !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_model_id, ''))) not between 1 and 200
    or char_length(btrim(coalesce(p_action, ''))) not between 1 and 120
    or char_length(btrim(coalesce(p_pricing_version, ''))) not between 1 and 120
    or p_customer_microcredits is null or p_customer_microcredits <= 0
    or p_provider_cost_currency_micros is null or p_provider_cost_currency_micros < 0
    or v_currency is null or v_currency !~ '^[A-Z]{3}$'
    or p_expires_at is null or p_expires_at <= clock_timestamp()
  then
    raise exception 'Invalid generation quote' using errcode = '22023';
  end if;

  select e.out_customer_id, e.out_account_id
  into v_customer_id, v_account_id
  from billing_private.ensure_billing_account(p_user_id) e;

  v_admin_bypass := billing_private.is_active_admin(p_user_id);

  if not v_admin_bypass then
    select p.* into v_plan
    from public.subscriptions s
    join billing_private.plan_catalog p on p.plan_key = s.plan_key and p.active
    where s.customer_id = v_customer_id
      and s.status in ('trialing', 'active')
      and coalesce(s.entitlement_ends_at, s.current_period_end) > clock_timestamp()
      and s.pricing_version = p.pricing_version
      and s.currency_code = p.currency_code
      and s.unit_amount_currency_micros = case s.billing_interval
        when 'monthly' then p.monthly_price_currency_micros
        else p.annual_price_currency_micros
      end
      and s.included_microcredits_per_grant = p.monthly_grant_microcredits
    order by s.current_period_end desc nulls last, s.created_at desc
    limit 1;
    if not found then
      raise exception 'An active catalog-backed plan entitlement is required'
        using errcode = '42501';
    end if;
    if btrim(p_model_id) = any(v_plan.blocked_model_ids) then
      raise exception 'The selected model is not entitled for plan %', v_plan.plan_key
        using errcode = '42501';
    end if;
  end if;

  select * into v_existing
  from public.generation_billing_quotes
  where customer_id = v_customer_id and idempotency_key = btrim(p_idempotency_key);

  if found then
    if v_existing.request_sha256 <> p_request_sha256
      or v_existing.model_id <> btrim(p_model_id)
      or v_existing.action <> btrim(p_action)
      or v_existing.customer_microcredits <> p_customer_microcredits
      or v_existing.provider_cost_currency_micros <> p_provider_cost_currency_micros
      or v_existing.provider_cost_currency_code <> v_currency
      or v_existing.pricing_version <> btrim(p_pricing_version)
      or v_existing.plan_key is distinct from case when v_admin_bypass then null else v_plan.plan_key end
      or v_existing.admin_bypass <> v_admin_bypass
      or v_existing.expires_at <> p_expires_at
    then
      raise exception 'Quote idempotency key was reused with different inputs' using errcode = '22000';
    end if;
    return v_existing;
  end if;

  insert into public.generation_billing_quotes (
    customer_id, idempotency_key, request_sha256, model_id, action,
    customer_microcredits, provider_cost_currency_micros,
    provider_cost_currency_code, pricing_version, plan_key, admin_bypass, expires_at
  ) values (
    v_customer_id, btrim(p_idempotency_key), p_request_sha256,
    btrim(p_model_id), btrim(p_action), p_customer_microcredits,
    p_provider_cost_currency_micros, v_currency,
    btrim(p_pricing_version), case when v_admin_bypass then null else v_plan.plan_key end,
    v_admin_bypass, p_expires_at
  ) returning * into v_quote;
  return v_quote;
end;
$$;

-- -------------------------------------------------------------------------
-- Credit grants, expiration, reservations, captures and releases
-- -------------------------------------------------------------------------

create or replace function billing_private.grant_credits(
  p_user_id uuid,
  p_amount_microcredits bigint,
  p_source_type text,
  p_idempotency_key text,
  p_source_ref text default null,
  p_subscription_id uuid default null,
  p_granted_at timestamptz default clock_timestamp(),
  p_expires_at timestamptz default null,
  p_currency_amount_micros bigint default null,
  p_currency_code text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_checkout_intent_id uuid default null,
  p_renewal_attempt_id uuid default null
)
returns public.credit_grant_lots
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_existing public.credit_grant_lots;
  v_lot public.credit_grant_lots;
  v_checkout public.checkout_intents;
  v_renewal billing_private.renewal_attempts;
  v_subscription public.subscriptions;
  v_source_ref text := nullif(btrim(p_source_ref), '');
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_request_sha256 text;
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_currency_amount_micros bigint := p_currency_amount_micros;
  v_currency text := case when p_currency_code is null then null else upper(btrim(p_currency_code)) end;
begin
  if p_amount_microcredits is null or p_amount_microcredits <= 0
    or p_source_type is null
    or p_source_type not in ('subscription', 'annual_monthly_grant', 'credit_pack', 'auto_reload', 'promotion', 'refund', 'adjustment')
    or (
      p_source_type not in ('subscription', 'credit_pack', 'auto_reload')
      and char_length(v_idempotency_key) not between 8 and 240
    )
    or p_granted_at is null
    or (p_expires_at is not null and p_expires_at <= p_granted_at)
    or jsonb_typeof(v_metadata) <> 'object'
    or ((p_currency_amount_micros is null) <> (v_currency is null))
    or (p_currency_amount_micros is not null and p_currency_amount_micros < 0)
    or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
  then
    raise exception 'Invalid credit grant' using errcode = '22023';
  end if;

  select e.out_customer_id, e.out_account_id
  into v_customer_id, v_account_id
  from billing_private.ensure_billing_account(p_user_id) e;

  if p_subscription_id is not null and not exists (
    select 1 from public.subscriptions s
    where s.id = p_subscription_id and s.customer_id = v_customer_id
  ) then
    raise exception 'Credit grant subscription does not belong to the user'
      using errcode = '42501';
  end if;

  if p_source_type in ('credit_pack', 'auto_reload') then
    if p_checkout_intent_id is null or p_renewal_attempt_id is not null
      or p_subscription_id is not null or p_expires_at is not null
    then
      raise exception 'Purchased credits require one checkout and must be non-expiring'
        using errcode = '22023';
    end if;
    select * into v_checkout
    from public.checkout_intents
    where id = p_checkout_intent_id;
    if not found
      or v_checkout.customer_id <> v_customer_id
      or v_checkout.intent_type <> p_source_type
      or v_checkout.status <> 'completed' or v_checkout.completed_at is null
      or v_checkout.provider_checkout_ref is null
      or v_checkout.credit_microcredits <> p_amount_microcredits
    then
      raise exception 'Purchased-credit grant does not match a verified completed checkout'
        using errcode = '42501';
    end if;
    if p_currency_amount_micros is not null and (
      p_currency_amount_micros <> v_checkout.amount_currency_micros
      or v_currency is distinct from v_checkout.currency_code
    ) then
      raise exception 'Purchased-credit amount does not match its checkout'
        using errcode = '22023';
    end if;
    v_currency_amount_micros := v_checkout.amount_currency_micros;
    v_currency := v_checkout.currency_code;
    v_source_ref := v_checkout.id::text;
    v_idempotency_key := 'paid:checkout:' || p_checkout_intent_id::text;
  elsif p_source_type = 'subscription' then
    if p_subscription_id is null or p_expires_at is null
      or num_nonnulls(p_checkout_intent_id, p_renewal_attempt_id) <> 1
    then
      raise exception 'Monthly subscription credits require one checkout or renewal source'
        using errcode = '22023';
    end if;
    if p_checkout_intent_id is not null then
      select * into v_checkout
      from public.checkout_intents
      where id = p_checkout_intent_id;
      if not found
        or v_checkout.customer_id <> v_customer_id
        or v_checkout.intent_type <> 'subscription'
        or v_checkout.billing_interval <> 'monthly'
        or v_checkout.status <> 'completed' or v_checkout.completed_at is null
        or v_checkout.provider_checkout_ref is null
        or v_checkout.credit_microcredits <> p_amount_microcredits
      then
        raise exception 'Subscription grant does not match a verified completed checkout'
          using errcode = '42501';
      end if;
      if p_currency_amount_micros is not null and (
        p_currency_amount_micros <> v_checkout.amount_currency_micros
        or v_currency is distinct from v_checkout.currency_code
      ) then
        raise exception 'Subscription amount does not match its checkout'
          using errcode = '22023';
      end if;
      v_currency_amount_micros := v_checkout.amount_currency_micros;
      v_currency := v_checkout.currency_code;
      v_source_ref := v_checkout.id::text;
      v_idempotency_key := 'paid:checkout:' || p_checkout_intent_id::text;
    else
      select * into v_renewal
      from billing_private.renewal_attempts
      where id = p_renewal_attempt_id;
      if not found
        or v_renewal.subscription_id <> p_subscription_id
        or v_renewal.state <> 'succeeded'
        or v_renewal.provider_document_ref is null
        or v_renewal.period_start is distinct from p_granted_at
        or v_renewal.period_end is distinct from p_expires_at
      then
        raise exception 'Subscription grant does not match a verified successful renewal'
          using errcode = '42501';
      end if;
      if p_currency_amount_micros is not null and (
        p_currency_amount_micros <> v_renewal.amount_currency_micros
        or v_currency is distinct from v_renewal.currency_code
      ) then
        raise exception 'Subscription amount does not match its renewal'
          using errcode = '22023';
      end if;
      v_currency_amount_micros := v_renewal.amount_currency_micros;
      v_currency := v_renewal.currency_code;
      v_source_ref := v_renewal.id::text;
      v_idempotency_key := 'paid:renewal:' || p_renewal_attempt_id::text;
    end if;
  elsif p_checkout_intent_id is not null or p_renewal_attempt_id is not null then
    raise exception 'Only paid grants may reference checkout or renewal records'
      using errcode = '22023';
  end if;

  v_request_sha256 := encode(extensions.digest(jsonb_build_object(
    'amount_microcredits', p_amount_microcredits,
    'source_type', p_source_type,
    'source_ref', v_source_ref,
    'subscription_id', p_subscription_id,
    'checkout_intent_id', p_checkout_intent_id,
    'renewal_attempt_id', p_renewal_attempt_id,
    'expires_epoch', case when p_expires_at is null then null else extract(epoch from p_expires_at)::numeric end,
    'currency_amount_micros', v_currency_amount_micros,
    'currency_code', v_currency,
    'metadata', v_metadata
  )::text, 'sha256'), 'hex');

  -- Retry identity is checked before mutable subscription/schedule eligibility.
  -- A request that already committed remains safely idempotent after a period
  -- closes or a subscription changes state.
  select * into v_existing
  from public.credit_grant_lots
  where account_id = v_account_id and idempotency_key = v_idempotency_key;
  if found then
    if v_existing.request_sha256 <> v_request_sha256 then
      raise exception 'Grant idempotency key was reused with different inputs' using errcode = '22000';
    end if;
    return v_existing;
  end if;

  -- Only a new paid lot evaluates mutable subscription state. A retry derives
  -- the same immutable source identity and returns above even after the
  -- subscription advances to its next period, pauses, or is cancelled.
  if p_source_type = 'subscription' then
    select * into v_subscription
    from public.subscriptions
    where id = p_subscription_id and customer_id = v_customer_id;
    if not found
      or v_subscription.billing_interval <> 'monthly'
      or v_subscription.status not in ('trialing', 'active')
      or v_subscription.included_microcredits_per_grant <> p_amount_microcredits
      or v_subscription.current_period_start is distinct from p_granted_at
      or v_subscription.current_period_end is distinct from p_expires_at
    then
      raise exception 'Monthly subscription grant does not match its paid-period snapshot'
        using errcode = '22023';
    end if;
    if p_checkout_intent_id is not null and (
      v_checkout.plan_key <> v_subscription.plan_key
      or v_checkout.pricing_version <> v_subscription.pricing_version
      or v_checkout.amount_currency_micros <> v_subscription.unit_amount_currency_micros
      or v_checkout.currency_code <> v_subscription.currency_code
    ) then
      raise exception 'Subscription checkout does not match the active paid-period snapshot'
        using errcode = '42501';
    end if;
    if p_renewal_attempt_id is not null and (
      v_renewal.plan_key <> v_subscription.plan_key
      or v_renewal.pricing_version <> v_subscription.pricing_version
      or v_renewal.amount_currency_micros <> v_subscription.unit_amount_currency_micros
      or v_renewal.currency_code <> v_subscription.currency_code
    ) then
      raise exception 'Subscription renewal does not match the active paid-period snapshot'
        using errcode = '42501';
    end if;
  end if;

  if p_source_type in ('subscription', 'annual_monthly_grant')
    and (p_subscription_id is null or p_expires_at is null)
  then
    raise exception 'Subscription grants require a subscription and an expiry boundary'
      using errcode = '22023';
  end if;
  if p_source_type = 'annual_monthly_grant' and not exists (
    select 1 from public.subscription_grant_schedule g
    where g.subscription_id = p_subscription_id
      and g.idempotency_key = v_idempotency_key
      and g.amount_microcredits = p_amount_microcredits
      and g.scheduled_for is not distinct from p_granted_at
      and g.lot_expires_at is not distinct from p_expires_at
      and g.status in ('granting', 'granted')
  ) then
    raise exception 'Annual subscription grant does not match its monthly schedule snapshot'
      using errcode = '22023';
  end if;

  insert into public.credit_grant_lots (
    account_id, subscription_id, source_type, source_ref, idempotency_key, request_sha256,
    total_microcredits, available_microcredits, granted_at, expires_at, metadata,
    checkout_intent_id, renewal_attempt_id
  ) values (
    v_account_id, p_subscription_id, p_source_type, v_source_ref,
    v_idempotency_key, v_request_sha256, p_amount_microcredits, p_amount_microcredits,
    p_granted_at, p_expires_at, v_metadata, p_checkout_intent_id, p_renewal_attempt_id
  ) returning * into v_lot;

  update public.credit_accounts
  set available_microcredits = available_microcredits + p_amount_microcredits,
      lifetime_granted_microcredits = lifetime_granted_microcredits + p_amount_microcredits,
      version = version + 1
  where id = v_account_id;

  insert into public.credit_ledger (
    account_id, lot_id, entry_type, available_delta_microcredits,
    currency_amount_micros, currency_code, idempotency_key,
    reference_type, reference_id, metadata
  ) values (
    v_account_id, v_lot.id,
    case when p_source_type = 'refund' then 'refund' when p_source_type = 'adjustment' then 'adjustment' else 'grant' end,
    p_amount_microcredits, v_currency_amount_micros, v_currency,
    'grant:' || v_idempotency_key, p_source_type,
    v_lot.id::text, v_metadata
  );
  return v_lot;
end;
$$;

create or replace function billing_private.expire_account_credit_lots(p_account_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot public.credit_grant_lots;
  v_expired bigint := 0;
begin
  perform 1 from public.credit_accounts where id = p_account_id for update;
  if not found then
    raise exception 'Credit account not found' using errcode = '23503';
  end if;

  for v_lot in
    select *
    from public.credit_grant_lots
    where account_id = p_account_id
      and expires_at is not null
      and expires_at <= clock_timestamp()
      and available_microcredits > 0
    order by expires_at, granted_at, id
    for update
  loop
    update public.credit_grant_lots
    set available_microcredits = 0
    where id = v_lot.id;

    update public.credit_accounts
    set available_microcredits = available_microcredits - v_lot.available_microcredits,
        lifetime_expired_microcredits = lifetime_expired_microcredits + v_lot.available_microcredits,
        version = version + 1
    where id = p_account_id;

    insert into public.credit_ledger (
      account_id, lot_id, entry_type, available_delta_microcredits,
      expired_delta_microcredits, idempotency_key, reference_type, reference_id
    ) values (
      p_account_id, v_lot.id, 'expiration', -v_lot.available_microcredits,
      v_lot.available_microcredits, 'lot.expire:' || v_lot.id::text,
      'credit_lot', v_lot.id::text
    ) on conflict (account_id, idempotency_key) do nothing;

    v_expired := v_expired + v_lot.available_microcredits;
  end loop;
  return v_expired;
end;
$$;

create or replace function billing_private.expire_credit_lots(p_limit integer default 500)
returns table (out_account_id uuid, expired_microcredits bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_expired bigint;
begin
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'Expiration limit must be between 1 and 5000' using errcode = '22023';
  end if;
  for v_account_id in
    select distinct l.account_id
    from public.credit_grant_lots l
    where l.expires_at is not null
      and l.expires_at <= clock_timestamp()
      and l.available_microcredits > 0
    order by l.account_id
    limit p_limit
  loop
    v_expired := billing_private.expire_account_credit_lots(v_account_id);
    if v_expired > 0 then
      out_account_id := v_account_id;
      expired_microcredits := v_expired;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function billing_private.reserve_credits(
  p_user_id uuid,
  p_quote_id uuid,
  p_generation_job_key text,
  p_idempotency_key text,
  p_expires_at timestamptz default (clock_timestamp() + interval '30 minutes')
)
returns public.credit_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote public.generation_billing_quotes;
  v_account public.credit_accounts;
  v_existing public.credit_reservations;
  v_reservation public.credit_reservations;
  v_lot public.credit_grant_lots;
  v_remaining bigint;
  v_take bigint;
  v_expiry timestamptz;
begin
  if char_length(btrim(coalesce(p_generation_job_key, ''))) not between 1 and 240
    or char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 240
    or p_expires_at is null or p_expires_at <= clock_timestamp()
  then
    raise exception 'Invalid credit reservation' using errcode = '22023';
  end if;

  -- Resolve ownership first without retaining a row lock, then use the global
  -- billing lock order (account -> quote -> reservation/lots). This keeps a
  -- simultaneous capture/release from deadlocking with an idempotent retry.
  select q.* into v_quote
  from public.generation_billing_quotes q
  join public.billing_customers c on c.id = q.customer_id
  where q.id = p_quote_id and c.user_id = p_user_id;
  if not found then
    raise exception 'Quote not found for user' using errcode = '23503';
  end if;

  select a.* into v_account
  from public.credit_accounts a
  where a.customer_id = v_quote.customer_id
  for update;
  if not found then
    raise exception 'Credit account not found' using errcode = '23503';
  end if;

  select * into v_quote
  from public.generation_billing_quotes
  where id = p_quote_id and customer_id = v_account.customer_id
  for update;

  if v_quote.admin_bypass then
    raise exception 'Administrator bypass quotes must skip credit reservation'
      using errcode = '55000';
  end if;

  select * into v_existing
  from public.credit_reservations
  where account_id = v_account.id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.quote_id <> p_quote_id
      or v_existing.generation_job_key <> btrim(p_generation_job_key)
    then
      raise exception 'Reservation idempotency key was reused with different inputs' using errcode = '22000';
    end if;
    return v_existing;
  end if;

  if v_quote.status <> 'open' then
    raise exception 'Quote is not open (status: %)', v_quote.status using errcode = '55000';
  end if;
  if v_quote.expires_at <= clock_timestamp() then
    raise exception 'Quote has expired' using errcode = '22000';
  end if;

  perform billing_private.expire_account_credit_lots(v_account.id);
  select * into v_account from public.credit_accounts where id = v_account.id for update;
  if v_account.available_microcredits < v_quote.customer_microcredits then
    raise exception 'Insufficient EasyField credits' using errcode = 'P0001';
  end if;

  v_expiry := least(p_expires_at, clock_timestamp() + interval '24 hours');
  insert into public.credit_reservations (
    account_id, quote_id, generation_job_key, idempotency_key,
    amount_microcredits, expires_at
  ) values (
    v_account.id, p_quote_id, btrim(p_generation_job_key),
    btrim(p_idempotency_key), v_quote.customer_microcredits, v_expiry
  ) returning * into v_reservation;

  v_remaining := v_quote.customer_microcredits;
  for v_lot in
    select *
    from public.credit_grant_lots
    where account_id = v_account.id
      and available_microcredits > 0
      and (expires_at is null or expires_at > clock_timestamp())
    order by expires_at asc nulls last, granted_at, id
    for update
  loop
    exit when v_remaining = 0;
    v_take := least(v_remaining, v_lot.available_microcredits);
    update public.credit_grant_lots
    set available_microcredits = available_microcredits - v_take,
        reserved_microcredits = reserved_microcredits + v_take
    where id = v_lot.id;
    insert into public.credit_reservation_allocations (
      reservation_id, lot_id, reserved_microcredits
    ) values (v_reservation.id, v_lot.id, v_take);
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining <> 0 then
    raise exception 'Credit lot balance does not reconcile with account balance' using errcode = 'P0001';
  end if;

  update public.credit_accounts
  set available_microcredits = available_microcredits - v_quote.customer_microcredits,
      reserved_microcredits = reserved_microcredits + v_quote.customer_microcredits,
      version = version + 1
  where id = v_account.id;

  update public.generation_billing_quotes
  set status = 'reserved'
  where id = p_quote_id;

  insert into public.credit_ledger (
    account_id, reservation_id, quote_id, entry_type,
    available_delta_microcredits, reserved_delta_microcredits,
    idempotency_key, reference_type, reference_id
  ) values (
    v_account.id, v_reservation.id, p_quote_id, 'reserve',
    -v_quote.customer_microcredits, v_quote.customer_microcredits,
    'reservation.reserve:' || btrim(p_idempotency_key),
    'generation_job', btrim(p_generation_job_key)
  );
  return v_reservation;
end;
$$;

create or replace function billing_private.capture_credits(
  p_reservation_id uuid,
  p_idempotency_key text,
  p_amount_microcredits bigint default null,
  p_provider_task_ref text default null
)
returns public.credit_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.credit_reservations;
  v_allocation public.credit_reservation_allocations;
  v_amount bigint;
  v_outstanding bigint;
  v_remaining bigint;
  v_take bigint;
  v_new_captured bigint;
  v_new_status text;
  v_ledger_key text;
  v_existing_ledger public.credit_ledger;
  v_provider_task_ref text := nullif(btrim(p_provider_task_ref), '');
  v_provider_task_ref_sha256 text;
  v_request_sha256 text;
begin
  if char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 240
    or (p_amount_microcredits is not null and p_amount_microcredits <= 0)
    or char_length(coalesce(v_provider_task_ref, '')) > 500
  then
    raise exception 'Invalid capture idempotency key' using errcode = '22023';
  end if;
  if v_provider_task_ref is not null then
    v_provider_task_ref_sha256 := encode(
      extensions.digest(v_provider_task_ref, 'sha256'), 'hex'
    );
  end if;
  v_request_sha256 := encode(extensions.digest(jsonb_build_object(
    'amount_microcredits', p_amount_microcredits,
    'provider_task_ref_sha256', v_provider_task_ref_sha256
  )::text, 'sha256'), 'hex');

  -- Discover the owning account, lock it first, then lock and re-read the
  -- reservation. Every balance mutation follows this same lock order.
  select * into v_reservation
  from public.credit_reservations
  where id = p_reservation_id;
  if not found then
    raise exception 'Reservation not found' using errcode = '23503';
  end if;
  perform 1 from public.credit_accounts where id = v_reservation.account_id for update;
  select * into v_reservation
  from public.credit_reservations
  where id = p_reservation_id
  for update;

  v_ledger_key := 'reservation.capture:' || btrim(p_idempotency_key);
  select * into v_existing_ledger
  from public.credit_ledger
  where account_id = v_reservation.account_id and idempotency_key = v_ledger_key;
  if found then
    if v_existing_ledger.metadata->>'request_sha256' is distinct from v_request_sha256 then
      raise exception 'Capture idempotency key was reused with different inputs'
        using errcode = '22000';
    end if;
    return v_reservation;
  end if;

  v_outstanding := v_reservation.amount_microcredits
    - v_reservation.captured_microcredits
    - v_reservation.released_microcredits;
  v_amount := coalesce(p_amount_microcredits, v_outstanding);
  if v_amount <= 0 or v_amount > v_outstanding then
    raise exception 'Capture amount exceeds reservation remainder' using errcode = '22023';
  end if;

  v_remaining := v_amount;
  for v_allocation in
    select a.*
    from public.credit_reservation_allocations a
    join public.credit_grant_lots l on l.id = a.lot_id
    where a.reservation_id = p_reservation_id
      and a.captured_microcredits + a.released_microcredits < a.reserved_microcredits
    order by l.expires_at asc nulls last, l.granted_at, l.id
    for update of a
  loop
    exit when v_remaining = 0;
    v_take := least(
      v_remaining,
      v_allocation.reserved_microcredits
        - v_allocation.captured_microcredits
        - v_allocation.released_microcredits
    );
    update public.credit_grant_lots
    set reserved_microcredits = reserved_microcredits - v_take
    where id = v_allocation.lot_id;
    update public.credit_reservation_allocations
    set captured_microcredits = captured_microcredits + v_take
    where reservation_id = p_reservation_id and lot_id = v_allocation.lot_id;
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining <> 0 then
    raise exception 'Reservation allocations do not reconcile' using errcode = 'P0001';
  end if;

  v_new_captured := v_reservation.captured_microcredits + v_amount;
  v_new_status := case
    when v_new_captured = v_reservation.amount_microcredits then 'captured'
    when v_new_captured + v_reservation.released_microcredits = v_reservation.amount_microcredits then 'settled'
    else 'partially_captured'
  end;

  update public.credit_accounts
  set reserved_microcredits = reserved_microcredits - v_amount,
      lifetime_consumed_microcredits = lifetime_consumed_microcredits + v_amount,
      version = version + 1
  where id = v_reservation.account_id;

  update public.credit_reservations
  set captured_microcredits = v_new_captured,
      status = v_new_status
  where id = p_reservation_id
  returning * into v_reservation;

  update public.generation_billing_quotes
  set status = case
    when v_new_status = 'captured' then 'captured'
    when v_new_status = 'settled' then 'settled'
    else 'partially_captured'
  end
  where id = v_reservation.quote_id;

  insert into public.credit_ledger (
    account_id, reservation_id, quote_id, entry_type,
    reserved_delta_microcredits, consumed_delta_microcredits,
    idempotency_key, reference_type, reference_id,
    metadata
  ) values (
    v_reservation.account_id, v_reservation.id, v_reservation.quote_id,
    'capture', -v_amount, v_amount, v_ledger_key,
    'reservation', v_reservation.id::text,
    jsonb_build_object(
      'provider_task_recorded', v_provider_task_ref is not null,
      'request_sha256', v_request_sha256
    )
  );
  return v_reservation;
end;
$$;

create or replace function billing_private.release_credits(
  p_reservation_id uuid,
  p_idempotency_key text,
  p_amount_microcredits bigint default null,
  p_reason text default 'manual'
)
returns public.credit_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.credit_reservations;
  v_allocation public.credit_reservation_allocations;
  v_lot public.credit_grant_lots;
  v_amount bigint;
  v_outstanding bigint;
  v_remaining bigint;
  v_take bigint;
  v_returned bigint := 0;
  v_expired bigint := 0;
  v_new_released bigint;
  v_new_status text;
  v_ledger_key text;
  v_existing_ledger public.credit_ledger;
  v_reason text := btrim(p_reason);
  v_request_sha256 text;
begin
  if char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 240
    or char_length(coalesce(v_reason, '')) not between 2 and 200
    or (p_amount_microcredits is not null and p_amount_microcredits <= 0)
  then
    raise exception 'Invalid release request' using errcode = '22023';
  end if;
  v_request_sha256 := encode(extensions.digest(jsonb_build_object(
    'amount_microcredits', p_amount_microcredits,
    'reason', v_reason
  )::text, 'sha256'), 'hex');

  select * into v_reservation
  from public.credit_reservations
  where id = p_reservation_id;
  if not found then
    raise exception 'Reservation not found' using errcode = '23503';
  end if;
  perform 1 from public.credit_accounts where id = v_reservation.account_id for update;
  select * into v_reservation
  from public.credit_reservations
  where id = p_reservation_id
  for update;

  v_ledger_key := 'reservation.release:' || btrim(p_idempotency_key);
  select * into v_existing_ledger
  from public.credit_ledger
  where account_id = v_reservation.account_id and idempotency_key = v_ledger_key;
  if found then
    if v_existing_ledger.metadata->>'request_sha256' is distinct from v_request_sha256 then
      raise exception 'Release idempotency key was reused with different inputs'
        using errcode = '22000';
    end if;
    return v_reservation;
  end if;

  v_outstanding := v_reservation.amount_microcredits
    - v_reservation.captured_microcredits
    - v_reservation.released_microcredits;
  v_amount := coalesce(p_amount_microcredits, v_outstanding);
  if v_amount <= 0 or v_amount > v_outstanding then
    raise exception 'Release amount exceeds reservation remainder' using errcode = '22023';
  end if;

  v_remaining := v_amount;
  for v_allocation in
    select a.*
    from public.credit_reservation_allocations a
    join public.credit_grant_lots l on l.id = a.lot_id
    where a.reservation_id = p_reservation_id
      and a.captured_microcredits + a.released_microcredits < a.reserved_microcredits
    -- Release latest-expiring/non-expiring allocations first so any later
    -- capture still consumes the FIFO reservation origin.
    order by l.expires_at desc nulls first, l.granted_at desc, l.id desc
    for update of a
  loop
    exit when v_remaining = 0;
    v_take := least(
      v_remaining,
      v_allocation.reserved_microcredits
        - v_allocation.captured_microcredits
        - v_allocation.released_microcredits
    );
    select * into v_lot
    from public.credit_grant_lots
    where id = v_allocation.lot_id
    for update;

    if v_lot.expires_at is not null and v_lot.expires_at <= clock_timestamp() then
      update public.credit_grant_lots
      set reserved_microcredits = reserved_microcredits - v_take
      where id = v_lot.id;
      v_expired := v_expired + v_take;
    else
      update public.credit_grant_lots
      set reserved_microcredits = reserved_microcredits - v_take,
          available_microcredits = available_microcredits + v_take
      where id = v_lot.id;
      v_returned := v_returned + v_take;
    end if;

    update public.credit_reservation_allocations
    set released_microcredits = released_microcredits + v_take
    where reservation_id = p_reservation_id and lot_id = v_allocation.lot_id;
    v_remaining := v_remaining - v_take;
  end loop;
  if v_remaining <> 0 then
    raise exception 'Reservation allocations do not reconcile' using errcode = 'P0001';
  end if;

  v_new_released := v_reservation.released_microcredits + v_amount;
  v_new_status := case
    when v_new_released = v_reservation.amount_microcredits
      and lower(v_reason) in ('expired', 'timeout') then 'expired'
    when v_new_released = v_reservation.amount_microcredits then 'released'
    when v_new_released + v_reservation.captured_microcredits = v_reservation.amount_microcredits then 'settled'
    else v_reservation.status
  end;

  update public.credit_accounts
  set available_microcredits = available_microcredits + v_returned,
      reserved_microcredits = reserved_microcredits - v_amount,
      lifetime_expired_microcredits = lifetime_expired_microcredits + v_expired,
      version = version + 1
  where id = v_reservation.account_id;

  update public.credit_reservations
  set released_microcredits = v_new_released,
      status = v_new_status
  where id = p_reservation_id
  returning * into v_reservation;

  update public.generation_billing_quotes
  set status = case
    when v_new_status = 'expired' then 'expired'
    when v_new_status = 'released' then 'released'
    when v_new_status = 'settled' then 'settled'
    when v_reservation.captured_microcredits > 0 then 'partially_captured'
    else 'reserved'
  end
  where id = v_reservation.quote_id;

  insert into public.credit_ledger (
    account_id, reservation_id, quote_id, entry_type,
    available_delta_microcredits, reserved_delta_microcredits,
    expired_delta_microcredits, idempotency_key,
    reference_type, reference_id, metadata
  ) values (
    v_reservation.account_id, v_reservation.id, v_reservation.quote_id,
    'release', v_returned, -v_amount, v_expired, v_ledger_key,
    'reservation', v_reservation.id::text,
    jsonb_build_object(
      'reason', v_reason,
      'returned_microcredits', v_returned,
      'expired_microcredits', v_expired,
      'request_sha256', v_request_sha256
    )
  );
  return v_reservation;
end;
$$;

create or replace function billing_private.expire_credit_reservations(p_limit integer default 500)
returns table (reservation_id uuid, released_microcredits bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_before bigint;
  v_after public.credit_reservations;
begin
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'Reservation expiration limit must be between 1 and 5000' using errcode = '22023';
  end if;
  for v_id in
    select r.id
    from public.credit_reservations r
    where r.status in ('active', 'partially_captured')
      and r.expires_at <= clock_timestamp()
      and r.captured_microcredits + r.released_microcredits < r.amount_microcredits
    order by r.expires_at, r.id
    limit p_limit
  loop
    if not pg_try_advisory_xact_lock(hashtextextended('easyfield.reservation-expiry:' || v_id::text, 0)) then
      continue;
    end if;
    select r.released_microcredits into v_before
    from public.credit_reservations r where r.id = v_id;
    v_after := billing_private.release_credits(
      v_id,
      'expiry-' || v_id::text,
      null,
      'expired'
    );
    reservation_id := v_id;
    released_microcredits := v_after.released_microcredits - v_before;
    return next;
  end loop;
end;
$$;

-- -------------------------------------------------------------------------
-- Annual-plan monthly grants and payment webhook deduplication
-- -------------------------------------------------------------------------

create or replace function billing_private.schedule_annual_plan_grants(
  p_subscription_id uuid,
  p_period_anchor timestamptz,
  p_grant_microcredits bigint,
  p_grant_count integer default 12,
  p_lot_ttl interval default interval '1 month'
)
returns setof public.subscription_grant_schedule
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription public.subscriptions;
  v_existing public.subscription_grant_schedule;
  v_existing_count integer;
  v_index integer;
  v_scheduled_for timestamptz;
  v_lot_expires_at timestamptz;
  v_idempotency_key text;
begin
  select * into v_subscription
  from public.subscriptions
  where id = p_subscription_id
  for update;
  if not found then
    raise exception 'Subscription not found' using errcode = '23503';
  end if;

  -- A retry is resolved from the immutable persisted schedule before looking
  -- at mutable current-period/status fields. This remains safe after a later
  -- renewal advances the subscription because each row retained its paid
  -- source and period snapshot.
  select count(*) into v_existing_count
  from public.subscription_grant_schedule s
  where s.subscription_id = p_subscription_id
    and s.period_anchor = p_period_anchor;
  if v_existing_count > 0 then
    select s.* into v_existing
    from public.subscription_grant_schedule s
    where s.subscription_id = p_subscription_id
      and s.period_anchor = p_period_anchor
    order by s.grant_number
    limit 1;
    if v_existing_count <> 12
      or p_grant_count is distinct from 12
      or p_lot_ttl is distinct from interval '1 month'
      or exists (
        select 1
        from public.subscription_grant_schedule s
        where s.subscription_id = p_subscription_id
          and s.period_anchor = p_period_anchor
          and (
            s.pricing_version is distinct from v_existing.pricing_version
            or s.amount_microcredits is distinct from p_grant_microcredits
            or s.scheduled_for is distinct from (
              p_period_anchor + make_interval(months => s.grant_number - 1)
            )
            or s.lot_expires_at is distinct from (
              p_period_anchor + make_interval(months => s.grant_number)
            )
            or s.annual_checkout_intent_id is distinct from v_existing.annual_checkout_intent_id
            or s.annual_renewal_attempt_id is distinct from v_existing.annual_renewal_attempt_id
          )
      )
      or not billing_private.annual_subscription_paid_source_is_valid(
        v_subscription.id,
        v_subscription.customer_id,
        v_subscription.plan_key,
        v_existing.pricing_version,
        v_subscription.unit_amount_currency_micros,
        v_subscription.currency_code,
        p_grant_microcredits,
        p_period_anchor,
        p_period_anchor + interval '1 year',
        v_existing.annual_checkout_intent_id,
        v_existing.annual_renewal_attempt_id
      )
    then
      raise exception 'Annual schedule retry does not match its paid period'
        using errcode = '22000';
    end if;
    return query
    select s.*
    from public.subscription_grant_schedule s
    where s.subscription_id = p_subscription_id
      and s.period_anchor = p_period_anchor
    order by s.grant_number;
    return;
  end if;

  if v_subscription.billing_interval <> 'annual'
    or v_subscription.status not in ('trialing', 'active')
    or v_subscription.current_period_start is null
    or p_period_anchor is distinct from v_subscription.current_period_start
    or coalesce(v_subscription.entitlement_ends_at, v_subscription.current_period_end) is null
    or coalesce(v_subscription.entitlement_ends_at, v_subscription.current_period_end) <= p_period_anchor
    or p_grant_microcredits is distinct from v_subscription.included_microcredits_per_grant
    or p_grant_count is distinct from 12
    or p_lot_ttl is distinct from interval '1 month'
    or v_subscription.pricing_version is null
    or v_subscription.included_microcredits_per_grant <= 0
  then
    raise exception 'Invalid annual grant schedule' using errcode = '22023';
  end if;
  if not billing_private.annual_subscription_paid_source_is_valid(
    v_subscription.id,
    v_subscription.customer_id,
    v_subscription.plan_key,
    v_subscription.pricing_version,
    v_subscription.unit_amount_currency_micros,
    v_subscription.currency_code,
    v_subscription.included_microcredits_per_grant,
    v_subscription.current_period_start,
    v_subscription.current_period_end,
    v_subscription.annual_checkout_intent_id,
    v_subscription.annual_renewal_attempt_id
  ) then
    raise exception 'Annual grant schedule lacks a verified paid source'
      using errcode = '42501';
  end if;

  -- Once the provider advances current_period_start, any still-pending rows
  -- from an older annual period are no longer eligible to catch up.
  update public.subscription_grant_schedule
  set status = 'cancelled'
  where subscription_id = p_subscription_id
    and period_anchor <> p_period_anchor
    and status = 'pending';

  for v_index in 0..(p_grant_count - 1) loop
    v_scheduled_for := p_period_anchor + make_interval(months => v_index);
    v_lot_expires_at := p_period_anchor + make_interval(months => v_index + 1);
    v_idempotency_key := 'annual:' || p_subscription_id::text || ':'
      || extract(epoch from p_period_anchor)::numeric::text || ':' || (v_index + 1)::text;
    insert into public.subscription_grant_schedule (
      subscription_id, period_anchor, pricing_version, grant_number, scheduled_for,
      amount_microcredits, lot_expires_at, annual_checkout_intent_id,
      annual_renewal_attempt_id, idempotency_key
    ) values (
      p_subscription_id, p_period_anchor, v_subscription.pricing_version,
      v_index + 1, v_scheduled_for,
      p_grant_microcredits, v_lot_expires_at,
      v_subscription.annual_checkout_intent_id,
      v_subscription.annual_renewal_attempt_id,
      v_idempotency_key
    ) on conflict (subscription_id, period_anchor, grant_number) do nothing;

    select * into v_existing
    from public.subscription_grant_schedule
    where subscription_id = p_subscription_id
      and period_anchor = p_period_anchor
      and grant_number = v_index + 1;
    if v_existing.pricing_version <> v_subscription.pricing_version
      or v_existing.scheduled_for <> v_scheduled_for
      or v_existing.amount_microcredits <> p_grant_microcredits
      or v_existing.lot_expires_at is distinct from v_lot_expires_at
      or v_existing.annual_checkout_intent_id is distinct from v_subscription.annual_checkout_intent_id
      or v_existing.annual_renewal_attempt_id is distinct from v_subscription.annual_renewal_attempt_id
      or v_existing.idempotency_key <> v_idempotency_key
    then
      raise exception 'Annual schedule retry does not match the persisted schedule'
        using errcode = '22000';
    end if;
  end loop;

  return query
  select s.*
  from public.subscription_grant_schedule s
  where s.subscription_id = p_subscription_id
    and s.period_anchor = p_period_anchor
  order by s.grant_number;
end;
$$;

create or replace function billing_private.grant_due_annual_plan_credits(p_limit integer default 100)
returns table (schedule_id uuid, granted_lot_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule_id uuid;
  v_subscription_id uuid;
  v_schedule public.subscription_grant_schedule;
  v_subscription public.subscriptions;
  v_user_id uuid;
  v_lot public.credit_grant_lots;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Grant limit must be between 1 and 1000' using errcode = '22023';
  end if;

  for v_schedule_id in
    select s.id
    from public.subscription_grant_schedule s
    where s.status = 'pending'
      and s.scheduled_for <= clock_timestamp()
    order by s.scheduled_for, s.id
    limit p_limit
  loop
    select s.subscription_id into v_subscription_id
    from public.subscription_grant_schedule s where s.id = v_schedule_id;
    if not found then
      continue;
    end if;

    -- Global order for annual work is subscription -> schedule -> customer ->
    -- account, matching schedule creation and avoiding schedule/account races.
    select * into v_subscription
    from public.subscriptions
    where id = v_subscription_id
    for update;
    if not found then
      continue;
    end if;

    select * into v_schedule
    from public.subscription_grant_schedule
    where id = v_schedule_id
    for update skip locked;
    if not found or v_schedule.status <> 'pending'
      or v_schedule.scheduled_for > clock_timestamp()
    then
      continue;
    end if;

    if v_subscription.billing_interval <> 'annual'
      or v_subscription.current_period_start is null
      or v_schedule.period_anchor is distinct from v_subscription.current_period_start
      or coalesce(v_subscription.entitlement_ends_at, v_subscription.current_period_end) is null
      or coalesce(v_subscription.entitlement_ends_at, v_subscription.current_period_end) <= v_schedule.scheduled_for
      or v_schedule.pricing_version is distinct from v_subscription.pricing_version
      or v_schedule.amount_microcredits is distinct from v_subscription.included_microcredits_per_grant
      or v_schedule.annual_checkout_intent_id is distinct from v_subscription.annual_checkout_intent_id
      or v_schedule.annual_renewal_attempt_id is distinct from v_subscription.annual_renewal_attempt_id
      or v_schedule.lot_expires_at is distinct from (
        v_schedule.period_anchor + make_interval(months => v_schedule.grant_number)
      )
      or not billing_private.annual_subscription_paid_source_is_valid(
        v_subscription.id,
        v_subscription.customer_id,
        v_subscription.plan_key,
        v_subscription.pricing_version,
        v_subscription.unit_amount_currency_micros,
        v_subscription.currency_code,
        v_subscription.included_microcredits_per_grant,
        v_subscription.current_period_start,
        v_subscription.current_period_end,
        v_schedule.annual_checkout_intent_id,
        v_schedule.annual_renewal_attempt_id
      )
      or v_subscription.status in ('canceled', 'expired')
    then
      update public.subscription_grant_schedule
      set status = 'cancelled'
      where id = v_schedule.id;
      continue;
    end if;

    -- Delinquency/pausing is non-terminal. Keep the row pending, but never grant
    -- until the same paid period is active again.
    if v_subscription.status not in ('trialing', 'active') then
      continue;
    end if;

    update public.subscription_grant_schedule
    set status = 'granting'
    where id = v_schedule.id;

    select c.user_id into v_user_id
    from public.billing_customers c
    where c.id = v_subscription.customer_id;

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
        'period_anchor', v_schedule.period_anchor
      )
    );

    update public.subscription_grant_schedule
    set status = 'granted',
        granted_lot_id = v_lot.id,
        granted_at = clock_timestamp()
    where id = v_schedule.id;

    schedule_id := v_schedule.id;
    granted_lot_id := v_lot.id;
    return next;
  end loop;
end;
$$;

create or replace function billing_private.create_renewal_attempt(
  p_subscription_id uuid,
  p_period_start timestamptz
)
returns billing_private.renewal_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription public.subscriptions;
  v_method billing_private.saved_payment_methods;
  v_existing billing_private.renewal_attempts;
  v_attempt billing_private.renewal_attempts;
  v_period_end timestamptz;
  v_amount bigint;
begin
  select * into v_subscription
  from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Subscription not found' using errcode = '23503';
  end if;
  if v_subscription.status not in ('trialing', 'active')
    or p_period_start is null
    or p_period_start is distinct from v_subscription.current_period_end
    or v_subscription.saved_payment_method_id is null
    or v_subscription.unit_amount_currency_micros <= 0
    or v_subscription.cancel_at_period_end
  then
    raise exception 'Subscription is not eligible for renewal' using errcode = '42501';
  end if;
  select * into v_method from billing_private.saved_payment_methods
  where id = v_subscription.saved_payment_method_id
    and customer_id = v_subscription.customer_id and status = 'active';
  if not found or not (v_subscription.currency_code = any(v_method.supported_currencies)) then
    raise exception 'Active saved payment method does not support the renewal currency'
      using errcode = '42501';
  end if;

  v_period_end := p_period_start + case v_subscription.billing_interval
    when 'monthly' then interval '1 month' else interval '1 year' end;
  v_amount := v_subscription.unit_amount_currency_micros;

  select * into v_existing from billing_private.renewal_attempts
  where subscription_id = p_subscription_id and period_start = p_period_start;
  if found then
    if v_existing.saved_payment_method_id <> v_method.id
      or v_existing.plan_key <> v_subscription.plan_key
      or v_existing.pricing_version <> v_subscription.pricing_version
      or v_existing.period_end <> v_period_end
      or v_existing.amount_currency_micros <> v_amount
      or v_existing.currency_code <> v_subscription.currency_code
    then
      raise exception 'Renewal retry does not match the persisted price snapshot'
        using errcode = '22000';
    end if;
    return v_existing;
  end if;

  insert into billing_private.renewal_attempts (
    subscription_id, saved_payment_method_id, plan_key, pricing_version,
    period_start, period_end, amount_currency_micros, currency_code
  ) values (
    p_subscription_id, v_method.id, v_subscription.plan_key, v_subscription.pricing_version,
    p_period_start, v_period_end, v_amount, v_subscription.currency_code
  ) returning * into v_attempt;
  return v_attempt;
end;
$$;

create or replace function billing_private.claim_renewal_attempt(
  p_attempt_id uuid,
  p_claim_id uuid
)
returns billing_private.renewal_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt billing_private.renewal_attempts;
begin
  if p_claim_id is null then
    raise exception 'Renewal claim ID is required' using errcode = '22023';
  end if;
  select * into v_attempt from billing_private.renewal_attempts
  where id = p_attempt_id for update;
  if not found then
    raise exception 'Renewal attempt not found' using errcode = '23503';
  end if;
  -- This is intentionally not an idempotent "permission to charge" RPC. Once
  -- the database commits a claim, no retry (including one with the same claim
  -- ID after a lost response) may authorize a second provider call. The worker
  -- must reconcile that one ambiguous call and finish the persisted attempt.
  if v_attempt.state <> 'scheduled' or v_attempt.charge_attempt_count <> 0 then
    raise exception 'Renewal charge was already claimed; automatic retry is forbidden'
      using errcode = '55000';
  end if;
  update billing_private.renewal_attempts
  set state = 'charging', charge_attempt_count = 1,
      charge_claim_id = p_claim_id, charge_claimed_at = clock_timestamp()
  where id = p_attempt_id returning * into v_attempt;
  return v_attempt;
end;
$$;

create or replace function billing_private.finish_renewal_attempt(
  p_attempt_id uuid,
  p_claim_id uuid,
  p_result_state text,
  p_provider_document_ref text default null,
  p_provider_transaction_ref text default null,
  p_provider_status integer default null,
  p_failure_reason text default null
)
returns billing_private.renewal_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt billing_private.renewal_attempts;
  v_document_ref text := nullif(btrim(p_provider_document_ref), '');
  v_transaction_ref text := nullif(btrim(p_provider_transaction_ref), '');
  v_reason text := nullif(btrim(p_failure_reason), '');
begin
  if p_claim_id is null or p_result_state is null
    or p_result_state not in ('succeeded', 'failed', 'unknown')
    or (p_result_state = 'succeeded' and v_document_ref is null)
    or (p_result_state in ('failed', 'unknown') and v_reason is null)
    or char_length(coalesce(v_document_ref, '')) > 500
    or char_length(coalesce(v_transaction_ref, '')) > 500
    or char_length(coalesce(v_reason, '')) > 2000
  then
    raise exception 'Invalid renewal result' using errcode = '22023';
  end if;
  select * into v_attempt from billing_private.renewal_attempts
  where id = p_attempt_id for update;
  if not found then
    raise exception 'Renewal attempt not found' using errcode = '23503';
  end if;
  if v_attempt.charge_claim_id <> p_claim_id then
    raise exception 'Renewal result does not own the charge claim' using errcode = '42501';
  end if;
  if v_attempt.state = p_result_state then
    if v_attempt.provider_document_ref is not distinct from v_document_ref
      and v_attempt.provider_transaction_ref is not distinct from v_transaction_ref
      and v_attempt.provider_status is not distinct from p_provider_status
      and v_attempt.failure_reason is not distinct from v_reason
    then return v_attempt;
    end if;
    raise exception 'Renewal result retry has different inputs' using errcode = '22000';
  end if;
  if v_attempt.state <> 'charging' then
    raise exception 'Renewal attempt is not awaiting its single result' using errcode = '55000';
  end if;
  update billing_private.renewal_attempts
  set state = p_result_state,
      provider_document_ref = v_document_ref,
      provider_transaction_ref = v_transaction_ref,
      provider_status = p_provider_status,
      failure_reason = v_reason
  where id = p_attempt_id returning * into v_attempt;
  return v_attempt;
end;
$$;

create or replace function billing_private.payment_reconciliation_amount_is_valid(p_amount jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_minor_units numeric;
begin
  if jsonb_typeof(p_amount) <> 'object'
    or not (p_amount ?& array['currency', 'minorUnits', 'exponent'])
    or exists (
      select 1 from jsonb_object_keys(p_amount) as amount_keys(key_name)
      where key_name <> all (array['currency', 'minorUnits', 'exponent'])
    )
    or jsonb_typeof(p_amount->'currency') <> 'string'
    or p_amount->>'currency' not in ('ILS', 'USD', 'EUR', 'GBP')
    or jsonb_typeof(p_amount->'minorUnits') <> 'number'
    or p_amount->>'minorUnits' !~ '^[0-9]+$'
    or jsonb_typeof(p_amount->'exponent') <> 'number'
    or p_amount->'exponent' <> '2'::jsonb
  then
    return false;
  end if;
  v_minor_units := (p_amount->>'minorUnits')::numeric;
  return v_minor_units between 1 and 100000000;
exception when others then
  return false;
end;
$$;

-- The database accepts only the provider-neutral DTO emitted after signature
-- verification and PII redaction. It deliberately rejects generic/raw webhook
-- JSON, unknown top-level fields and unknown nested transaction/amount fields.
create or replace function billing_private.payment_reconciliation_payload_is_valid(
  p_payload jsonb,
  p_event_type text
)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_issue jsonb;
  v_transaction jsonb;
  v_text text;
  v_ready boolean;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_payload) as payload_keys(key_name)
      where key_name <> all (array[
        'type', 'id', 'reconciliationState', 'entitlementGrantAllowed', 'issues',
        'operationReference', 'total', 'transactions'
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
    if p_payload ?| array['operationReference', 'total', 'transactions']
      or (v_ready and not (p_payload ? 'id'))
    then
      return false;
    end if;
    return true;
  end if;

  if not (p_payload ? 'transactions')
    or jsonb_typeof(p_payload->'transactions') <> 'array'
    or jsonb_array_length(p_payload->'transactions') > 100
  then
    return false;
  end if;
  if p_payload ? 'operationReference' and (
    jsonb_typeof(p_payload->'operationReference') <> 'string'
    or p_payload->>'operationReference' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ) then
    return false;
  end if;
  if p_payload ? 'total' and (
    jsonb_typeof(p_payload->'total') <> 'object'
    or not billing_private.payment_reconciliation_amount_is_valid(p_payload->'total')
  ) then
    return false;
  end if;

  for v_transaction in select value from jsonb_array_elements(p_payload->'transactions') loop
    if jsonb_typeof(v_transaction) <> 'object'
      or exists (
        select 1 from jsonb_object_keys(v_transaction) as transaction_keys(key_name)
        where key_name <> all (array['id', 'createdAt', 'amount', 'gatewayTransactionId'])
      )
    then
      return false;
    end if;
    if v_transaction ? 'id' then
      v_text := v_transaction->>'id';
      if jsonb_typeof(v_transaction->'id') <> 'string'
        or v_text !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      then
        return false;
      end if;
    end if;
    if v_transaction ? 'gatewayTransactionId' then
      v_text := v_transaction->>'gatewayTransactionId';
      if jsonb_typeof(v_transaction->'gatewayTransactionId') <> 'string'
        or v_text !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      then
        return false;
      end if;
    end if;
    if v_transaction ? 'createdAt' and (
      jsonb_typeof(v_transaction->'createdAt') <> 'number'
      or v_transaction->>'createdAt' !~ '^[0-9]+$'
      or (v_transaction->>'createdAt')::numeric not between 1 and 9007199254740991
    ) then
      return false;
    end if;
    if v_transaction ? 'amount' and (
      jsonb_typeof(v_transaction->'amount') <> 'object'
      or not billing_private.payment_reconciliation_amount_is_valid(v_transaction->'amount')
    ) then
      return false;
    end if;
    if v_ready and not (v_transaction ?& array['id', 'amount']) then
      return false;
    end if;
  end loop;

  if v_ready and (
    not (p_payload ?& array['id', 'total'])
    or jsonb_array_length(p_payload->'transactions') = 0
  ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

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
begin
  if v_provider is null or char_length(v_provider) not between 2 and 40
    or (v_event_id is not null and char_length(v_event_id) > 300)
    or char_length(coalesce(v_delivery_id, '')) not between 1 and 300
    or v_event_type is distinct from 'payment/received'
    or p_raw_body_sha256 is null or p_raw_body_sha256 !~ '^[0-9a-f]{64}$'
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 262144
    or not billing_private.payment_reconciliation_payload_is_valid(p_payload, v_event_type)
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

create or replace function billing_private.claim_payment_event(
  p_payment_event_id uuid,
  p_claim_id uuid,
  p_reclaim_after interval default interval '15 minutes'
)
returns public.payment_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.payment_events;
begin
  if p_claim_id is null or p_reclaim_after is null
    or p_reclaim_after <= interval '0 seconds'
  then
    raise exception 'Invalid payment event claim' using errcode = '22023';
  end if;
  select * into v_event from public.payment_events
  where id = p_payment_event_id for update;
  if not found then
    raise exception 'Payment event not found' using errcode = '23503';
  end if;
  if v_event.status in ('processed', 'ignored') then
    raise exception 'Payment event is already terminal' using errcode = '55000';
  end if;
  if v_event.status = 'processing' and v_event.processing_claim_id = p_claim_id then
    return v_event;
  end if;
  if v_event.status = 'processing'
    and v_event.processing_started_at > clock_timestamp() - p_reclaim_after
  then
    raise exception 'Payment event is claimed by another worker' using errcode = '55P03';
  end if;
  update public.payment_events
  set status = 'processing', attempt_count = attempt_count + 1,
      processing_claim_id = p_claim_id, processing_started_at = clock_timestamp(),
      last_error = null
  where id = p_payment_event_id returning * into v_event;
  return v_event;
end;
$$;

create or replace function billing_private.finish_payment_event(
  p_payment_event_id uuid,
  p_claim_id uuid,
  p_status text,
  p_last_error text default null
)
returns public.payment_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.payment_events;
  v_error text := nullif(btrim(p_last_error), '');
begin
  if p_claim_id is null or p_status is null
    or p_status not in ('processed', 'failed', 'ignored')
    or (p_status = 'failed' and v_error is null)
    or char_length(coalesce(v_error, '')) > 4000
  then
    raise exception 'Invalid payment event result' using errcode = '22023';
  end if;
  select * into v_event from public.payment_events
  where id = p_payment_event_id for update;
  if not found then
    raise exception 'Payment event not found' using errcode = '23503';
  end if;
  if v_event.processing_claim_id <> p_claim_id then
    raise exception 'Payment event result does not own the claim' using errcode = '42501';
  end if;
  if v_event.status = p_status then
    if v_event.last_error is not distinct from v_error then return v_event; end if;
    raise exception 'Payment event result retry has different inputs' using errcode = '22000';
  end if;
  if v_event.status <> 'processing' then
    raise exception 'Payment event is not processing' using errcode = '55000';
  end if;
  update public.payment_events
  set status = p_status,
      processed_at = case when p_status in ('processed', 'ignored') then clock_timestamp() else null end,
      last_error = v_error
  where id = p_payment_event_id returning * into v_event;
  return v_event;
end;
$$;

-- -------------------------------------------------------------------------
-- Safe user snapshot: no provider IDs, payment method IDs, webhook payloads,
-- idempotency keys or raw provider costs are returned.
-- -------------------------------------------------------------------------

create or replace function public.my_billing_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'as_of', clock_timestamp(),
    'profile', jsonb_build_object(
      'user_id', p.user_id,
      'email', p.email_normalized,
      'platform_role', p.platform_role
    ),
    'customer_status', c.status,
    'account', case when a.id is null then null else jsonb_build_object(
      'account_id', a.id,
      -- Derive the visible balance from unexpired lots so a delayed sweeper can
      -- never make expired credits appear spendable in the account UI.
      'available_microcredits', coalesce(lot_balance.available_microcredits, 0),
      'subscription_microcredits', coalesce(lot_balance.subscription_microcredits, 0),
      'purchased_microcredits', coalesce(lot_balance.purchased_microcredits, 0),
      'other_microcredits', coalesce(lot_balance.other_microcredits, 0),
      'reserved_microcredits', a.reserved_microcredits,
      'lifetime_granted_microcredits', a.lifetime_granted_microcredits,
      'lifetime_consumed_microcredits', a.lifetime_consumed_microcredits,
      'lifetime_expired_microcredits', a.lifetime_expired_microcredits,
      'version', a.version
    ) end,
    'subscription', (
      select jsonb_build_object(
        'id', s.id,
        'plan_key', s.plan_key,
        'billing_interval', s.billing_interval,
        'pricing_version', s.pricing_version,
        'status', s.status,
        'current_period_start', s.current_period_start,
        'current_period_end', s.current_period_end,
        'entitlement_ends_at', s.entitlement_ends_at,
        'cancel_at_period_end', s.cancel_at_period_end,
        'currency_code', s.currency_code,
        'unit_amount_currency_micros', s.unit_amount_currency_micros,
        'included_microcredits_per_grant', s.included_microcredits_per_grant
      )
      from public.subscriptions s
      where s.customer_id = c.id
      order by
        case s.status when 'active' then 0 when 'trialing' then 1 when 'past_due' then 2 else 3 end,
        s.current_period_end desc nulls last,
        s.created_at desc
      limit 1
    ),
    'next_expiring_lot', (
      select jsonb_build_object(
        'expires_at', x.expires_at,
        'available_microcredits', x.available_microcredits
      )
      from (
        select l.expires_at, sum(l.available_microcredits)::bigint as available_microcredits
        from public.credit_grant_lots l
        where l.account_id = a.id
          and l.available_microcredits > 0
          and l.expires_at > clock_timestamp()
        group by l.expires_at
        order by l.expires_at
        limit 1
      ) x
    ),
    'auto_reload', (
      select jsonb_build_object(
        'enabled', r.enabled,
        'trigger_below_microcredits', r.trigger_below_microcredits,
        'reload_microcredits', r.reload_microcredits,
        'plan_key', r.plan_key,
        'pricing_version', r.pricing_version,
        'top_up_currency_micros_per_credit', r.top_up_currency_micros_per_credit,
        'minimum_top_up_currency_micros', r.minimum_top_up_currency_micros,
        'reload_price_currency_micros', r.reload_price_currency_micros,
        'max_reload_currency_micros_per_month', r.max_reload_currency_micros_per_month,
        'current_month_spend_currency_micros', r.current_month_spend_currency_micros,
        'currency_code', r.currency_code,
        'last_triggered_at', r.last_triggered_at
      )
      from public.auto_reload_settings r
      where r.account_id = a.id
    )
  ) into v_result
  from public.profiles p
  left join public.billing_customers c on c.user_id = p.user_id
  left join public.credit_accounts a on a.customer_id = c.id
  left join lateral (
    select
      coalesce(sum(l.available_microcredits), 0)::bigint as available_microcredits,
      coalesce(sum(l.available_microcredits) filter (
        where l.source_type in ('subscription', 'annual_monthly_grant')
      ), 0)::bigint
        as subscription_microcredits,
      coalesce(sum(l.available_microcredits) filter (
        where l.source_type in ('credit_pack', 'auto_reload')
      ), 0)::bigint
        as purchased_microcredits,
      coalesce(sum(l.available_microcredits) filter (
        where l.source_type not in (
          'subscription', 'annual_monthly_grant', 'credit_pack', 'auto_reload'
        )
      ), 0)::bigint
        as other_microcredits
    from public.credit_grant_lots l
    where l.account_id = a.id
      and l.available_microcredits > 0
      and (l.expires_at is null or l.expires_at > clock_timestamp())
  ) lot_balance on true
  where p.user_id = v_user_id;

  return coalesce(v_result, jsonb_build_object(
    'as_of', clock_timestamp(),
    'profile', null,
    'customer_status', null,
    'account', null,
    'subscription', null,
    'next_expiring_lot', null,
    'auto_reload', null
  ));
end;
$$;

-- -------------------------------------------------------------------------
-- Row-level security. A platform_role never bypasses RLS from the client;
-- support/admin tooling must authenticate to a trusted server using service_role.
-- -------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.platform_role_audit enable row level security;
alter table public.platform_role_audit force row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_customers force row level security;
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_accounts force row level security;
alter table public.generation_billing_quotes enable row level security;
alter table public.generation_billing_quotes force row level security;
alter table public.credit_grant_lots enable row level security;
alter table public.credit_grant_lots force row level security;
alter table public.credit_reservations enable row level security;
alter table public.credit_reservations force row level security;
alter table public.credit_reservation_allocations enable row level security;
alter table public.credit_reservation_allocations force row level security;
alter table public.credit_ledger enable row level security;
alter table public.credit_ledger force row level security;
alter table public.checkout_intents enable row level security;
alter table public.checkout_intents force row level security;
alter table public.payment_events enable row level security;
alter table public.payment_events force row level security;
alter table public.auto_reload_settings enable row level security;
alter table public.auto_reload_settings force row level security;
alter table public.subscription_grant_schedule enable row level security;
alter table public.subscription_grant_schedule force row level security;

create policy profiles_select_own on public.profiles
for select to authenticated using (user_id = auth.uid());
create policy billing_customers_select_own on public.billing_customers
for select to authenticated using (user_id = auth.uid());
create policy subscriptions_select_own on public.subscriptions
for select to authenticated using (billing_private.owns_customer(customer_id));
create policy credit_accounts_select_own on public.credit_accounts
for select to authenticated using (billing_private.owns_customer(customer_id));
create policy generation_quotes_select_own on public.generation_billing_quotes
for select to authenticated using (billing_private.owns_customer(customer_id));
create policy credit_lots_select_own on public.credit_grant_lots
for select to authenticated using (billing_private.owns_account(account_id));
create policy reservations_select_own on public.credit_reservations
for select to authenticated using (billing_private.owns_account(account_id));
create policy reservation_allocations_select_own on public.credit_reservation_allocations
for select to authenticated using (billing_private.owns_reservation(reservation_id));
create policy credit_ledger_select_own on public.credit_ledger
for select to authenticated using (billing_private.owns_account(account_id));
create policy checkout_intents_select_own on public.checkout_intents
for select to authenticated using (billing_private.owns_customer(customer_id));
create policy auto_reload_select_own on public.auto_reload_settings
for select to authenticated using (billing_private.owns_account(account_id));
create policy subscription_grants_select_own on public.subscription_grant_schedule
for select to authenticated using (billing_private.owns_subscription(subscription_id));

-- No client INSERT/UPDATE/DELETE policies or table privileges are created.
revoke all on all tables in schema billing_private from public, anon, authenticated;
revoke all on all sequences in schema billing_private from public, anon, authenticated;
revoke all on all functions in schema billing_private from public, anon, authenticated;
revoke all on function public.my_billing_snapshot() from public, anon;

revoke all on public.profiles,
  public.platform_role_audit,
  public.billing_customers,
  public.subscriptions,
  public.credit_accounts,
  public.generation_billing_quotes,
  public.credit_grant_lots,
  public.credit_reservations,
  public.credit_reservation_allocations,
  public.credit_ledger,
  public.checkout_intents,
  public.payment_events,
  public.auto_reload_settings,
  public.subscription_grant_schedule
from public, anon, authenticated;

grant usage on schema billing_private to authenticated;
grant execute on function billing_private.owns_customer(uuid) to authenticated;
grant execute on function billing_private.owns_account(uuid) to authenticated;
grant execute on function billing_private.owns_subscription(uuid) to authenticated;
grant execute on function billing_private.owns_reservation(uuid) to authenticated;
grant execute on function public.my_billing_snapshot() to authenticated;

grant select on public.profiles to authenticated;
grant select (
  id, customer_id, plan_key, billing_interval, pricing_version, status,
  current_period_start, current_period_end, entitlement_ends_at,
  cancel_at_period_end, currency_code, unit_amount_currency_micros,
  included_microcredits_per_grant, created_at, updated_at
) on public.subscriptions to authenticated;
grant select on public.credit_accounts to authenticated;
grant select (
  id, customer_id, model_id, action, customer_microcredits,
  pricing_version, status, expires_at, created_at, updated_at
) on public.generation_billing_quotes to authenticated;
grant select (
  id, account_id, subscription_id, source_type, total_microcredits,
  available_microcredits, reserved_microcredits, granted_at, expires_at, created_at
) on public.credit_grant_lots to authenticated;
grant select (
  id, account_id, amount_microcredits, captured_microcredits,
  released_microcredits, status, expires_at, created_at, updated_at
) on public.credit_reservations to authenticated;
grant select on public.credit_reservation_allocations to authenticated;
grant select (
  id, account_id, lot_id, reservation_id, quote_id, entry_type,
  available_delta_microcredits, reserved_delta_microcredits,
  consumed_delta_microcredits, expired_delta_microcredits,
  currency_amount_micros, currency_code, created_at
) on public.credit_ledger to authenticated;
grant select (
  id, customer_id, intent_type, plan_key, billing_interval, pricing_version,
  monthly_grant_microcredits, top_up_currency_micros_per_credit,
  minimum_top_up_currency_micros, status, amount_currency_micros,
  currency_code, credit_microcredits, expires_at, completed_at,
  created_at, updated_at
) on public.checkout_intents to authenticated;
grant select (
  account_id, enabled, trigger_below_microcredits, reload_microcredits,
  plan_key, pricing_version, top_up_currency_micros_per_credit,
  minimum_top_up_currency_micros,
  reload_price_currency_micros, max_reload_currency_micros_per_month,
  current_month_spend_currency_micros, currency_code,
  month_window_started_at, last_triggered_at, created_at, updated_at
) on public.auto_reload_settings to authenticated;
grant select (
  id, subscription_id, period_anchor, pricing_version, grant_number, scheduled_for,
  amount_microcredits, lot_expires_at, status, granted_lot_id,
  granted_at, created_at, updated_at
) on public.subscription_grant_schedule to authenticated;

-- Trusted backend reads operational state, but financial mutations go through
-- the SECURITY DEFINER functions above. Direct role, quote, balance, allocation,
-- event-evidence, schedule and ledger mutation is intentionally not granted.
grant select on public.profiles,
  public.platform_role_audit,
  public.billing_customers,
  public.subscriptions,
  public.credit_accounts,
  public.generation_billing_quotes,
  public.credit_grant_lots,
  public.credit_reservations,
  public.credit_reservation_allocations,
  public.credit_ledger,
  public.checkout_intents,
  public.payment_events,
  public.auto_reload_settings,
  public.subscription_grant_schedule
to service_role;
grant insert, update on public.subscriptions,
  public.checkout_intents,
  public.auto_reload_settings
to service_role;
grant update on public.billing_customers to service_role;
grant select on billing_private.plan_catalog,
  billing_private.saved_payment_methods,
  billing_private.renewal_attempts,
  billing_private.payment_event_deliveries
to service_role;
grant insert, update on billing_private.saved_payment_methods to service_role;
grant execute on all functions in schema billing_private to service_role;
grant execute on function public.my_billing_snapshot() to service_role;

comment on table public.credit_ledger is
  'Append-only double-entry-style credit movements in integer microcredits. Never update/delete; write a compensating row.';
comment on column public.generation_billing_quotes.provider_cost_currency_micros is
  'Server/admin-only raw provider cost. This column is intentionally not granted to authenticated clients.';
comment on function billing_private.reserve_credits(uuid, uuid, text, text, timestamptz) is
  'Atomically expires due lots, validates a server-created quote, reserves FIFO credit lots and appends a ledger entry before provider submission.';
comment on function billing_private.capture_credits(uuid, text, bigint, text) is
  'Idempotently captures reserved microcredits after provider acceptance/success according to backend policy.';
comment on function billing_private.release_credits(uuid, text, bigint, text) is
  'Idempotently releases unspent reservation credits; already-expired lot portions are recorded as expired rather than restored.';

commit;
