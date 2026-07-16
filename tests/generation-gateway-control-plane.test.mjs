import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL(
  '../supabase/migrations/20260715175329_generation_gateway_control_plane.sql',
  import.meta.url,
)

test('generation prices are server-owned and client estimates cannot create quotes', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /create table billing_private\.generation_price_catalog/)
  assert.match(sql, /where pricing_key = btrim\(p_pricing_key\) and active/)
  assert.match(sql, /v_customer_microcredits := v_price\.customer_microcredits_per_unit \* p_quantity_units/)
  assert.match(sql, /billing_private\.create_generation_quote/)
  assert.match(sql, /alter table billing_private\.generation_price_catalog enable row level security/)
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete)[^;]+generation_price_catalog[^;]+authenticated/i)
})

test('one durable operation can begin at most one provider submission', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /unique \(customer_id, operation_key\)/)
  assert.match(sql, /if v_job\.status = 'prepared' then[\s\S]+set status = 'submitting'/)
  assert.match(sql, /Submitting or[\s\S]+ambiguous work is never sent again/)
  assert.match(sql, /easyfield_generation_mark_ambiguous/)
  assert.match(sql, /easyfield_generation_reject_submission/)
  assert.match(sql, /timeout, disconnect or unclassified 5xx must use mark_ambiguous/)
  assert.match(sql, /'provider_rejected_before_acceptance'/)
  assert.match(sql, /where id = v_job\.id[\s\S]+return query select v_job\.id, false/)
})

test('accepted tasks are uniquely bound and polling is account/path scoped', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /unique \(provider_task_ref_sha256\)/)
  assert.match(sql, /extensions\.digest\(v_task, 'sha256'\)/)
  assert.match(sql, /join public\.billing_customers c on c\.id = j\.customer_id[\s\S]+c\.user_id = p_user_id/)
  assert.match(sql, /j\.provider_task_ref_sha256 = v_task_sha[\s\S]+j\.poll_path = p_poll_path/)
  assert.match(sql, /Deliberately indistinguishable for missing and foreign tasks/)
})

test('terminal accounting captures inside the approved ceiling and releases the remainder', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /v_capture := least\(coalesce\(p_reported_microcredits, v_remaining\), v_remaining\)/)
  assert.match(sql, /billing_private\.capture_credits/)
  assert.match(sql, /'unused_approved_ceiling'/)
  assert.match(sql, /'provider_failed'/)
  assert.match(sql, /customer_ceiling_applied/)
  assert.match(sql, /if v_job\.status <> 'prepared' then return false/)
  assert.match(sql, /'cancelled_before_submission'/)
})

test('restart recovery exposes only nonterminal jobs owned by the authenticated user', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /easyfield_generation_recovery_snapshot/)
  assert.match(sql, /c\.user_id = p_user_id/)
  assert.match(sql, /j\.status in \('submitting', 'submission_ambiguous', 'accepted', 'running', 'reconciliation_required'\)/)
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.easyfield_generation_prepare\\([^;]+from [^;]*${role}`))
  }
})

test('desktop provider creates send stable per-job and per-child operation identities', async () => {
  const gateway = await readFile(new URL('../src/services/providerGateway.ts', import.meta.url), 'utf8')
  const run = await readFile(new URL('../src/services/run.ts', import.meta.url), 'utf8')
  assert.match(gateway, /X-EasyField-Operation-Id/)
  assert.match(gateway, /authHeaders\(apiKey, opts\.gatewayOperationId\)/)
  assert.match(run, /gatewayOperationId: job\.id/)
  assert.match(run, /gatewayOperationId: opts\.gatewayOperationId[\s\S]+:child:/)
  assert.match(run, /:angle:/)
  assert.match(run, /:foley:/)
})
