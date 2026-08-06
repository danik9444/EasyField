/**
 * A ledger that does not reconcile must not look like an empty wallet.
 *
 * `billing_private.reserve_credits` raised `P0001` for two conditions that
 * could not be further apart: the customer has spent their allowance, and the
 * account balance disagrees with the sum of its lots. The second is corruption
 * in the ledger the whole schema exists to keep exact.
 *
 * Identical SQLSTATE means no caller can tell them apart, and the obvious
 * mapping — the one the generation data plane needs — turns the corruption
 * into `402 Buy more credits`. The customer is told to pay again, the
 * subtransaction discards the evidence, and nothing alerts.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')

const fix = readFileSync(
  path.join(migrationsDirectory, '202608060006_distinguish_ledger_corruption.sql'),
  'utf8',
)
const billing = readFileSync(
  path.join(migrationsDirectory, '202607140001_subscription_billing.sql'),
  'utf8',
)

function normalize(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const sql = normalize(fix)

test('the deployed function really did use one code for both', () => {
  // Pins the defect, so the fix cannot be quietly reverted.
  const deployed = normalize(billing)
  assert.match(deployed, /raise exception 'Insufficient EasyField credits' using errcode = 'P0001'/)
  assert.match(
    deployed,
    /raise exception 'Credit lot balance does not reconcile with account balance' using errcode = 'P0001'/,
  )
})

test('the two conditions now carry different codes', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  // Spending your allowance stays an ordinary, expected outcome.
  assert.match(sql, /raise exception 'Insufficient EasyField credits' using errcode = 'P0001'/)
  // XX001 is the standard PostgreSQL data_corrupted code, so the distinction
  // needs no local convention to read.
  assert.match(
    sql,
    /raise exception 'Credit lot balance does not reconcile with account balance' using errcode = 'XX001'/,
  )
  assert.doesNotMatch(
    sql,
    /does not reconcile with account balance' using errcode = 'P0001'/,
    'the corruption raise still shares a code with an empty wallet',
  )
})

test('the deployed parameter default is carried forward', () => {
  // `create or replace function` refuses to remove a parameter default, so
  // omitting it fails at deploy time rather than at review.
  assert.match(
    sql,
    /p_expires_at timestamptz default \(clock_timestamp\(\) \+ interval '30 minutes'\)/,
  )
})

test('nothing else about the reservation changed', () => {
  // Every guard, in order, and the invariants that make the reservation safe.
  for (const guard of [
    /Invalid credit reservation' using errcode = '22023'/,
    /Quote not found for user' using errcode = '23503'/,
    /Credit account not found' using errcode = '23503'/,
    /Administrator bypass quotes must skip credit reservation'/,
    /Reservation idempotency key was reused with different inputs' using errcode = '22000'/,
    /Quote is not open \(status: %\)', v_quote\.status using errcode = '55000'/,
    /Quote has expired' using errcode = '22000'/,
  ]) {
    assert.match(sql, guard, `reserve_credits dropped a guard: ${guard}`)
  }

  // The global billing lock order, and the ceiling that stops a reservation
  // outliving the sweeper that would release it. The order is documented in a
  // comment, so it is asserted against the raw file — `normalize` strips them.
  assert.match(fix, /billing lock order \(account -> quote -> reservation\/lots\)/)
  assert.match(sql, /v_expiry := least\(p_expires_at, clock_timestamp\(\) \+ interval '24 hours'\)/)

  // FIFO consumption: soonest-expiring credit is spent first.
  assert.match(sql, /order by expires_at asc nulls last, granted_at, id for update/)

  // The account is still debited by exactly the quoted amount.
  assert.match(
    sql,
    /available_microcredits = available_microcredits - v_quote\.customer_microcredits, reserved_microcredits = reserved_microcredits \+ v_quote\.customer_microcredits, version = version \+ 1/,
  )
  assert.match(sql, /'reservation\.reserve:' \|\| btrim\(p_idempotency_key\)/)
})

test('the function stays closed to clients', () => {
  assert.match(
    sql,
    /revoke all on function billing_private\.reserve_credits\(uuid, uuid, text, text, timestamptz\) from public, anon, authenticated/,
  )
  assert.match(sql, /security definer set search_path = ''/)
  // service_role already holds execute and `create or replace` preserves the
  // ACL, so no grant is re-issued here.
  assert.doesNotMatch(sql, /grant execute on function billing_private\.reserve_credits/)
})
