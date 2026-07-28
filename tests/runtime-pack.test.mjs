import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { resolveRuntimePack, verifyRuntimeExecutable } = require('../plugin/runtime-pack.cjs')

const componentExecutables = {
  ffmpeg: ['ffmpeg', 'ffprobe'],
  'librosa-python': ['python3'],
  whispercpp: ['whisper-cli'],
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function writeCatalog(root, releaseReady) {
  const architecture = process.arch === 'x64' ? 'x64' : 'arm64'
  const components = Object.entries(componentExecutables).map(([id, requiredExecutables]) => {
    const targets = { arm64: null, x64: null }
    if (releaseReady) {
      const runtimeRoot = `runtime-packs/${id}/${architecture}`
      const files = []
      const executables = {}
      for (const name of [...requiredExecutables].sort((left, right) => left.localeCompare(right, 'en'))) {
        const relativePath = `bin/${name}`
        const bytes = Buffer.from(`${id}:${architecture}:${name}\n`)
        const filePath = path.join(root, runtimeRoot, relativePath)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, bytes, { mode: 0o755 })
        fs.chmodSync(filePath, 0o755)
        files.push({ path: relativePath, size: bytes.length, sha256: digest(bytes), kind: 'mach-o', executable: true })
        executables[name] = relativePath
      }
      targets[architecture] = { version: '1.0.0-test', root: runtimeRoot, executables, files }
    }
    return { id, requiredExecutables, targets }
  })
  const catalog = {
    schemaVersion: 1,
    platform: 'darwin',
    architectures: ['arm64', 'x64'],
    releaseReady,
    licenseReview: releaseReady
      ? { status: 'approved', evidence: 'docs/release-approvals/runtime-packs.md' }
      : { status: 'pending', evidence: null },
    components,
  }
  fs.writeFileSync(path.join(root, 'runtime-packs.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  return { architecture, catalog }
}

test('incomplete source catalog permits only the existing development fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-source-'))
  try {
    writeCatalog(root, false)
    const result = resolveRuntimePack({ pluginRoot: root, architecture: process.arch })
    assert.equal(result.strict, false)
    assert.equal(result.available, false)
    assert.deepEqual(result.executables, {})
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release-ready catalog resolves only checksum-pinned packaged executables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-resolve-'))
  try {
    const { architecture, catalog } = writeCatalog(root, true)
    const result = resolveRuntimePack({ pluginRoot: root, architecture })
    assert.equal(result.strict, true)
    assert.equal(result.available, true)
    assert.deepEqual(Object.keys(result.executables).sort(), ['ffmpeg', 'ffprobe', 'python3', 'whisper-cli'])
    for (const executable of Object.values(result.executables)) {
      assert.ok(executable.startsWith(root + path.sep))
    }

    const ffmpeg = path.join(root, catalog.components[0].targets[architecture].root, 'bin', 'ffmpeg')
    fs.appendFileSync(ffmpeg, 'tampered')
    const rejected = resolveRuntimePack({ pluginRoot: root, architecture })
    assert.equal(rejected.strict, true)
    assert.equal(rejected.available, false)
    assert.deepEqual(rejected.executables, {})
    assert.match(rejected.error, /integrity verification/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime executable authentication accepts only the exact checksum-pinned path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-auth-'))
  try {
    const { architecture, catalog } = writeCatalog(root, true)
    const target = catalog.components.find((component) => component.id === 'librosa-python').targets[architecture]
    const python = path.join(root, target.root, target.executables.python3)
    assert.equal(verifyRuntimeExecutable({
      candidate: python,
      componentId: 'librosa-python',
      executableName: 'python3',
      pluginRoot: root,
      architecture,
    }), true)
    assert.equal(verifyRuntimeExecutable({
      candidate: '/usr/bin/python3',
      componentId: 'librosa-python',
      executableName: 'python3',
      pluginRoot: root,
      architecture,
    }), false)
    fs.appendFileSync(python, 'tampered')
    assert.equal(verifyRuntimeExecutable({
      candidate: python,
      componentId: 'librosa-python',
      executableName: 'python3',
      pluginRoot: root,
      architecture,
    }), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release-ready catalog never falls back after a packaged executable is replaced by a link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-link-'))
  try {
    const { architecture, catalog } = writeCatalog(root, true)
    const whisper = path.join(root, catalog.components[2].targets[architecture].root, 'bin', 'whisper-cli')
    fs.unlinkSync(whisper)
    fs.symlinkSync('/usr/bin/true', whisper)
    const result = resolveRuntimePack({ pluginRoot: root, architecture })
    assert.equal(result.strict, true)
    assert.equal(result.available, false)
    assert.deepEqual(result.executables, {})
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('missing or malformed catalog is strict because it cannot prove a development build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-runtime-invalid-'))
  try {
    const missing = resolveRuntimePack({ pluginRoot: root, architecture: process.arch })
    assert.equal(missing.strict, true)
    assert.equal(missing.available, false)
    fs.writeFileSync(path.join(root, 'runtime-packs.json'), '{}\n')
    const malformed = resolveRuntimePack({ pluginRoot: root, architecture: process.arch })
    assert.equal(malformed.strict, true)
    assert.equal(malformed.available, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
