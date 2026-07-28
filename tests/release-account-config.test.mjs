import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertCiAccountReleaseStructure,
  assertProjectReleaseAccountConfig,
  assertReleaseAccountBuildMode,
  validateReleaseAccountConfig,
  validateReleaseAccountConfigFile,
} from '../scripts/release-account-config.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRef = 'abcdefghijklmnopqrst'
const publishableKey = 'sb_publishable_8WmYLtR3JPbS5qQeVnKzD4xHcA7uF2gN'

function validConfig(overrides = {}) {
  return {
    supabaseUrl: `https://${projectRef}.supabase.co`,
    anonKey: publishableKey,
    accountApiUrl: `https://${projectRef}.supabase.co/functions/v1/easyfield-account`,
    oauthProviders: ['google', 'apple'],
    checkoutHosts: ['app.lemonsqueezy.com'],
    ...overrides,
  }
}

function legacyAnonKey(payloadOverrides = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ role: 'anon', ref: projectRef, ...payloadOverrides }),
    'valid_public_signature_1234567890',
  ].join('.')
}

test('release account config accepts public Supabase publishable and legacy anon keys', () => {
  const publishable = validateReleaseAccountConfig(validConfig())
  assert.equal(publishable.supabaseUrl, `https://${projectRef}.supabase.co`)
  assert.equal(publishable.accountApiUrl, `https://${projectRef}.supabase.co/functions/v1/easyfield-account`)
  assert.deepEqual(publishable.oauthProviders, ['google', 'apple'])
  assert.deepEqual(publishable.checkoutHosts, ['app.lemonsqueezy.com'])

  const legacy = validateReleaseAccountConfig(validConfig({ anonKey: legacyAnonKey() }))
  assert.equal(legacy.anonKey, legacyAnonKey())
})

test('release account config rejects placeholders, secret keys, and non-anon JWTs', () => {
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({
      supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
      accountApiUrl: 'https://YOUR_PROJECT.supabase.co/functions/v1/easyfield-account',
    })),
    /placeholders|hosted Supabase project/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ anonKey: 'sb_secret_this_must_never_ship_123456789' })),
    /must never contain a Supabase secret key/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ anonKey: legacyAnonKey({ role: 'service_role' }) })),
    /public Supabase anon key/,
  )
})

test('release account config rejects unknown fields without exposing their values', () => {
  const secret = 'never-print-this-webhook-secret'
  let error
  try {
    validateReleaseAccountConfig({ ...validConfig(), webhookSecret: secret })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof Error)
  assert.match(error.message, /unsupported field: webhookSecret/)
  assert.doesNotMatch(error.message, new RegExp(secret))
})

test('release account config requires matching function origin and safe checkout hostnames', () => {
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({
      accountApiUrl: 'https://zyxwvutsrqponmlkjihg.supabase.co/functions/v1/easyfield-account',
    })),
    /must match supabaseUrl/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ checkoutHosts: [] })),
    /nonempty array/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ oauthProviders: ['google'] })),
    /both google and apple/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ oauthProviders: ['google', 'google'] })),
    /without duplicates/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ checkoutHosts: ['https://app.lemonsqueezy.com/checkout'] })),
    /only a DNS hostname/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({ checkoutHosts: ['localhost'] })),
    /public lowercase DNS hostname/,
  )
  assert.throws(
    () => validateReleaseAccountConfig(validConfig({
      checkoutHosts: ['app.lemonsqueezy.com', 'app.lemonsqueezy.com'],
    })),
    /duplicate hostname/,
  )
})

test('release account config file must exist and be a regular bounded JSON file', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-account-config-'))
  try {
    const missing = path.join(temporaryRoot, 'missing.json')
    assert.throws(() => validateReleaseAccountConfigFile(missing), /Missing release account config/)

    const configPath = path.join(temporaryRoot, 'account-config.json')
    fs.writeFileSync(configPath, `${JSON.stringify(validConfig(), null, 2)}\n`)
    assert.equal(validateReleaseAccountConfigFile(configPath).anonKey, publishableKey)

    const linkPath = path.join(temporaryRoot, 'account-config-link.json')
    fs.symlinkSync(configPath, linkPath)
    assert.throws(() => validateReleaseAccountConfigFile(linkPath), /regular file, not a link/)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('validator CLI confirms only public metadata and never prints the key', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-account-cli-'))
  try {
    const configPath = path.join(temporaryRoot, 'account-config.json')
    fs.writeFileSync(configPath, `${JSON.stringify(validConfig(), null, 2)}\n`)
    const result = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'scripts/release-account-config.mjs'), configPath],
      { cwd: projectRoot, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(projectRef))
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(publishableKey))
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('both production artifact builders invoke the reusable account release gate', () => {
  for (const script of ['release-build-update.mjs', 'release-build-pkg.mjs']) {
    const source = fs.readFileSync(path.join(projectRoot, 'scripts', script), 'utf8')
    assert.match(source, /import \{ assertReleaseAccountBuildMode \} from '\.\/release-account-config\.mjs'/)
    assert.match(source, /assertReleaseAccountBuildMode\(projectRoot\)/)
  }

  const updateSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'release-build-update.mjs'), 'utf8')
  const packageSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'release-build-pkg.mjs'), 'utf8')
  assert.match(updateSource, /EasyField-\$\{manifest\.version\}-ci-structure-plugin\.tar\.gz/)
  assert.match(updateSource, /CI STRUCTURE TEST — NO ACCOUNT CONFIG — NOT FOR DISTRIBUTION/)
  assert.match(packageSource, /CI account structure packages must remain unsigned and non-distributable/)
  assert.match(packageSource, /-ci-structure-unsigned/)
})

test('CI structure mode proves an unconfigured fail-closed tree without granting a builder bypass', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-account-ci-structure-'))
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'plugin'), { recursive: true })
    fs.mkdirSync(path.join(temporaryRoot, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(temporaryRoot, 'supabase', 'functions', 'easyfield-account'), { recursive: true })
    fs.writeFileSync(
      path.join(temporaryRoot, 'supabase', 'functions', 'easyfield-account', 'index.ts'),
      [
        'const CUSTOMER_GENERATION_GATEWAY_READY = false',
        'const PARTNER_REVERSAL_HANDLING_READY = false',
        "const response = { code: 'generation-gateway-unavailable' }",
        '',
      ].join('\n'),
    )
    for (const builder of ['release-build-update.mjs', 'release-build-pkg.mjs']) {
      fs.writeFileSync(path.join(temporaryRoot, 'scripts', builder), [
        "import { assertReleaseAccountBuildMode } from './release-account-config.mjs'",
        "const projectRoot = '/safe/test/root'",
        'assertReleaseAccountBuildMode(projectRoot)',
        '',
      ].join('\n'))
    }

    assert.deepEqual(assertCiAccountReleaseStructure(temporaryRoot), {
      customerGenerationBlocked: true,
      partnerCheckoutBlocked: true,
      productionBuildersGated: true,
    })

    fs.writeFileSync(path.join(temporaryRoot, 'plugin', 'account-config.json'), '{}\n')
    assert.throws(
      () => assertCiAccountReleaseStructure(temporaryRoot),
      /refuses a live account config/,
    )
    fs.unlinkSync(path.join(temporaryRoot, 'plugin', 'account-config.json'))

    const accountFunctionPath = path.join(
      temporaryRoot,
      'supabase',
      'functions',
      'easyfield-account',
      'index.ts',
    )
    fs.writeFileSync(accountFunctionPath, [
      'const CUSTOMER_GENERATION_GATEWAY_READY = true',
      'const PARTNER_REVERSAL_HANDLING_READY = false',
      "const response = { code: 'generation-gateway-unavailable' }",
      '',
    ].join('\n'))
    assert.throws(
      () => assertCiAccountReleaseStructure(temporaryRoot),
      /valid only while customer generation is explicitly fail-closed/,
    )
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('artifact structure mode is accepted only by non-tag GitHub CI and can never carry a live config', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-account-builder-mode-'))
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'plugin'), { recursive: true })
    fs.mkdirSync(path.join(temporaryRoot, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(temporaryRoot, 'supabase', 'functions', 'easyfield-account'), { recursive: true })
    fs.writeFileSync(
      path.join(temporaryRoot, 'supabase', 'functions', 'easyfield-account', 'index.ts'),
      [
        'const CUSTOMER_GENERATION_GATEWAY_READY = false',
        'const PARTNER_REVERSAL_HANDLING_READY = false',
        "const response = { code: 'generation-gateway-unavailable' }",
        '',
      ].join('\n'),
    )
    for (const builder of ['release-build-update.mjs', 'release-build-pkg.mjs']) {
      fs.writeFileSync(path.join(temporaryRoot, 'scripts', builder), [
        "import { assertReleaseAccountBuildMode } from './release-account-config.mjs'",
        "const projectRoot = '/safe/test/root'",
        'assertReleaseAccountBuildMode(projectRoot)',
        '',
      ].join('\n'))
    }
    const ciEnvironment = {
      EASYFIELD_ACCOUNT_STRUCTURE_TEST: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF_TYPE: 'branch',
    }

    assert.equal(assertReleaseAccountBuildMode(temporaryRoot, ciEnvironment).kind, 'ci-structure')
    assert.throws(
      () => assertReleaseAccountBuildMode(temporaryRoot, {
        ...ciEnvironment,
        GITHUB_WORKFLOW: 'Release',
      }),
      /restricted to the non-tag GitHub CI workflow/,
    )
    assert.throws(
      () => assertReleaseAccountBuildMode(temporaryRoot, {
        ...ciEnvironment,
        GITHUB_REF_TYPE: 'tag',
      }),
      /restricted to the non-tag GitHub CI workflow/,
    )
    assert.throws(
      () => assertReleaseAccountBuildMode(temporaryRoot, {}),
      /Missing release account config/,
    )

    fs.writeFileSync(path.join(temporaryRoot, 'plugin', 'account-config.json'), '{}\n')
    assert.throws(
      () => assertReleaseAccountBuildMode(temporaryRoot, ciEnvironment),
      /refuses a live account config/,
    )
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('CI and release workflows keep structure testing separate from protected production config', () => {
  const ciSource = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const releaseSource = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8')

  assert.match(ciSource, /release:validate-account -- --ci-structure-test/)
  assert.match(ciSource, /EASYFIELD_ACCOUNT_STRUCTURE_TEST: ['"]1['"]/)
  assert.match(ciSource, /EasyField-\$\{VERSION\}-ci-structure-plugin\.tar\.gz/)
  assert.match(ciSource, /test ! -e "\$PAYLOAD\/account-config\.json"/)
  assert.doesNotMatch(ciSource, /EASYFIELD_ACCOUNT_CONFIG_BASE64/)
  assert.doesNotMatch(releaseSource, /--ci-structure-test/)
  assert.doesNotMatch(releaseSource, /EASYFIELD_ACCOUNT_STRUCTURE_TEST/)

  const materializeIndex = releaseSource.indexOf('Materialize protected public account configuration')
  const assembleIndex = releaseSource.indexOf('Test and assemble plugin')
  assert.ok(materializeIndex >= 0 && materializeIndex < assembleIndex)
  assert.match(releaseSource, /ACCOUNT_CONFIG_BASE64: \$\{\{ secrets\.EASYFIELD_ACCOUNT_CONFIG_BASE64 \}\}/)
  assert.match(releaseSource, /umask 077/)
  assert.match(releaseSource, /printf '%s' "\$ACCOUNT_CONFIG_BASE64" \| \/usr\/bin\/base64 -D/)
  assert.match(releaseSource, /mv "\$TEMPORARY_CONFIG" plugin\/account-config\.json/)
  assert.match(releaseSource, /npm run release:validate-account/)
  assert.match(releaseSource, /rm -f "\$GITHUB_WORKSPACE\/plugin\/account-config\.json"/)
  assert.doesNotMatch(releaseSource, /echo .*ACCOUNT_CONFIG_BASE64|set -x/)
})

test('project release gate blocks checkout builds while the customer generation gateway is fail-closed', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-release-gateway-'))
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'plugin'), { recursive: true })
    fs.mkdirSync(path.join(temporaryRoot, 'supabase', 'functions', 'easyfield-account'), { recursive: true })
    fs.writeFileSync(
      path.join(temporaryRoot, 'plugin', 'account-config.json'),
      `${JSON.stringify(validConfig(), null, 2)}\n`,
    )
    const accountFunctionPath = path.join(temporaryRoot, 'supabase', 'functions', 'easyfield-account', 'index.ts')
    fs.writeFileSync(accountFunctionPath, 'const CUSTOMER_GENERATION_GATEWAY_READY = false\n')
    assert.throws(
      () => assertProjectReleaseAccountConfig(temporaryRoot),
      /generation gateway is still fail-closed/,
    )

    fs.writeFileSync(accountFunctionPath, [
      'const CUSTOMER_GENERATION_GATEWAY_READY = true',
      'const PARTNER_REVERSAL_HANDLING_READY = false',
      '',
    ].join('\n'))
    assert.throws(
      () => assertProjectReleaseAccountConfig(temporaryRoot),
      /refund and chargeback handling is still fail-closed/,
    )

    fs.writeFileSync(accountFunctionPath, [
      'const CUSTOMER_GENERATION_GATEWAY_READY = true',
      'const PARTNER_REVERSAL_HANDLING_READY = true',
      '',
    ].join('\n'))
    assert.equal(assertProjectReleaseAccountConfig(temporaryRoot).anonKey, publishableKey)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('live account config is ignored while the public example remains eligible for tracking', () => {
  const ignored = spawnSync('git', ['check-ignore', '-q', 'plugin/account-config.json'], {
    cwd: projectRoot,
  })
  const example = spawnSync('git', ['check-ignore', '-q', 'plugin/account-config.example.json'], {
    cwd: projectRoot,
  })
  assert.equal(ignored.status, 0)
  assert.equal(example.status, 1)
})
