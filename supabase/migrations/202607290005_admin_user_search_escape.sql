begin;

-- Escape both LIKE wildcards in admin user search, not just '%'.
--
-- 202607290003 escaped the backslash and '%' and its comment claimed the
-- pattern was safe, but left '_' alone. In LIKE, '_' matches any single
-- character, so an operator searching the exact address jane_doe@corp.com also
-- matches jane-doe@corp.com and jane.doe@corp.com. Underscores are common in
-- email local parts, and the failure is quiet: the operator believes they are
-- looking at one account while the list holds several, which is precisely the
-- moment before someone changes a role on the wrong person.
--
-- Forward-only: 202607290003 is already applied and is not edited.

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
  v_pattern text;
  v_rows jsonb;
begin
  perform billing_private.require_active_admin(p_actor_user_id);

  if p_role is not null and p_role not in ('customer', 'support', 'admin') then
    raise exception 'Invalid platform role filter' using errcode = '22023';
  end if;

  -- Backslash first, or it would re-escape the escapes added after it.
  if v_search is not null then
    v_pattern := '%' || replace(
                          replace(
                            replace(lower(v_search), '\', '\\'),
                          '%', '\%'),
                        '_', '\_') || '%';
  end if;

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
        or profile.email_normalized like v_pattern
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

revoke all on function public.easyfield_admin_users(uuid, text, text, integer, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.easyfield_admin_users(uuid, text, text, integer, timestamptz, uuid)
  to service_role;

commit;
