import { execFileSync } from 'node:child_process'
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

// A local publish installs straight into the channel Resolve consumes, without
// passing through a commit, a tag or CI. Record where the bytes came from so an
// installed build can always be traced back to source, and say so out loud when
// that source is not recoverable from the remote.
function readProvenance() {
  const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const commit = git('rev-parse', 'HEAD')
    const dirty = git('status', '--porcelain') !== ''
    let pushed = false
    try {
      pushed = git('branch', '--remotes', '--contains', commit) !== ''
    } catch {
      pushed = false
    }
    return { commit, dirty, pushed }
  } catch {
    return { commit: null, dirty: null, pushed: false }
  }
}

const provenance = readProvenance()
const unrecoverable = provenance.commit === null || provenance.dirty !== false || !provenance.pushed
if (unrecoverable) {
  const reasons = []
  if (provenance.commit === null) reasons.push('the project is not a git checkout')
  else {
    if (provenance.dirty) reasons.push('the working tree has uncommitted changes')
    if (!provenance.pushed) reasons.push(`commit ${provenance.commit.slice(0, 12)} is not on any remote branch`)
  }
  process.emitWarning(
    `This build cannot be reproduced from pushed history: ${reasons.join('; ')}. `
    + 'Commit and push before relying on it, or the only copy of this source is on this machine.',
    'EasyFieldProvenanceWarning',
  )
}

const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'update-manifest.json'), 'utf8')))
const descriptor = Object.freeze({ schemaVersion: 1, kind: 'local-release', pluginRoot: destination, provenance: Object.freeze(provenance) })
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

const origin = provenance.commit === null
  ? 'untracked source'
  : `${provenance.commit.slice(0, 12)}${provenance.dirty ? '-dirty' : ''}${provenance.pushed ? '' : ' (unpushed)'}`
console.log(`Published local update ${manifest.version} · ${manifest.buildId.slice(0, 12)} · ${origin} · Application Support`)
