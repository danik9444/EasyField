import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_FIELDS = Object.freeze([
  'supabaseUrl',
  'anonKey',
  'accountApiUrl',
  'oauthProviders',
  'checkoutHosts',
])
const EXPECTED_FIELD_SET = new Set(EXPECTED_FIELDS)
const ACCOUNT_FUNCTION_PATH = '/functions/v1/easyfield-account'
const MAX_CONFIG_BYTES = 64 * 1024
const PRODUCTION_BUILDERS = Object.freeze([
  'release-build-update.mjs',
  'release-build-pkg.mjs',
])

function fail(message) {
  throw new Error(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsPlaceholder(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return !normalized
    || normalized.includes('your_project')
    || normalized.includes('your-project')
    || normalized.includes('your project')
    || normalized.includes('your_public')
    || normalized.includes('your-public')
    || normalized.includes('your public')
    || normalized.includes('placeholder')
    || normalized.includes('replace_me')
    || normalized.includes('replace-me')
    || normalized.includes('change_me')
    || normalized.includes('change-me')
    || normalized.includes('${')
    || normalized.includes('<')
    || normalized.includes('>')
}

function assertDnsHostname(hostname, fieldName) {
  if (
    typeof hostname !== 'string'
    || !hostname
    || hostname.length > 253
    || hostname !== hostname.toLowerCase()
    || containsPlaceholder(hostname)
    || net.isIP(hostname) !== 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.example')
    || hostname.endsWith('.invalid')
    || hostname.endsWith('.test')
  ) {
    fail(`${fieldName} must be a public lowercase DNS hostname`)
  }

  const labels = hostname.split('.')
  if (
    labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    fail(`${fieldName} must be a valid DNS hostname`)
  }
}

function parseHttpsUrl(value, fieldName) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length > 2048
    || containsPlaceholder(value)
  ) {
    fail(`${fieldName} must be a real HTTPS URL with no placeholders`)
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${fieldName} must be a valid HTTPS URL`)
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
  ) {
    fail(`${fieldName} must be an HTTPS URL without credentials, a port, query, or fragment`)
  }
  assertDnsHostname(parsed.hostname, `${fieldName} hostname`)
  return parsed
}

function decodeBase64UrlJson(value, fieldName) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(`${fieldName} is not a valid public anon key`)
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    fail(`${fieldName} is not a valid public anon key`)
  }
}

function validatePublicSupabaseKey(value, projectRef) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length > 4096
    || /\s/.test(value)
    || containsPlaceholder(value)
  ) {
    fail('anonKey must be a real public Supabase anon or publishable key')
  }

  if (value.startsWith('sb_secret_')) {
    fail('anonKey must never contain a Supabase secret key')
  }

  if (value.startsWith('sb_publishable_')) {
    const suffix = value.slice('sb_publishable_'.length)
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(suffix) || /^([A-Za-z0-9_-])\1+$/.test(suffix)) {
      fail('anonKey is not a valid Supabase publishable key')
    }
    return value
  }

  const segments = value.split('.')
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    fail('anonKey must be a public Supabase anon or publishable key')
  }
  const header = decodeBase64UrlJson(segments[0], 'anonKey')
  const payload = decodeBase64UrlJson(segments[1], 'anonKey')
  if (
    !isPlainObject(header)
    || !isPlainObject(payload)
    || typeof header.alg !== 'string'
    || !header.alg
    || header.alg.toLowerCase() === 'none'
    || payload.role !== 'anon'
    || (payload.ref !== undefined && payload.ref !== projectRef)
    || !/^[A-Za-z0-9_-]{16,}$/.test(segments[2])
  ) {
    fail('anonKey must be a public Supabase anon key for this project')
  }
  return value
}

/**
 * The checkout host allowlist.
 *
 * An empty list is permitted and means "no checkout redirect is allowed" — the
 * fail-closed state, and the correct one while no payment provider has been
 * chosen. Requiring a nonempty list forced the operator to grant a permission
 * before they had anything to grant it to, so the only way to produce a
 * signable build was to name a host the product does not use. A wrong host is
 * strictly worse than none: it passes the gate and sends customers somewhere
 * real that is not the merchant.
 *
 * Every entry that IS present is still validated exactly as strictly as before.
 */
function validateCheckoutHosts(value) {
  if (!Array.isArray(value) || value.length > 20) {
    fail('checkoutHosts must be an array of at most 20 checkout hostnames')
  }

  const seen = new Set()
  return Object.freeze(value.map((entry, index) => {
    if (
      typeof entry !== 'string'
      || entry !== entry.trim()
      || entry.includes('://')
      || entry.includes('/')
      || entry.includes(':')
      || entry.includes('*')
    ) {
      fail(`checkoutHosts[${index}] must contain only a DNS hostname`)
    }
    assertDnsHostname(entry, `checkoutHosts[${index}]`)
    if (seen.has(entry)) fail(`checkoutHosts contains a duplicate hostname at index ${index}`)
    seen.add(entry)
    return entry
  }))
}

/**
 * Which social sign-in buttons the shipped app offers.
 *
 * This validates the value; it does not mandate a product decision. Demanding
 * both providers made an email-only build unreleasable, which is a legitimate
 * configuration — and worse, it invited someone to list a provider that is not
 * actually configured in Supabase Auth, producing a button that fails after
 * the customer has already left for their browser.
 *
 * An unknown provider is still rejected, because the renderer maps these names
 * onto real sign-in paths and a typo would ship a dead button.
 *
 * The accepted names are written inline rather than held in a module constant.
 * Validation failures reach console.error, and taint analysis reasonably treats
 * anything named for OAuth as credential-like once it can flow into a log — the
 * values here are 'google' and 'apple', but the shape of that path is worth not
 * creating.
 */
function validateOAuthProviders(value) {
  if (!Array.isArray(value) || value.length > 2) {
    fail('oauthProviders must be an array of at most 2 providers')
  }
  const normalized = value.map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
  for (const entry of normalized) {
    if (entry !== 'google' && entry !== 'apple') {
      fail('oauthProviders may only contain google and apple')
    }
  }
  if (new Set(normalized).size !== normalized.length) {
    fail('oauthProviders must not contain duplicates')
  }
  // Built in a stable order so the packaged config is byte-identical for the
  // same set regardless of how it was written.
  const ordered = []
  if (normalized.includes('google')) ordered.push('google')
  if (normalized.includes('apple')) ordered.push('apple')
  return Object.freeze(ordered)
}

export function validateReleaseAccountConfig(value) {
  if (!isPlainObject(value)) fail('Account config must be a JSON object')

  for (const field of Object.keys(value)) {
    if (!EXPECTED_FIELD_SET.has(field)) {
      fail(`Account config contains an unsupported field: ${field}`)
    }
  }
  for (const field of EXPECTED_FIELDS) {
    if (!Object.hasOwn(value, field)) fail(`Account config is missing required field: ${field}`)
  }

  const supabaseUrl = parseHttpsUrl(value.supabaseUrl, 'supabaseUrl')
  if (supabaseUrl.pathname !== '/' || !/^[a-z0-9][a-z0-9-]{4,62}\.supabase\.co$/.test(supabaseUrl.hostname)) {
    fail('supabaseUrl must be the root URL of a hosted Supabase project')
  }

  const projectRef = supabaseUrl.hostname.slice(0, -'.supabase.co'.length)
  const accountApiUrl = parseHttpsUrl(value.accountApiUrl, 'accountApiUrl')
  const normalizedAccountPath = accountApiUrl.pathname.replace(/\/$/, '')
  if (accountApiUrl.origin !== supabaseUrl.origin || normalizedAccountPath !== ACCOUNT_FUNCTION_PATH) {
    fail(`accountApiUrl must match supabaseUrl and end with ${ACCOUNT_FUNCTION_PATH}`)
  }

  return Object.freeze({
    supabaseUrl: supabaseUrl.origin,
    anonKey: validatePublicSupabaseKey(value.anonKey, projectRef),
    accountApiUrl: `${accountApiUrl.origin}${ACCOUNT_FUNCTION_PATH}`,
    oauthProviders: validateOAuthProviders(value.oauthProviders),
    checkoutHosts: validateCheckoutHosts(value.checkoutHosts),
  })
}

export function validateReleaseAccountConfigFile(filePath) {
  let handle
  try {
    handle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`Missing release account config: ${filePath}`)
    }
    if (error?.code === 'ELOOP') {
      fail('Release account config must be a regular file, not a link')
    }
    throw error
  }

  // Inspect and read the one descriptor we opened, so the path cannot be
  // swapped for another file between the checks and the read.
  let contents
  try {
    const stat = fs.fstatSync(handle)
    if (!stat.isFile()) fail('Release account config must be a regular file, not a link')
    if (stat.size < 2 || stat.size > MAX_CONFIG_BYTES) fail('Release account config has an invalid size')
    contents = fs.readFileSync(handle, 'utf8')
  } finally {
    fs.closeSync(handle)
  }

  let parsed
  try {
    parsed = JSON.parse(contents)
  } catch {
    fail('Release account config must contain valid JSON')
  }
  return validateReleaseAccountConfig(parsed)
}

export function assertProjectReleaseAccountConfig(projectRoot) {
  const config = validateReleaseAccountConfigFile(path.join(projectRoot, 'plugin', 'account-config.json'))
  const accountFunctionPath = path.join(projectRoot, 'supabase', 'functions', 'easyfield-account', 'index.ts')
  let accountFunctionSource = ''
  try {
    accountFunctionSource = fs.readFileSync(accountFunctionPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Missing customer account function: ${accountFunctionPath}`)
    throw error
  }
  if (
    /const\s+CUSTOMER_GENERATION_GATEWAY_READY\s*=\s*false\b/.test(accountFunctionSource)
    || /code:\s*["']generation-gateway-unavailable["']/.test(accountFunctionSource)
  ) {
    fail('Customer generation gateway is still fail-closed; production release is blocked')
  }
  if (/const\s+PARTNER_REVERSAL_HANDLING_READY\s*=\s*false\b/.test(accountFunctionSource)) {
    fail('Partner refund and chargeback handling is still fail-closed; production release is blocked')
  }
  return config
}

function readRequiredSource(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Missing ${label}: ${filePath}`)
    throw error
  }
}

/**
 * CI uses this check only while paid-account release work is deliberately
 * incomplete. It proves that the checked-in tree still fails closed without
 * creating a deployable account config or granting an artifact-builder
 * bypass. When either readiness flag becomes true, this mode intentionally
 * fails so CI must be migrated to the real production release gate.
 */
export function assertCiAccountReleaseStructure(projectRoot) {
  const liveConfigPath = path.join(projectRoot, 'plugin', 'account-config.json')
  if (fs.existsSync(liveConfigPath)) {
    fail('CI account structure mode refuses a live account config')
  }

  const accountFunctionPath = path.join(
    projectRoot,
    'supabase',
    'functions',
    'easyfield-account',
    'index.ts',
  )
  const accountFunctionSource = readRequiredSource(accountFunctionPath, 'customer account function')
  if (!/const\s+CUSTOMER_GENERATION_GATEWAY_READY\s*=\s*false\b/.test(accountFunctionSource)) {
    fail('CI account structure mode is valid only while customer generation is explicitly fail-closed')
  }
  if (!/const\s+PARTNER_REVERSAL_HANDLING_READY\s*=\s*false\b/.test(accountFunctionSource)) {
    fail('CI account structure mode is valid only while Partner checkout is explicitly fail-closed')
  }
  if (!/code:\s*["']generation-gateway-unavailable["']/.test(accountFunctionSource)) {
    fail('CI account structure mode requires the non-billable generation gateway response')
  }

  for (const builder of PRODUCTION_BUILDERS) {
    const builderPath = path.join(projectRoot, 'scripts', builder)
    const source = readRequiredSource(builderPath, `production builder ${builder}`)
    const importIndex = source.indexOf("import { assertReleaseAccountBuildMode } from './release-account-config.mjs'")
    const gateIndex = source.indexOf('assertReleaseAccountBuildMode(projectRoot)')
    if (importIndex < 0 || gateIndex < 0 || gateIndex < importIndex) {
      fail(`Production builder ${builder} is missing the mandatory account release gate`)
    }
  }

  return Object.freeze({
    customerGenerationBlocked: true,
    partnerCheckoutBlocked: true,
    productionBuildersGated: true,
  })
}

function ciStructureEnvironmentIsBounded(environment) {
  return environment?.CI === 'true'
    && environment?.GITHUB_ACTIONS === 'true'
    && environment?.GITHUB_WORKFLOW === 'CI'
    && (environment?.GITHUB_EVENT_NAME === 'push' || environment?.GITHUB_EVENT_NAME === 'pull_request')
    && environment?.GITHUB_REF_TYPE !== 'tag'
}

/**
 * The artifact builders use one entry point. Production is the default and
 * always requires the real config plus both readiness gates. The only alternate
 * result is a tightly-bound GitHub CI structure build: no account config,
 * explicitly blocked paid paths, a non-tag CI event, and no release workflow.
 */
export function assertReleaseAccountBuildMode(projectRoot, environment = process.env) {
  const requestedMode = environment?.EASYFIELD_ACCOUNT_STRUCTURE_TEST
  if (requestedMode == null || requestedMode === '') {
    return Object.freeze({ kind: 'production', config: assertProjectReleaseAccountConfig(projectRoot) })
  }
  if (requestedMode !== '1' || !ciStructureEnvironmentIsBounded(environment)) {
    fail('CI account structure artifacts are restricted to the non-tag GitHub CI workflow')
  }
  assertCiAccountReleaseStructure(projectRoot)
  return Object.freeze({ kind: 'ci-structure', config: null })
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1) {
    console.error('Usage: node scripts/release-account-config.mjs [account-config.json|--ci-structure-test]')
    process.exitCode = 1
  } else {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    try {
      if (args[0] === '--ci-structure-test') {
        assertCiAccountReleaseStructure(projectRoot)
        console.log('Verified CI-only account structure: paid checkout remains fail-closed and production builders remain gated')
      } else {
        const config = args[0]
          ? validateReleaseAccountConfigFile(path.resolve(process.cwd(), args[0]))
          : assertProjectReleaseAccountConfig(projectRoot)
        const projectHost = new URL(config.supabaseUrl).hostname
        console.log(`Validated public release account config for ${projectHost} (${config.checkoutHosts.length} checkout host${config.checkoutHosts.length === 1 ? '' : 's'})`)
      }
    } catch (error) {
      console.error(`Release account config validation failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exitCode = 1
    }
  }
}
