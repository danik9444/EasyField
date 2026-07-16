import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ARCHITECTURES = Object.freeze(['arm64', 'x64'])
const REQUIRED_COMPONENTS = Object.freeze({
  ffmpeg: Object.freeze(['ffmpeg', 'ffprobe']),
  'librosa-python': Object.freeze(['python3']),
  whispercpp: Object.freeze(['whisper-cli']),
})
const COMPONENT_IDS = Object.freeze(Object.keys(REQUIRED_COMPONENTS))
const PRODUCTION_BUILDERS = Object.freeze([
  'release-build-update.mjs',
  'release-build-pkg.mjs',
])
const MAX_CATALOG_BYTES = 16 * 1024 * 1024
const MAX_EVIDENCE_BYTES = 1024 * 1024
const MAX_RUNTIME_FILE_BYTES = 8 * 1024 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactFields(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be a JSON object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}`)
  }
}

function assertSafeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > 1024
    || value.includes('\\')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} must be a safe relative POSIX path`)
  }
  return value
}

function assertVersion(value, label) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !/^[0-9A-Za-z][0-9A-Za-z._+\-]{0,79}$/.test(value)
    || /placeholder|replace|unknown|latest/i.test(value)
  ) {
    fail(`${label} must identify one pinned runtime version`)
  }
  return value
}

function assertMetadataText(value, label, maximum = 300) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
    || /placeholder|replace[_ -]?me|change[_ -]?me/i.test(value)
  ) {
    fail(`${label} must contain reviewed release metadata`)
  }
  return value
}

function validateSpdxMetadata(value, componentId) {
  assertExactFields(
    value,
    ['name', 'supplier', 'licenseDeclared', 'downloadLocation', 'copyrightText'],
    `${componentId}.spdx`,
  )
  const name = assertMetadataText(value.name, `${componentId}.spdx.name`, 120)
  const supplier = assertMetadataText(value.supplier, `${componentId}.spdx.supplier`, 200)
  if (!/^(?:Organization|Person):\s\S/.test(supplier)) {
    fail(`${componentId}.spdx.supplier must use SPDX Organization: or Person: syntax`)
  }
  const licenseDeclared = assertMetadataText(value.licenseDeclared, `${componentId}.spdx.licenseDeclared`, 200)
  if (!/^[A-Za-z0-9.+()\-\s]+$/.test(licenseDeclared) || licenseDeclared === 'NOASSERTION') {
    fail(`${componentId}.spdx.licenseDeclared must be a reviewed SPDX license expression`)
  }
  const downloadLocation = assertMetadataText(value.downloadLocation, `${componentId}.spdx.downloadLocation`, 2048)
  let source
  try { source = new URL(downloadLocation) } catch { fail(`${componentId}.spdx.downloadLocation must be a real HTTPS provenance URL`) }
  if (
    source.protocol !== 'https:'
    || source.username
    || source.password
    || source.port
    || source.hash
    || !source.hostname.includes('.')
    || /\.(?:example|invalid|test)$/.test(source.hostname)
  ) {
    fail(`${componentId}.spdx.downloadLocation must be a real HTTPS provenance URL`)
  }
  const copyrightText = assertMetadataText(value.copyrightText, `${componentId}.spdx.copyrightText`, 1000)
  return Object.freeze({ name, supplier, licenseDeclared, downloadLocation, copyrightText })
}

function validateTarget(value, componentId, architecture, requiredExecutables) {
  const label = `${componentId}.${architecture}`
  assertExactFields(value, ['version', 'root', 'executables', 'files'], label)
  const version = assertVersion(value.version, `${label}.version`)
  const root = assertSafeRelativePath(value.root, `${label}.root`)
  const expectedRoot = `runtime-packs/${componentId}/${architecture}`
  if (root !== expectedRoot) fail(`${label}.root must be ${expectedRoot}`)

  assertExactFields(value.executables, requiredExecutables, `${label}.executables`)
  const executables = {}
  for (const name of requiredExecutables) {
    executables[name] = assertSafeRelativePath(value.executables[name], `${label}.executables.${name}`)
  }

  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 100000) {
    fail(`${label}.files must be a nonempty bounded array`)
  }
  const files = []
  const seen = new Set()
  for (let index = 0; index < value.files.length; index += 1) {
    const entry = value.files[index]
    const entryLabel = `${label}.files[${index}]`
    assertExactFields(entry, ['path', 'size', 'sha256', 'kind', 'executable'], entryLabel)
    const relativePath = assertSafeRelativePath(entry.path, `${entryLabel}.path`)
    if (seen.has(relativePath)) fail(`${label}.files contains duplicate path: ${relativePath}`)
    seen.add(relativePath)
    if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_RUNTIME_FILE_BYTES) {
      fail(`${entryLabel}.size must be a positive safe integer`)
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail(`${entryLabel}.sha256 must be a lowercase SHA-256 digest`)
    }
    if (entry.kind !== 'data' && entry.kind !== 'mach-o') {
      fail(`${entryLabel}.kind must be data or mach-o`)
    }
    if (typeof entry.executable !== 'boolean') fail(`${entryLabel}.executable must be boolean`)
    if (entry.kind === 'data' && entry.executable) {
      fail(`${entryLabel} cannot mark non-Mach-O data as executable`)
    }
    files.push(Object.freeze({
      path: relativePath,
      size: entry.size,
      sha256: entry.sha256,
      kind: entry.kind,
      executable: entry.executable,
    }))
  }
  const sorted = files.map((entry) => entry.path).sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(sorted) !== JSON.stringify(files.map((entry) => entry.path))) {
    fail(`${label}.files must be sorted by path`)
  }
  for (const [name, executablePath] of Object.entries(executables)) {
    const entry = files.find((candidate) => candidate.path === executablePath)
    if (!entry || entry.kind !== 'mach-o' || !entry.executable) {
      fail(`${label}.executables.${name} must reference an executable Mach-O file entry`)
    }
  }
  return Object.freeze({
    version,
    root,
    executables: Object.freeze(executables),
    files: Object.freeze(files),
  })
}

export function validateReleaseRuntimeCatalog(value) {
  assertExactFields(
    value,
    ['schemaVersion', 'platform', 'architectures', 'releaseReady', 'licenseReview', 'components'],
    'Runtime pack catalog',
  )
  if (value.schemaVersion !== 1) fail('Runtime pack catalog schemaVersion must be 1')
  if (value.platform !== 'darwin') fail('Runtime pack catalog platform must be darwin')
  if (JSON.stringify(value.architectures) !== JSON.stringify(ARCHITECTURES)) {
    fail('Runtime pack catalog must target arm64 and x64 in canonical order')
  }
  if (typeof value.releaseReady !== 'boolean') fail('Runtime pack catalog releaseReady must be boolean')

  assertExactFields(value.licenseReview, ['status', 'evidence'], 'Runtime pack licenseReview')
  if (value.licenseReview.status !== 'pending' && value.licenseReview.status !== 'approved') {
    fail('Runtime pack licenseReview.status must be pending or approved')
  }
  if (value.licenseReview.status === 'pending' && value.licenseReview.evidence !== null) {
    fail('Pending runtime license review cannot claim approval evidence')
  }
  if (value.licenseReview.status === 'approved') {
    assertSafeRelativePath(value.licenseReview.evidence, 'Runtime pack licenseReview.evidence')
    if (!value.licenseReview.evidence.startsWith('docs/release-approvals/') || !value.licenseReview.evidence.endsWith('.md')) {
      fail('Approved runtime license evidence must be a Markdown record under docs/release-approvals')
    }
  }

  if (!Array.isArray(value.components) || value.components.length !== COMPONENT_IDS.length) {
    fail(`Runtime pack catalog must contain exactly ${COMPONENT_IDS.length} components`)
  }
  const components = []
  for (let index = 0; index < value.components.length; index += 1) {
    const component = value.components[index]
    const expectedId = COMPONENT_IDS[index]
    assertExactFields(component, ['id', 'requiredExecutables', 'spdx', 'targets'], `Runtime component ${index}`)
    if (component.id !== expectedId) fail(`Runtime component ${index} must be ${expectedId}`)
    const requiredExecutables = REQUIRED_COMPONENTS[expectedId]
    if (JSON.stringify(component.requiredExecutables) !== JSON.stringify(requiredExecutables)) {
      fail(`${expectedId}.requiredExecutables must match the fixed runtime contract`)
    }
    const spdx = component.spdx === null ? null : validateSpdxMetadata(component.spdx, expectedId)
    if (value.releaseReady && !spdx) fail(`${expectedId}.spdx is required for a release-ready catalog`)
    if (!value.releaseReady && spdx) fail('A non-release-ready catalog cannot claim runtime SBOM metadata')
    assertExactFields(component.targets, ARCHITECTURES, `${expectedId}.targets`)
    const targets = {}
    for (const architecture of ARCHITECTURES) {
      const target = component.targets[architecture]
      if (target === null) {
        if (value.releaseReady) fail(`${expectedId}.${architecture} is required for a release-ready catalog`)
        targets[architecture] = null
      } else {
        targets[architecture] = validateTarget(target, expectedId, architecture, requiredExecutables)
      }
    }
    components.push(Object.freeze({
      id: expectedId,
      requiredExecutables,
      spdx,
      targets: Object.freeze(targets),
    }))
  }
  if (value.releaseReady && value.licenseReview.status !== 'approved') {
    fail('Release-ready runtime packs require recorded license approval')
  }
  if (!value.releaseReady) {
    const populated = components.some((component) => ARCHITECTURES.some((architecture) => component.targets[architecture] !== null))
    if (populated) fail('A non-release-ready catalog cannot contain partially publishable runtime targets')
  }

  return Object.freeze({
    schemaVersion: 1,
    platform: 'darwin',
    architectures: ARCHITECTURES,
    releaseReady: value.releaseReady,
    licenseReview: Object.freeze({
      status: value.licenseReview.status,
      evidence: value.licenseReview.evidence,
    }),
    components: Object.freeze(components),
  })
}

export function validateReleaseRuntimeCatalogFile(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Missing runtime pack catalog: ${filePath}`)
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Runtime pack catalog must be a regular file, not a link')
  if (stat.size < 2 || stat.size > MAX_CATALOG_BYTES) fail('Runtime pack catalog has an invalid size')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    fail('Runtime pack catalog must contain valid JSON')
  }
  return validateReleaseRuntimeCatalog(parsed)
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!bytes) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function walkFiles(directory, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) fail(`Runtime payload contains a symbolic link: ${relativePath}`)
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath, relativePath))
    else if (entry.isFile()) files.push(relativePath)
    else fail(`Runtime payload contains an unsupported filesystem entry: ${relativePath}`)
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function inspectMachO(filePath, architecture) {
  if (process.platform !== 'darwin') fail('Release runtime Mach-O inspection requires macOS')
  const lipo = spawnSync('/usr/bin/lipo', ['-archs', filePath], { encoding: 'utf8' })
  if (lipo.status !== 0) fail(`Runtime Mach-O architecture inspection failed: ${path.basename(filePath)}`)
  const arches = String(lipo.stdout || '').trim().split(/\s+/).filter(Boolean)
  const expected = architecture === 'x64' ? ['x86_64'] : ['arm64', 'arm64e']
  if (!expected.some((candidate) => arches.includes(candidate))) {
    fail(`Runtime Mach-O file does not support ${architecture}: ${path.basename(filePath)}`)
  }
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', filePath], { encoding: 'utf8' })
  if (verify.status !== 0) fail(`Runtime Mach-O signature is invalid: ${path.basename(filePath)}`)
  const details = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', filePath], { encoding: 'utf8' })
  const signatureDetails = `${details.stdout || ''}\n${details.stderr || ''}`
  if (details.status !== 0 || (!/\bAuthority=/.test(signatureDetails) && !/\bPlatform identifier=/.test(signatureDetails))) {
    fail(`Runtime Mach-O file requires a non-ad-hoc trusted signature: ${path.basename(filePath)}`)
  }
}

function assertManifestMatchesRuntimePayload(pluginRoot, expectedRuntimeFiles) {
  const manifestPath = path.join(pluginRoot, 'update-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    fail('Plugin update-manifest.json is missing or invalid; assemble the plugin after materializing runtime packs')
  }
  if (!Array.isArray(manifest.files)) fail('Plugin update-manifest.json has no file inventory')
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]))
  const manifestRuntimeFiles = manifest.files
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath === 'runtime-packs.json' || entryPath.startsWith('runtime-packs/'))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const expected = ['runtime-packs.json', ...expectedRuntimeFiles].sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(manifestRuntimeFiles) !== JSON.stringify(expected)) {
    fail('Plugin update-manifest.json does not exactly inventory the runtime payload')
  }
  for (const relativePath of expected) {
    const absolutePath = path.join(pluginRoot, ...relativePath.split('/'))
    const stat = fs.lstatSync(absolutePath)
    const entry = entries.get(relativePath)
    if (!entry || entry.size !== stat.size || entry.sha256 !== sha256File(absolutePath)) {
      fail(`Plugin update manifest is stale for runtime file: ${relativePath}`)
    }
  }
}

export function verifyReleaseRuntimePayload(projectRoot, catalog, options = {}) {
  if (!catalog.releaseReady) fail('Portable runtime packs are not marked release-ready')
  const pluginRoot = path.join(projectRoot, 'plugin')
  const runtimeRoot = path.join(pluginRoot, 'runtime-packs')
  let runtimeStat
  try { runtimeStat = fs.lstatSync(runtimeRoot) } catch (error) {
    if (error?.code === 'ENOENT') fail('Portable runtime payload directory is missing')
    throw error
  }
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    fail('Portable runtime payload must be a real directory, not a link')
  }
  // Reject links and special entries across the whole payload before reading
  // any target through a potentially redirected ancestor.
  const actualPayloadFiles = walkFiles(runtimeRoot).map((relativePath) => `runtime-packs/${relativePath}`)

  const expectedPayloadFiles = []
  let fileCount = 0
  let byteCount = 0
  const inspectBinary = options.inspectMachO || inspectMachO
  for (const component of catalog.components) {
    for (const architecture of ARCHITECTURES) {
      const target = component.targets[architecture]
      if (!target) fail(`Missing runtime target ${component.id}.${architecture}`)
      const targetRoot = path.join(pluginRoot, ...target.root.split('/'))
      const targetStat = fs.lstatSync(targetRoot)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        fail(`Runtime target root must be a real directory: ${target.root}`)
      }
      const actualFiles = walkFiles(targetRoot)
      const expectedFiles = target.files.map((entry) => entry.path)
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        fail(`Runtime target tree does not exactly match its checksum inventory: ${component.id}.${architecture}`)
      }
      for (const entry of target.files) {
        const absolutePath = path.join(targetRoot, ...entry.path.split('/'))
        const stat = fs.lstatSync(absolutePath)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) {
          fail(`Runtime file size/type mismatch: ${target.root}/${entry.path}`)
        }
        if (sha256File(absolutePath) !== entry.sha256) {
          fail(`Runtime file checksum mismatch: ${target.root}/${entry.path}`)
        }
        const executable = (stat.mode & 0o111) !== 0
        if (executable !== entry.executable) {
          fail(`Runtime executable mode mismatch: ${target.root}/${entry.path}`)
        }
        if (entry.kind === 'mach-o') inspectBinary(absolutePath, architecture)
        expectedPayloadFiles.push(`${target.root}/${entry.path}`)
        fileCount += 1
        byteCount += stat.size
      }
    }
  }
  expectedPayloadFiles.sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(actualPayloadFiles) !== JSON.stringify(expectedPayloadFiles)) {
    fail('Runtime payload contains files outside the checksum-pinned target inventories')
  }
  if (options.verifyUpdateManifest !== false) {
    assertManifestMatchesRuntimePayload(pluginRoot, expectedPayloadFiles)
  }
  return Object.freeze({ fileCount, byteCount })
}

function validateLicenseEvidence(projectRoot, catalog) {
  if (catalog.licenseReview.status !== 'approved') fail('Runtime redistribution license review is still pending')
  const evidencePath = path.join(projectRoot, ...catalog.licenseReview.evidence.split('/'))
  const stat = fs.lstatSync(evidencePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_EVIDENCE_BYTES) {
    fail('Runtime redistribution approval evidence must be a nonempty regular Markdown file')
  }
}

export function assertProjectReleaseRuntimePacks(projectRoot, options = {}) {
  const catalog = validateReleaseRuntimeCatalogFile(path.join(projectRoot, 'plugin', 'runtime-packs.json'))
  if (!catalog.releaseReady) fail('Portable FFmpeg/ffprobe, librosa/Python and whisper.cpp packs are not release-ready')
  validateLicenseEvidence(projectRoot, catalog)
  const payload = verifyReleaseRuntimePayload(projectRoot, catalog, options)
  return Object.freeze({ catalog, ...payload })
}

function readRequiredSource(filePath, label) {
  try { return fs.readFileSync(filePath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') fail(`Missing ${label}: ${filePath}`)
    throw error
  }
}

export function assertCiRuntimeReleaseStructure(projectRoot) {
  const catalog = validateReleaseRuntimeCatalogFile(path.join(projectRoot, 'plugin', 'runtime-packs.json'))
  if (catalog.releaseReady || catalog.licenseReview.status !== 'pending') {
    fail('CI runtime structure mode is valid only while portable runtimes are explicitly unavailable')
  }
  for (const component of catalog.components) {
    for (const architecture of ARCHITECTURES) {
      if (component.targets[architecture] !== null) {
        fail('CI runtime structure mode refuses a partially populated runtime catalog')
      }
    }
  }
  const payloadRoot = path.join(projectRoot, 'plugin', 'runtime-packs')
  if (fs.existsSync(payloadRoot)) {
    const stat = fs.lstatSync(payloadRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || walkFiles(payloadRoot).length > 0) {
      fail('CI runtime structure mode refuses unverified runtime payload files')
    }
  }
  for (const builder of PRODUCTION_BUILDERS) {
    const source = readRequiredSource(path.join(projectRoot, 'scripts', builder), `production builder ${builder}`)
    const importIndex = source.indexOf("import { assertReleaseRuntimeBuildMode } from './release-runtime-packs.mjs'")
    const gateIndex = source.indexOf('assertReleaseRuntimeBuildMode(projectRoot)')
    if (importIndex < 0 || gateIndex < 0 || gateIndex < importIndex) {
      fail(`Production builder ${builder} is missing the mandatory runtime release gate`)
    }
  }
  return Object.freeze({ portableRuntimesBlocked: true, productionBuildersGated: true })
}

function ciStructureEnvironmentIsBounded(environment) {
  return environment?.CI === 'true'
    && environment?.GITHUB_ACTIONS === 'true'
    && environment?.GITHUB_WORKFLOW === 'CI'
    && (environment?.GITHUB_EVENT_NAME === 'push' || environment?.GITHUB_EVENT_NAME === 'pull_request')
    && environment?.GITHUB_REF_TYPE !== 'tag'
}

export function assertReleaseRuntimeBuildMode(projectRoot, environment = process.env, options = {}) {
  const requestedMode = environment?.EASYFIELD_RUNTIME_STRUCTURE_TEST
  if (requestedMode == null || requestedMode === '') {
    return Object.freeze({ kind: 'production', ...assertProjectReleaseRuntimePacks(projectRoot, options) })
  }
  if (requestedMode !== '1' || !ciStructureEnvironmentIsBounded(environment)) {
    fail('CI runtime structure artifacts are restricted to the non-tag GitHub CI workflow')
  }
  assertCiRuntimeReleaseStructure(projectRoot)
  return Object.freeze({ kind: 'ci-structure', catalog: null, fileCount: 0, byteCount: 0 })
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--ci-structure-test')) {
    console.error('Usage: node scripts/release-runtime-packs.mjs [--ci-structure-test]')
    process.exitCode = 1
  } else {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    try {
      if (args[0] === '--ci-structure-test') {
        assertCiRuntimeReleaseStructure(projectRoot)
        console.log('Verified CI-only runtime structure: portable packs remain absent and production builders remain gated')
      } else {
        const result = assertProjectReleaseRuntimePacks(projectRoot)
        console.log(`Verified portable runtime payload: ${result.fileCount} checksum-pinned files for arm64 and x64`)
      }
    } catch (error) {
      console.error(`Release runtime validation failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exitCode = 1
    }
  }
}
