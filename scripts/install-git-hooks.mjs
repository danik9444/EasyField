// Install the repository's git hooks into this checkout.
//
// Hooks live under .git/, which git never tracks, so a fresh clone would other-
// wise lose them. scripts/hooks/ holds the tracked source of truth and this
// script copies it into the hooks directory. It runs from the npm "prepare"
// lifecycle, so `npm install` after a clone is enough.
//
// Deliberately never fails the install: a tarball checkout, a CI runner without
// a .git directory, or a hooks path the user manages themselves should all be
// no-ops rather than errors.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptsDir, '..')
const sourceDir = path.join(scriptsDir, 'hooks')

function skip(reason) {
  console.log(`install-git-hooks: skipped (${reason})`)
  process.exit(0)
}

if (!fs.existsSync(sourceDir)) skip('scripts/hooks is missing')

// --git-common-dir resolves to the main .git even from inside a worktree, so a
// hook installed here is shared by every worktree rather than one of them.
let hooksDir
try {
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!commonDir) skip('not a git checkout')
  hooksDir = path.resolve(projectRoot, commonDir, 'hooks')
} catch {
  skip('git is unavailable')
}

// Respect an explicitly configured hooks path instead of fighting it.
try {
  const configured = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (configured) hooksDir = path.resolve(projectRoot, configured)
} catch {
  // No core.hooksPath set — the default location above is correct.
}

fs.mkdirSync(hooksDir, { recursive: true })

const installed = []
for (const name of fs.readdirSync(sourceDir)) {
  const from = path.join(sourceDir, name)
  if (!fs.statSync(from).isFile()) continue
  const to = path.join(hooksDir, name)
  const next = fs.readFileSync(from)

  if (fs.existsSync(to) && fs.readFileSync(to).equals(next)) continue

  fs.writeFileSync(to, next, { mode: 0o755 })
  fs.chmodSync(to, 0o755)
  installed.push(name)
}

console.log(
  installed.length
    ? `install-git-hooks: installed ${installed.join(', ')} into ${hooksDir}`
    : 'install-git-hooks: hooks already current',
)
