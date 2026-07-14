import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  validateManifest,
  stageVerifiedRelease,
  runPrivilegedAtomicSwap,
} = require('../plugin/plugin-updater.cjs')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = path.join(projectRoot, 'plugin')
const updateRoot = path.join(os.homedir(), 'Library', 'Application Support', 'EasyField', 'Updates', 'com.easyfield.panel')
const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(updateRoot, 'update-manifest.json'), 'utf8')))
const descriptor = Object.freeze({
  schemaVersion: 1,
  kind: 'local-release',
  pluginRoot: updateRoot,
})
const runtimeRequirementHash = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(pluginRoot, 'python', 'requirements-beat.txt')))
  .digest('hex')

function probeRuntime(runtimeRoot) {
  const python = path.join(runtimeRoot, 'bin', 'python3')
  if (!fs.existsSync(python)) return false
  const probe = spawnSync(python, [path.join(pluginRoot, 'python', 'beat_detect.py'), '--probe'], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.status !== 0) return false
  try {
    return JSON.parse(probe.stdout.trim()).ok === true
  } catch {
    return false
  }
}

function installLocalBeatRuntime() {
  const source = path.join(pluginRoot, 'python', '.venv')
  if (!fs.existsSync(source)) return
  const runtimeRoot = path.join(os.homedir(), 'Library', 'Application Support', 'EasyField', 'runtime')
  const destination = path.join(runtimeRoot, 'python')
  let marker = null
  try { marker = JSON.parse(fs.readFileSync(path.join(destination, '.easyfield-runtime.json'), 'utf8')) } catch { /* refresh legacy runtime */ }
  if (marker?.requirementsSha256 === runtimeRequirementHash && marker?.architecture === process.arch && probeRuntime(destination)) {
    console.log('==> Local librosa runtime is ready')
    return
  }

  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
  const next = `${destination}.next-${process.pid}`
  const backup = `${destination}.backup-${process.pid}`
  fs.rmSync(next, { recursive: true, force: true })
  fs.rmSync(backup, { recursive: true, force: true })
  console.log('==> Installing the managed local librosa runtime')
  fs.cpSync(source, next, { recursive: true, dereference: false, preserveTimestamps: true })
  if (!probeRuntime(next)) {
    fs.rmSync(next, { recursive: true, force: true })
    console.warn(`==> Local librosa runtime is unavailable for ${process.arch}; the plugin update will continue.`)
    return
  }
  fs.writeFileSync(path.join(next, '.easyfield-runtime.json'), `${JSON.stringify({ schemaVersion: 1, architecture: process.arch, requirementsSha256: runtimeRequirementHash }, null, 2)}\n`, { mode: 0o600 })
  if (fs.existsSync(destination)) fs.renameSync(destination, backup)
  try {
    fs.renameSync(next, destination)
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    fs.rmSync(next, { recursive: true, force: true })
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination)
    throw error
  }
}

installLocalBeatRuntime()
const stage = await stageVerifiedRelease(updateRoot, manifest, descriptor)
try {
  console.log('==> Requesting macOS approval for an atomic Resolve integration update')
  await runPrivilegedAtomicSwap(stage.stagedPlugin, undefined, manifest, descriptor)
} finally {
  fs.rmSync(stage.temporaryRoot, { recursive: true, force: true })
}

console.log(`==> Installed EasyField ${manifest.version} (${manifest.buildId.slice(0, 12)})`)
