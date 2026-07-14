import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  REQUIRED_FILES,
  canonicalReleasePayload,
  candidateIsNewer,
  computeBuildId,
  createPluginUpdater,
  readVerifiedRegularFile,
  stageVerifiedRelease,
  validateManifest,
  validateRemoteRelease,
} = require('../plugin/plugin-updater.cjs')

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function createRelease(directory, {
  version = '1.1.0',
  createdAt,
  salt,
  minMacOSVersion = '0.0.0',
  minResolveVersion = '20.0.0',
}) {
  fs.mkdirSync(directory, { recursive: true })
  const files = []
  for (const relativePath of REQUIRED_FILES) {
    const bytes = Buffer.from(`${relativePath}:${salt}`)
    const filePath = path.join(directory, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, bytes)
    files.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) })
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const manifest = {
    schemaVersion: 1,
    pluginId: 'com.easyfield.panel',
    platform: 'darwin',
    architectures: ['arm64', 'x64'],
    minMacOSVersion,
    minResolveVersion,
    version,
    createdAt,
    buildId: '',
    files,
  }
  manifest.buildId = computeBuildId(manifest)
  fs.writeFileSync(path.join(directory, 'update-manifest.json'), JSON.stringify(manifest))
  return manifest
}

function writeSource(installed, source) {
  fs.writeFileSync(path.join(installed, '.easyfield-update-source.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'local-workspace',
    pluginRoot: source,
  }))
}

function createRemoteEnvelope(manifest, { repository = 'easyfield/releases', releaseNotes = 'Security and stability update.' } = {}) {
  manifest = validateManifest(manifest)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const descriptor = {
    schemaVersion: 2,
    kind: 'github-release',
    feedUrl: `https://github.com/${repository}/releases/latest/download/easyfield-update.json`,
    publicKey: publicKeyBase64,
  }
  const name = `EasyField-${manifest.version}-plugin.tar.gz`
  const payload = {
    pluginId: 'com.easyfield.panel',
    channel: 'stable',
    version: manifest.version,
    buildId: manifest.buildId,
    createdAt: manifest.createdAt,
    manifest,
    archive: {
      name,
      url: `https://github.com/${repository}/releases/download/v${manifest.version}/${name}`,
      size: 1234,
      sha256: 'b'.repeat(64),
    },
    releaseNotes,
  }
  const envelope = {
    schemaVersion: 1,
    kind: 'easyfield-release',
    payload,
    signature: crypto.sign(null, Buffer.from(canonicalReleasePayload(payload)), privateKey).toString('base64'),
  }
  return { descriptor, envelope, release: validateRemoteRelease(envelope, descriptor) }
}

function writeRemoteSource(installed, descriptor) {
  fs.writeFileSync(path.join(installed, '.easyfield-update-source.json'), JSON.stringify(descriptor))
}

test('regular-file reader rejects symlinks and non-files while preserving verified bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-file-read-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const regular = path.join(root, 'regular.json')
  const linked = path.join(root, 'linked.json')
  const bytes = Buffer.from('{"ok":true}')
  fs.writeFileSync(regular, bytes)
  fs.symlinkSync(regular, linked)

  assert.deepEqual(readVerifiedRegularFile(regular, {
    expectedBytes: bytes.length,
    expectedSha256: sha256(bytes),
    errorMessage: 'Rejected release input',
  }), bytes)
  assert.throws(() => readVerifiedRegularFile(linked, { errorMessage: 'Rejected release input' }), /Rejected release input/)
  assert.throws(() => readVerifiedRegularFile(root, { errorMessage: 'Rejected release input' }), /Rejected release input/)
})

test('successful privileged swaps purge the obsolete recovery bundle', () => {
  const updaterSource = fs.readFileSync(new URL('../plugin/plugin-updater.cjs', import.meta.url), 'utf8')
  const successBlock = updaterSource.match(/if \/bin\/mv "\$NEXT" "\$DEST"; then([\s\S]*?)\nfi/)

  assert.ok(successBlock, 'the atomic swap success block must remain explicit')
  assert.match(successBlock[1], /\/bin\/rm -rf "\$BACKUP"/)
  assert.ok(
    successBlock[1].indexOf('/bin/rm -rf "$BACKUP"') < successBlock[1].indexOf('exit 0'),
    'the old bundle must be removed before the privileged installer reports success',
  )
})

test('detects and atomically installs a newer verified build of the same version', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  createRelease(installed, { createdAt: '2026-07-11T01:00:00.000Z', salt: 'old' })
  const candidate = createRelease(source, { createdAt: '2026-07-11T02:00:00.000Z', salt: 'new' })
  writeSource(installed, source)

  const updater = createPluginUpdater({
    installedPluginDir: installed,
    destinationDir: destination,
    privilegedInstall: async (stagedPlugin) => fs.cpSync(stagedPlugin, destination, { recursive: true }),
  })
  const status = await updater.check()
  assert.equal(status.supported, true)
  assert.equal(status.available, true)
  assert.equal(status.currentVersion, '1.1.0')
  assert.equal(status.candidateBuildId, candidate.buildId)

  const result = await updater.install()
  assert.deepEqual(result, {
    installed: true,
    restartRequired: true,
    version: '1.1.0',
    buildId: candidate.buildId,
  })
  assert.equal(fs.readFileSync(path.join(destination, 'main.cjs'), 'utf8'), 'main.cjs:new')
  assert.equal(fs.existsSync(path.join(destination, 'python', '.venv')), false)
})

test('refuses an update when a source file no longer matches its manifest', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-tamper-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  createRelease(installed, { createdAt: '2026-07-11T01:00:00.000Z', salt: 'old' })
  createRelease(source, { createdAt: '2026-07-11T02:00:00.000Z', salt: 'new' })
  writeSource(installed, source)
  fs.appendFileSync(path.join(source, 'main.cjs'), ':tampered')

  const updater = createPluginUpdater({
    installedPluginDir: installed,
    destinationDir: destination,
    privilegedInstall: async () => assert.fail('tampered files must never reach the installer'),
  })
  await assert.rejects(updater.install(), /changed|checksum/i)
  assert.equal(fs.existsSync(destination), false)
})

test('rejects a corrupted deployed tree after the privileged boundary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-deploy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  createRelease(installed, { createdAt: '2026-07-11T01:00:00.000Z', salt: 'old' })
  createRelease(source, { createdAt: '2026-07-11T02:00:00.000Z', salt: 'new' })
  writeSource(installed, source)
  const updater = createPluginUpdater({
    installedPluginDir: installed,
    destinationDir: destination,
    privilegedInstall: async (stagedPlugin) => {
      fs.cpSync(stagedPlugin, destination, { recursive: true })
      fs.appendFileSync(path.join(destination, 'main.cjs'), ':corrupt-after-copy')
    },
  })
  await assert.rejects(updater.install(), /deployed update file failed/i)
})

test('coalesces concurrent install requests into one privileged operation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-concurrent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  createRelease(installed, { createdAt: '2026-07-11T01:00:00.000Z', salt: 'old' })
  createRelease(source, { createdAt: '2026-07-11T02:00:00.000Z', salt: 'new' })
  writeSource(installed, source)
  let operations = 0
  const updater = createPluginUpdater({
    installedPluginDir: installed,
    destinationDir: destination,
    privilegedInstall: async (stagedPlugin) => {
      operations += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      fs.cpSync(stagedPlugin, destination, { recursive: true })
    },
  })
  const [first, second] = await Promise.all([updater.install(), updater.install()])
  assert.equal(operations, 1)
  assert.deepEqual(first, second)
})

test('rejects traversal and non-canonical manifest paths', () => {
  const files = REQUIRED_FILES.map((relativePath) => ({ path: relativePath, size: 1, sha256: 'a'.repeat(64) }))
  files.push({ path: '../outside', size: 1, sha256: 'a'.repeat(64) })
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const manifest = {
    schemaVersion: 1,
    pluginId: 'com.easyfield.panel',
    platform: 'darwin',
    architectures: ['arm64', 'x64'],
    minResolveVersion: '20.0.0',
    version: '1.1.0',
    createdAt: '2026-07-11T02:00:00.000Z',
    buildId: 'a'.repeat(64),
    files,
  }
  assert.throws(() => validateManifest(manifest), /path/i)
})

test('does not offer a rebuild when its verified content is identical', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-same-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  createRelease(installed, { createdAt: '2026-07-11T01:00:00.000Z', salt: 'same' })
  createRelease(source, { createdAt: '2026-07-11T02:00:00.000Z', salt: 'same' })
  writeSource(installed, source)
  const updater = createPluginUpdater({ installedPluginDir: installed })
  const status = await updater.check()
  assert.equal(status.supported, true)
  assert.equal(status.available, false)
})

test('verifies an Ed25519-signed GitHub release and rejects metadata tampering', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-signature-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = createRelease(root, { version: '1.2.0', createdAt: '2026-07-14T02:00:00.000Z', salt: 'signed' })
  const { descriptor, envelope, release } = createRemoteEnvelope(manifest)
  assert.equal(release.manifest.buildId, manifest.buildId)
  assert.equal(release.releaseNotes, 'Security and stability update.')

  const tampered = structuredClone(envelope)
  tampered.payload.releaseNotes = 'An attacker changed these notes.'
  assert.throws(() => validateRemoteRelease(tampered, descriptor), /signature/i)

  const wrongRepository = { ...descriptor, feedUrl: 'https://github.com/other/releases/releases/latest/download/easyfield-update.json' }
  assert.throws(() => validateRemoteRelease(envelope, wrongRepository), /archive URL/i)
})

test('checks and installs a signed GitHub candidate without accepting renderer URLs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-remote-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  createRelease(installed, { version: '1.1.0', createdAt: '2026-07-14T01:00:00.000Z', salt: 'old' })
  const candidate = createRelease(source, { version: '1.2.0', createdAt: '2026-07-14T02:00:00.000Z', salt: 'new' })
  const { descriptor, release } = createRemoteEnvelope(candidate)
  writeRemoteSource(installed, descriptor)
  let loads = 0
  const updater = createPluginUpdater({
    installedPluginDir: installed,
    destinationDir: destination,
    remoteReleaseLoader: async (actualDescriptor) => {
      loads += 1
      assert.deepEqual(actualDescriptor, descriptor)
      return release
    },
    remoteReleaseStager: (actualDescriptor, actualRelease) => {
      assert.equal(actualRelease.manifest.buildId, candidate.buildId)
      return stageVerifiedRelease(source, candidate, actualDescriptor)
    },
    privilegedInstall: async (stagedPlugin) => fs.cpSync(stagedPlugin, destination, { recursive: true }),
  })
  const status = await updater.check()
  assert.equal(status.supported, true)
  assert.equal(status.available, true)
  assert.equal(status.sourceKind, 'github-release')
  assert.equal(status.releaseNotes, 'Security and stability update.')
  const result = await updater.install()
  assert.equal(result.version, '1.2.0')
  // One explicit check, one guarded check inside install, and one fresh fetch
  // immediately before staging prevent a changed release from being installed.
  assert.equal(loads, 3)
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, '.easyfield-update-source.json'), 'utf8')).feedUrl, descriptor.feedUrl)
})

test('public GitHub releases require a version bump and never offer same-version rebuilds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-immutable-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  createRelease(installed, { version: '1.2.0', createdAt: '2026-07-14T01:00:00.000Z', salt: 'old' })
  const candidate = createRelease(source, { version: '1.2.0', createdAt: '2026-07-14T02:00:00.000Z', salt: 'rebuilt' })
  const { descriptor, release } = createRemoteEnvelope(candidate)
  writeRemoteSource(installed, descriptor)
  const updater = createPluginUpdater({
    installedPluginDir: installed,
    remoteReleaseLoader: async () => release,
  })
  const status = await updater.check()
  assert.equal(status.supported, true)
  assert.equal(status.available, false)
})

test('blocks incompatible macOS and Resolve versions before staging an update', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-updater-compat-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = path.join(root, 'installed')
  const source = path.join(root, 'source')
  createRelease(installed, { version: '1.1.0', createdAt: '2026-07-14T01:00:00.000Z', salt: 'old' })
  createRelease(source, {
    version: '1.2.0',
    createdAt: '2026-07-14T02:00:00.000Z',
    salt: 'new',
    minMacOSVersion: '15.0.0',
    minResolveVersion: '21.0.2',
  })
  writeSource(installed, source)

  const oldMac = await createPluginUpdater({
    installedPluginDir: installed,
    currentMacOSVersion: '14.7.0',
    resolveVersionProvider: async () => '21.0.2',
  }).check()
  assert.equal(oldMac.supported, false)
  assert.match(oldMac.reason, /macOS 15\.0\.0/)

  const oldResolve = await createPluginUpdater({
    installedPluginDir: installed,
    currentMacOSVersion: '15.0.0',
    resolveVersionProvider: async () => '20.6.1',
  }).check()
  assert.equal(oldResolve.supported, false)
  assert.match(oldResolve.reason, /Resolve 21\.0\.2/)

  const compatible = await createPluginUpdater({
    installedPluginDir: installed,
    currentMacOSVersion: '15.0.0',
    resolveVersionProvider: async () => '21.1.0',
  }).check()
  assert.equal(compatible.supported, true)
  assert.equal(compatible.available, true)
})

test('orders numeric SemVer prerelease identifiers numerically', () => {
  const installed = { version: '1.2.0-beta.2', buildId: 'a', createdAt: '2026-07-14T01:00:00.000Z' }
  const candidate = { version: '1.2.0-beta.10', buildId: 'b', createdAt: '2026-07-14T02:00:00.000Z' }
  assert.equal(candidateIsNewer(installed, candidate), true)
})
