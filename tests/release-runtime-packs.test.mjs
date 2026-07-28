import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertCiRuntimeReleaseStructure,
  assertProjectReleaseRuntimePacks,
  assertReleaseRuntimeBuildMode,
  validateReleaseRuntimeCatalog,
  validateReleaseRuntimeCatalogFile,
} from '../scripts/release-runtime-packs.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const architectures = ['arm64', 'x64']
const componentExecutables = {
  ffmpeg: ['ffmpeg', 'ffprobe'],
  'librosa-python': ['python3'],
  whispercpp: ['whisper-cli'],
}

function placeholderCatalog() {
  return {
    schemaVersion: 1,
    platform: 'darwin',
    architectures,
    releaseReady: false,
    licenseReview: { status: 'pending', evidence: null },
    components: Object.entries(componentExecutables).map(([id, requiredExecutables]) => ({
      id,
      requiredExecutables,
      spdx: null,
      targets: { arm64: null, x64: null },
    })),
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function writeRuntimeFixture(root) {
  const pluginRoot = path.join(root, 'plugin')
  const evidence = 'docs/release-approvals/runtime-packs.md'
  fs.mkdirSync(path.join(root, 'docs', 'release-approvals'), { recursive: true })
  fs.writeFileSync(path.join(root, evidence), '# Approved test runtime payload\n')

  const components = []
  const manifestFiles = []
  for (const [id, requiredExecutables] of Object.entries(componentExecutables)) {
    const targets = {}
    for (const architecture of architectures) {
      const targetRoot = `runtime-packs/${id}/${architecture}`
      const files = []
      const executables = {}
      for (const name of [...requiredExecutables].sort((left, right) => left.localeCompare(right, 'en'))) {
        const relativePath = `bin/${name}`
        const bytes = Buffer.from(`${id}:${architecture}:${name}\n`)
        const absolutePath = path.join(pluginRoot, targetRoot, relativePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        fs.writeFileSync(absolutePath, bytes, { mode: 0o755 })
        fs.chmodSync(absolutePath, 0o755)
        files.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes), kind: 'mach-o', executable: true })
        executables[name] = relativePath
        manifestFiles.push({ path: `${targetRoot}/${relativePath}`, size: bytes.length, sha256: sha256(bytes) })
      }
      targets[architecture] = { version: '1.0.0-test', root: targetRoot, executables, files }
    }
    components.push({
      id,
      requiredExecutables,
      spdx: {
        name: `Synthetic ${id}`,
        supplier: 'Organization: Synthetic Runtime Test',
        licenseDeclared: 'MIT',
        downloadLocation: `https://downloads.synthetic-runtime.dev/${id}/1.0.0`,
        copyrightText: 'Copyright Synthetic Runtime Test',
      },
      targets,
    })
  }

  const catalog = {
    schemaVersion: 1,
    platform: 'darwin',
    architectures,
    releaseReady: true,
    licenseReview: { status: 'approved', evidence },
    components,
  }
  fs.mkdirSync(pluginRoot, { recursive: true })
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`)
  fs.writeFileSync(path.join(pluginRoot, 'runtime-packs.json'), catalogBytes)
  manifestFiles.push({ path: 'runtime-packs.json', size: catalogBytes.length, sha256: sha256(catalogBytes) })
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  fs.writeFileSync(path.join(pluginRoot, 'update-manifest.json'), `${JSON.stringify({ files: manifestFiles })}\n`)
  return { catalog, pluginRoot }
}

function writeCiFixture(root) {
  fs.mkdirSync(path.join(root, 'plugin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'plugin', 'runtime-packs.json'), `${JSON.stringify(placeholderCatalog(), null, 2)}\n`)
  for (const builder of ['release-build-update.mjs', 'release-build-pkg.mjs']) {
    fs.writeFileSync(path.join(root, 'scripts', builder), [
      "import { assertReleaseRuntimeBuildMode } from './release-runtime-packs.mjs'",
      "const projectRoot = '/safe/test/root'",
      'assertReleaseRuntimeBuildMode(projectRoot)',
      '',
    ].join('\n'))
  }
}

test('checked-in runtime catalog is an explicit complete absence, not a partial payload', () => {
  const catalog = validateReleaseRuntimeCatalogFile(path.join(projectRoot, 'plugin', 'runtime-packs.json'))
  assert.equal(catalog.releaseReady, false)
  assert.equal(catalog.licenseReview.status, 'pending')
  for (const component of catalog.components) {
    assert.equal(component.targets.arm64, null)
    assert.equal(component.targets.x64, null)
  }
})

test('runtime catalog rejects partial targets, unsafe roots, and unpinned hashes', () => {
  const partial = placeholderCatalog()
  partial.components[0].targets.arm64 = {
    version: 'latest',
    root: '../outside',
    executables: { ffmpeg: 'bin/ffmpeg', ffprobe: 'bin/ffprobe' },
    files: [{ path: 'bin/ffmpeg', size: 1, sha256: 'not-a-hash', kind: 'mach-o', executable: true }],
  }
  assert.throws(() => validateReleaseRuntimeCatalog(partial), /non-release-ready catalog cannot contain partially|pinned runtime version|root must be/)

  const extra = { ...placeholderCatalog(), downloadUrl: 'https://example.invalid/runtime.zip' }
  assert.throws(() => validateReleaseRuntimeCatalog(extra), /must contain exactly/)
})

test('release runtime payload requires exact checksums, exact tree, manifest sync, and approval evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-ready-'))
  try {
    const fixture = writeRuntimeFixture(root)
    const verified = assertProjectReleaseRuntimePacks(root, { inspectMachO: () => {} })
    assert.equal(verified.fileCount, 8)
    assert.ok(verified.byteCount > 0)

    const extra = path.join(fixture.pluginRoot, 'runtime-packs', 'unexpected.txt')
    fs.writeFileSync(extra, 'unexpected')
    assert.throws(
      () => assertProjectReleaseRuntimePacks(root, { inspectMachO: () => {} }),
      /outside the checksum-pinned target inventories/,
    )
    fs.unlinkSync(extra)

    const target = path.join(fixture.pluginRoot, fixture.catalog.components[0].targets.arm64.root, 'bin', 'ffmpeg')
    fs.appendFileSync(target, 'tampered')
    assert.throws(
      () => assertProjectReleaseRuntimePacks(root, { inspectMachO: () => {} }),
      /size\/type mismatch|checksum mismatch/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release runtime validation does not accept a development venv or PATH tools', () => {
  assert.throws(
    () => assertProjectReleaseRuntimePacks(projectRoot),
    /Portable FFmpeg\/ffprobe, librosa\/Python and whisper\.cpp packs are not release-ready/,
  )
})

test('CI runtime structure mode is tightly bounded and cannot become a production bypass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-ci-'))
  try {
    writeCiFixture(root)
    assert.deepEqual(assertCiRuntimeReleaseStructure(root), {
      portableRuntimesBlocked: true,
      productionBuildersGated: true,
    })
    const ciEnvironment = {
      EASYFIELD_RUNTIME_STRUCTURE_TEST: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF_TYPE: 'branch',
    }
    assert.equal(assertReleaseRuntimeBuildMode(root, ciEnvironment).kind, 'ci-structure')
    assert.throws(
      () => assertReleaseRuntimeBuildMode(root, { ...ciEnvironment, GITHUB_WORKFLOW: 'Release' }),
      /restricted to the non-tag GitHub CI workflow/,
    )
    assert.throws(
      () => assertReleaseRuntimeBuildMode(root, { ...ciEnvironment, GITHUB_REF_TYPE: 'tag' }),
      /restricted to the non-tag GitHub CI workflow/,
    )

    fs.mkdirSync(path.join(root, 'plugin', 'runtime-packs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plugin', 'runtime-packs', 'unverified'), 'bytes')
    assert.throws(() => assertCiRuntimeReleaseStructure(root), /refuses unverified runtime payload files/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('both production builders and workflows enforce the portable runtime gate', () => {
  for (const script of ['release-build-update.mjs', 'release-build-pkg.mjs']) {
    const source = fs.readFileSync(path.join(projectRoot, 'scripts', script), 'utf8')
    assert.match(source, /import \{ assertReleaseRuntimeBuildMode \} from '\.\/release-runtime-packs\.mjs'/)
    assert.match(source, /assertReleaseRuntimeBuildMode\(projectRoot\)/)
    assert.match(source, /runtimeBuildMode\.kind !== accountBuildMode\.kind/)
  }
  const ciSource = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const releaseSource = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(ciSource, /release:validate-runtimes -- --ci-structure-test/)
  assert.match(ciSource, /EASYFIELD_RUNTIME_STRUCTURE_TEST: ['"]1['"]/)
  assert.doesNotMatch(releaseSource, /EASYFIELD_RUNTIME_STRUCTURE_TEST|--ci-structure-test/)
  assert.match(releaseSource, /npm run release:validate-runtimes/)
})

test('runtime validator CLI exposes no path-based production bypass', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'release-runtime-packs.mjs'), '--ci-structure-test'],
    { cwd: projectRoot, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /portable packs remain absent and production builders remain gated/)

  const rejected = spawnSync(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'release-runtime-packs.mjs'), '/tmp/untrusted-runtime.json'],
    { cwd: projectRoot, encoding: 'utf8' },
  )
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Usage:/)
})
