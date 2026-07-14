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
const args = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: projectRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${path.basename(command)} failed${output ? `:\n${output}` : ''}`)
  }
  return result.stdout.trim()
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function copyVerified(source, destination, entry) {
  const stat = fs.lstatSync(source)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || sha256File(source) !== entry.sha256) {
    throw new Error(`Plugin file failed manifest verification: ${entry.path}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 })
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o644)
}

if (process.platform !== 'darwin') throw new Error('PKG construction requires macOS pkgbuild and productbuild')
for (const tool of ['/usr/bin/pkgbuild', '/usr/bin/productbuild']) {
  if (!fs.existsSync(tool)) throw new Error(`${tool} is unavailable`)
}

const outDirectory = path.resolve(projectRoot, option('--out-dir', 'release/output'))
const descriptorPath = path.resolve(projectRoot, option('--descriptor', path.join(outDirectory, '.easyfield-update-source.json')))
const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
if (descriptor.schemaVersion !== 2 || descriptor.kind !== 'github-release'
  || typeof descriptor.feedUrl !== 'string' || typeof descriptor.publicKey !== 'string'
  || Object.keys(descriptor).join(',') !== 'schemaVersion,kind,feedUrl,publicKey') {
  throw new Error('The installed update descriptor does not match schema v2')
}
let descriptorUrl
try { descriptorUrl = new URL(descriptor.feedUrl) } catch { throw new Error('The installed update descriptor has an invalid feed URL') }
if (descriptorUrl.protocol !== 'https:' || descriptorUrl.hostname !== 'github.com'
  || !/^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/releases\/latest\/download\/easyfield-update\.json$/.test(descriptorUrl.pathname)
  || descriptorUrl.username || descriptorUrl.password || descriptorUrl.search || descriptorUrl.hash || descriptorUrl.port) {
  throw new Error('The installed update descriptor must use the fixed GitHub release feed')
}
const publicBytes = Buffer.from(descriptor.publicKey, 'base64')
if (!publicBytes.length || publicBytes.toString('base64') !== descriptor.publicKey) throw new Error('The update public key is not canonical base64')
let publicKey
try { publicKey = crypto.createPublicKey({ key: publicBytes, format: 'der', type: 'spki' }) } catch { throw new Error('The installed update descriptor has an invalid public key') }
if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('The installed update descriptor requires an Ed25519 public key')
const manifest = updater.validateManifest(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'update-manifest.json'), 'utf8')))
if (manifest.minMacOSVersion !== '15.0.0' || manifest.minResolveVersion !== '21.0.2') {
  throw new Error('Release compatibility must be macOS 15.0.0 and DaVinci Resolve 21.0.2')
}
if (manifest.files.some((entry) => entry.path === 'WorkflowIntegration.node')) {
  throw new Error('WorkflowIntegration.node must remain external to the PKG payload')
}
const feedPath = path.join(outDirectory, 'easyfield-update.json')
if (!fs.existsSync(feedPath)) throw new Error('Build the signed update feed before building the PKG')
const release = updater.validateRemoteRelease(JSON.parse(fs.readFileSync(feedPath, 'utf8')), descriptor)
if (release.manifest.version !== manifest.version || release.manifest.buildId !== manifest.buildId) {
  throw new Error('The signed update feed does not match the plugin being packaged')
}

const unsigned = args.includes('--unsigned')
const identity = option('--sign', process.env.APPLE_INSTALLER_IDENTITY)
if (!unsigned && !identity) throw new Error('Provide --sign/APPLE_INSTALLER_IDENTITY, or pass --unsigned for a local test package')
if (unsigned && identity) throw new Error('Choose either --unsigned or a signing identity')

fs.mkdirSync(outDirectory, { recursive: true })
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-pkg-'))
try {
  const packageRoot = path.join(temporaryRoot, 'root')
  const payloadRoot = path.join(packageRoot, 'Library/Application Support/EasyField/InstallerPayload')
  const stagedPlugin = path.join(payloadRoot, 'com.easyfield.panel')
  const scriptsRoot = path.join(temporaryRoot, 'scripts')
  fs.mkdirSync(stagedPlugin, { recursive: true, mode: 0o755 })
  fs.mkdirSync(scriptsRoot, { recursive: true, mode: 0o755 })

  const checksumEntries = []
  for (const entry of manifest.files) {
    const source = path.join(pluginRoot, ...entry.path.split('/'))
    const destination = path.join(stagedPlugin, ...entry.path.split('/'))
    copyVerified(source, destination, entry)
    checksumEntries.push({ path: entry.path, sha256: entry.sha256 })
  }

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
  const metadata = [
    { name: 'update-manifest.json', bytes: manifestBytes },
    { name: '.easyfield-update-source.json', bytes: descriptorBytes },
  ]
  for (const item of metadata) {
    fs.writeFileSync(path.join(stagedPlugin, item.name), item.bytes, { mode: 0o644 })
    checksumEntries.push({ path: item.name, sha256: crypto.createHash('sha256').update(item.bytes).digest('hex') })
  }
  checksumEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  for (const entry of checksumEntries) {
    if (/\r|\n|\t/.test(entry.path)) throw new Error(`Unsafe checksum path: ${entry.path}`)
  }
  fs.writeFileSync(
    path.join(payloadRoot, 'release-checksums.sha256'),
    checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(''),
    { mode: 0o600 },
  )

  for (const name of ['preinstall', 'postinstall']) {
    const source = path.join(projectRoot, 'packaging/pkg/scripts', name)
    const destination = path.join(scriptsRoot, name)
    fs.copyFileSync(source, destination)
    fs.chmodSync(destination, 0o755)
  }

  const componentPath = path.join(temporaryRoot, 'EasyField-component.pkg')
  run('/usr/bin/pkgbuild', [
    '--root', packageRoot,
    '--scripts', scriptsRoot,
    '--identifier', 'com.easyfield.panel.installer',
    '--version', manifest.version,
    '--install-location', '/',
    '--ownership', 'recommended',
    componentPath,
  ])

  const suffix = unsigned ? '-unsigned' : ''
  const outputPath = path.join(outDirectory, `EasyField-${manifest.version}-macOS-universal${suffix}.pkg`)
  const productArgs = ['--package', componentPath]
  if (identity) productArgs.push('--sign', identity)
  productArgs.push(outputPath)
  run('/usr/bin/productbuild', productArgs)

  if (!fs.statSync(outputPath).isFile() || fs.statSync(outputPath).size <= 0) throw new Error('productbuild did not create a package')
  console.log(`Created ${outputPath}`)
  console.log(`PKG SHA-256: ${sha256File(outputPath)}`)
  if (unsigned) console.log('This is an unsigned local verification package and must not be published.')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
