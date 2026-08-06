import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')

const reversals = readFileSync(
  path.join(migrationsDirectory, '202608060003_payment_reversal_ingestion.sql'),
  'utf8',
)
const billing = readFileSync(
  path.join(migrationsDirectory, '202607140001_subscription_billing.sql'),
  'utf8',
)
const partner = readFileSync(
  path.join(migrationsDirectory, '202607150003_partner_lifetime_access.sql'),
  'utf8',
)
const entry = readFileSync(
  path.join(migrationsDirectory, '202608060004_reversal_webhook_entry.sql'),
  'utf8',
)
const deployedReconciliation = readFileSync(
  path.join(migrationsDirectory, '202607150005_atomic_payment_reconciliation.sql'),
  'utf8',
)

function normalize(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function fn(sql, name) {
  const match = new RegExp(
    `create or replace function ${name.replace('.', '\\.')}\\(([\\s\\S]+?)\\$\\$;`,
  ).exec(sql)
  assert.ok(match, `missing ${name}`)
  return match[1]
}

const sql = normalize(reversals)

test('the migration is forward-only and does not collide with an earlier stamp', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  // 202608060001 and ...02 are separate migrations that must remain distinct.
  for (const earlier of [
    '202608060001_checkout_abandonment_recovery.sql',
    '202608060002_renewal_settlement_and_payment_methods.sql',
  ]) {
    assert.ok(
      readFileSync(path.join(migrationsDirectory, earlier), 'utf8').length > 0,
      `${earlier} is missing`,
    )
  }
})

test('the entitlement revocation that had no caller now has one', () => {
  // revoke_partner_entitlement has been correct and unreachable since it was
  // written. This is the whole point of the migration.
  assert.match(normalize(partner), /create or replace function billing_private\.revoke_partner_entitlement/)
  assert.match(sql, /perform billing_private\.revoke_partner_entitlement\(/)

  const body = fn(sql, 'billing_private.reconcile_payment_reversal')
  assert.match(body, /when v_type = 'refund' then 'refunded' else 'chargeback' end/)
})

test('a second reversal on an already-terminal entitlement does not wedge', () => {
  const body = fn(sql, 'billing_private.reconcile_payment_reversal')

  // revoke_partner_entitlement raises 55000 when the entitlement is not
  // active, and enforce_subscription_state_and_catalog makes a canceled
  // subscription immutable. A partial chargeback followed by a refund of the
  // remainder is ordinary; revoking twice would roll the second reversal back
  // and leave the provider retrying for ever.
  assert.match(body, /if found and v_entitlement\.status = 'active' then/)
  assert.match(body, /v_action := 'partner_already_terminal'/)
  assert.match(body, /status not in \('canceled', 'expired'\)/)
  assert.match(body, /v_action := 'subscription_already_terminal'/)

  // Both outcomes are recorded, not silently swallowed.
  assert.match(sql, /entitlement_action text not null check \(entitlement_action in \( 'partner_revoked', 'partner_already_terminal', 'subscription_canceled', 'subscription_already_terminal', 'none' \)\)/)
})

test('the account is locked before any credit lot', () => {
  const body = fn(sql, 'billing_private.reconcile_payment_reversal')

  // The credit subsystem's documented order is account -> quote ->
  // reservation/lots. Reversed, a clawback deadlocks against any concurrent
  // reserve_credits or capture_credits on live generation traffic.
  assert.match(
    billing,
    /global\s*--?\s*billing lock order \(account -> quote -> reservation\/lots\)/i,
    'the credit subsystem no longer documents its lock order',
  )

  const accountLock = body.indexOf('from public.credit_accounts as account where account.customer_id = v_customer_id for update')
  const lotRead = body.indexOf('from public.credit_grant_lots as lot')
  assert.ok(accountLock >= 0, 'the reversal never locks the credit account')
  assert.ok(lotRead >= 0)
  assert.ok(accountLock < lotRead, 'a credit lot is read before the account is locked')

  // The helper deliberately does not take the account lock itself, so the
  // ordering stays visible at the call site.
  const clawback = fn(sql, 'billing_private.claw_back_lot_credits')
  assert.doesNotMatch(clawback, /credit_accounts[\s\S]{0,60}for update/)
})

test('cumulative completion is what makes a reversal full', () => {
  // A second partial reversal that completes the total IS full. A CHECK
  // comparing only this row's amount rejects exactly that case, which is the
  // common refund-the-remainder flow.
  assert.match(
    sql,
    /check \(full_reversal = \(prior_reversed_amount_currency_micros \+ reversed_amount_currency_micros = original_amount_currency_micros\)\)/,
  )
  assert.match(
    sql,
    /check \(prior_reversed_amount_currency_micros \+ reversed_amount_currency_micros <= original_amount_currency_micros\)/,
  )
  assert.match(sql, /create unique index payment_reversals_one_full_per_payment/)

  const body = fn(sql, 'billing_private.reconcile_payment_reversal')
  assert.match(body, /v_full := \(v_prior \+ p_reversed_amount_currency_micros = v_original\)/)
  assert.match(body, /reversals would exceed the original payment/)
  // A chargeback always ends access; a partial refund does not.
  assert.match(body, /v_terminates := v_type in \('chargeback', 'dispute_lost'\) or v_full/)
})

test('recovery is computed before it is recorded, never corrected after', () => {
  const clawback = fn(sql, 'billing_private.claw_back_lot_credits')

  // Both evidence tables are append-only, so a row cannot be written first and
  // updated once the recovery is known.
  for (const table of ['payment_reversals', 'payment_reversal_clawbacks']) {
    assert.match(
      sql,
      new RegExp(`before update or delete on billing_private\\.${table} for each row execute function billing_private\\.reject_immutable_mutation\\(\\)`),
      `${table} is not append-only`,
    )
  }

  const compute = clawback.indexOf('v_recovered := least(p_target_microcredits, v_lot.available_microcredits)')
  const insert = clawback.indexOf('insert into billing_private.payment_reversal_clawbacks')
  assert.ok(compute >= 0 && insert >= 0)
  assert.ok(compute < insert, 'the clawback row is written before the recovery is known')

  // Nothing updates or deletes an evidence row.
  assert.doesNotMatch(sql, /update billing_private\.payment_reversals/)
  assert.doesNotMatch(sql, /delete from billing_private\.payment_reversals/)
  assert.doesNotMatch(sql, /update billing_private\.payment_reversal_clawbacks/)

  // Reserved credit funds a generation already in flight; taking it would make
  // an accepted provider task unsettleable.
  assert.match(clawback, /least\(p_target_microcredits, v_lot\.available_microcredits\)/)
})

test('the outcome is derived from the clawback rows rather than stored twice', () => {
  // Storing a recovered total on payment_reversals would need a column written
  // before it could be computed, on an append-only table.
  assert.doesNotMatch(sql, /clawed_back_microcredits bigint/)

  const body = fn(sql, 'billing_private.reconcile_payment_reversal')
  assert.match(
    body,
    /coalesce\(sum\(clawback\.target_microcredits - clawback\.recovered_microcredits\), 0\)/,
  )
  // Both the fresh path and the redelivery path report the same way.
  const derivations = body.match(/from billing_private\.payment_reversal_clawbacks as clawback/g) || []
  assert.equal(derivations.length, 2, 'redelivery and first delivery must report identically')
})

test('pro-rata is taken against granted credit, not against price', () => {
  const body = fn(sql, 'billing_private.reconcile_payment_reversal')
  // Three of twelve annual instalments granted: applying the price ratio to
  // each granted lot would reclaim roughly everything the customer received.
  assert.match(
    body,
    /v_target := case when v_full then v_lot\.total_microcredits else \(v_lot\.total_microcredits \* p_reversed_amount_currency_micros\) \/ v_original end/,
  )
  assert.match(body, /v_granted := v_granted \+ v_lot\.total_microcredits/)
})

test('a reversal is never invented from an unclaimed payment', () => {
  const body = fn(sql, 'billing_private.reconcile_payment_reversal')
  // The operation is resolved from recorded evidence via
  // payment_entitlement_claims. An unresolvable reversal raises rather than
  // guessing which entitlement to revoke.
  assert.match(body, /from billing_private\.payment_entitlement_claims as claim where claim\.payment_event_id = p_reversed_payment_event_id/)
  assert.match(body, /the reversed payment funded no known entitlement/)
  assert.match(body, /a reversal cannot reverse itself/)
  // Redelivery is a no-op, not an error.
  assert.match(body, /'duplicate', true/)
})

test('the shortfall is reported rather than papered over', () => {
  // Spent credit cannot be recovered. There is deliberately no sweeper that
  // retries for ever, and no invented negative balance.
  assert.match(sql, /create or replace function billing_private\.reversal_shortfalls/)
  const alerts = fn(sql, 'billing_private.operational_alerts')
  assert.match(alerts, /'reversal-shortfall'/)
  assert.doesNotMatch(sql, /settle_reversal_clawbacks/)
})

test('the rewritten alerts keep every alert the earlier migrations added', () => {
  const alerts = fn(sql, 'billing_private.operational_alerts')
  for (const code of [
    'maintenance-stale',
    'maintenance-failing',
    'renewal-stuck-charging',
    'renewal-unsettled',
    'renewal-blocked',
    'checkout-unopened-not-swept',
    'checkout-awaiting-reconciliation',
    'reversal-shortfall',
  ]) {
    assert.match(alerts, new RegExp(`'${code}'`), `operational_alerts dropped ${code}`)
  }
})

test('every new function is closed to clients and pins search_path', () => {
  for (const signature of [
    'billing_private\\.claw_back_lot_credits\\(uuid, uuid, bigint\\)',
    'billing_private\\.reconcile_payment_reversal\\( uuid, uuid, text, text, bigint, text \\)',
    'billing_private\\.reversal_shortfalls\\(integer\\)',
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function ${signature} from public, anon, authenticated`),
      `${signature} is not revoked from clients`,
    )
  }
  assert.doesNotMatch(sql, /grant execute on function billing_private\.reconcile_payment_reversal/)

  for (const name of [
    'claw_back_lot_credits',
    'reconcile_payment_reversal',
    'reversal_shortfalls',
    'operational_alerts',
  ]) {
    assert.match(
      sql,
      new RegExp(`function billing_private\\.${name}\\([^)]*\\)[\\s\\S]{0,400}?security definer set search_path = ''`),
      `${name} does not pin an empty search_path`,
    )
  }
})

// ---------------------------------------------------------------------------
// 202608060004 — the webhook entry point
// ---------------------------------------------------------------------------

const entrySql = normalize(entry)

test('the single recording path learns a second event type', () => {
  // record_payment_event gated on `v_event_type is distinct from
  // 'payment/received'` and raised 22023 otherwise, so a reversal could not be
  // recorded at all — dedup, delivery tracking and replay detection were
  // unreachable for reversals. Widening the one path avoids a second place for
  // replay logic to drift.
  assert.match(
    normalize(deployedReconciliation) + normalize(billing),
    /record_payment_event/,
    'record_payment_event is no longer part of the deployed schema',
  )
  assert.match(entrySql, /v_event_type not in \('payment\/received', 'payment\/reversed'\)/)
  assert.match(
    entrySql,
    /when v_event_type = 'payment\/received' then billing_private\.payment_reconciliation_payload_is_valid/,
  )
  assert.match(
    entrySql,
    /when v_event_type = 'payment\/reversed' then billing_private\.payment_reversal_payload_is_valid/,
  )
  assert.match(entrySql, /else false end/)

  // Every replay guarantee the deployed body carried must survive the copy.
  for (const message of [
    'signed payment event id does not match its normalized payload',
    'signed payment event id was replayed with different evidence',
    'payment delivery id was replayed with different evidence',
    'payment event deduplication conflict could not be resolved',
  ]) {
    assert.match(entrySql, new RegExp(message), `record_payment_event dropped: ${message}`)
  }
})

test('the reversal payload is validated key-exactly', () => {
  const body = fn(entrySql, 'billing_private.payment_reversal_payload_is_valid')
  assert.match(body, /key not in \('type', 'id', 'reversedpaymentreference', 'reversaltype', 'reason', 'total'\)/)
  assert.match(body, /p_payload->>'reversaltype' not in \('refund', 'chargeback', 'dispute_lost'\)/)
  // A reversal naming itself would resolve to its own event row.
  assert.match(body, /if p_payload->>'id' = p_payload->>'reversedpaymentreference' then return false/)
  assert.match(body, /\(v_total->>'exponent'\) is distinct from '2'/)
  assert.match(body, /\(v_total->>'minorunits'\)::numeric <= 0/)
})

test('a reversal of an unrecorded payment is refused, never guessed', () => {
  const body = fn(entrySql, 'public.easyfield_account_reconcile_payment_reversal')
  assert.match(body, /event\.event_type = 'payment\/received'/)
  assert.match(body, /the reversed payment was never recorded/)
  // Revoking on a guess would take access from the wrong customer.
  assert.doesNotMatch(body, /coalesce\([\s\S]{0,40}v_original_id/)
})

test('a redelivered reversal is recognised before anything is reconciled', () => {
  const body = fn(entrySql, 'public.easyfield_account_reconcile_payment_reversal')
  const replay = body.indexOf("v_event.event_status = 'processed'")
  const reconcile = body.indexOf('billing_private.reconcile_payment_reversal(')
  assert.ok(replay >= 0, 'the entry point does not detect a processed replay')
  assert.ok(replay < reconcile, 'a replay reaches reconciliation before it is detected')
})

test('minor units are converted to micro-units exactly once', () => {
  const body = fn(entrySql, 'public.easyfield_account_reconcile_payment_reversal')
  const conversions = body.match(/::bigint \* 10000/g) || []
  assert.equal(conversions.length, 1, 'the amount is converted more than once, or not at all')
})

test('the entry point is the only thing service_role may call', () => {
  assert.match(
    entrySql,
    /grant execute on function public\.easyfield_account_reconcile_payment_reversal\( text, text, text, text, jsonb \) to service_role/,
  )
  for (const signature of [
    'billing_private\\.payment_reversal_payload_is_valid\\(jsonb\\)',
    'billing_private\\.record_payment_event\\(text, text, text, text, text, jsonb\\)',
  ]) {
    assert.match(
      entrySql,
      new RegExp(`revoke all on function ${signature} from public, anon, authenticated`),
      `${signature} is not revoked from clients`,
    )
  }
  assert.doesNotMatch(entrySql, /grant execute on function billing_private\.record_payment_event/)
})
