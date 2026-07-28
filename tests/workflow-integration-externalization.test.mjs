import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  OFFICIAL_WORKFLOW_INTEGRATION_MODULE,
  loadWorkflowIntegration,
} = require('../plugin/workflow-integration.cjs')
const {
  REQUIRED_FILES,
  computeBuildId,
  validateManifest,
} = require('../plugin/plugin-updater.cjs')

test('loads Resolve’s official native module without attempting a bundled copy', () => {
  const expected = { source: 'resolve' }
  const attempts = []
  const actual = loadWorkflowIntegration({
    logger: { error: () => assert.fail('a successful official load must not log an error') },
    load: (modulePath) => {
      attempts.push(modulePath)
      return expected
    },
  })

  assert.equal(actual, expected)
  assert.deepEqual(attempts, [OFFICIAL_WORKFLOW_INTEGRATION_MODULE])
})

test('fails closed when Resolve’s official native module cannot be loaded', () => {
  const attempts = []
  const errors = []
  const actual = loadWorkflowIntegration({
    logger: { error: (...args) => errors.push(args) },
    load: (modulePath) => {
      attempts.push(modulePath)
      throw Object.assign(new Error('wrong ABI'), { code: 'ERR_DLOPEN_FAILED' })
    },
  })

  assert.equal(actual, null)
  assert.deepEqual(attempts, [OFFICIAL_WORKFLOW_INTEGRATION_MODULE])
  assert.equal(errors.length, 2)
  assert.match(errors[0][0], /Resolve SDK/)
  assert.match(errors[1][0], /unavailable/)
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
  assert.match(preinstall, /pgrep -x Resolve/)
  assert.match(preinstall, /pgrep -f "\^\$\{RESOLVE_APP\}\/Contents\/MacOS\/Resolve/)
  assert.match(preinstall, /if resolve_is_running; then/)

  const localInstaller = fs.readFileSync(path.join(projectRoot, 'scripts/plugin-install.sh'), 'utf8')
  assert.match(localInstaller, /packaging\/pkg\/scripts\/preinstall/)
  assert.doesNotMatch(localInstaller, /plugin\/WorkflowIntegration\.node missing/)
})

test('PKG installation keeps rollback transactional and purges obsolete code after verification', () => {
  const postinstall = fs.readFileSync(path.join(projectRoot, 'packaging/pkg/scripts/postinstall'), 'utf8')
  const finalVerification = postinstall.indexOf('if ! verify_tree "$DEST"; then')
  const successMarker = postinstall.indexOf('INSTALL_COMPLETE=1', finalVerification)
  const purgeBackup = postinstall.indexOf('/bin/rm -rf "$BACKUP"', successMarker)
  assert.ok(finalVerification >= 0)
  assert.ok(successMarker > finalVerification)
  assert.ok(purgeBackup > successMarker)
  assert.match(postinstall, /if \[ "\$INSTALL_COMPLETE" -ne 1 \].*"\$SWAP_STARTED" -eq 1/s)
  assert.match(postinstall, /if \[ "\$HAD_CURRENT" -eq 1 \] && \[ -e "\$BACKUP" \]; then \/bin\/mv "\$BACKUP" "\$DEST"/)
})
