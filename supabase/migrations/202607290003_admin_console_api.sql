begin;

-- Admin console read/write API.
--
-- The row-level security section of 202607140001_subscription_billing.sql
-- states the rule these functions exist to satisfy: "A platform_role never
-- bypasses RLS from the client; support/admin tooling must authenticate to a
-- trusted server using service_role." Every client policy is select-own, and
-- billing_private is revoked from anon and authenticated entirely, so an admin
-- reading another customer's rows is only possible through a trusted server.
--
-- These wrappers are that server's entry points. Each one re-checks the actor
-- with billing_private.is_active_admin inside the transaction rather than
-- trusting the caller, so a bug in the edge function is not by itself enough to
-- read or mutate anything — an attacker would also need the service-role key.
-- The check is transactional, so an admin demoted or banned mid-session loses
-- access on their next call rather than at the end of a cached window.

create or replace function billing_private.require_active_admin(p_actor_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor_user_id is null or not billing_private.is_active_admin(p_actor_user_id) then
    -- Deliberately identical for "not an admin", "unconfirmed", "banned" and
    -- "deleted". Distinguishing them would let a caller probe account state.
    raise exception 'Actor is not a platform admin' using errcode = '42501';
  end if;
end;
$$;

-- A page size is clamped here as well as in the edge function. The edge
-- function protects the operator from a typo; this protects the database from
-- an edge function that stops validating.
create or replace function billing_private.clamp_admin_limit(p_limit integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

-- -------------------------------------------------------------------------
-- Overview
-- -------------------------------------------------------------------------

create or replace function public.easyfield_admin_overview(p_actor_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  select jsonb_build_object(
    'generatedAt', to_jsonb(clock_timestamp()),
    'users', (
      select jsonb_build_object(
        'total', count(*),
        'customers', count(*) filter (where platform_role = 'customer'),
        'support', count(*) filter (where platform_role = 'support'),
        'admins', count(*) filter (where platform_role = 'admin')
      )
      from public.profiles
    ),
    'subscriptions', (
      select coalesce(jsonb_object_agg(status, tally), '{}'::jsonb)
      from (
        select status, count(*) as tally
        from public.subscriptions
        group by status
      ) as grouped
    ),
    'credits', (
      select jsonb_build_object(
        'availableMicrocredits', coalesce(sum(available_microcredits), 0)::text,
        'reservedMicrocredits', coalesce(sum(reserved_microcredits), 0)::text,
        'lifetimeGrantedMicrocredits', coalesce(sum(lifetime_granted_microcredits), 0)::text,
        'lifetimeConsumedMicrocredits', coalesce(sum(lifetime_consumed_microcredits), 0)::text
      )
      from public.credit_accounts
    ),
    'checkouts', (
      select coalesce(jsonb_object_agg(status, tally), '{}'::jsonb)
      from (
        select status, count(*) as tally
        from public.checkout_intents
        group by status
      ) as grouped
    )
  ) into v_result;

  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- User list
-- -------------------------------------------------------------------------

-- Keyset pagination on (created_at, user_id). An OFFSET page silently skips or
-- repeats rows when the underlying set changes between requests, which is the
-- normal condition for a console that is polling live data.
create or replace function public.easyfield_admin_users(
  p_actor_user_id uuid,
  p_search text default null,
  p_role text default null,
  p_limit integer default 25,
  p_cursor_created_at timestamptz default null,
  p_cursor_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := billing_private.clamp_admin_limit(p_limit);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows jsonb;
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  if p_role is not null and p_role not in ('customer', 'support', 'admin') then
    raise exception 'Invalid platform role filter' using errcode = '22023';
  end if;

  -- The aggregate carries its own ORDER BY over real columns. Ordering by the
  -- built JSON text instead would sort timestamps lexically, which happens to
  -- look right for ISO-8601 until a value formats differently.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'userId', page.user_id,
      'email', page.email_normalized,
      'platformRole', page.platform_role,
      'createdAt', to_jsonb(page.created_at),
      'emailConfirmed', (page.email_confirmed_at is not null),
      'banned', (page.banned_until is not null and page.banned_until > clock_timestamp()),
      'deleted', (page.deleted_at is not null),
      'availableMicrocredits', coalesce(page.available_microcredits, 0)::text,
      'subscriptionStatus', page.subscription_status,
      'planKey', page.plan_key
    ) order by page.created_at desc, page.user_id desc
  ), '[]'::jsonb)
  into v_rows
  from (
    select
      profile.user_id,
      profile.email_normalized,
      profile.platform_role,
      profile.created_at,
      account.email_confirmed_at,
      account.banned_until,
      account.deleted_at,
      credit_account.available_microcredits,
      active_subscription.status as subscription_status,
      active_subscription.plan_key
    from public.profiles as profile
    left join auth.users as account on account.id = profile.user_id
    left join public.billing_customers as customer on customer.user_id = profile.user_id
    left join public.credit_accounts as credit_account on credit_account.customer_id = customer.id
    left join lateral (
      select subscription.status, subscription.plan_key
      from public.subscriptions as subscription
      where subscription.customer_id = customer.id
        and subscription.status not in ('canceled', 'expired')
      order by subscription.created_at desc
      limit 1
    ) as active_subscription on true
    where (p_role is null or profile.platform_role = p_role)
      and (
        v_search is null
        -- Anchored to the normalized email column. The pattern is escaped so a
        -- search for "%" cannot turn into a match-everything query.
        or profile.email_normalized like '%' || replace(replace(lower(v_search), '\', '\\'), '%', '\%') || '%'
        or profile.user_id::text = lower(v_search)
      )
      and (
        p_cursor_created_at is null
        or (profile.created_at, profile.user_id) < (p_cursor_created_at, coalesce(p_cursor_user_id, '00000000-0000-0000-0000-000000000000'::uuid))
      )
    order by profile.created_at desc, profile.user_id desc
    limit v_limit
  ) as page;

  return jsonb_build_object('users', v_rows, 'limit', v_limit);
end;
$$;

-- -------------------------------------------------------------------------
-- User detail
-- -------------------------------------------------------------------------

create or replace function public.easyfield_admin_user_detail(
  p_actor_user_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_account_id uuid;
  v_result jsonb;
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  select customer.id into v_customer_id
  from public.billing_customers as customer
  where customer.user_id = p_user_id
  order by customer.created_at asc
  limit 1;

  select credit_account.id into v_account_id
  from public.credit_accounts as credit_account
  where credit_account.customer_id = v_customer_id;

  select jsonb_build_object(
    'profile', (
      select jsonb_build_object(
        'userId', profile.user_id,
        'email', profile.email_normalized,
        'platformRole', profile.platform_role,
        'createdAt', to_jsonb(profile.created_at),
        'emailConfirmed', (account.email_confirmed_at is not null),
        'banned', (account.banned_until is not null and account.banned_until > clock_timestamp()),
        'deleted', (account.deleted_at is not null),
        'lastSignInAt', to_jsonb(account.last_sign_in_at)
      )
      from public.profiles as profile
      left join auth.users as account on account.id = profile.user_id
      where profile.user_id = p_user_id
    ),
    'creditAccount', (
      select jsonb_build_object(
        'availableMicrocredits', credit_account.available_microcredits::text,
        'reservedMicrocredits', credit_account.reserved_microcredits::text,
        'lifetimeGrantedMicrocredits', credit_account.lifetime_granted_microcredits::text,
        'lifetimeConsumedMicrocredits', credit_account.lifetime_consumed_microcredits::text,
        'lifetimeExpiredMicrocredits', credit_account.lifetime_expired_microcredits::text,
        'updatedAt', to_jsonb(credit_account.updated_at)
      )
      from public.credit_accounts as credit_account
      where credit_account.id = v_account_id
    ),
    'subscriptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', subscription.id,
        'planKey', subscription.plan_key,
        'billingInterval', subscription.billing_interval,
        'status', subscription.status,
        'pricingVersion', subscription.pricing_version,
        'currentPeriodStart', to_jsonb(subscription.current_period_start),
        'currentPeriodEnd', to_jsonb(subscription.current_period_end),
        'cancelAtPeriodEnd', subscription.cancel_at_period_end,
        'unitAmountCurrencyMicros', subscription.unit_amount_currency_micros::text,
        'currencyCode', subscription.currency_code
      ) order by subscription.created_at desc), '[]'::jsonb)
      from public.subscriptions as subscription
      where subscription.customer_id = v_customer_id
    ),
    'autoReload', (
      select jsonb_build_object(
        'enabled', auto_reload.enabled,
        'planKey', auto_reload.plan_key
      )
      from public.auto_reload_settings as auto_reload
      where auto_reload.account_id = v_account_id
    ),
    -- partner_entitlements is keyed by customer, not user, and records
    -- starts_at/revoked_at rather than a grant timestamp.
    'partnerEntitlement', (
      select jsonb_build_object(
        'status', entitlement.status,
        'offerKey', entitlement.offer_key,
        'lifetimeAccess', entitlement.lifetime_access,
        'startsAt', to_jsonb(entitlement.starts_at),
        'revokedAt', to_jsonb(entitlement.revoked_at)
      )
      from public.partner_entitlements as entitlement
      where entitlement.customer_id = v_customer_id
      order by entitlement.created_at desc
      limit 1
    ),
    'roleHistory', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', audit.id::text,
        'previousRole', audit.previous_role,
        'newRole', audit.new_role,
        'reason', audit.reason,
        'actorUserId', audit.actor_user_id,
        'createdAt', to_jsonb(audit.created_at)
      ) order by audit.id desc), '[]'::jsonb)
      from (
        select * from public.platform_role_audit
        where target_user_id = p_user_id
        order by id desc
        limit 20
      ) as audit
    )
  ) into v_result;

  if v_result->'profile' is null or v_result->'profile' = 'null'::jsonb then
    raise exception 'Profile does not exist' using errcode = '23503';
  end if;

  return v_result;
end;
$$;

-- -------------------------------------------------------------------------
-- Credit detail
-- -------------------------------------------------------------------------

create or replace function public.easyfield_admin_credits(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_limit integer default 25,
  p_cursor_id bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := billing_private.clamp_admin_limit(p_limit);
  v_account_id uuid;
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  select credit_account.id into v_account_id
  from public.credit_accounts as credit_account
  join public.billing_customers as customer on customer.id = credit_account.customer_id
  where customer.user_id = p_user_id
  limit 1;

  if v_account_id is null then
    return jsonb_build_object('lots', '[]'::jsonb, 'ledger', '[]'::jsonb, 'limit', v_limit);
  end if;

  return jsonb_build_object(
    'limit', v_limit,
    'lots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', lot.id,
        'sourceType', lot.source_type,
        'totalMicrocredits', lot.total_microcredits::text,
        'availableMicrocredits', lot.available_microcredits::text,
        'reservedMicrocredits', lot.reserved_microcredits::text,
        'grantedAt', to_jsonb(lot.granted_at),
        'expiresAt', to_jsonb(lot.expires_at)
      ) order by lot.granted_at desc), '[]'::jsonb)
      from (
        select * from public.credit_grant_lots
        where account_id = v_account_id
        order by granted_at desc
        limit v_limit
      ) as lot
    ),
    -- The ledger is append-only and protected by credit_ledger_is_immutable.
    -- It is presented here strictly as evidence; nothing in this API writes it.
    'ledger', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', entry.id::text,
        'entryType', entry.entry_type,
        'availableDeltaMicrocredits', entry.available_delta_microcredits::text,
        'reservedDeltaMicrocredits', entry.reserved_delta_microcredits::text,
        'consumedDeltaMicrocredits', entry.consumed_delta_microcredits::text,
        'expiredDeltaMicrocredits', entry.expired_delta_microcredits::text,
        'referenceType', entry.reference_type,
        'createdAt', to_jsonb(entry.created_at)
      ) order by entry.id desc), '[]'::jsonb)
      from (
        select * from public.credit_ledger
        where account_id = v_account_id
          and (p_cursor_id is null or id < p_cursor_id)
        order by id desc
        limit v_limit
      ) as entry
    )
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Incident queue
-- -------------------------------------------------------------------------

-- Surfaces work that is stuck rather than everything that exists. These are the
-- states that need a human: money that may have moved without a matching
-- entitlement, and renewals that stopped progressing.
create or replace function public.easyfield_admin_incidents(
  p_actor_user_id uuid,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := billing_private.clamp_admin_limit(p_limit);
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  return jsonb_build_object(
    'limit', v_limit,
    'ambiguousCheckouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', intent.id,
        'customerId', intent.customer_id,
        'intentType', intent.intent_type,
        'planKey', intent.plan_key,
        'status', intent.status,
        'createdAt', to_jsonb(intent.created_at),
        'updatedAt', to_jsonb(intent.updated_at)
      ) order by intent.updated_at desc), '[]'::jsonb)
      from (
        select * from public.checkout_intents
        where status in ('failed', 'expired', 'cancelled')
        order by updated_at desc
        limit v_limit
      ) as intent
    ),
    'openCheckouts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', intent.id,
        'customerId', intent.customer_id,
        'intentType', intent.intent_type,
        'status', intent.status,
        'createdAt', to_jsonb(intent.created_at)
      ) order by intent.created_at asc), '[]'::jsonb)
      from (
        select * from public.checkout_intents
        where status in ('created', 'open')
        order by created_at asc
        limit v_limit
      ) as intent
    ),
    'unresolvedRenewals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', attempt.id,
        'planKey', attempt.plan_key,
        'state', attempt.state,
        'createdAt', to_jsonb(attempt.created_at)
      ) order by attempt.created_at asc), '[]'::jsonb)
      from (
        select * from billing_private.renewal_attempts
        where state in ('scheduled', 'charging')
        order by created_at asc
        limit v_limit
      ) as attempt
    ),
    'pendingGrants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', grant_row.id,
        'subscriptionId', grant_row.subscription_id,
        'status', grant_row.status,
        'grantNumber', grant_row.grant_number,
        'scheduledFor', to_jsonb(grant_row.scheduled_for)
      ) order by grant_row.scheduled_for asc), '[]'::jsonb)
      from (
        select * from public.subscription_grant_schedule
        where status in ('pending', 'granting')
        order by scheduled_for asc
        limit v_limit
      ) as grant_row
    )
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Role audit
-- -------------------------------------------------------------------------

create or replace function public.easyfield_admin_audit(
  p_actor_user_id uuid,
  p_limit integer default 25,
  p_cursor_id bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := billing_private.clamp_admin_limit(p_limit);
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  return jsonb_build_object(
    'limit', v_limit,
    'entries', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', audit.id::text,
        'targetUserId', audit.target_user_id,
        'targetEmail', target_profile.email_normalized,
        'actorUserId', audit.actor_user_id,
        'actorEmail', actor_profile.email_normalized,
        'previousRole', audit.previous_role,
        'newRole', audit.new_role,
        'reason', audit.reason,
        'createdAt', to_jsonb(audit.created_at)
      ) order by audit.id desc), '[]'::jsonb)
      from (
        select * from public.platform_role_audit
        where (p_cursor_id is null or id < p_cursor_id)
        order by id desc
        limit v_limit
      ) as audit
      left join public.profiles as target_profile on target_profile.user_id = audit.target_user_id
      left join public.profiles as actor_profile on actor_profile.user_id = audit.actor_user_id
    )
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Role mutation
-- -------------------------------------------------------------------------

-- The only write this API exposes. It delegates rather than reimplementing:
-- billing_private.set_platform_role already takes the mutation advisory lock,
-- requires a 3..500 character reason, refuses to demote the final admin, and
-- appends to the immutable audit trail. Duplicating any of that here would
-- create a second version of the rule that could drift from the first.
create or replace function public.easyfield_admin_set_role(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_new_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  v_profile := billing_private.set_platform_role(
    p_target_user_id,
    p_new_role,
    p_reason,
    p_actor_user_id
  );

  return jsonb_build_object(
    'userId', v_profile.user_id,
    'email', v_profile.email_normalized,
    'platformRole', v_profile.platform_role,
    'updatedAt', to_jsonb(v_profile.updated_at)
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Privileges
-- -------------------------------------------------------------------------

-- Only the trusted server may call these. A browser holding an ordinary user
-- JWT reaches PostgREST as `authenticated`, so revoking that role is what stops
-- an admin's own session from being usable as an admin API directly.
revoke all on function billing_private.require_active_admin(uuid) from public, anon, authenticated;
revoke all on function billing_private.clamp_admin_limit(integer) from public, anon, authenticated;
revoke all on function public.easyfield_admin_overview(uuid) from public, anon, authenticated;
revoke all on function public.easyfield_admin_users(uuid, text, text, integer, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.easyfield_admin_user_detail(uuid, uuid) from public, anon, authenticated;
revoke all on function public.easyfield_admin_credits(uuid, uuid, integer, bigint) from public, anon, authenticated;
revoke all on function public.easyfield_admin_incidents(uuid, integer) from public, anon, authenticated;
revoke all on function public.easyfield_admin_audit(uuid, integer, bigint) from public, anon, authenticated;
revoke all on function public.easyfield_admin_set_role(uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.easyfield_admin_overview(uuid) to service_role;
grant execute on function public.easyfield_admin_users(uuid, text, text, integer, timestamptz, uuid) to service_role;
grant execute on function public.easyfield_admin_user_detail(uuid, uuid) to service_role;
grant execute on function public.easyfield_admin_credits(uuid, uuid, integer, bigint) to service_role;
grant execute on function public.easyfield_admin_incidents(uuid, integer) to service_role;
grant execute on function public.easyfield_admin_audit(uuid, integer, bigint) to service_role;
grant execute on function public.easyfield_admin_set_role(uuid, uuid, text, text) to service_role;

commit;
