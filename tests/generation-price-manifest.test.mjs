import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations')

const migration = readFileSync(
  path.join(migrationsDirectory, '202608060007_generation_price_manifest_v1.sql'),
  'utf8',
)
const controlPlane = readFileSync(
  path.join(migrationsDirectory, '20260715175329_generation_gateway_control_plane.sql'),
  'utf8',
)
const settlement = readFileSync(
  path.join(migrationsDirectory, '202608060002_renewal_settlement_and_payment_methods.sql'),
  'utf8',
)
const reversals = readFileSync(
  path.join(migrationsDirectory, '202608060003_payment_reversal_ingestion.sql'),
  'utf8',
)
const manifest = JSON.parse(
  readFileSync(path.join(projectRoot, 'supabase', 'pricing', 'generation-price-manifest.v1.json'), 'utf8'),
)

function withoutComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ')
}

function normalize(value) {
  return withoutComments(value).replace(/\s+/g, ' ').trim().toLowerCase()
}

const sql = normalize(migration)

/** The seed tuples, read back out of the migration exactly as written. */
function seededRows() {
  const block = /\)\s*as\s+seed\s*\(/.exec(migration)
  assert.ok(block, 'the seed VALUES block is missing its column list')
  const values = migration.slice(migration.indexOf('\n  values\n'), block.index)
  assert.ok(!values.includes("''"), 'seed literals must not need quote escaping')
  const tuple = /\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+)\)/g
  const rows = []
  for (const match of values.matchAll(tuple)) {
    rows.push({
      pricing_key: match[1],
      model_id: match[2],
      action: match[3],
      family: match[4],
      create_path: match[5],
      poll_path: match[6],
      customer_microcredits_per_unit: Number(match[7]),
      provider_cost_currency_micros_per_unit: Number(match[8]),
      maximum_units: Number(match[9]),
    })
  }
  return rows
}

const rows = seededRows()

test('the migration is forward-only and wrapped in one transaction', () => {
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  assert.match(sql, /lock table billing_private\.generation_price_catalog in access exclusive mode;/)
})

test('the migration seeds exactly the reviewed manifest, row for row', () => {
  assert.equal(manifest.manifest_version, 1)
  assert.equal(manifest.entries.length, manifest.row_count)
  assert.equal(rows.length, manifest.row_count)

  const seeded = new Map(rows.map((row) => [row.pricing_key, row]))
  assert.equal(seeded.size, rows.length, 'a pricing_key is seeded twice')

  for (const entry of manifest.entries) {
    const row = seeded.get(entry.pricing_key)
    assert.ok(row, `${entry.pricing_key} is in the manifest but not in the migration`)
    assert.deepEqual(row, {
      pricing_key: entry.pricing_key,
      model_id: entry.model_id,
      action: entry.action,
      family: entry.family,
      create_path: entry.create_path,
      poll_path: entry.poll_path,
      customer_microcredits_per_unit: entry.customer_microcredits_per_unit,
      provider_cost_currency_micros_per_unit: entry.provider_cost_currency_micros_per_unit,
      maximum_units: entry.maximum_units,
    })
  }
})

test('the migration asserts the row count itself, so a truncated seed cannot deploy', () => {
  const count = String(manifest.row_count)
  assert.match(
    sql,
    new RegExp(`if v_rows <> ${count} then raise exception 'expected ${count} seeded generation prices, found %', v_rows;`),
  )
})

test('every seeded price is inert', () => {
  // The literal `false` is the last column of the insert's select list.
  assert.match(sql, /'generation-2026-08-06-manifest-v1', seed\.maximum_units, false from \(/)
  assert.equal(manifest.seeded_active, false)
  assert.doesNotMatch(sql, /active = true/)
  assert.doesNotMatch(sql, /set active/)
  assert.match(
    sql,
    /select count\(\*\) into v_bad from billing_private\.generation_price_catalog where active; if v_bad <> 0 then raise exception '% seeded generation prices are active; the seed must be inert', v_bad;/,
  )
})

test('the catalog becomes append-only before the first row exists', () => {
  // The control plane created this table with no trigger at all; the protection
  // is added here, not worked around.
  assert.doesNotMatch(normalize(controlPlane), /create trigger \w*generation_price_catalog/)
  const triggerAt = sql.indexOf('create trigger generation_price_catalog_is_immutable')
  const insertAt = sql.indexOf('insert into billing_private.generation_price_catalog')
  assert.ok(triggerAt > 0, 'the immutability trigger is missing')
  assert.ok(insertAt > triggerAt, 'rows are seeded before the table is made append-only')
  assert.match(
    sql,
    /create trigger generation_price_catalog_is_immutable before update or delete on billing_private\.generation_price_catalog for each row execute function billing_private\.reject_immutable_mutation\(\);/,
  )
  assert.match(
    sql,
    /revoke insert, update, delete on table billing_private\.generation_price_catalog from service_role;/,
  )
})

test('provider cost is a positive integer number of micro-dollars', () => {
  for (const entry of manifest.entries) {
    const micros = entry.provider_cost_currency_micros_per_unit
    assert.ok(Number.isSafeInteger(micros), `${entry.pricing_key} provider cost is not an integer`)
    assert.ok(micros > 0, `${entry.pricing_key} provider cost is not positive`)
    assert.equal(entry.provider_cost_currency_code, 'USD')
    // Derived from the feed's creditPrice, never from its usdPrice: five of the
    // 404 rows carry a usdPrice that contradicts their own credit price.
    assert.equal(micros, Math.round(entry.provider_credits_per_unit * 5_000))
  }
})

test('customer price restates the documented rule and changes no price', () => {
  assert.equal(manifest.price_rule.provider_credit_usd, 0.005)
  for (const entry of manifest.entries) {
    const customer = entry.customer_microcredits_per_unit
    assert.ok(Number.isSafeInteger(customer) && customer > 0, `${entry.pricing_key} customer price is invalid`)
    // One EasyField credit is one provider credit, and one provider credit is
    // 5000 micro-USD, so 1e6 microcredits always accompany 5000 micro-USD.
    assert.equal(customer, entry.provider_cost_currency_micros_per_unit * 200)
    assert.equal(customer, Math.round(entry.provider_credits_per_unit * 1_000_000))
    // Per-unit credits restate the reviewed 2026-07-11 table. A "per 1000
    // characters" feed rate becomes an exact per-character rate so that
    // quantity_units stays an integer; nothing else is rescaled.
    const expected = entry.unit === 'character'
      ? entry.reviewed_fallback_credits / 1000
      : entry.reviewed_fallback_credits
    assert.equal(entry.provider_credits_per_unit, expected)
    assert.equal(entry.reviewed_fallback_credits, entry.provenance.feed_credit_price)
  }
  assert.match(
    sql,
    /where customer_microcredits_per_unit <> provider_cost_currency_micros_per_unit \* 200/,
  )
})

test('the manifest records enough provenance to re-verify a price without guessing', () => {
  assert.equal(manifest.generated_at, '2026-08-06')
  assert.equal(manifest.source.fetched_at, '2026-08-06')
  assert.equal(manifest.source.rows_returned, 404)
  for (const entry of manifest.entries) {
    const source = entry.provenance
    assert.ok(source.feed_model_description.length > 0, `${entry.pricing_key} has no upstream description`)
    assert.equal(source.feed_fetched_at, '2026-08-06')
    assert.equal(typeof source.feed_credit_unit, 'string')
    assert.equal(typeof source.feed_usd_price, 'string')
    assert.equal(typeof source.feed_discount_rate, 'number')
    // discountRate compares against a competitor's price; discountPrice is what
    // would say a promotion is applied, and it is false on every upstream row.
    assert.equal(source.feed_discount_price, false)
    assert.ok(Array.isArray(source.feed_match_tokens) && source.feed_match_tokens.length > 0)
  }
})

test('every seeded row is routable', () => {
  // Nothing in the DDL ties family to its paths, and a mis-seeded poll_path
  // produces a job that is quoted, reserved, submitted and never settleable.
  const routes = new Map([
    ['jobs', ['/api/v1/jobs/createTask', '/api/v1/jobs/recordInfo']],
    ['veo', ['/api/v1/veo/generate', '/api/v1/veo/record-info']],
    ['runway', ['/api/v1/runway/generate', '/api/v1/runway/record-detail']],
    ['aleph', ['/api/v1/aleph/generate', '/api/v1/aleph/record-info']],
    ['suno', ['/api/v1/generate', '/api/v1/generate/record-info']],
    ['sounds', ['/api/v1/generate/sounds', '/api/v1/generate/record-info']],
  ])
  const gateway = readFileSync(
    path.join(projectRoot, 'supabase', 'functions', '_shared', 'generation_gateway.ts'),
    'utf8',
  )
  for (const [family, [createPath, pollPath]] of routes) {
    assert.ok(
      gateway.includes(`["${createPath}", { family: "${family}", pollPath: "${pollPath}" }]`),
      `${family} is not the gateway's own route pair`,
    )
  }
  for (const row of rows) {
    assert.deepEqual([row.create_path, row.poll_path], routes.get(row.family), `${row.pricing_key} is unroutable`)
  }
  assert.match(sql, /where \(family, create_path, poll_path\) not in \(/)
})

test('seeded identifiers are trimmed and within the catalog constraints', () => {
  for (const row of rows) {
    assert.equal(row.pricing_key, row.pricing_key.trim())
    assert.equal(row.model_id, row.model_id.trim())
    assert.equal(row.action, row.action.trim())
    assert.ok(row.pricing_key.length >= 3 && row.pricing_key.length <= 240)
    assert.ok(row.model_id.length >= 1 && row.model_id.length <= 200)
    assert.ok(row.action.length >= 1 && row.action.length <= 120)
    assert.ok(row.maximum_units >= 1 && row.maximum_units <= 100000)
    assert.equal(row.pricing_key, `${row.family}:${row.model_id}:${row.pricing_key.split(':').slice(2).join(':')}`)
  }
  assert.match(sql, /where pricing_key <> btrim\(pricing_key\) or model_id <> btrim\(model_id\) or action <> btrim\(action\)/)
})

test('a model id is either what the client submits or is declared synthetic', () => {
  const submitted = [
    readFileSync(path.join(projectRoot, 'src', 'data', 'providerModels.ts'), 'utf8'),
    readFileSync(path.join(projectRoot, 'src', 'data', 'avatar.ts'), 'utf8'),
  ].join('\n')
  for (const entry of manifest.entries) {
    if (entry.synthetic_model_id) {
      // Families whose request body carries no provider model id at all. The
      // label is EasyField's, and it is what plan_catalog.blocked_model_ids
      // would have to name to gate these families.
      assert.match(entry.model_id, /^easyfield\//)
      assert.ok(['runway', 'aleph', 'suno', 'sounds'].includes(entry.family))
      continue
    }
    if (/^flux-2\/(pro|flex)-(text-to-image|image-to-image)$/.test(entry.model_id)) {
      // The only offered id the client assembles rather than writes out. Both
      // halves are pinned so the catalog cannot drift away from the template.
      assert.ok(submitted.includes('job(`flux-2/${variant}-${kind}`'))
      assert.ok(submitted.includes("const variant = c.extras.variant === 'Pro' ? 'pro' : 'flex'"))
      assert.ok(submitted.includes("const kind = has ? 'image-to-image' : 'text-to-image'"))
      continue
    }
    assert.ok(
      submitted.includes(`'${entry.model_id}'`),
      `${entry.model_id} is not a string the desktop client submits`,
    )
  }
})

test('the migration does not regress the maintenance allowlist or the alert codes', () => {
  // This migration must not redefine either function. Both are asserted against
  // their current definitions so a future copy-paste of an older body is caught.
  assert.doesNotMatch(sql, /create or replace function billing_private\.run_maintenance/)
  assert.doesNotMatch(sql, /create or replace function billing_private\.operational_alerts/)

  const jobs = [
    'expire_credit_reservations',
    'expire_credit_lots',
    'grant_due_annual_plan_credits',
    'sweep_due_renewals',
    'close_unopened_checkouts',
    'expire_stale_open_checkouts',
    'settle_succeeded_renewals',
  ]
  const allowlist = /if p_job not in \(([^)]+)\) then/.exec(normalize(settlement))
  assert.ok(allowlist, 'run_maintenance has no job allowlist')
  const allowed = allowlist[1].split(',').map((name) => name.trim().replace(/'/g, ''))
  assert.deepEqual(allowed, jobs)
  assert.equal(allowed.length, 7)

  const codes = normalize(reversals).match(/'code', '([a-z-]+)'/g) ?? []
  assert.deepEqual(new Set(codes.map((code) => code.slice(9, -1))), new Set([
    'maintenance-stale',
    'maintenance-failing',
    'renewal-stuck-charging',
    'renewal-unsettled',
    'renewal-blocked',
    'checkout-unopened-not-swept',
    'checkout-awaiting-reconciliation',
    'reversal-shortfall',
  ]))
  assert.equal(codes.length, 8)
})

test('nothing here flips the customer generation gateway on', () => {
  assert.doesNotMatch(migration, /CUSTOMER_GENERATION_GATEWAY_READY/)
  assert.doesNotMatch(JSON.stringify(manifest), /CUSTOMER_GENERATION_GATEWAY_READY/)
})
