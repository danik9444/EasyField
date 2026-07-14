import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  PLUGIN_ID,
  validateManifest,
  stageVerifiedRelease,
  verifyReleaseDirectory,
} = require('../plugin/plugin-updater.cjs')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = path.join(projectRoot, 'plugin')
const updatesRoot = path.join(os.homedir(), 'Library', 'Application Support', 'EasyField', 'Updates')
const destination = path.join(updatesRoot, PLUGIN_ID)
const next = `${destination}.next-${process.pid}`
const backup = `${destination}.backup-${process.pid}`
const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'update-manifest.json'), 'utf8')))
const descriptor = Object.freeze({ schemaVersion: 1, kind: 'local-release', pluginRoot: destination })
const stage = await stageVerifiedRelease(pluginRoot, manifest, descriptor)

fs.mkdirSync(updatesRoot, { recursive: true, mode: 0o700 })
fs.rmSync(next, { recursive: true, force: true })
fs.rmSync(backup, { recursive: true, force: true })
try {
  fs.cpSync(stage.stagedPlugin, next, { recursive: true })
  await verifyReleaseDirectory(next, manifest, descriptor)
  if (fs.existsSync(destination)) fs.renameSync(destination, backup)
  try {
    fs.renameSync(next, destination)
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination)
    throw error
  }
} finally {
  fs.rmSync(next, { recursive: true, force: true })
  fs.rmSync(stage.temporaryRoot, { recursive: true, force: true })
}

console.log(`Published local update ${manifest.version} · ${manifest.buildId.slice(0, 12)} · Application Support`)
