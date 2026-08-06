import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')

const settlement = readFileSync(
  path.join(migrationsDirectory, '202608060002_renewal_settlement_and_payment_methods.sql'),
  'utf8',
)
const billing = readFileSync(
  path.join(migrationsDirectory, '202607140001_subscription_billing.sql'),
  'utf8',
)
const abandonment = readFileSync(
  path.join(migrationsDirectory, '202608060001_checkout_abandonment_recovery.sql'),
  'utf8',
)

function withoutComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ')
}

function normalize(value) {
  return withoutComments(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

function fn(sql, name) {
  const match = new RegExp(
    `create or replace function ${name.replace('.', '\\.')}\\(([\\s\\S]+?)\\$\\$;`,
  ).exec(sql)
  assert.ok(match, `missing ${name}`)
  return match[1]
}

const sql = normalize(settlement)

test('the migration is forward-only and does not renumber over the abandonment work', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  // 202608060001 is a separate, earlier migration. Both must exist.
  assert.ok(abandonment.length > 0)
  assert.match(
    normalize(abandonment),
    /create or replace function billing_private\.close_unopened_checkouts/,
  )
})

test('a renewal can be claimed against the global one-payment anchor', () => {
  assert.match(sql, /alter table billing_private\.payment_entitlement_claims drop constraint payment_entitlement_claims_claim_type_check;/)
  assert.match(
    sql,
    /claim_type in \( 'subscription', 'credit_pack', 'auto_reload', 'partner_lifetime', 'subscription_renewal' \)/,
  )
})

test('a saved payment method cannot be invented without a completed payment', () => {
  const body = fn(sql, 'billing_private.register_saved_payment_method')

  // The evidence gate is the whole point: a vault token is a claim about a
  // provider relationship, and nothing here takes that on trust.
  assert.match(body, /from public\.checkout_intents as checkout where checkout\.customer_id = p_customer_id and checkout\.provider = v_provider and checkout\.status = 'completed'/)
  assert.match(body, /from billing_private\.partner_purchase_intents as partner where partner\.customer_id = p_customer_id and partner\.provider = v_provider and partner\.status = 'completed'/)
  assert.match(body, /a saved payment method requires a completed payment with the same provider/)

  // One vault token must never be re-pointed at a second customer.
  assert.match(body, /saved payment method belongs to another customer/)

  // Validation mirrors the table's own CHECK constraints rather than trusting
  // the caller to have read them.
  assert.match(body, /coalesce\(p_last_four, ''\) !~ '\^\[0-9\]\{4\}\$'/)
  assert.match(body, /v_status not in \('active', 'inactive', 'expired', 'unknown'\)/)
  assert.match(body, /\(p_expiry_month is null\) <> \(p_expiry_year is null\)/)
  assert.match(body, /code !~ '\^\[a-z\]\{3\}\$'/)
})

test('neither public wrapper can leak the vault token', () => {
  for (const name of [
    'public.easyfield_account_register_payment_method',
    'public.easyfield_account_select_subscription_payment_method',
  ]) {
    const body = fn(sql, name)
    const returned = /return jsonb_build_object\(([\s\S]+?)\);/g
    let match
    while ((match = returned.exec(body)) !== null) {
      assert.doesNotMatch(
        match[1],
        /provider_payment_method_ref/,
        `${name} returns the vault token to the caller`,
      )
    }
  }
})

test('the currency predicate fails at selection, not at renewal time', () => {
  const body = fn(sql, 'public.easyfield_account_select_subscription_payment_method')
  // create_renewal_attempt enforces exactly this (202607140001:2914). Checking
  // it here means the customer learns while they can still act.
  assert.match(body, /v_subscription\.currency_code = any\(v_method\.supported_currencies\)/)
  assert.match(billing, /supported_currencies/)
})

test('settlement locks subscription before attempt, matching the annual cron', () => {
  const body = fn(sql, 'billing_private.settle_renewal_attempt')

  // The deployed every-minute annual job states its order at 202607140001:2782
  // — subscription, then schedule, then customer, then account. Locking the
  // customer first here would deadlock against it, and on a payment path a
  // deadlock files a paid event as failed.
  // Asserted against the raw source: `normalize` strips comments, and this
  // order is documented in one.
  assert.match(
    billing,
    /Global order for annual work is subscription -> schedule -> customer ->\s*--\s*account/,
    'the deployed annual job no longer documents its lock order',
  )

  const subscriptionLock = body.indexOf('from public.subscriptions as subscription where subscription.id = v_subscription_id for update')
  const attemptLock = body.indexOf('from billing_private.renewal_attempts as attempt where attempt.id = p_attempt_id for update')
  assert.ok(subscriptionLock >= 0, 'settle does not lock the subscription')
  assert.ok(attemptLock >= 0, 'settle does not lock the attempt')
  assert.ok(subscriptionLock < attemptLock, 'settle locks the attempt before the subscription')

  // billing_customers must NOT be locked ahead of the subscription.
  assert.doesNotMatch(body, /billing_customers[\s\S]{0,80}for update/)
})

test('settlement refuses to infer that money moved', () => {
  const body = fn(sql, 'billing_private.settle_renewal_attempt')
  assert.match(body, /v_attempt\.state <> 'succeeded' or v_attempt\.provider_document_ref is null/)
  assert.match(body, /only a succeeded renewal with provider evidence may settle/)
  assert.match(body, /a terminal subscription cannot be settled; refund the renewal/)
})

test('the period advances before credits are granted, never after', () => {
  const body = fn(sql, 'billing_private.settle_renewal_attempt')

  // grant_credits validates current_period_start = p_granted_at and
  // current_period_end = p_expires_at against the row it reads
  // (202607140001:1904-1913), so granting first cannot succeed.
  assert.match(normalize(billing), /v_subscription\.current_period_start is distinct from p_granted_at/)

  const advance = body.indexOf('update public.subscriptions set')
  const grant = body.indexOf('billing_private.grant_credits(')
  assert.ok(advance >= 0 && grant >= 0)
  assert.ok(advance < grant, 'credits are granted before the period advances')
})

test('the period advance is idempotent and forward-only', () => {
  const body = fn(sql, 'billing_private.settle_renewal_attempt')
  assert.match(body, /v_subscription\.current_period_start is not distinct from v_attempt\.period_start and v_subscription\.current_period_end is not distinct from v_attempt\.period_end/)
  assert.match(body, /v_subscription\.current_period_start >= v_attempt\.period_end/)
  assert.match(body, /v_subscription\.current_period_end is not distinct from v_attempt\.period_start/)
  assert.match(body, /renewal period does not continue the subscription period/)

  // Both period columns and both annual paid-source columns must move in ONE
  // statement or apply_subscription_catalog_snapshot rejects it.
  const update = /update public\.subscriptions set ([\s\S]+?) where id = v_subscription\.id/.exec(body)
  assert.ok(update, 'missing the period advance')
  for (const column of [
    'current_period_start',
    'current_period_end',
    'entitlement_ends_at',
    'annual_checkout_intent_id',
    'annual_renewal_attempt_id',
  ]) {
    assert.match(update[1], new RegExp(`${column} =`), `the advance does not move ${column}`)
  }

  // Only 'trialing' is promoted; a past_due or paused delinquency this function
  // did not resolve must not be silently cleared.
  assert.match(update[1], /status = case when v_subscription\.status = 'trialing' then 'active' else v_subscription\.status end/)
})

test('monthly and annual settle by different mechanisms', () => {
  const body = fn(sql, 'billing_private.settle_renewal_attempt')

  assert.match(body, /if v_subscription\.billing_interval = 'monthly' then/)
  assert.match(body, /'paid:renewal:' \|\| v_attempt\.id::text/)
  // grant_credits hard-refuses an annual subscription on the subscription
  // source path, so an annual renewal must schedule instalments instead.
  assert.match(body, /perform billing_private\.schedule_annual_plan_grants\( v_subscription\.id, v_attempt\.period_start, v_subscription\.included_microcredits_per_grant, 12, interval '1 month' \)/)

  // The metadata must be byte-identical across callers or grant_credits raises
  // 22000: it folds metadata into request_sha256.
  assert.match(body, /jsonb_build_object\('renewal_attempt_id', v_attempt\.id\)/)
  const grantCall = /billing_private\.grant_credits\(([\s\S]+?)\);/.exec(body)
  assert.ok(grantCall)
  assert.doesNotMatch(grantCall[1], /clock_timestamp\(\)/, 'the grant metadata varies between callers')
  assert.doesNotMatch(grantCall[1], /payment_event/, 'the grant metadata varies between callers')
})

test('finish_renewal_attempt keeps its signature, guards and error text', () => {
  const body = fn(sql, 'billing_private.finish_renewal_attempt')

  // Identical signature keeps every existing caller and grant working.
  assert.match(
    sql,
    /create or replace function billing_private\.finish_renewal_attempt\( p_attempt_id uuid, p_claim_id uuid, p_result_state text, p_provider_document_ref text default null, p_provider_transaction_ref text default null, p_provider_status integer default null, p_failure_reason text default null \)/,
  )

  for (const message of [
    'invalid renewal result',
    'renewal attempt not found',
    'renewal result does not own the charge claim',
    'renewal result retry has different inputs',
    'renewal attempt is not awaiting its single result',
  ]) {
    assert.match(body, new RegExp(message), `finish_renewal_attempt dropped: ${message}`)
    assert.match(normalize(billing), new RegExp(message), `${message} is not the deployed wording`)
  }

  // Same lock inversion argument as settle.
  const subscriptionLock = body.indexOf('from public.subscriptions as subscription where subscription.id = v_subscription_id for update')
  const attemptLock = body.indexOf('from billing_private.renewal_attempts where id = p_attempt_id for update')
  assert.ok(subscriptionLock >= 0 && attemptLock >= 0)
  assert.ok(subscriptionLock < attemptLock, 'finish locks the attempt before the subscription')

  // A success settles in the same transaction, on both the terminal write and
  // the idempotent retry path.
  const settleCalls = body.match(/perform billing_private\.settle_renewal_attempt\(v_attempt\.id\)/g) || []
  assert.equal(settleCalls.length, 2, 'a success must settle on both the write and the retry path')

  // The error must propagate: sharing one transaction is what lets the worker
  // safely retry. Swallowing it produces "money moved, entitlement did not".
  assert.doesNotMatch(body, /exception when others then null/)
})

test('the sweeper and the alert agree on what unsettled means', () => {
  const sweeper = fn(sql, 'billing_private.settle_succeeded_renewals')
  const alerts = fn(sql, 'billing_private.operational_alerts')

  // protect_renewal_attempt_origin makes a terminal attempt immutable, so an
  // alert the sweeper will never clear could never be cleared by anyone.
  for (const predicate of [
    /attempt\.state = 'succeeded'/,
    /attempt\.provider_document_ref is not null/,
    /subscription\.status not in \('canceled', 'expired'\)/,
    /where lot\.renewal_attempt_id = attempt\.id/,
    /subscription\.current_period_end is distinct from attempt\.period_end/,
  ]) {
    assert.match(sweeper, predicate, `sweeper predicate missing: ${predicate}`)
    assert.match(alerts, predicate, `alert predicate missing: ${predicate}`)
  }

  // One unsettleable attempt must not stall the rest of the batch.
  assert.match(sweeper, /exception when others then/)
})

test('the maintenance allowlist keeps all seven jobs', () => {
  const runner = fn(sql, 'billing_private.run_maintenance')

  // The two checkout sweepers are on live hourly cron entries. Dropping either
  // from this list makes it raise 22023 every hour, forever.
  assert.match(
    runner,
    /if p_job not in \( 'expire_credit_reservations', 'expire_credit_lots', 'grant_due_annual_plan_credits', 'sweep_due_renewals', 'close_unopened_checkouts', 'expire_stale_open_checkouts', 'settle_succeeded_renewals' \)/,
  )
  for (const job of [
    'expire_credit_reservations',
    'expire_credit_lots',
    'grant_due_annual_plan_credits',
    'sweep_due_renewals',
    'close_unopened_checkouts',
    'expire_stale_open_checkouts',
    'settle_succeeded_renewals',
  ]) {
    assert.match(runner, new RegExp(`billing_private\\.${job}\\(`), `run_maintenance cannot dispatch ${job}`)
  }

  assert.match(sql, /select cron\.schedule\( 'easyfield-settle-renewals',/)
})

test('the rewritten alerts keep every alert that already existed', () => {
  const alerts = fn(sql, 'billing_private.operational_alerts')
  for (const code of [
    'maintenance-stale',
    'maintenance-failing',
    'renewal-stuck-charging',
    'renewal-blocked',
    'checkout-unopened-not-swept',
    'checkout-awaiting-reconciliation',
    'renewal-unsettled',
  ]) {
    assert.match(alerts, new RegExp(`'${code}'`), `operational_alerts dropped ${code}`)
  }
  // The signatures the body depends on.
  assert.match(alerts, /jsonb_array_length\(billing_private\.due_renewals_blocked\(100\)\)/)
  assert.match(alerts, /jsonb_array_elements\(billing_private\.maintenance_health\(\)\)/)
})

test('every new function is service-role only and pins search_path', () => {
  for (const signature of [
    'billing_private\\.register_saved_payment_method\\( uuid, text, text, text, text, integer, integer, text, text\\[\\] \\)',
    'billing_private\\.settle_renewal_attempt\\(uuid\\)',
    'billing_private\\.settle_succeeded_renewals\\(integer\\)',
    'billing_private\\.finish_renewal_attempt\\( uuid, uuid, text, text, text, integer, text \\)',
    'public\\.easyfield_account_register_payment_method\\( uuid, text, text, text, text, integer, integer, text, text\\[\\] \\)',
    'public\\.easyfield_account_select_subscription_payment_method\\(uuid, uuid\\)',
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function ${signature} from public, anon, authenticated`),
      `${signature} is not revoked from clients`,
    )
  }

  for (const name of [
    'register_saved_payment_method',
    'settle_renewal_attempt',
    'settle_succeeded_renewals',
    'finish_renewal_attempt',
    'run_maintenance',
    'operational_alerts',
  ]) {
    assert.match(
      sql,
      new RegExp(`function billing_private\\.${name}\\([^)]*\\)[\\s\\S]{0,400}?security definer set search_path = ''`),
      `${name} does not pin an empty search_path`,
    )
  }

  // Only the two account wrappers are callable by the edge functions.
  assert.match(sql, /grant execute on function public\.easyfield_account_register_payment_method\([\s\S]{0,120}?\) to service_role/)
  assert.match(sql, /grant execute on function public\.easyfield_account_select_subscription_payment_method\(uuid, uuid\) to service_role/)
  assert.doesNotMatch(sql, /grant execute on function billing_private\.settle_renewal_attempt/)
})
