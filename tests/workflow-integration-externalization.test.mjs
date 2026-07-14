import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  LEGACY_WORKFLOW_INTEGRATION_MODULE,
  OFFICIAL_WORKFLOW_INTEGRATION_MODULE,
  loadWorkflowIntegration,
} = require('../plugin/workflow-integration.cjs')
const {
  REQUIRED_FILES,
  computeBuildId,
  validateManifest,
} = require('../plugin/plugin-updater.cjs')

function missingModule(message = 'missing') {
  return Object.assign(new Error(message), { code: 'MODULE_NOT_FOUND' })
}

test('loads a legacy bundled native module before Resolve’s official copy', () => {
  const expected = { source: 'legacy' }
  const attempts = []
  const actual = loadWorkflowIntegration({
    logger: { error: () => assert.fail('a successful legacy load must not log an error') },
    load: (modulePath) => {
      attempts.push(modulePath)
      return expected
    },
  })

  assert.equal(actual, expected)
  assert.deepEqual(attempts, [LEGACY_WORKFLOW_INTEGRATION_MODULE])
})

test('falls back to the official Resolve SamplePlugin module', () => {
  const expected = { source: 'resolve' }
  const attempts = []
  const errors = []
  const actual = loadWorkflowIntegration({
    logger: { error: (...args) => errors.push(args) },
    load: (modulePath) => {
      attempts.push(modulePath)
      if (modulePath === LEGACY_WORKFLOW_INTEGRATION_MODULE) throw missingModule()
      return expected
    },
  })

  assert.equal(actual, expected)
  assert.deepEqual(attempts, [
    LEGACY_WORKFLOW_INTEGRATION_MODULE,
    OFFICIAL_WORKFLOW_INTEGRATION_MODULE,
  ])
  assert.deepEqual(errors, [])
})

test('continues to the official module when a legacy binary cannot be loaded', () => {
  const expected = { source: 'resolve' }
  const attempts = []
  const errors = []
  const actual = loadWorkflowIntegration({
    logger: { error: (...args) => errors.push(args) },
    load: (modulePath) => {
      attempts.push(modulePath)
      if (modulePath === LEGACY_WORKFLOW_INTEGRATION_MODULE) {
        throw Object.assign(new Error('wrong ABI'), { code: 'ERR_DLOPEN_FAILED' })
      }
      return expected
    },
  })

  assert.equal(actual, expected)
  assert.equal(errors.length, 1)
  assert.match(errors[0][0], /bundled legacy/)
  assert.deepEqual(attempts, [
    LEGACY_WORKFLOW_INTEGRATION_MODULE,
    OFFICIAL_WORKFLOW_INTEGRATION_MODULE,
  ])
})

test('release manifests reject WorkflowIntegration.node', () => {
  const files = [...REQUIRED_FILES, 'WorkflowIntegration.node']
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((relativePath) => ({ path: relativePath, size: 1, sha256: 'a'.repeat(64) }))
  const manifest = {
    schemaVersion: 1,
    pluginId: 'com.easyfield.panel',
    platform: 'darwin',
    architectures: ['arm64', 'x64'],
    minMacOSVersion: '15.0.0',
    minResolveVersion: '21.0.2',
    version: '1.2.0',
    createdAt: '2026-07-14T00:00:00.000Z',
    buildId: '',
    files,
  }
  manifest.buildId = computeBuildId(manifest)

  assert.throws(() => validateManifest(manifest), /file path/i)
})

test('source, manifest, archive and PKG boundaries exclude the Blackmagic binary', () => {
  assert.equal(fs.existsSync(path.join(projectRoot, 'plugin', 'WorkflowIntegration.node')), false)
  assert.equal(REQUIRED_FILES.includes('WorkflowIntegration.node'), false)

  for (const relativePath of [
    'scripts/plugin-update-manifest.mjs',
    'scripts/release-build-update.mjs',
    'scripts/release-verify-plugin.mjs',
  ]) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
    assert.match(source, /relativePath === 'WorkflowIntegration\.node'/, `${relativePath} must exclude the native module`)
  }

  const packageBuilder = fs.readFileSync(path.join(projectRoot, 'scripts/release-build-pkg.mjs'), 'utf8')
  assert.match(packageBuilder, /WorkflowIntegration\.node must remain external to the PKG payload/)
})

test('installer preflight pins and authenticates Resolve’s official native module', () => {
  const preinstall = fs.readFileSync(path.join(projectRoot, 'packaging/pkg/scripts/preinstall'), 'utf8')
  assert.match(preinstall, /Examples\/SamplePlugin\/WorkflowIntegration\.node/)
  assert.match(preinstall, /WORKFLOW_IDENTIFIER="com\.blackmagic-design\.WorkflowIntegration"/)
  assert.match(preinstall, /WORKFLOW_TEAM="9ZGFBWLSYP"/)
  assert.match(preinstall, /codesign --verify --strict/)
  assert.match(preinstall, /TeamIdentifier=/)
  assert.match(preinstall, /lipo -archs/)
  assert.match(preinstall, /"arm64 x86_64"\|"x86_64 arm64"/)

  const localInstaller = fs.readFileSync(path.join(projectRoot, 'scripts/plugin-install.sh'), 'utf8')
  assert.match(localInstaller, /packaging\/pkg\/scripts\/preinstall/)
  assert.doesNotMatch(localInstaller, /plugin\/WorkflowIntegration\.node missing/)
})
