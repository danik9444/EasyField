import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = path.join(projectRoot, 'plugin')
const require = createRequire(import.meta.url)
const updater = require(path.join(pluginRoot, 'plugin-updater.cjs'))
const args = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

function atomicWrite(filePath, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, contents, { mode })
  fs.chmodSync(temporary, mode)
  fs.renameSync(temporary, filePath)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function safeJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function loadPrivateKey() {
  const keyPath = option('--private-key', null)
  if (keyPath) return crypto.createPrivateKey(fs.readFileSync(path.resolve(projectRoot, keyPath)))
  const encoded = process.env.EASYFIELD_UPDATE_PRIVATE_KEY_BASE64
  if (!encoded) throw new Error('Provide --private-key or EASYFIELD_UPDATE_PRIVATE_KEY_BASE64')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.toString('base64') !== encoded.replace(/\s+/g, '')) throw new Error('The update private key is not canonical base64')
  const text = bytes.toString('utf8')
  return text.includes('BEGIN PRIVATE KEY')
    ? crypto.createPrivateKey(text)
    : crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' })
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
    if (entry.isSymbolicLink()) throw new Error(`Release input contains a symbolic link: ${relativePath}`)
    if (entry.isDirectory()) files.push(...walk(absolutePath, relativePath))
    else if (entry.isFile()) files.push(relativePath)
    else throw new Error(`Release input contains an unsupported file: ${relativePath}`)
  }
  return files
}

function splitTarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' }
  for (let index = value.lastIndexOf('/'); index > 0; index = value.lastIndexOf('/', index - 1)) {
    const prefix = value.slice(0, index)
    const name = value.slice(index + 1)
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix }
  }
  throw new Error(`Archive path is too long for USTAR: ${value}`)
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error(`USTAR field overflow: ${value}`)
  bytes.copy(buffer, offset)
}

function writeOctal(buffer, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, '0') + '\0'
  writeString(buffer, offset, length, encoded)
}

function tarHeader(name, size, type, mode, mtime) {
  const header = Buffer.alloc(512)
  const split = splitTarPath(name)
  writeString(header, 0, 100, split.name)
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  header.fill(0x20, 148, 156)
  writeString(header, 156, 1, type)
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  writeString(header, 265, 32, 'root')
  writeString(header, 297, 32, 'wheel')
  if (split.prefix) writeString(header, 345, 155, split.prefix)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const encodedChecksum = checksum.toString(8).padStart(6, '0') + '\0 '
  writeString(header, 148, 8, encodedChecksum)
  return header
}

function createTar(entries, mtime) {
  const chunks = []
  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.bytes?.length || 0, entry.type, entry.type === '5' ? 0o755 : 0o644, mtime))
    if (entry.bytes) {
      chunks.push(entry.bytes)
      const remainder = entry.bytes.length % 512
      if (remainder) chunks.push(Buffer.alloc(512 - remainder))
    }
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

function canonicalMtime() {
  const raw = process.env.SOURCE_DATE_EPOCH
  if (raw == null || raw === '') return 0
  if (!/^\d+$/.test(raw)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > 8_589_934_591) throw new Error('SOURCE_DATE_EPOCH is outside the USTAR timestamp range')
  return value
}

const repository = option('--repo', process.env.GITHUB_REPOSITORY)
if (!repository || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
  throw new Error('Provide a GitHub owner/repository using --repo or GITHUB_REPOSITORY')
}
const [owner, repo] = repository.split('/')
if (owner.startsWith('.') || repo.startsWith('.')) throw new Error('Invalid GitHub repository')

const outDirectory = path.resolve(projectRoot, option('--out-dir', 'release/output'))
const rawManifest = safeJson(path.join(pluginRoot, 'update-manifest.json'))
const manifest = updater.validateManifest(rawManifest)
if (manifest.minMacOSVersion !== '15.0.0' || manifest.minResolveVersion !== '21.0.2') {
  throw new Error('Release compatibility must be macOS 15.0.0 and DaVinci Resolve 21.0.2')
}

const actualFiles = walk(pluginRoot).sort((left, right) => left.localeCompare(right, 'en'))
const expectedFiles = manifest.files.map((entry) => entry.path)
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  const expected = new Set(expectedFiles)
  const actual = new Set(actualFiles)
  const missing = expectedFiles.filter((value) => !actual.has(value))
  const unexpected = actualFiles.filter((value) => !expected.has(value))
  throw new Error(`Plugin files do not match update-manifest.json; missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`)
}

const fileBuffers = new Map()
for (const entry of manifest.files) {
  const absolutePath = path.join(pluginRoot, ...entry.path.split('/'))
  const stat = fs.lstatSync(absolutePath)
  const bytes = fs.readFileSync(absolutePath)
  if (!stat.isFile() || stat.isSymbolicLink() || bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
    throw new Error(`Plugin file failed manifest verification: ${entry.path}`)
  }
  fileBuffers.set(entry.path, bytes)
}

const privateKey = loadPrivateKey()
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing requires an Ed25519 private key')
const publicKey = crypto.createPublicKey(privateKey)
const publicDer = publicKey.export({ format: 'der', type: 'spki' })
const descriptor = {
  schemaVersion: 2,
  kind: 'github-release',
  feedUrl: `https://github.com/${repository}/releases/latest/download/easyfield-update.json`,
  publicKey: publicDer.toString('base64'),
}

const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
fileBuffers.set('update-manifest.json', manifestBytes)
fileBuffers.set('.easyfield-update-source.json', descriptorBytes)

const directories = new Set(['com.easyfield.panel/'])
for (const relativePath of fileBuffers.keys()) {
  const parts = relativePath.split('/')
  for (let index = 1; index < parts.length; index += 1) {
    directories.add(`com.easyfield.panel/${parts.slice(0, index).join('/')}/`)
  }
}
const entries = [
  ...[...directories].sort((left, right) => left.localeCompare(right, 'en')).map((name) => ({ name, type: '5' })),
  ...[...fileBuffers.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([relativePath, bytes]) => ({ name: `com.easyfield.panel/${relativePath}`, type: '0', bytes })),
]
const tarBytes = createTar(entries, canonicalMtime())
const archiveBytes = zlib.gzipSync(tarBytes, { level: 9, mtime: 0 })
const archiveName = `EasyField-${manifest.version}-plugin.tar.gz`
const archive = {
  name: archiveName,
  url: `https://github.com/${repository}/releases/download/v${manifest.version}/${archiveName}`,
  size: archiveBytes.length,
  sha256: sha256(archiveBytes),
}

let releaseNotes = option('--notes', `EasyField ${manifest.version}`)
const notesFile = option('--notes-file', null)
if (notesFile) releaseNotes = fs.readFileSync(path.resolve(projectRoot, notesFile), 'utf8').trim()
if (Buffer.byteLength(releaseNotes) > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(releaseNotes)) {
  throw new Error('Release notes must be at most 4000 bytes and contain no control characters')
}

const payload = {
  pluginId: 'com.easyfield.panel',
  channel: 'stable',
  version: manifest.version,
  buildId: manifest.buildId,
  createdAt: manifest.createdAt,
  manifest,
  archive,
  releaseNotes,
}
const signature = crypto.sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), privateKey).toString('base64')
const envelope = {
  schemaVersion: 1,
  kind: 'easyfield-release',
  payload,
  signature,
}

updater.validateRemoteRelease(envelope, descriptor)
fs.mkdirSync(outDirectory, { recursive: true })
atomicWrite(path.join(outDirectory, archiveName), archiveBytes)
atomicWrite(path.join(outDirectory, 'easyfield-update.json'), `${JSON.stringify(envelope, null, 2)}\n`)
atomicWrite(path.join(outDirectory, '.easyfield-update-source.json'), descriptorBytes)
atomicWrite(path.join(outDirectory, 'easyfield-update-public.spki.b64'), `${descriptor.publicKey}\n`)

console.log(`Created ${archiveName} (${archive.size} bytes, sha256 ${archive.sha256})`)
console.log(`Created signed easyfield-update.json for ${repository} v${manifest.version}`)
console.log(`Publisher-key SHA-256 fingerprint: ${sha256(publicDer)}`)
