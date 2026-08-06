/**
 * A submission that was merely slow must still be able to bind its task.
 *
 * The reconciler moves a job that has been `submitting` too long to
 * `submission_ambiguous`, which means "this database does not know whether the
 * provider took the work". The deployed accept function treated that as
 * unbindable, so a submit call returning late with a real provider task
 * reference was refused and the reference thrown away — the provider ran and
 * billed EasyField for work the customer never received, and the operation
 * stayed permanently ambiguous with nothing to reconcile against.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')

const binding = readFileSync(
  path.join(migrationsDirectory, '202608060005_late_submission_binding.sql'),
  'utf8',
)
const controlPlane = readFileSync(
  path.join(migrationsDirectory, '20260715175329_generation_gateway_control_plane.sql'),
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

const sql = normalize(binding)
const deployed = normalize(controlPlane)

test('the deployed function really did refuse an ambiguous submission', () => {
  // Pins the defect this migration exists to fix, so the fix cannot be
  // reverted without something failing.
  assert.match(
    deployed,
    /if v_job\.status <> 'submitting' then raise exception 'generation operation cannot accept a task in status %'/,
    'the deployed accept no longer has the single-status gate this migration widens',
  )
  assert.doesNotMatch(
    deployed,
    /in \('accepted', 'running', 'succeeded', 'reconciliation_required', 'submission_ambiguous'\)/,
  )
})

test('an ambiguous submission can now bind, and nothing else can', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  assert.match(
    sql,
    /if v_job\.status not in \('submitting', 'submission_ambiguous'\) then raise exception 'generation operation cannot accept a task in status %'/,
  )
  // Every other status still raises 55000.
  assert.match(sql, /using errcode = '55000'/)
})

test('the one-task-per-operation guarantee is untouched', () => {
  // A job already bound to a different reference must still be refused, or a
  // second provider task could be attached to one paid operation.
  assert.match(
    sql,
    /if v_job\.status in \('accepted', 'running', 'succeeded', 'reconciliation_required'\) then if v_job\.provider_task_ref_sha256 <> v_task_sha then raise exception 'generation operation is already bound to another task' using errcode = '22000'/,
  )
  assert.match(sql, /generation operation was not found[\s\S]{0,40}23503/)
  assert.match(sql, /invalid provider task binding[\s\S]{0,40}22023/)
  assert.match(sql, /v_job\.request_sha256 <> p_request_sha256/)
})

test('the binding supplies the task reference the schema requires', () => {
  // generation_gateway_jobs carries `status in (...) or provider_task_ref is
  // not null`, so 'accepted' is only reachable with a reference. The update
  // sets both in one statement.
  const update = /update billing_private\.generation_gateway_jobs set ([\s\S]+?) where id = v_job\.id/.exec(sql)
  assert.ok(update, 'missing the state transition')
  assert.match(update[1], /status = 'accepted'/)
  assert.match(update[1], /provider_task_ref = v_task/)
  assert.match(update[1], /provider_task_ref_sha256 = v_task_sha/)
})

test('a binding that resolved an ambiguity is written down', () => {
  // This is the only signal that the submit budget and the reconciler
  // threshold are too close together. Without it the near-miss is invisible.
  assert.match(sql, /v_was_ambiguous := v_job\.status = 'submission_ambiguous'/)
  assert.match(sql, /'resolved_ambiguous_submission', v_was_ambiguous/)
  assert.match(sql, /'accepted', p_request_sha256/)
})

test('the function stays service-role only', () => {
  assert.match(
    sql,
    /revoke all on function public\.easyfield_generation_accept_submission\(uuid, text, text, text\) from public, anon, authenticated/,
  )
  assert.match(
    sql,
    /grant execute on function public\.easyfield_generation_accept_submission\(uuid, text, text, text\) to service_role/,
  )
  assert.match(sql, /security definer set search_path = ''/)
})
