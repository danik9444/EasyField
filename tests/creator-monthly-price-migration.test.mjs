import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')
const initialCatalog = readFileSync(
  path.join(migrationsDirectory, '202607140001_subscription_billing.sql'),
  'utf8',
)
const creatorPriceMigration = readFileSync(
  path.join(migrationsDirectory, '20260715154941_creator_monthly_price_24.sql'),
  'utf8',
)

function withoutComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
}

function normalize(value) {
  return withoutComments(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

test('Creator $24 monthly pricing is a new forward-only catalog revision', () => {
  const sql = normalize(creatorPriceMigration)

  assert.match(
    initialCatalog,
    /\('creator', 'Creator', 'billing-2026-07-15', 'USD', 30000000, 300000000, 2000000000, 15000, 10000000/,
    'the already-deployed catalog migration must remain unchanged',
  )
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  assert.match(sql, /in access exclusive mode;/)
  assert.match(sql, /billing-2026-07-15-creator-monthly-24/)

  const update = /update billing_private\.plan_catalog as catalog set ([\s\S]+?) where catalog\.plan_key = 'creator';/.exec(sql)
  assert.ok(update, 'missing the Creator-only catalog update')
  assert.match(update[1], /pricing_version = 'billing-2026-07-15-creator-monthly-24'/)
  assert.match(update[1], /monthly_price_currency_micros = 24000000::bigint/)
  assert.doesNotMatch(update[1], /annual_price_currency_micros/)
  assert.doesNotMatch(update[1], /monthly_grant_microcredits/)
  assert.doesNotMatch(update[1], /top_up_currency_micros_per_credit/)
  assert.doesNotMatch(update[1], /minimum_top_up_currency_micros/)
  assert.doesNotMatch(update[1], /blocked_model_ids/)

  const mutatedTables = [...sql.matchAll(/\bupdate\s+((?:public|billing_private)\.[a-z_][a-z0-9_]*)/g)]
    .map((match) => match[1])
  assert.deepEqual(mutatedTables, ['billing_private.plan_catalog'])
  assert.match(sql, /if v_updated <> 1 then/)
})

test('Creator catalog revision preserves paid-period immutability before updating', () => {
  const sql = normalize(creatorPriceMigration)

  for (const table of [
    'public.subscriptions',
    'public.checkout_intents',
    'billing_private.renewal_attempts',
    'public.auto_reload_settings',
    'public.subscription_grant_schedule',
    'public.credit_grant_lots',
    'billing_private.plan_catalog',
  ]) {
    assert.match(sql, new RegExp(`lock table[\\s\\S]+${table.replace('.', '\\.')}`))
  }

  assert.match(sql, /v_creator\.pricing_version = 'billing-2026-07-15'/)
  assert.match(sql, /v_creator\.monthly_price_currency_micros = 30000000::bigint/)
  assert.match(sql, /v_creator\.annual_price_currency_micros <> 300000000::bigint/)
  assert.match(sql, /v_creator\.monthly_grant_microcredits <> 2000000000::bigint/)
  assert.match(sql, /v_creator\.top_up_currency_micros_per_credit <> 15000::bigint/)
  assert.match(sql, /v_creator\.minimum_top_up_currency_micros <> 10000000::bigint/)

  assert.match(
    sql,
    /checkout_intent\.status in \( 'created', 'open', 'failed', 'expired', 'cancelled' \)/,
  )
  assert.match(sql, /paid_checkout\.intent_type = 'subscription'/)
  assert.match(sql, /paid_checkout\.status = 'completed'/)
  assert.match(sql, /annual_subscription\.annual_checkout_intent_id = paid_checkout\.id/)
  assert.match(sql, /initial_grant\.checkout_intent_id = paid_checkout\.id/)
  assert.match(sql, /monthly_subscription\.pricing_version = paid_checkout\.pricing_version/)
  assert.match(sql, /creator_subscription\.status not in \('canceled', 'expired'\)/)
  assert.match(sql, /renewal_attempt\.state in \('scheduled', 'charging'\)/)
  assert.match(sql, /auto_reload\.plan_key = 'creator' and auto_reload\.enabled/)
  assert.match(sql, /grant_schedule\.status in \('pending', 'granting'\)/)

  const disableTrigger = sql.indexOf(
    'alter table billing_private.plan_catalog disable trigger plan_catalog_is_immutable',
  )
  const catalogUpdate = sql.indexOf('update billing_private.plan_catalog as catalog')
  const enableTrigger = sql.indexOf(
    'alter table billing_private.plan_catalog enable trigger plan_catalog_is_immutable',
  )
  assert.ok(disableTrigger >= 0 && disableTrigger < catalogUpdate)
  assert.ok(catalogUpdate < enableTrigger)
})
