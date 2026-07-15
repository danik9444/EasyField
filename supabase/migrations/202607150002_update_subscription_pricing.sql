begin;

-- Forward-only catalog update for installations that already applied
-- 202607140001_subscription_billing.sql before the 2026-07-15 pricing revision.
--
-- Paid-period economics are immutable. This migration therefore refuses to
-- rewrite the catalog while a live billing workflow still references the old
-- version. Existing completed/cancelled history remains untouched.

-- ACCESS EXCLUSIVE also waits for SELECT ... FOR UPDATE workers. The state
-- guards installed by the preceding migration reject stale work after this
-- transaction releases the locks.
lock table
  public.subscriptions,
  public.checkout_intents,
  billing_private.renewal_attempts,
  public.auto_reload_settings,
  public.subscription_grant_schedule,
  public.credit_grant_lots,
  billing_private.plan_catalog
in access exclusive mode;

do $$
declare
  v_known_plans integer;
  v_requires_revision boolean;
begin
  select
    count(*) filter (where catalog.plan_key in ('starter', 'creator', 'pro', 'studio')),
    coalesce(bool_or(
      catalog.plan_key in ('starter', 'creator', 'pro', 'studio')
      and (
        catalog.pricing_version <> 'billing-2026-07-15'
        or catalog.monthly_grant_microcredits <> case catalog.plan_key
          when 'starter' then 800000000::bigint
          when 'creator' then 2000000000::bigint
          when 'pro' then 5000000000::bigint
          when 'studio' then 12000000000::bigint
        end
        or catalog.top_up_currency_micros_per_credit <> case catalog.plan_key
          when 'starter' then 20000::bigint
          when 'creator' then 15000::bigint
          when 'pro' then 12000::bigint
          when 'studio' then 10000::bigint
        end
      )
    ), false)
  into v_known_plans, v_requires_revision
  from billing_private.plan_catalog as catalog;

  if v_known_plans <> 4 then
    raise exception 'Expected all four EasyField subscription plans, found %', v_known_plans;
  end if;

  -- Closed checkouts can still move directly to completed if a delayed signed
  -- payment event proves the charge. Keep their old catalog live until a
  -- trusted adapter either completes them or records no-payment evidence.
  if exists (
    select 1
    from public.checkout_intents as recoverable_checkout
    where recoverable_checkout.plan_key in ('starter', 'creator', 'pro', 'studio')
      and recoverable_checkout.pricing_version <> 'billing-2026-07-15'
      and recoverable_checkout.status in ('failed', 'expired', 'cancelled')
  ) then
    raise exception
      'Cannot revise plan catalog while a closed checkout awaits reconciliation';
  end if;

  -- A verified subscription payment can exist briefly before its subscription
  -- and first grant are materialized. Do not strand that immutable purchase on
  -- the previous catalog version, even if the catalog was manually revised.
  if exists (
    select 1
    from public.checkout_intents as paid_checkout
    where paid_checkout.plan_key in ('starter', 'creator', 'pro', 'studio')
      and paid_checkout.intent_type = 'subscription'
      and paid_checkout.status = 'completed'
      and paid_checkout.pricing_version <> 'billing-2026-07-15'
      and not exists (
        select 1
        from public.subscriptions as annual_subscription
        where annual_subscription.annual_checkout_intent_id = paid_checkout.id
      )
      and not exists (
        select 1
        from public.credit_grant_lots as initial_grant
        join public.subscriptions as monthly_subscription
          on monthly_subscription.customer_id = paid_checkout.customer_id
          and monthly_subscription.billing_interval = 'monthly'
          and monthly_subscription.plan_key = paid_checkout.plan_key
          and monthly_subscription.pricing_version = paid_checkout.pricing_version
        where initial_grant.checkout_intent_id = paid_checkout.id
          and initial_grant.source_type = 'subscription'
      )
  ) then
    raise exception
      'Cannot revise plan catalog while a completed subscription checkout is unmaterialized';
  end if;

  if not v_requires_revision then
    return;
  end if;

  if exists (
    select 1
    from public.subscriptions as active_subscription
    where active_subscription.plan_key in ('starter', 'creator', 'pro', 'studio')
      and active_subscription.status not in ('canceled', 'expired')
  ) then
    raise exception
      'Cannot revise plan catalog while a non-terminal subscription retains paid-period economics';
  end if;

  if exists (
    select 1
    from public.checkout_intents as checkout_intent
    where checkout_intent.plan_key in ('starter', 'creator', 'pro', 'studio')
      and checkout_intent.status in ('created', 'open')
  ) then
    raise exception 'Cannot revise plan catalog while a checkout is open';
  end if;

  if exists (
    select 1
    from billing_private.renewal_attempts as renewal_attempt
    where renewal_attempt.plan_key in ('starter', 'creator', 'pro', 'studio')
      and renewal_attempt.state in ('scheduled', 'charging')
  ) then
    raise exception 'Cannot revise plan catalog while a renewal is unresolved';
  end if;

  if exists (
    select 1
    from public.auto_reload_settings as auto_reload
    where auto_reload.enabled
      and auto_reload.plan_key in ('starter', 'creator', 'pro', 'studio')
  ) then
    raise exception 'Cannot revise plan catalog while auto-reload is enabled';
  end if;

  if exists (
    select 1
    from public.subscription_grant_schedule as grant_schedule
    join public.subscriptions as scheduled_subscription
      on scheduled_subscription.id = grant_schedule.subscription_id
    where scheduled_subscription.plan_key in ('starter', 'creator', 'pro', 'studio')
      and grant_schedule.status in ('pending', 'granting')
  ) then
    raise exception 'Cannot revise plan catalog while an annual grant is pending';
  end if;
end
$$;

-- The catalog is deliberately immutable during normal operation. A trusted,
-- transactional migration may replace the current control-plane values after
-- the preflight above proves no live paid snapshot would be invalidated.
alter table billing_private.plan_catalog
  disable trigger plan_catalog_is_immutable;

do $$
declare
  v_updated integer;
begin
  update billing_private.plan_catalog as catalog
  set
    pricing_version = revised.pricing_version,
    monthly_grant_microcredits = revised.monthly_grant_microcredits,
    top_up_currency_micros_per_credit = revised.top_up_currency_micros_per_credit
  from (values
    ('starter'::text, 'billing-2026-07-15'::text, 800000000::bigint, 20000::bigint),
    ('creator'::text, 'billing-2026-07-15'::text, 2000000000::bigint, 15000::bigint),
    ('pro'::text, 'billing-2026-07-15'::text, 5000000000::bigint, 12000::bigint),
    ('studio'::text, 'billing-2026-07-15'::text, 12000000000::bigint, 10000::bigint)
  ) as revised(
    plan_key,
    pricing_version,
    monthly_grant_microcredits,
    top_up_currency_micros_per_credit
  )
  where catalog.plan_key = revised.plan_key;

  get diagnostics v_updated = row_count;
  if v_updated <> 4 then
    raise exception 'Expected to update four subscription plans, updated %', v_updated;
  end if;
end
$$;

alter table billing_private.plan_catalog
  enable trigger plan_catalog_is_immutable;

commit;
