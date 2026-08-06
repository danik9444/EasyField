// Fails when plugin/update-manifest.json stops describing the plugin sources
// committed beside it. Only git-tracked files are compared, and only against
// their committed blobs, so the result does not depend on the build machine,
// the installed dependencies, or artefacts a release step generates later
// (plugin/ui, account-config.json). Those are covered by the reproducibility
// checks that run after assembly; this guards the copy humans commit.
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ref = process.argv[2] || 'HEAD'
const git = (args, encoding = 'utf8') => execFileSync('git', args, { encoding, maxBuffer: 256 * 1024 * 1024 })

// Mirrors the exclusions in scripts/plugin-update-manifest.mjs. A file left out
// of the manifest on purpose must not be reported as missing from it.
const excluded = (relativePath) => (
  relativePath === 'update-manifest.json'
  || relativePath === '.easyfield-update-source.json'
  || relativePath === 'WorkflowIntegration.node'
  || relativePath === '.DS_Store'
  || relativePath.endsWith('/.DS_Store')
  || relativePath === 'python/.venv'
  || relativePath.startsWith('python/.venv/')
)

let manifest
try {
  manifest = JSON.parse(git(['show', `${ref}:plugin/update-manifest.json`]))
} catch {
  console.error(`Cannot read plugin/update-manifest.json at ${ref}.`)
  process.exit(1)
}

const recorded = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]))
const tracked = git(['ls-tree', '-r', '--name-only', `${ref}`, 'plugin/'])
  .split('\n')
  .filter(Boolean)
  .map((path) => path.slice('plugin/'.length))
  .filter((path) => !excluded(path))

const stale = []
const missing = []
for (const path of tracked) {
  const expected = recorded.get(path)
  if (expected === undefined) {
    missing.push(path)
    continue
  }
  const actual = crypto.createHash('sha256').update(git(['show', `${ref}:plugin/${path}`], null)).digest('hex')
  if (actual !== expected) stale.push({ path, expected, actual })
}

if (!stale.length && !missing.length) {
  console.log(`plugin/update-manifest.json describes all ${tracked.length} committed plugin sources at ${ref}.`)
  process.exit(0)
}

const annotate = process.env.GITHUB_ACTIONS === 'true' ? '::error file=plugin/update-manifest.json::' : ''
for (const entry of stale) {
  console.error(`${annotate}${entry.path} is committed with checksum ${entry.actual.slice(0, 12)} but the manifest records ${entry.expected.slice(0, 12)}.`)
}
for (const path of missing) {
  console.error(`${annotate}${path} is committed under plugin/ but absent from the manifest.`)
}
console.error("Run 'npm run plugin:assemble' and commit the regenerated plugin/update-manifest.json.")
process.exit(1)
