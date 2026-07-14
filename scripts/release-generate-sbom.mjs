import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

function runNpm(commandArgs, cwd) {
  const result = spawnSync('npm', commandArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`npm ${commandArgs[0]} failed${output ? `:\n${output}` : ''}`)
  }
  return result.stdout
}

function atomicWrite(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, contents, { mode: 0o644 })
  fs.renameSync(temporary, filePath)
}

const outputPath = path.resolve(projectRoot, option('--out', 'release/output/easyfield.spdx.json'))
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const productionNames = Object.keys(packageJson.dependencies || {}).sort()
const developmentNames = Object.keys(packageJson.devDependencies || {}).sort()
if (!productionNames.length) throw new Error('package.json has no production dependencies to document')

// npm 10 can omit packages that are both production dependencies and peers of
// development tools when `npm sbom --omit=dev` runs against the full tree.
// Generate from a clean production-only manifest instead, then validate the
// result before it becomes a release artifact or attestation input.
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-sbom-'))
try {
  const productionPackage = { ...packageJson }
  delete productionPackage.devDependencies
  fs.writeFileSync(path.join(temporaryRoot, 'package.json'), `${JSON.stringify(productionPackage, null, 2)}\n`, { mode: 0o644 })
  fs.copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(temporaryRoot, 'package-lock.json'))

  runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], temporaryRoot)
  const raw = runNpm(['sbom', '--sbom-format', 'spdx'], temporaryRoot)
  const sbom = JSON.parse(raw)
  if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.packages) || !Array.isArray(sbom.relationships)) {
    throw new Error('npm produced an invalid SPDX document')
  }

  const documented = new Set(sbom.packages.map((entry) => entry?.name).filter(Boolean))
  const missing = productionNames.filter((name) => !documented.has(name))
  const leaked = developmentNames.filter((name) => documented.has(name) && !productionNames.includes(name))
  if (missing.length) throw new Error(`SPDX is missing production dependencies: ${missing.join(', ')}`)
  if (leaked.length) throw new Error(`SPDX includes development-only dependencies: ${leaked.join(', ')}`)

  atomicWrite(outputPath, `${JSON.stringify(sbom, null, 2)}\n`)
  console.log(`Created SPDX 2.3 SBOM with ${sbom.packages.length} packages at ${outputPath}`)
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
