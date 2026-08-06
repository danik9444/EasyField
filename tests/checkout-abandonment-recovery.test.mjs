import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')

const recovery = readFileSync(
  path.join(migrationsDirectory, '202608060001_checkout_abandonment_recovery.sql'),
  'utf8',
)
const stateHardening = readFileSync(
  path.join(migrationsDirectory, '202607150001_harden_billing_state_transitions.sql'),
  'utf8',
)
const checkoutRecovery = readFileSync(
  path.join(migrationsDirectory, '202607150006_checkout_status_recovery.sql'),
  'utf8',
)
const accountEdgeApi = readFileSync(
  path.join(migrationsDirectory, '202607150004_account_edge_api.sql'),
  'utf8',
)

function withoutComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ')
}

function normalize(value) {
  return withoutComments(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

const sql = normalize(recovery)

test('the migration is a forward-only transaction that leaves history intact', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)

  // The deployed migrations this one builds on must never be rewritten.
  assert.match(
    normalize(checkoutRecovery),
    /create unique index checkout_intents_one_payable_subscription_per_customer on public\.checkout_intents \(customer_id\) where intent_type = 'subscription' and status in \('created', 'open', 'expired', 'cancelled', 'failed'\)/,
    'the deployed one-payable index must remain unchanged',
  )
  assert.match(
    normalize(stateHardening),
    /create or replace function billing_private\.reconcile_checkout_without_payment/,
    'the deployed no-payment reconciliation function must remain unchanged',
  )

  // This migration must not widen the index that creates the deadlock. The
  // exit is a new terminal status, not a hole in the uniqueness guarantee.
  assert.doesNotMatch(sql, /drop index[\s\S]*one_payable/)
  assert.doesNotMatch(sql, /create unique index[\s\S]*one_payable/)
})

test('only a checkout no provider ever saw is closed on local evidence', () => {
  const body =
    /create or replace function billing_private\.close_unopened_checkouts\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(body, 'missing close_unopened_checkouts')
  const fn = body[1]

  // The whole safety argument rests on these four columns being null: the
  // insert in easyfield_account_prepare_checkout leaves them null, and
  // easyfield_account_open_checkout is the only writer of the first two.
  for (const guard of [
    /checkout\.status = 'created'/,
    /checkout\.provider_checkout_ref is null/,
    /checkout\.checkout_url is null/,
    /checkout\.completed_payment_event_id is null/,
    /checkout\.provider_payment_ref is null/,
  ]) {
    assert.match(fn, guard, `close_unopened_checkouts dropped a required guard: ${guard}`)
  }

  for (const guard of [
    /intent\.status = 'created'/,
    /intent\.provider_checkout_ref is null/,
    /intent\.checkout_url is null/,
    /intent\.completed_payment_event_id is null/,
    /intent\.provider_payment_ref is null/,
  ]) {
    assert.match(fn, guard, `the Partner arm dropped a required guard: ${guard}`)
  }

  // An in-flight easyfield_account_open_checkout must never be overtaken.
  assert.match(fn, /v_min_age interval := greatest\(coalesce\(p_min_age, interval '24 hours'\), interval '1 hour'\)/)
  assert.match(fn, /created_at < v_cutoff/)
  assert.match(fn, /for update skip locked/)

  // Local closure is recorded as local closure, never as provider evidence.
  assert.match(fn, /insert into billing_private\.unopened_checkout_closures/)
  assert.doesNotMatch(fn, /checkout_no_payment_reconciliations/)
  assert.doesNotMatch(fn, /partner_no_payment_reconciliations/)
})

test('the never-opened insert really does leave the proving columns null', () => {
  // If a future change gave prepare_checkout a provider reference, the closure
  // guard above would silently stop matching anything. Pin the precondition.
  const prepare = normalize(accountEdgeApi)
  assert.match(
    prepare,
    /insert into public\.checkout_intents \( customer_id, intent_type, plan_key, billing_interval, pricing_version, monthly_grant_microcredits, top_up_currency_micros_per_credit, minimum_top_up_currency_micros, idempotency_key, provider, amount_currency_micros, currency_code, credit_microcredits, expires_at \)/,
    'prepare_checkout no longer inserts the column list this closure depends on',
  )
  assert.match(
    prepare,
    /update public\.checkout_intents set provider_checkout_ref = v_ref, checkout_url = v_url, status = 'open'/,
    'open_checkout is no longer the sole writer of provider_checkout_ref and checkout_url',
  )
})

test('an opened session keeps its slot and is queued instead of closed', () => {
  const body =
    /create or replace function billing_private\.expire_stale_open_checkouts\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(body, 'missing expire_stale_open_checkouts')
  const fn = body[1]

  assert.match(fn, /checkout\.status = 'open'/)
  assert.match(fn, /set status = 'expired'/)

  // 'expired' is still inside the one-payable index, so this must not be
  // mistaken for a fix to the deadlock. Reaching a terminal state from here
  // requires provider evidence, which only the seam can supply.
  assert.doesNotMatch(fn, /reconciled_no_payment/)
  assert.match(fn, /completed_payment_event_id is null/)
  assert.match(fn, /for update skip locked/)
})

test('the provider seam exposes a session reference and nothing about the customer', () => {
  const body =
    /create or replace function billing_private\.checkouts_awaiting_reconciliation\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(body, 'missing checkouts_awaiting_reconciliation')
  const fn = body[1]

  assert.match(fn, /provider_checkout_ref is not null/)
  assert.match(fn, /completed_payment_event_id is null/)
  // Already reconciled rows must leave the queue.
  assert.match(fn, /not exists \( select 1 from billing_private\.checkout_no_payment_reconciliations/)
  assert.match(fn, /not exists \( select 1 from billing_private\.partner_no_payment_reconciliations/)

  // Answering "was this session paid?" needs the provider's own reference and
  // no customer identity. Leaking one here would put customer data into an
  // outbound provider call for no reason.
  assert.doesNotMatch(fn, /customer_id/)
  assert.doesNotMatch(fn, /user_id/)
  assert.doesNotMatch(fn, /email/)
})

test('Partner gains the terminal state and the single new transition edge', () => {
  assert.match(sql, /alter table billing_private\.partner_purchase_intents drop constraint partner_purchase_intents_status_check;/)
  assert.match(
    sql,
    /add constraint partner_purchase_intents_status_check check \( status in \( 'created', 'open', 'completed', 'expired', 'cancelled', 'failed', 'reconciled_no_payment' \) \)/,
  )

  const guard =
    /create or replace function billing_private\.apply_partner_purchase_snapshot\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(guard, 'missing apply_partner_purchase_snapshot')
  const fn = guard[1]

  // Every original refusal survives.
  assert.match(fn, /partner purchase identity, price and capabilities are immutable/)
  assert.match(fn, /a partner purchase cannot return to created/)
  assert.match(fn, /an open partner purchase requires its hosted checkout identity/)
  assert.match(fn, /partner entitlement payment does not reconcile/)
  assert.match(fn, /a closed partner purchase cannot be reopened/)

  // The new terminal state is as immutable as 'completed'.
  assert.match(fn, /old\.status in \('completed', 'reconciled_no_payment'\)/)

  // The one widened edge, and it is evidence-gated.
  assert.match(
    fn,
    /new\.status = 'reconciled_no_payment' and exists \( select 1 from billing_private\.partner_no_payment_reconciliations/,
  )
})

test('Partner no-payment reconciliation demands the same evidence as checkout', () => {
  const body =
    /create or replace function billing_private\.reconcile_partner_without_payment\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(body, 'missing reconcile_partner_without_payment')
  const fn = body[1]

  assert.match(fn, /coalesce\(p_evidence_sha256, ''\) !~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(fn, /valid no-payment reconciliation evidence is required/)
  assert.match(fn, /status not in \('failed', 'expired', 'cancelled'\)/)
  assert.match(fn, /completed_payment_event_id is not null/)
  assert.match(fn, /for update/)
  assert.match(fn, /insert into billing_private\.partner_no_payment_reconciliations/)
})

test('both evidence tables are append-only and closed to clients', () => {
  for (const table of [
    'billing_private.partner_no_payment_reconciliations',
    'billing_private.unopened_checkout_closures',
  ]) {
    const escaped = table.replace('.', '\\.')
    assert.match(
      sql,
      new RegExp(`before update or delete on ${escaped} for each row execute function billing_private\\.reject_immutable_mutation\\(\\)`),
      `${table} is not immutable`,
    )
    assert.match(sql, new RegExp(`alter table ${escaped} enable row level security`))
    assert.match(sql, new RegExp(`alter table ${escaped} force row level security`))
  }

  // A closure belongs to exactly one ledger, never both.
  assert.match(sql, /check \(num_nonnulls\(checkout_intent_id, partner_purchase_intent_id\) = 1\)/)
})

test('every new function is service-role only', () => {
  for (const signature of [
    'billing_private\\.close_unopened_checkouts\\(integer, interval\\)',
    'billing_private\\.expire_stale_open_checkouts\\(integer, interval\\)',
    'billing_private\\.checkouts_awaiting_reconciliation\\(integer\\)',
    'billing_private\\.reconcile_partner_without_payment\\( uuid, text, text, text, text \\)',
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function ${signature} from public, anon, authenticated`),
      `${signature} is not revoked from clients`,
    )
  }

  assert.match(
    sql,
    /grant execute on function billing_private\.reconcile_partner_without_payment\( uuid, text, text, text, text \) to service_role/,
  )

  // The two sweepers are reached only through run_maintenance, so they are
  // granted to nobody at all.
  assert.doesNotMatch(sql, /grant execute on function billing_private\.close_unopened_checkouts/)
  assert.doesNotMatch(sql, /grant execute on function billing_private\.expire_stale_open_checkouts/)

  for (const fn of [
    'close_unopened_checkouts',
    'expire_stale_open_checkouts',
    'checkouts_awaiting_reconciliation',
    'reconcile_partner_without_payment',
    'apply_partner_purchase_snapshot',
    'operational_alerts',
    'run_maintenance',
  ]) {
    assert.match(
      sql,
      new RegExp(`function billing_private\\.${fn}\\([^)]*\\)[\\s\\S]{0,400}?security definer set search_path = ''`),
      `${fn} does not pin an empty search_path`,
    )
  }
})

test('both sweepers are dispatched by name and scheduled', () => {
  const runner = /create or replace function billing_private\.run_maintenance\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(runner, 'missing run_maintenance')
  const fn = runner[1]

  // The allowlist keeps a cron entry from becoming an execution primitive, so
  // the new jobs must be named in it rather than passed through.
  assert.match(
    fn,
    /if p_job not in \( 'expire_credit_reservations', 'expire_credit_lots', 'grant_due_annual_plan_credits', 'sweep_due_renewals', 'close_unopened_checkouts', 'expire_stale_open_checkouts' \)/,
  )
  assert.match(fn, /v_count := billing_private\.close_unopened_checkouts\(v_limit\)/)
  assert.match(fn, /v_count := billing_private\.expire_stale_open_checkouts\(v_limit\)/)

  // The four pre-existing jobs still dispatch.
  assert.match(fn, /billing_private\.expire_credit_reservations\(v_limit\)/)
  assert.match(fn, /billing_private\.expire_credit_lots\(v_limit\)/)
  assert.match(fn, /billing_private\.grant_due_annual_plan_credits\(v_limit\)/)
  assert.match(fn, /billing_private\.sweep_due_renewals\(v_limit\)/)

  // A run that fails must still leave a row, or the scheduler looks healthy.
  assert.match(fn, /exception when others then update billing_private\.maintenance_runs set finished_at = clock_timestamp\(\), error_text/)

  for (const job of ['easyfield-close-unopened-checkouts', 'easyfield-expire-stale-open-checkouts']) {
    assert.match(sql, new RegExp(`if exists \\(select 1 from cron\\.job where jobname = '${job}'\\) then perform cron\\.unschedule\\('${job}'\\)`))
    assert.match(sql, new RegExp(`select cron\\.schedule\\( '${job}',`))
  }
})

test('the abandonment alert distinguishes self-healing from stuck', () => {
  const body = /create or replace function billing_private\.operational_alerts\(([\s\S]+?)\$\$;/.exec(sql)
  assert.ok(body, 'missing operational_alerts')
  const fn = body[1]

  // The old undifferentiated counter is gone.
  assert.doesNotMatch(fn, /'checkout-abandoned'/)
  assert.match(fn, /'checkout-unopened-not-swept'/)
  assert.match(fn, /'checkout-awaiting-reconciliation'/)

  // Signatures the surrounding code depends on: due_renewals_blocked returns
  // jsonb, maintenance_health returns jsonb, renewal_attempts has created_at.
  assert.match(fn, /jsonb_array_length\(billing_private\.due_renewals_blocked\(100\)\)/)
  assert.match(fn, /jsonb_array_elements\(billing_private\.maintenance_health\(\)\)/)
  assert.match(fn, /from billing_private\.renewal_attempts where state = 'charging' and created_at </)

  // Every pre-existing alert survives the rewrite.
  for (const code of [
    'maintenance-stale',
    'maintenance-failing',
    'renewal-stuck-charging',
    'renewal-blocked',
  ]) {
    assert.match(fn, new RegExp(`'${code}'`), `operational_alerts dropped ${code}`)
  }
})
