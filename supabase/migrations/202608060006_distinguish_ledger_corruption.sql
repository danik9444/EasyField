begin;

-- A ledger that does not reconcile is not a customer telling you to buy more.
--
-- `billing_private.reserve_credits` raises `P0001` twice, with an explicit
-- `using errcode = 'P0001'` on both:
--
--   'Insufficient EasyField credits'
--       An ordinary, expected outcome. The customer has spent their allowance.
--
--   'Credit lot balance does not reconcile with account balance'
--       The account says one balance and the sum of its lots says another.
--       That is data corruption in the ledger this whole schema exists to keep
--       exact, and it is reached only after a reservation row and its
--       allocations have already been written in the same transaction.
--
-- Identical SQLSTATE means no caller can tell them apart. Any wrapper that
-- maps `P0001` to "insufficient credits" — the obvious mapping, and the one
-- the generation data plane needs — turns the second into a routine
-- `402 Buy more credits`. The customer is told to pay for something they
-- already paid for, the subtransaction rolls back the evidence, and nothing
-- alerts. A corruption alarm becomes an upsell, silently and permanently.
--
-- `XX001 data_corrupted` is the standard PostgreSQL code for exactly this
-- condition, so the distinction needs no local convention to interpret.
--
-- The body below is the deployed one, byte-for-byte, apart from that single
-- errcode. Note in particular that the global billing lock order
-- (account -> quote -> reservation/lots) and the 24-hour reservation ceiling
-- are preserved exactly.

-- `p_expires_at` keeps its deployed default. `create or replace function`
-- refuses to remove a parameter default ("cannot remove parameter defaults
-- from existing function"), so omitting it here would make this migration fail
-- on deploy rather than at review.
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
    -- The account balance permitted this reservation and the lots could not
    -- fund it. The two disagree, which is corruption, not a spending limit.
    raise exception 'Credit lot balance does not reconcile with account balance'
      using errcode = 'XX001';
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

revoke all on function billing_private.reserve_credits(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;

commit;
