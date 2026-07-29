import assert from 'node:assert/strict'
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  formatAge,
  formatCount,
  formatCredits,
  formatDateTime,
  formatMoney,
  formatUnits,
  shortId,
} from '../admin/src/format.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const adminSource = path.join(projectRoot, 'admin', 'src')
const adminDist = path.join(projectRoot, 'admin', 'dist')

/**
 * Comments explain what the code deliberately avoids, so scanning raw text for
 * a forbidden API matches the prose that promises not to use it. These checks
 * run against code only.
 */
function stripComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Reads through one descriptor rather than testing a path and then acting on it
 * again — the rule in CLAUDE.md, modelled on `readRegularFile` in
 * scripts/install-git-hooks.mjs. Absence comes from ENOENT on open, not from a
 * prior existence check.
 */
function readRegularFile(filePath: string): string | null {
  let handle: number
  try {
    handle = openSync(filePath, constants.O_RDONLY)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
  try {
    return fstatSync(handle).isFile() ? readFileSync(handle, 'utf8') : null
  } finally {
    closeSync(handle)
  }
}

function requireFile(filePath: string): string {
  const contents = readRegularFile(filePath)
  assert.ok(contents !== null, `${path.relative(projectRoot, filePath)} is missing`)
  return contents
}

function readAll(directory: string, extensions: readonly string[]): string {
  let combined = ''
  // withFileTypes carries the entry kind from the single readdir call, so no
  // separate stat is issued against a path that could change underneath it.
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      combined += readAll(full, extensions)
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      combined += readRegularFile(full) ?? ''
    }
  }
  return combined
}

test('micro-unit amounts render as units, and unusable values never render as numbers', () => {
  // The database emits bigints as strings so they cannot be truncated in
  // transit. A value that will not round-trip must show as an em dash rather
  // than as a plausible wrong number.
  assert.equal(formatUnits('240000000'), '240.00')
  assert.equal(formatMoney('240000000'), '$240.00')
  assert.equal(formatMoney(60_000_000), '$60.00')

  assert.equal(formatCredits('2000000000'), '2,000')
  assert.equal(formatCredits('1483920000'), '1,483.92')
  assert.equal(formatCredits('0'), '0')

  for (const bad of [null, undefined, '', 'nope', '12.5', 1.5, Number.MAX_SAFE_INTEGER + 2, '1e9']) {
    assert.equal(formatCredits(bad as never), '—', `${String(bad)} must not render as a number`)
    assert.equal(formatMoney(bad as never), '—', `${String(bad)} must not render as money`)
  }
})

test('negative deltas keep their sign, because the ledger records both directions', () => {
  assert.equal(formatCredits('-20000000'), '-20')
  assert.equal(formatUnits('-1500000'), '-1.50')
})

test('counts and timestamps degrade to a dash rather than to NaN or Invalid Date', () => {
  assert.equal(formatCount(5), '5')
  assert.equal(formatCount(12_345), '12,345')
  assert.equal(formatCount(Number.NaN), '—')
  assert.equal(formatCount(undefined), '—')

  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime('not a date'), '—')
  assert.match(formatDateTime('2026-07-29T00:00:00Z'), /2026/)
})

test('the freshness label reports age, and says never before the first load', () => {
  assert.equal(formatAge(null), 'never')
  assert.equal(formatAge(Date.now()), 'just now')
  assert.equal(formatAge(Date.now() - 30_000), '30s ago')
  assert.equal(formatAge(Date.now() - 5 * 60_000), '5m ago')
  assert.equal(formatAge(Date.now() - 3 * 3_600_000), '3h ago')
})

test('identifiers are shortened for display without becoming ambiguous', () => {
  assert.equal(shortId(null), '—')
  assert.equal(shortId('short'), 'short')
  assert.equal(shortId('7c1d5a92-3e64-4b18-9f27-6ad3c8b41052'), '7c1d5a92…')
})

test('no service-role credential can reach the admin bundle', () => {
  // A service-role key bypasses every row-level security policy in the schema.
  // There is no legitimate path for one into a browser, so the console is
  // checked at the source and again at the built artifact.
  const source = readAll(adminSource, ['.ts', '.tsx', '.css'])
  assert.doesNotMatch(source, /SERVICE_ROLE/i, 'the console must never name a service-role variable')
  assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{20,}/, 'no JWT literal may appear in the console source')

  // The console reads exactly one key, and it is the publishable one.
  const keyReads = [...source.matchAll(/env\.(VITE_[A-Z_]+)/g)].map((match) => match[1])
  assert.deepEqual(
    [...new Set(keyReads)].sort(),
    ['VITE_ADMIN_API_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL'],
    'the console must read only the API URL and the publishable anon key',
  )
})

/**
 * Supabase keys are JWTs, and one of them belongs in the browser: the anon key
 * is publishable by design. So "contains a JWT" is the wrong question — the
 * question is which role it carries. This decodes every JWT in the artifact and
 * fails on any that is not the publishable one.
 */
function jwtRoles(source: string): string[] {
  const roles: string[] = []
  for (const match of source.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    let claims: unknown
    try {
      claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
    } catch {
      // Not a decodable JWT payload; treated as unknown so it cannot pass silently.
      roles.push('undecodable')
      continue
    }
    const role = (claims as { role?: unknown })?.role
    roles.push(typeof role === 'string' ? role : 'unknown')
  }
  return roles
}

test('the built admin bundle carries no privileged credential', () => {
  let built: string
  try {
    built = readAll(adminDist, ['.js', '.html', '.css'])
  } catch {
    assert.fail('admin/dist is missing — run `npm run admin:build` (verify does this before tests)')
  }
  assert.ok(built.length > 0, 'the built bundle must not be empty')

  // A service-role key bypasses every policy in the schema. Any JWT that is not
  // the publishable anon key is treated as a leak, including one whose payload
  // cannot be read.
  for (const role of jwtRoles(built)) {
    assert.equal(role, 'anon', `a "${role}" token must never reach the browser bundle`)
  }
  assert.doesNotMatch(built, /sb_secret_/, 'no secret Supabase key may be embedded')
  assert.doesNotMatch(built, /SERVICE_ROLE/i, 'the bundle must not name a service-role variable')

  // Source maps would ship the console's logic alongside it.
  assert.doesNotMatch(built, /sourceMappingURL/, 'the admin build must not emit source maps')
})

test('the credential check can actually fail', () => {
  // A guard that cannot fail is decoration. This proves the decoder classifies a
  // service-role token correctly, without one ever existing in the repository.
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const payload = Buffer.from('{"iss":"supabase","role":"service_role"}').toString('base64url')
  const forged = `${header}.${payload}.aaaaaaaaaaaaaaaaaaaa`
  assert.deepEqual(jwtRoles(`const k = "${forged}"`), ['service_role'])

  const anonPayload = Buffer.from('{"iss":"supabase","role":"anon"}').toString('base64url')
  assert.deepEqual(jwtRoles(`const k = "${header}.${anonPayload}.aaaaaaaaaaaaaaaaaaaa"`), ['anon'])
})

test('the built console declares a policy that permits only the configured origin', () => {
  const html = requireFile(path.join(adminDist, 'index.html'))
  assert.match(html, /Content-Security-Policy/)
  for (const directive of [
    /default-src &#39;self&#39;/,
    /script-src &#39;self&#39;/,
    /object-src &#39;none&#39;/,
    /frame-ancestors &#39;none&#39;/,
    /base-uri &#39;none&#39;/,
    /form-action &#39;none&#39;/,
  ]) {
    assert.match(html, directive, `the policy must contain ${directive}`)
  }
  // An unconfigured build must be able to reach nothing rather than everything.
  assert.doesNotMatch(html, /connect-src[^;"]*\*/, 'connect-src must never be a wildcard')
  assert.doesNotMatch(html, /unsafe-eval/, 'the console must never permit eval')
})

test('the console is bound to loopback and asks not to be indexed', () => {
  const config = requireFile(path.join(projectRoot, 'vite.admin.config.ts'))
  const hosts = [...config.matchAll(/host: '([^']+)'/g)].map((match) => match[1])
  assert.ok(hosts.length >= 2, 'both the dev server and the preview server must set a host')
  for (const host of hosts) {
    assert.equal(host, '127.0.0.1', 'the console must never bind a routable interface')
  }
  assert.match(config, /sourcemap: false/)

  const html = requireFile(path.join(projectRoot, 'admin', 'index.html'))
  assert.match(html, /name="robots" content="noindex, nofollow"/)
  assert.match(html, /name="referrer" content="no-referrer"/)
})

test('the console holds no session in persistent browser storage', () => {
  const source = stripComments(readAll(adminSource, ['.ts', '.tsx']))
  // A token in localStorage outlives the tab and can be read by anything that
  // achieves script execution later. The console keeps it in memory instead.
  assert.doesNotMatch(source, /localStorage/, 'no token may be written to localStorage')
  assert.doesNotMatch(source, /sessionStorage/, 'no token may be written to sessionStorage')
  assert.doesNotMatch(source, /document\.cookie/, 'no token may be written to a cookie')
})

test('the admin API surface exposes exactly one mutation, and it is the role change', () => {
  const source = stripComments(readAll(adminSource, ['.ts', '.tsx']))

  // Sign-in POSTs to Supabase Auth, which is not an admin API call. Only the
  // requests routed through `request(config, session, …)` reach the admin
  // service, so the check is scoped to those.
  const adminCalls = [...source.matchAll(/request\(config, session, ([^,)]+)(?:,\s*\{[\s\S]*?method: '(\w+)')?/g)]
  const mutating = adminCalls.filter((match) => match[2] !== undefined).map((match) => match[2])
  assert.deepEqual(mutating, ['POST'], 'the console must reach the admin service with exactly one mutation')
  assert.match(source, /request\(config, session, '\/roles'/, 'the one mutation must be the role change')

  // Nothing may address the ledger or the audit trail with a write.
  assert.doesNotMatch(source, /method: '(PUT|PATCH|DELETE)'/, 'the console must never PUT, PATCH or DELETE')
})
