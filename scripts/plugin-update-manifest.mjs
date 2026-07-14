import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = path.join(projectRoot, 'plugin')
const manifestPath = path.join(pluginRoot, 'update-manifest.json')
const pluginPackage = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))

const excluded = (relativePath) => (
  relativePath === 'update-manifest.json'
  || relativePath === '.easyfield-update-source.json'
  || relativePath === 'WorkflowIntegration.node'
  || relativePath === '.DS_Store'
  || relativePath.endsWith('/.DS_Store')
  || relativePath === 'python/.venv'
  || relativePath.startsWith('python/.venv/')
)

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const file = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const bytes = fs.readSync(file, buffer, 0, buffer.length, null)
      if (!bytes) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(file)
  }
  return hash.digest('hex')
}

function walk(directory, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (excluded(relativePath)) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Release packages cannot contain symbolic links: ${relativePath}`)
    if (entry.isDirectory()) files.push(...walk(absolutePath, relativePath))
    else if (entry.isFile()) {
      const stat = fs.statSync(absolutePath)
      files.push({ path: relativePath, size: stat.size, sha256: sha256File(absolutePath) })
    }
  }
  return files
}

const files = walk(pluginRoot).sort((left, right) => left.path.localeCompare(right.path, 'en'))
const createdAt = (() => {
  if (process.env.RELEASE_CREATED_AT) {
    const value = new Date(process.env.RELEASE_CREATED_AT)
    if (!Number.isFinite(value.getTime())) throw new Error('RELEASE_CREATED_AT must be an ISO-8601 timestamp')
    return value.toISOString()
  }
  if (process.env.SOURCE_DATE_EPOCH) {
    if (!/^\d+$/.test(process.env.SOURCE_DATE_EPOCH)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer')
    return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  }
  return new Date().toISOString()
})()
const canonical = JSON.stringify({
  pluginId: 'com.easyfield.panel',
  platform: 'darwin',
  architectures: ['arm64', 'x64'],
  minResolveVersion: '21.0.2',
  version: pluginPackage.version,
  files,
})
const manifest = {
  schemaVersion: 1,
  pluginId: 'com.easyfield.panel',
  platform: 'darwin',
  architectures: ['arm64', 'x64'],
  minMacOSVersion: '15.0.0',
  minResolveVersion: '21.0.2',
  version: pluginPackage.version,
  createdAt,
  buildId: crypto.createHash('sha256').update(canonical).digest('hex'),
  files,
}

const temporary = `${manifestPath}.tmp-${process.pid}`
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
fs.renameSync(temporary, manifestPath)
console.log(`EasyField plugin ${manifest.version} · ${manifest.buildId.slice(0, 12)} · ${files.length} verified files`)
