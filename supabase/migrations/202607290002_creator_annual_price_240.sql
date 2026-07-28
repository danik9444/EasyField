begin;

-- Forward-only Creator annual catalog revision.
--
-- 20260715154941_creator_monthly_price_24.sql lowered the Creator monthly price
-- from $30 to $24 and deliberately left the annual price at $300. That left the
-- annual plan costing $300 against $288 for twelve monthly charges, so annual
-- was $12 MORE expensive than paying monthly while every other tier saved. The
-- client clamped the displayed saving to zero rather than showing a negative
-- number, which is why the inconsistency was never visible on screen.
--
-- $240 restores the intended relationship: $20/month equivalent, saving $48 a
-- year, in line with Starter, Pro and Studio.
--
-- The catalog is intentionally one current row per plan. Refuse the in-place
-- control-plane revision while any Creator workflow could still become paid,
-- renew, reload or grant against the previous pricing version.
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
  v_creator billing_private.plan_catalog;
  v_source_version constant text := 'billing-2026-07-15-creator-monthly-24';
  v_target_version constant text := 'billing-2026-07-29-creator-annual-240';
begin
  select catalog.* into v_creator
  from billing_private.plan_catalog as catalog
  where catalog.plan_key = 'creator';

  if not found then
    raise exception 'Expected the Creator subscription plan in the catalog';
  end if;

  -- Fail closed instead of overwriting an unknown catalog revision. The
  -- migration may be inspected/replayed after it already reached its target,
  -- but every other starting state requires an explicit follow-up migration.
  if not (
    (
      v_creator.pricing_version = v_source_version
      and v_creator.annual_price_currency_micros = 300000000::bigint
    )
    or
    (
      v_creator.pricing_version = v_target_version
      and v_creator.annual_price_currency_micros = 240000000::bigint
    )
  ) then
    raise exception 'Creator catalog is not at the expected source or target revision';
  end if;

  -- These values are deliberately not part of this price change. Checking them
  -- prevents a superficially successful deployment from blessing drift.
  if v_creator.currency_code <> 'USD'
    or v_creator.monthly_price_currency_micros <> 24000000::bigint
    or v_creator.monthly_grant_microcredits <> 2000000000::bigint
    or v_creator.top_up_currency_micros_per_credit <> 15000::bigint
    or v_creator.minimum_top_up_currency_micros <> 10000000::bigint
  then
    raise exception 'Creator monthly price, grants or top-up economics do not match the approved catalog';
  end if;

  -- Failed/expired/cancelled hosted sessions remain externally ambiguous until
  -- signed no-payment reconciliation. Any of these states can still prove paid
  -- later, so none may straddle the pricing-version change.
  if exists (
    select 1
    from public.checkout_intents as checkout_intent
    where checkout_intent.plan_key = 'creator'
      and checkout_intent.status in (
        'created', 'open', 'failed', 'expired', 'cancelled'
      )
  ) then
    raise exception 'Cannot revise Creator pricing while a checkout remains payable or ambiguous';
  end if;

  -- A completed subscription checkout can briefly precede materialization.
  -- Do not leave that immutable purchase without its subscription/first grant.
  if exists (
    select 1
    from public.checkout_intents as paid_checkout
    where paid_checkout.plan_key = 'creator'
      and paid_checkout.intent_type = 'subscription'
      and paid_checkout.status = 'completed'
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
    raise exception 'Cannot revise Creator pricing while a completed subscription checkout is unmaterialized';
  end if;

  -- Includes incomplete, trialing, active, past-due and paused periods. Their
  -- immutable amount/version remains valid until they become terminal.
  if exists (
    select 1
    from public.subscriptions as creator_subscription
    where creator_subscription.plan_key = 'creator'
      and creator_subscription.status not in ('canceled', 'expired')
  ) then
    raise exception 'Cannot revise Creator pricing while a non-terminal subscription retains paid-period economics';
  end if;

  if exists (
    select 1
    from billing_private.renewal_attempts as renewal_attempt
    where renewal_attempt.plan_key = 'creator'
      and renewal_attempt.state in ('scheduled', 'charging')
  ) then
    raise exception 'Cannot revise Creator pricing while a renewal is unresolved';
  end if;

  if exists (
    select 1
    from public.auto_reload_settings as auto_reload
    where auto_reload.plan_key = 'creator'
      and auto_reload.enabled
  ) then
    raise exception 'Cannot revise Creator pricing while auto-reload is enabled';
  end if;

  if exists (
    select 1
    from public.subscription_grant_schedule as grant_schedule
    join public.subscriptions as scheduled_subscription
      on scheduled_subscription.id = grant_schedule.subscription_id
    where scheduled_subscription.plan_key = 'creator'
      and grant_schedule.status in ('pending', 'granting')
  ) then
    raise exception 'Cannot revise Creator pricing while an annual grant is pending';
  end if;
end
$$;

-- Normal operation rejects catalog mutation. This trusted transaction disables
-- that one trigger only after the locked preflight proves the revision safe.
alter table billing_private.plan_catalog
  disable trigger plan_catalog_is_immutable;

do $$
declare
  v_updated integer;
begin
  update billing_private.plan_catalog as catalog
  set
    pricing_version = 'billing-2026-07-29-creator-annual-240',
    annual_price_currency_micros = 240000000::bigint
  where catalog.plan_key = 'creator';

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Expected to update one Creator subscription plan, updated %', v_updated;
  end if;
end
$$;

alter table billing_private.plan_catalog
  enable trigger plan_catalog_is_immutable;

commit;
