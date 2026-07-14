import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function fail(message) {
  console.error(`release-version: ${message}`)
  process.exit(1)
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'))
}

function atomicWrite(relativePath, contents) {
  const destination = path.join(projectRoot, relativePath)
  const temporary = `${destination}.tmp-${process.pid}`
  fs.writeFileSync(temporary, contents, { mode: 0o644 })
  fs.renameSync(temporary, destination)
}

function readVersions() {
  const rootPackage = readJson('package.json')
  const lock = readJson('package-lock.json')
  const pluginPackage = readJson('plugin/package.json')
  const manifestXml = fs.readFileSync(path.join(projectRoot, 'plugin/manifest.xml'), 'utf8')
  const match = manifestXml.match(/<Version>([^<]+)<\/Version>/)
  if (!match) fail('plugin/manifest.xml does not contain a Version element')
  return {
    'package.json': rootPackage.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'plugin/package.json': pluginPackage.version,
    'plugin/manifest.xml': match[1],
  }
}

function check(expected) {
  const versions = readVersions()
  const values = Object.values(versions)
  for (const [source, version] of Object.entries(versions)) {
    if (typeof version !== 'string' || !versionPattern.test(version)) fail(`${source} has invalid version ${JSON.stringify(version)}`)
  }
  const unique = new Set(values)
  if (unique.size !== 1) {
    fail(`versions are out of sync:\n${Object.entries(versions).map(([source, version]) => `  ${source}: ${version}`).join('\n')}`)
  }
  const version = values[0]
  if (expected && expected !== version) fail(`expected ${expected}, found ${version}`)
  console.log(`EasyField version ${version} is synchronized across ${values.length} release sources`)
  return version
}

function setVersion(version) {
  if (!versionPattern.test(version || '')) fail('set requires a SemVer value such as 1.2.3')

  const rootPackage = readJson('package.json')
  const lock = readJson('package-lock.json')
  if (!lock.packages?.['']) fail('package-lock.json is missing packages[""]')
  const pluginPackage = readJson('plugin/package.json')
  const manifestPath = path.join(projectRoot, 'plugin/manifest.xml')
  const manifestXml = fs.readFileSync(manifestPath, 'utf8')
  if (!/<Version>[^<]+<\/Version>/.test(manifestXml)) fail('plugin/manifest.xml does not contain a Version element')

  rootPackage.version = version
  lock.version = version
  lock.packages[''].version = version
  pluginPackage.version = version
  atomicWrite('package.json', `${JSON.stringify(rootPackage, null, 2)}\n`)
  atomicWrite('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
  atomicWrite('plugin/package.json', `${JSON.stringify(pluginPackage, null, 2)}\n`)
  atomicWrite('plugin/manifest.xml', manifestXml.replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`))

  check(version)
  console.log('Rebuild the plugin manifest before creating release artifacts.')
}

const [command = 'check', value] = process.argv.slice(2)
if (command === 'check') check(value)
else if (command === 'set') setVersion(value)
else fail('usage: node scripts/release-version.mjs check [version] | set <version>')
