-- Forward-only catalog update for installations that already applied
-- 202607140001_subscription_billing.sql before the 2026-07-15 pricing revision.
-- The private catalog remains the server authority; no customer balance or
-- historical checkout snapshot is rewritten by this migration.

do $$
declare
  v_updated integer;
begin
  update billing_private.plan_catalog as catalog
  set
    catalog_version = revised.catalog_version,
    monthly_grant_microcredits = revised.monthly_grant_microcredits,
    top_up_currency_micros_per_credit = revised.top_up_currency_micros_per_credit,
    updated_at = now()
  from (values
    ('starter'::text, 'billing-2026-07-15'::text, 800000000::bigint, 20000::bigint),
    ('creator'::text, 'billing-2026-07-15'::text, 2000000000::bigint, 15000::bigint),
    ('pro'::text, 'billing-2026-07-15'::text, 5000000000::bigint, 12000::bigint),
    ('studio'::text, 'billing-2026-07-15'::text, 12000000000::bigint, 10000::bigint)
  ) as revised(
    plan_key,
    catalog_version,
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
