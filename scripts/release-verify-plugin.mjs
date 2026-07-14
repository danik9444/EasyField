import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = path.join(projectRoot, 'plugin')
const require = createRequire(import.meta.url)
const updater = require(path.join(pluginRoot, 'plugin-updater.cjs'))

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${path.basename(command)} failed${output ? `:\n${output}` : ''}`)
  }
  return `${result.stdout || ''}${result.stderr || ''}`
}

function excluded(relativePath) {
  return relativePath === 'update-manifest.json'
    || relativePath === '.easyfield-update-source.json'
    || relativePath === 'WorkflowIntegration.node'
    || relativePath === '.DS_Store'
    || relativePath.endsWith('/.DS_Store')
    || relativePath === 'python/.venv'
    || relativePath.startsWith('python/.venv/')
}

function walk(directory, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (excluded(relativePath)) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Plugin contains a symbolic link: ${relativePath}`)
    if (entry.isDirectory()) files.push(...walk(absolutePath, relativePath))
    else if (entry.isFile()) files.push(relativePath)
    else throw new Error(`Plugin contains an unsupported file: ${relativePath}`)
  }
  return files
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

const manifest = updater.validateManifest(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'update-manifest.json'), 'utf8')))
if (manifest.minMacOSVersion !== '15.0.0' || manifest.minResolveVersion !== '21.0.2') {
  throw new Error('Release compatibility must be macOS 15.0.0 and DaVinci Resolve 21.0.2')
}
if (manifest.files.some((entry) => entry.path === 'WorkflowIntegration.node')) {
  throw new Error('WorkflowIntegration.node must remain external to EasyField releases')
}

const actualFiles = walk(pluginRoot).sort((left, right) => left.localeCompare(right, 'en'))
const expectedFiles = manifest.files.map((entry) => entry.path)
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error('Plugin tree does not exactly match update-manifest.json')
}

for (const entry of manifest.files) {
  const filePath = path.join(pluginRoot, ...entry.path.split('/'))
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || sha256File(filePath) !== entry.sha256) {
    throw new Error(`Plugin file failed checksum verification: ${entry.path}`)
  }
  if (entry.path.endsWith('.cjs')) run(process.execPath, ['--check', filePath])
}

const forbiddenPaths = [projectRoot, os.homedir()].filter((value, index, all) => value && all.indexOf(value) === index)
const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs', '.py', '.txt', '.xml'])
for (const relativePath of expectedFiles) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue
  const text = fs.readFileSync(path.join(pluginRoot, ...relativePath.split('/')), 'utf8')
  const leaked = forbiddenPaths.find((candidate) => text.includes(candidate))
  if (leaked) throw new Error(`Plugin contains an absolute developer path in ${relativePath}`)
}

console.log(`Verified release plugin ${manifest.version} · ${manifest.buildId.slice(0, 12)} · ${expectedFiles.length} files`)
console.log('WorkflowIntegration.node is external and excluded from the release')
