import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(
  projectRoot,
  'supabase',
  'migrations',
  '202607140001_subscription_billing.sql',
)
const migration = readFileSync(migrationPath, 'utf8')
const stateHardeningMigration = readFileSync(path.join(
  projectRoot,
  'supabase',
  'migrations',
  '202607150001_harden_billing_state_transitions.sql',
), 'utf8')
const pricingMigration = readFileSync(path.join(
  projectRoot,
  'supabase',
  'migrations',
  '202607150002_update_subscription_pricing.sql',
), 'utf8')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function withoutComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
}

function normalize(value) {
  return withoutComments(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

function readBalanced(value, openingIndex) {
  assert.equal(value[openingIndex], '(', 'balanced SQL fragment must start with an opening parenthesis')
  let depth = 0
  let quote = null
  for (let index = openingIndex; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return { body: value.slice(openingIndex + 1, index), end: index }
    }
  }
  assert.fail('unterminated SQL parenthesis')
}

function splitTopLevel(value) {
  const parts = []
  let start = 0
  let roundDepth = 0
  let squareDepth = 0
  let quote = null
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === '(') roundDepth += 1
    else if (character === ')') roundDepth -= 1
    else if (character === '[') squareDepth += 1
    else if (character === ']') squareDepth -= 1
    else if (character === ',' && roundDepth === 0 && squareDepth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function extractTable(qualifiedName) {
  const source = withoutComments(migration)
  const pattern = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i',
  )
  const match = pattern.exec(source)
  assert.ok(match, `missing table ${qualifiedName}`)
  const openingIndex = match.index + match[0].lastIndexOf('(')
  return normalize(readBalanced(source, openingIndex).body)
}

function extractTableColumns(qualifiedName) {
  const source = withoutComments(migration)
  const pattern = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i',
  )
  const match = pattern.exec(source)
  assert.ok(match, `missing table ${qualifiedName}`)
  const openingIndex = match.index + match[0].lastIndexOf('(')
  const definitions = splitTopLevel(readBalanced(source, openingIndex).body)
  const columns = new Set()
  for (const definition of definitions) {
    const normalizedDefinition = normalize(definition)
    if (/^(?:check|constraint|primary key|foreign key|unique)\b/.test(normalizedDefinition)) continue
    const column = /^(?:"([^"]+)"|([a-z_][a-z0-9_]*))\b/.exec(normalizedDefinition)
    assert.ok(column, `could not parse a column in ${qualifiedName}: ${definition}`)
    columns.add(column[1] ?? column[2])
  }
  return columns
}

function extractFunction(qualifiedName) {
  const source = withoutComments(migration)
  const pattern = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i',
  )
  const match = pattern.exec(source)
  assert.ok(match, `missing function ${qualifiedName}`)
  const tail = source.slice(match.index)
  const bodyStart = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(tail)
  assert.ok(bodyStart, `missing dollar-quoted body for ${qualifiedName}`)
  const delimiter = bodyStart[1]
  const contentStart = bodyStart.index + bodyStart[0].length
  const contentEnd = tail.indexOf(delimiter, contentStart)
  assert.notEqual(contentEnd, -1, `unterminated function ${qualifiedName}`)
  return normalize(tail.slice(0, contentEnd + delimiter.length))
}

function parseCatalogRows() {
  const source = withoutComments(migration)
  const match = /insert\s+into\s+billing_private\.plan_catalog\s*\(/i.exec(source)
  assert.ok(match, 'missing server plan catalog seed')
  const columnsStart = match.index + match[0].lastIndexOf('(')
  const columnsFragment = readBalanced(source, columnsStart)
  const columns = splitTopLevel(columnsFragment.body).map((column) => normalize(column))
  const afterColumns = source.slice(columnsFragment.end + 1)
  const valuesMatch = /\bvalues\b/i.exec(afterColumns)
  assert.ok(valuesMatch, 'missing plan catalog values')
  const valuesStart = columnsFragment.end + 1 + valuesMatch.index + valuesMatch[0].length
  const rows = new Map()
  let cursor = valuesStart
  while (cursor < source.length) {
    while (/\s|,/.test(source[cursor])) cursor += 1
    if (source[cursor] === ';') break
    assert.equal(source[cursor], '(', 'plan catalog seed must contain value tuples')
    const tuple = readBalanced(source, cursor)
    const values = splitTopLevel(tuple.body).map((value) => normalize(value))
    assert.equal(values.length, columns.length, 'plan catalog row does not match its column list')
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]))
    const key = row.plan_key?.replaceAll("'", '')
    assert.ok(key, 'plan catalog row is missing a plan key')
    rows.set(key, row)
    cursor = tuple.end + 1
  }
  return rows
}

function authenticatedSelectColumns(qualifiedName) {
  const source = normalize(migration)
  const pattern = new RegExp(
    `grant select \\(([^;]+)\\) on ${escapeRegExp(qualifiedName)} to authenticated;`,
  )
  const match = pattern.exec(source)
  assert.ok(match, `missing authenticated column grant for ${qualifiedName}`)
  return splitTopLevel(match[1]).map((column) => normalize(column))
}

const catalogRows = parseCatalogRows()

test('the private server catalog owns the exact four plan prices, grants and top-up rates', () => {
  const expected = {
    starter: ['15000000', '144000000', '800000000', '20000'],
    creator: ['30000000', '300000000', '2000000000', '15000'],
    pro: ['60000000', '588000000', '5000000000', '12000'],
    studio: ['129000000', '1188000000', '12000000000', '10000'],
  }
  assert.deepEqual([...catalogRows.keys()].sort(), Object.keys(expected).sort())
  for (const [planKey, values] of Object.entries(expected)) {
    const row = catalogRows.get(planKey)
    assert.ok(row, `missing ${planKey} plan`)
    assert.deepEqual(
      [
        row.monthly_price_currency_micros,
        row.annual_price_currency_micros,
        row.monthly_grant_microcredits,
        row.top_up_currency_micros_per_credit,
      ],
      values,
    )
    assert.equal(row.minimum_top_up_currency_micros, '10000000')
  }
})

test('the pricing revision has a forward migration for already-installed catalogs', () => {
  const normalizedPricingMigration = normalize(pricingMigration)
  const normalizedStateHardeningMigration = normalize(stateHardeningMigration)
  const planCatalogColumns = extractTableColumns('billing_private.plan_catalog')
  assert.match(pricingMigration, /billing-2026-07-15/g)
  assert.match(pricingMigration, /'starter'::text[^\n]+800000000::bigint[^\n]+20000::bigint/)
  assert.match(pricingMigration, /'creator'::text[^\n]+2000000000::bigint[^\n]+15000::bigint/)
  assert.match(pricingMigration, /'pro'::text[^\n]+5000000000::bigint[^\n]+12000::bigint/)
  assert.match(pricingMigration, /'studio'::text[^\n]+12000000000::bigint[^\n]+10000::bigint/)
  assert.match(normalizedPricingMigration, /\bbegin;/)
  assert.match(normalizedPricingMigration, /\bcommit;/)
  assert.match(normalizedPricingMigration, /in access exclusive mode/)
  assert.match(normalizedPricingMigration, /set pricing_version = revised\.pricing_version/)
  assert.doesNotMatch(normalizedPricingMigration, /\bcatalog_version\b/)
  assert.doesNotMatch(normalizedPricingMigration, /\bupdated_at\s*=/)
  assert.match(pricingMigration, /if v_updated <> 4 then/)

  const catalogUpdateMatch =
    /update\s+billing_private\.plan_catalog\s+as\s+catalog\s+set([\s\S]+?)from\s+\(values/i.exec(
      withoutComments(pricingMigration),
    )
  assert.ok(catalogUpdateMatch, 'missing the forward catalog update')
  for (const assignment of splitTopLevel(catalogUpdateMatch[1])) {
    const column = /^\s*([a-z_][a-z0-9_]*)\s*=/i.exec(assignment)?.[1]?.toLowerCase()
    assert.ok(column, `could not parse catalog assignment: ${assignment}`)
    assert.ok(planCatalogColumns.has(column), `forward migration updates unknown catalog column ${column}`)
  }

  const disableTrigger = normalizedPricingMigration.indexOf(
    'alter table billing_private.plan_catalog disable trigger plan_catalog_is_immutable',
  )
  const catalogUpdate = normalizedPricingMigration.indexOf(
    'update billing_private.plan_catalog as catalog',
  )
  const enableTrigger = normalizedPricingMigration.indexOf(
    'alter table billing_private.plan_catalog enable trigger plan_catalog_is_immutable',
  )
  assert.ok(disableTrigger >= 0 && disableTrigger < catalogUpdate)
  assert.ok(catalogUpdate < enableTrigger)
  assert.match(
    normalizedPricingMigration,
    /active_subscription\.status not in \('canceled', 'expired'\)/,
  )
  assert.match(normalizedPricingMigration, /checkout_intent\.status in \('created', 'open'\)/)
  assert.match(normalizedPricingMigration, /paid_checkout\.status = 'completed'/)
  assert.match(normalizedPricingMigration, /annual_subscription\.annual_checkout_intent_id = paid_checkout\.id/)
  assert.match(normalizedPricingMigration, /initial_grant\.checkout_intent_id = paid_checkout\.id/)
  assert.match(normalizedPricingMigration, /monthly_subscription\.pricing_version = paid_checkout\.pricing_version/)
  assert.match(normalizedPricingMigration, /renewal_attempt\.state in \('scheduled', 'charging'\)/)
  assert.match(normalizedPricingMigration, /auto_reload\.enabled/)
  assert.match(normalizedPricingMigration, /grant_schedule\.status in \('pending', 'granting'\)/)

  assert.match(
    normalizedStateHardeningMigration,
    /old\.status in \('expired', 'cancelled', 'failed'\)/,
  )
  assert.match(
    normalizedStateHardeningMigration,
    /old\.status in \('completed', 'reconciled_no_payment'\)/,
  )
  assert.match(normalizedStateHardeningMigration, /a terminal reconciled checkout is immutable/)
  assert.match(
    normalizedStateHardeningMigration,
    /checkout_payment_event_is_verified\( new\.id, new\.provider/,
  )
  assert.match(
    normalizedStateHardeningMigration,
    /a closed checkout requires verified payment or no-payment evidence/,
  )
  assert.match(normalizedStateHardeningMigration, /old\.status in \('canceled', 'expired'\)/)
  assert.match(normalizedStateHardeningMigration, /raise exception 'a terminal subscription is immutable'/)
  assert.match(normalizedStateHardeningMigration, /old\.status in \('granted', 'skipped', 'cancelled'\)/)
  assert.match(normalizedStateHardeningMigration, /checkout snapshot does not match the active catalog/)
  assert.match(normalizedStateHardeningMigration, /subscription snapshot does not match the active catalog/)
  assert.match(
    normalizedPricingMigration,
    /recoverable_checkout\.status in \('failed', 'expired', 'cancelled'\)/,
  )
  assert.match(
    normalizedStateHardeningMigration,
    /create table billing_private\.checkout_no_payment_reconciliations/,
  )
  assert.match(normalizedStateHardeningMigration, /unique \(provider, provider_reconciliation_ref\)/)
  assert.match(normalizedStateHardeningMigration, /reconciliation\.provider = new\.provider/)
  assert.match(
    normalizedStateHardeningMigration,
    /create or replace function billing_private\.reconcile_checkout_without_payment/,
  )
  assert.match(normalizedStateHardeningMigration, /evidence_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(normalizedStateHardeningMigration, /grant execute on function billing_private\.reconcile_checkout_without_payment/)
  assert.match(
    normalizedStateHardeningMigration,
    /create trigger checkout_intents_state_guard before update on public\.checkout_intents/,
  )
  assert.match(
    normalizedStateHardeningMigration,
    /create trigger subscriptions_state_guard before update on public\.subscriptions/,
  )
  assert.match(
    normalizedStateHardeningMigration,
    /create trigger subscription_grants_state_guard before update on public\.subscription_grant_schedule/,
  )
})

test('Starter blocks only the canonical regular Seedance 2 model by exact ID', () => {
  const starterBlock = catalogRows.get('starter').blocked_model_ids
  assert.match(starterBlock, /^array\s*\[\s*'bytedance\/seedance-2'\s*\]::text\[\]$/)
  assert.doesNotMatch(starterBlock, /(?:fast|mini)/)

  const quote = extractFunction('billing_private.create_generation_quote')
  assert.match(quote, /btrim\(p_model_id\) = any\(v_plan\.blocked_model_ids\)/)
  assert.doesNotMatch(
    quote,
    /(?:like|ilike|similar to)[^;]{0,120}blocked_model_ids|blocked_model_ids[^;]{0,120}(?:like|ilike|similar to)/,
  )
})

test('top-ups enforce the raw $10 minimum before upward whole-cent rounding', () => {
  const checkout = extractFunction('billing_private.apply_checkout_catalog_snapshot')
  const pro = catalogRows.get('pro')
  const rawPro833 = 833n * BigInt(pro.top_up_currency_micros_per_credit)
  const roundedPro833 = ((rawPro833 + 9999n) / 10000n) * 10000n
  assert.equal(rawPro833, 9996000n)
  assert.equal(roundedPro833, 10000000n)
  assert.ok(rawPro833 < BigInt(pro.minimum_top_up_currency_micros))

  const rawAmount = checkout.indexOf('v_raw_expected_amount := ceil(')
  const minimumCheck = checkout.indexOf(
    'if v_raw_expected_amount < v_plan.minimum_top_up_currency_micros then',
  )
  const centRounding = checkout.indexOf(
    'v_expected_amount := ceil(v_raw_expected_amount / 10000::numeric) * 10000::numeric',
  )
  const persistedAmount = checkout.indexOf('new.amount_currency_micros := v_expected_amount::bigint')
  assert.ok(rawAmount >= 0 && rawAmount < minimumCheck)
  assert.ok(minimumCheck < centRounding && centRounding < persistedAmount)
  assert.match(
    checkout,
    /new\.credit_microcredits::numeric \* v_plan\.top_up_currency_micros_per_credit::numeric\) \/ 1000000::numeric/,
  )
  assert.match(checkout, /join billing_private\.plan_catalog p on p\.plan_key = s\.plan_key and p\.active/)
})

test('generation quotes require an active catalog-backed plan unless the server confirms an admin', () => {
  const quote = extractFunction('billing_private.create_generation_quote')
  assert.doesNotMatch(quote, /\bp_admin_bypass\b/)
  assert.match(quote, /billing_private\.is_active_admin\(p_user_id\)/)
  assert.match(quote, /if not v_admin_bypass then/)
  assert.match(quote, /join billing_private\.plan_catalog p on p\.plan_key = s\.plan_key and p\.active/)
  assert.match(quote, /s\.status in \('trialing', 'active'\)/)
  assert.match(
    quote,
    /coalesce\(s\.entitlement_ends_at, s\.current_period_end\) > clock_timestamp\(\)/,
  )
  assert.match(quote, /raise exception 'an active catalog-backed plan entitlement is required'/)
})

test('annual plans schedule exactly twelve monthly grants that each expire after one month', () => {
  const sql = normalize(migration)
  const subscriptions = extractTable('public.subscriptions')
  const schedules = extractTable('public.subscription_grant_schedule')
  const subscriptionSnapshot = extractFunction('billing_private.apply_subscription_catalog_snapshot')
  const paidSource = extractFunction('billing_private.annual_subscription_paid_source_is_valid')
  const schedule = extractFunction('billing_private.schedule_annual_plan_grants')
  const grantDue = extractFunction('billing_private.grant_due_annual_plan_credits')
  assert.match(subscriptions, /pricing_version text not null/)
  assert.match(schedules, /pricing_version text not null/)
  assert.match(
    sql,
    /add column annual_checkout_intent_id uuid references public\.checkout_intents\(id\) on delete restrict/,
  )
  assert.match(
    sql,
    /add column annual_renewal_attempt_id uuid references billing_private\.renewal_attempts\(id\) on delete restrict/,
  )
  assert.match(sql, /unique \(annual_checkout_intent_id\)/)
  assert.match(sql, /unique \(annual_renewal_attempt_id\)/)
  assert.match(
    sql,
    /billing_interval = 'annual'[^;]+num_nonnulls\(annual_checkout_intent_id, annual_renewal_attempt_id\) = 1/,
  )
  assert.match(schedules, /annual_checkout_intent_id uuid/)
  assert.match(schedules, /annual_renewal_attempt_id uuid/)
  assert.match(sql, /create trigger subscription_grants_protect_origin/)
  assert.match(
    schedules,
    /annual_checkout_intent_id uuid references public\.checkout_intents\(id\) on delete restrict/,
  )
  assert.match(
    schedules,
    /annual_renewal_attempt_id uuid references billing_private\.renewal_attempts\(id\) on delete restrict/,
  )
  assert.match(subscriptionSnapshot, /new\.pricing_version is distinct from old\.pricing_version/)
  assert.match(subscriptionSnapshot, /paid-period subscription pricing snapshots are immutable/)
  assert.match(
    subscriptionSnapshot,
    /billing_private\.annual_subscription_paid_source_is_valid\(/,
  )
  assert.match(paidSource, /v_checkout\.status <> 'completed'/)
  assert.match(paidSource, /v_checkout\.billing_interval <> 'annual'/)
  assert.match(paidSource, /v_checkout\.customer_id <> p_customer_id/)
  assert.match(paidSource, /v_checkout\.plan_key <> p_plan_key/)
  assert.match(paidSource, /v_checkout\.pricing_version <> p_pricing_version/)
  assert.match(paidSource, /v_checkout\.amount_currency_micros <> p_amount_currency_micros/)
  assert.match(paidSource, /v_checkout\.currency_code <> p_currency_code/)
  assert.match(paidSource, /v_renewal\.state <> 'succeeded'/)
  assert.match(paidSource, /v_renewal\.period_start is distinct from p_period_start/)
  assert.match(paidSource, /v_renewal\.period_end is distinct from p_period_end/)
  assert.match(schedule, /p_grant_count integer default 12/)
  assert.match(schedule, /p_lot_ttl interval default interval '1 month'/)
  assert.match(schedule, /p_grant_count is distinct from 12/)
  assert.match(schedule, /p_lot_ttl is distinct from interval '1 month'/)
  assert.match(schedule, /for v_index in 0\.\.\(p_grant_count - 1\) loop/)
  assert.match(schedule, /v_scheduled_for := p_period_anchor \+ make_interval\(months => v_index\)/)
  assert.match(schedule, /v_lot_expires_at := p_period_anchor \+ make_interval\(months => v_index \+ 1\)/)
  assert.match(schedule, /p_grant_microcredits is distinct from v_subscription\.included_microcredits_per_grant/)
  assert.match(schedule, /v_subscription\.pricing_version/)
  assert.doesNotMatch(schedule, /billing_private\.plan_catalog/)
  assert.match(schedule, /billing_private\.annual_subscription_paid_source_is_valid\(/)
  assert.match(
    schedule,
    /insert into public\.subscription_grant_schedule \([^;]+annual_checkout_intent_id, annual_renewal_attempt_id/,
  )
  const existingScheduleRetry = schedule.indexOf('if v_existing_count > 0 then')
  const mutableAnnualEligibility = schedule.indexOf("if v_subscription.billing_interval <> 'annual'")
  assert.ok(existingScheduleRetry >= 0 && existingScheduleRetry < mutableAnnualEligibility)
  assert.match(grantDue, /v_schedule\.pricing_version is distinct from v_subscription\.pricing_version/)
  assert.match(grantDue, /v_schedule\.amount_microcredits is distinct from v_subscription\.included_microcredits_per_grant/)
  assert.match(grantDue, /billing_private\.annual_subscription_paid_source_is_valid\(/)
  assert.doesNotMatch(grantDue, /billing_private\.plan_catalog/)
})

test('a checkout cannot complete without one processed signed payment reconciliation event', () => {
  const sql = normalize(migration)
  const checkoutProof = extractFunction('billing_private.checkout_payment_event_is_verified')
  const checkoutSnapshot = extractFunction('billing_private.apply_checkout_catalog_snapshot')
  const record = extractFunction('billing_private.record_payment_event')

  assert.match(
    sql,
    /add column completed_payment_event_id uuid references public\.payment_events\(id\) on delete restrict/,
  )
  assert.match(sql, /add column provider_payment_ref text/)
  assert.match(sql, /unique \(completed_payment_event_id\)/)
  assert.match(sql, /unique \(provider, provider_payment_ref\)/)
  assert.match(sql, /add column subscription_period_start timestamptz/)
  assert.match(sql, /add column subscription_period_end timestamptz/)
  assert.match(sql, /status = 'completed'[^;]+completed_payment_event_id is not null/)
  assert.match(checkoutProof, /v_event\.provider <> p_provider/)
  assert.match(checkoutProof, /v_event\.status <> 'processed'/)
  assert.match(checkoutProof, /v_event\.event_type <> 'payment\/received'/)
  assert.match(checkoutProof, /v_event\.provider_event_id <> p_provider_payment_ref/)
  assert.match(checkoutProof, /v_event\.payload->>'operationreference' <> p_checkout_id::text/)
  assert.match(checkoutProof, /v_event\.payload->'total'->>'currency' <> p_currency_code/)
  assert.match(checkoutProof, /v_minor_units \* 10000::numeric = p_amount_currency_micros::numeric/)
  assert.match(
    checkoutSnapshot,
    /billing_private\.checkout_payment_event_is_verified\(/,
  )
  assert.match(
    record,
    /p_payload->>'id' is distinct from v_event_id/,
  )
})

test('credit packs and automatic reload grants are validated as non-expiring lots', () => {
  const grant = extractFunction('billing_private.grant_credits')
  assert.match(
    grant,
    /p_source_type in \('credit_pack', 'auto_reload'\)[^;]{0,180}p_expires_at is not null|p_source_type not in \('credit_pack', 'auto_reload'\)[^;]{0,180}p_expires_at is null/,
  )
  assert.match(
    grant,
    /p_source_type in \('credit_pack', 'auto_reload'\)[^;]{0,180}p_subscription_id is not null/,
  )
})

test('every paid grant has one verified checkout or renewal origin and a derived retry identity', () => {
  const sql = normalize(migration)
  const grant = extractFunction('billing_private.grant_credits')

  assert.match(
    sql,
    /add column checkout_intent_id uuid references public\.checkout_intents\(id\) on delete restrict/,
  )
  assert.match(
    sql,
    /add column renewal_attempt_id uuid references billing_private\.renewal_attempts\(id\) on delete restrict/,
  )
  assert.match(sql, /unique \(checkout_intent_id\)/)
  assert.match(sql, /unique \(renewal_attempt_id\)/)
  assert.match(
    sql,
    /source_type in \('credit_pack', 'auto_reload'\)[^;]+checkout_intent_id is not null[^;]+renewal_attempt_id is null/,
  )
  assert.match(
    sql,
    /source_type = 'subscription'[^;]+num_nonnulls\(checkout_intent_id, renewal_attempt_id\) = 1/,
  )
  assert.match(
    grant,
    /v_idempotency_key := 'paid:checkout:' \|\| p_checkout_intent_id::text/,
  )
  assert.match(
    grant,
    /v_idempotency_key := 'paid:renewal:' \|\| p_renewal_attempt_id::text/,
  )
  assert.match(grant, /v_checkout\.status <> 'completed' or v_checkout\.completed_at is null/)
  assert.match(grant, /v_renewal\.state <> 'succeeded'/)
  assert.match(grant, /v_renewal\.provider_document_ref is null/)
  assert.doesNotMatch(grant, /v_checkout\.provider <> v_subscription\.provider/)
  assert.match(
    grant,
    /insert into public\.credit_grant_lots \([^;]+checkout_intent_id, renewal_attempt_id/,
  )
  const sourceIdentity = grant.indexOf("v_idempotency_key := 'paid:checkout:'")
  const existingRetry = grant.indexOf(
    'where account_id = v_account_id and idempotency_key = v_idempotency_key',
  )
  const mutableSubscriptionCheck = grant.indexOf(
    'select * into v_subscription from public.subscriptions',
  )
  assert.ok(sourceIdentity >= 0 && sourceIdentity < existingRetry)
  assert.ok(existingRetry < mutableSubscriptionCheck)

  const annual = extractFunction('billing_private.grant_due_annual_plan_credits')
  assert.match(annual, /'annual_monthly_grant'/)
  assert.doesNotMatch(annual, /paid:checkout:|paid:renewal:/)
})

test('saved payment methods are private and renewal charging can be claimed only once', () => {
  const subscriptions = extractTable('public.subscriptions')
  const methods = extractTable('billing_private.saved_payment_methods')
  const attempts = extractTable('billing_private.renewal_attempts')
  const claim = extractFunction('billing_private.claim_renewal_attempt')
  assert.match(methods, /provider_payment_method_ref text not null/)
  assert.match(subscriptions, /saved_payment_method_id uuid references billing_private\.saved_payment_methods/)
  assert.match(attempts, /charge_attempt_count smallint not null default 0 check \(charge_attempt_count in \(0, 1\)\)/)
  assert.match(attempts, /unique \(subscription_id, period_start\)/)
  assert.match(attempts, /state in \('scheduled', 'charging', 'succeeded', 'failed', 'unknown'\)/)
  assert.match(claim, /v_attempt\.state <> 'scheduled' or v_attempt\.charge_attempt_count <> 0/)
  assert.match(claim, /set state = 'charging', charge_attempt_count = 1/)
  assert.doesNotMatch(claim, /charge_claim_id = p_claim_id then return/)
})

test('payment ingestion deduplicates signed events, deliveries and raw evidence', () => {
  const events = extractTable('public.payment_events')
  const deliveries = extractTable('billing_private.payment_event_deliveries')
  const record = extractFunction('billing_private.record_payment_event')
  assert.match(events, /raw_body_sha256 text not null/)
  assert.match(events, /unique \(provider, provider_event_id\)/)
  assert.match(events, /unique \(provider, raw_body_sha256\)/)
  assert.match(deliveries, /raw_body_sha256 text not null/)
  assert.match(deliveries, /unique \(provider, provider_delivery_id\)/)
  assert.match(deliveries, /unique \(payment_event_id\)/)
  assert.match(normalize(migration), /create trigger payment_event_deliveries_are_immutable/)
  assert.match(record, /v_event_id := coalesce\(v_event_id, 'body:' \|\| p_raw_body_sha256\)/)
  assert.match(record, /v_event_type is distinct from 'payment\/received'/)
  assert.match(record, /insert into public\.payment_events[^;]+on conflict do nothing/)
  assert.match(record, /insert into billing_private\.payment_event_deliveries[^;]+on conflict do nothing/)
  assert.match(record, /where payment_event_id = v_event\.id/)
  assert.match(record, /where provider = v_provider and provider_delivery_id = v_delivery_id/)
  assert.match(record, /v_event\.raw_body_sha256 <> p_raw_body_sha256/)
  assert.match(record, /v_delivery\.raw_body_sha256 <> p_raw_body_sha256/)
  assert.match(record, /v_delivery\.payment_event_id <> v_event\.id/)
})

test('payment ingestion accepts only the redacted normalized reconciliation DTO', () => {
  const validator = extractFunction('billing_private.payment_reconciliation_payload_is_valid')
  const amountValidator = extractFunction('billing_private.payment_reconciliation_amount_is_valid')
  const record = extractFunction('billing_private.record_payment_event')
  assert.match(
    validator,
    /array\[ 'type', 'id', 'reconciliationstate', 'entitlementgrantallowed', 'issues', 'operationreference', 'total', 'transactions' \]/,
  )
  assert.match(
    validator,
    /array\['id', 'createdat', 'amount', 'gatewaytransactionid'\]/,
  )
  assert.match(amountValidator, /array\['currency', 'minorunits', 'exponent'\]/)
  assert.match(validator, /p_payload->'entitlementgrantallowed' <> 'false'::jsonb/)
  assert.match(validator, /p_payload->>'type' is distinct from p_event_type/)
  assert.match(validator, /jsonb_typeof\(v_transaction->'amount'\) <> 'object'/)
  assert.match(validator, /jsonb_typeof\(p_payload->'total'\) <> 'object'/)
  assert.doesNotMatch(validator, /payer|email|card|authorization/)
  assert.match(
    record,
    /not billing_private\.payment_reconciliation_payload_is_valid\(p_payload, v_event_type\)/,
  )
})

test('the user snapshot classifies active balance by grant source and keeps an other bucket', () => {
  const snapshot = extractFunction('public.my_billing_snapshot')
  assert.match(snapshot, /'available_microcredits', coalesce\(lot_balance\.available_microcredits, 0\)/)
  assert.match(snapshot, /'subscription_microcredits', coalesce\(lot_balance\.subscription_microcredits, 0\)/)
  assert.match(snapshot, /'purchased_microcredits', coalesce\(lot_balance\.purchased_microcredits, 0\)/)
  assert.match(snapshot, /'other_microcredits', coalesce\(lot_balance\.other_microcredits, 0\)/)
  assert.match(snapshot, /filter \( where l\.source_type in \('subscription', 'annual_monthly_grant'\) \)/)
  assert.match(snapshot, /filter \( where l\.source_type in \('credit_pack', 'auto_reload'\) \)/)
  assert.match(snapshot, /filter \( where l\.source_type not in \( 'subscription', 'annual_monthly_grant', 'credit_pack', 'auto_reload' \) \)/)
  assert.match(snapshot, /l\.expires_at is null or l\.expires_at > clock_timestamp\(\)/)
})

test('first-admin bootstrap accepts only one active email-confirmed auth user', () => {
  const bootstrap = extractFunction('billing_private.bootstrap_platform_admin')
  assert.match(bootstrap, /where lower\(btrim\(email\)\) = v_email/)
  assert.match(bootstrap, /email_confirmed_at is not null/)
  assert.match(bootstrap, /deleted_at is null/)
  assert.match(bootstrap, /banned_until is null or banned_until <= clock_timestamp\(\)/)
  assert.match(bootstrap, /auth user is not confirmed, was deleted, or is currently banned/)
})

test('administrator powers require a currently active confirmed auth identity', () => {
  const activeAdmin = extractFunction('billing_private.is_active_admin')
  const setRole = extractFunction('billing_private.set_platform_role')
  const quote = extractFunction('billing_private.create_generation_quote')

  assert.match(activeAdmin, /from public\.profiles p/)
  assert.match(activeAdmin, /join auth\.users u on u\.id = p\.user_id/)
  assert.match(activeAdmin, /p\.platform_role = 'admin'/)
  assert.match(activeAdmin, /u\.email_confirmed_at is not null/)
  assert.match(activeAdmin, /u\.deleted_at is null/)
  assert.match(activeAdmin, /u\.banned_until is null or u\.banned_until <= statement_timestamp\(\)/)
  assert.match(setRole, /billing_private\.is_active_admin\(p_actor_user_id\)/)
  assert.match(quote, /billing_private\.is_active_admin\(p_user_id\)/)
  assert.doesNotMatch(setRole, /user_id = p_actor_user_id and platform_role = 'admin'/)
  assert.doesNotMatch(quote, /p\.user_id = p_user_id and p\.platform_role = 'admin'/)
})

test('authenticated reads omit provider economics, reusable tokens and task references', () => {
  const quoteColumns = authenticatedSelectColumns('public.generation_billing_quotes')
  const subscriptionColumns = authenticatedSelectColumns('public.subscriptions')
  const lotColumns = authenticatedSelectColumns('public.credit_grant_lots')
  const ledgerColumns = authenticatedSelectColumns('public.credit_ledger')
  const checkoutColumns = authenticatedSelectColumns('public.checkout_intents')
  const reloadColumns = authenticatedSelectColumns('public.auto_reload_settings')

  for (const column of ['provider_cost_currency_micros', 'provider_cost_currency_code', 'request_sha256']) {
    assert.ok(!quoteColumns.includes(column), `${column} must stay server-only`)
  }
  for (const column of ['provider_subscription_ref', 'saved_payment_method_id', 'provider_metadata']) {
    assert.ok(!subscriptionColumns.includes(column), `${column} must stay server-only`)
  }
  for (const column of [
    'source_ref',
    'idempotency_key',
    'request_sha256',
    'metadata',
    'checkout_intent_id',
    'renewal_attempt_id',
  ]) {
    assert.ok(!lotColumns.includes(column), `${column} must stay server-only`)
  }
  for (const column of ['idempotency_key', 'reference_type', 'reference_id', 'metadata']) {
    assert.ok(!ledgerColumns.includes(column), `${column} must stay server-only`)
  }
  for (const column of ['provider', 'provider_checkout_ref', 'checkout_url', 'idempotency_key']) {
    assert.ok(!checkoutColumns.includes(column), `${column} must stay server-only`)
  }
  assert.ok(!reloadColumns.includes('saved_payment_method_id'))

  const sql = normalize(migration)
  assert.match(sql, /revoke all on all tables in schema billing_private from public, anon, authenticated;/)
  assert.doesNotMatch(sql, /grant select(?: on| \([^;]+\) on) billing_private\.[^;]+ to authenticated;/)
  assert.doesNotMatch(sql, /grant select(?: on| \([^;]+\) on) public\.payment_events to authenticated;/)
})

test('auto-reload resolves its plan and payment ownership from trusted server state', () => {
  const autoReload = extractFunction('billing_private.apply_auto_reload_catalog_snapshot')
  const sql = normalize(migration)
  assert.match(autoReload, /join billing_private\.plan_catalog p on p\.plan_key = s\.plan_key and p\.active/)
  assert.match(autoReload, /m\.customer_id = v_customer_id/)
  assert.match(autoReload, /m\.status = 'active'/)
  assert.match(autoReload, /v_plan\.currency_code = any\(m\.supported_currencies\)/)
  assert.match(autoReload, /v_raw_expected_amount < v_plan\.minimum_top_up_currency_micros/)
  assert.match(
    sql,
    /create trigger auto_reload_catalog_snapshot before insert or update on public\.auto_reload_settings for each row execute function billing_private\.apply_auto_reload_catalog_snapshot\(\);/,
  )
})

test('all financial mutations are service-only and immutable records cannot be rewritten', () => {
  const sql = normalize(migration)
  const reserve = extractFunction('billing_private.reserve_credits')
  const authenticatedExecutions = [...sql.matchAll(
    /grant execute on function ([a-z0-9_.]+)\([^;]*?\) to authenticated;/g,
  )].map((match) => match[1]).sort()
  assert.deepEqual(authenticatedExecutions, [
    'billing_private.owns_account',
    'billing_private.owns_customer',
    'billing_private.owns_reservation',
    'billing_private.owns_subscription',
    'public.my_billing_snapshot',
  ])
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]* to authenticated;/)
  assert.match(sql, /revoke all on all functions in schema billing_private from public, anon, authenticated;/)
  assert.match(sql, /grant execute on all functions in schema billing_private to service_role;/)
  assert.match(reserve, /if v_quote\.admin_bypass then/)
  assert.match(reserve, /administrator bypass quotes must skip credit reservation/)
  assert.match(
    sql,
    /create trigger plan_catalog_is_immutable before update or delete on billing_private\.plan_catalog for each row execute function billing_private\.reject_immutable_mutation\(\);/,
  )
  assert.match(
    sql,
    /create trigger credit_ledger_is_immutable before update or delete on public\.credit_ledger for each row execute function billing_private\.reject_immutable_mutation\(\);/,
  )
  assert.match(
    sql,
    /create trigger platform_role_audit_is_immutable before update or delete on public\.platform_role_audit for each row execute function billing_private\.reject_immutable_mutation\(\);/,
  )
  assert.match(
    sql,
    /alter default privileges in schema billing_private revoke all on tables from public, anon, authenticated;/,
  )
  assert.match(
    sql,
    /alter default privileges in schema billing_private revoke all on sequences from public, anon, authenticated;/,
  )
  assert.match(
    sql,
    /alter default privileges in schema billing_private revoke execute on functions from public, anon, authenticated;/,
  )
})

test('new account and subscription UI sources contain no legacy provider branding', () => {
  const legacyProvider = String.fromCharCode(107, 105, 101)
  const brandedText = new RegExp(
    `(^|[^a-z0-9])${legacyProvider}(?:[.]?ai)?(?=$|[^a-z0-9])`,
    'i',
  )
  const userFacingFiles = [
    'src/data/subscriptions.ts',
    'src/core/account.ts',
    'src/screens/Account.tsx',
    'src/account.css',
  ]
  for (const relativePath of userFacingFiles) {
    const contents = readFileSync(path.join(projectRoot, relativePath), 'utf8')
    assert.doesNotMatch(contents, brandedText, `${relativePath} exposes a legacy provider brand`)
  }
})
