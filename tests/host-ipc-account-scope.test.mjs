import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginMain = path.join(projectRoot, 'plugin', 'main.cjs')

async function reservePort() {
  const socket = createServer()
  socket.unref()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const address = socket.address()
  assert(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return port
}

// Exercise the real Main IPC and loopback proxy. Supabase and provider calls
// are deterministic in-memory fakes; no developer or user credential is read.
const ACCOUNT_SCOPE_BOOTSTRAP = String.raw`
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough, Readable } = require('node:stream')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const realHttps = require('node:https')
const realDns = require('node:dns')
const realFetch = globalThis.fetch

const users = {
  'admin-a@example.com': {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'admin-a@example.com',
    email_confirmed_at: '2026-07-15T08:00:00.000Z',
    user_metadata: {},
  },
  'admin-b@example.com': {
    id: '20000000-0000-4000-8000-000000000002',
    email: 'admin-b@example.com',
    email_confirmed_at: '2026-07-15T08:00:00.000Z',
    user_metadata: {},
  },
}
let revokedAccountId = ''
let billingChecks = 0
const forwardedCredentials = []
const validatedCredentials = []
const rendererMessages = []
let credentialValidationHook = null
let blockedGlobalDeletionPath = ''
const realUnlinkSync = fs.unlinkSync.bind(fs)
fs.unlinkSync = (file) => {
  if (blockedGlobalDeletionPath && String(file) === blockedGlobalDeletionPath) {
    blockedGlobalDeletionPath = ''
    const error = new Error('synthetic deletion failure')
    error.code = 'EACCES'
    throw error
  }
  return realUnlinkSync(file)
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function userFromAuthorization(options) {
  const value = String(options?.headers?.Authorization || options?.headers?.authorization || '')
  const accountId = value.replace(/^Bearer access-/, '')
  return Object.values(users).find((user) => user.id === accountId)
}
function authResponse(user) {
  return {
    access_token: 'access-' + user.id,
    refresh_token: 'refresh-' + user.id,
    expires_in: 3600,
    user,
  }
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.includes('/auth/v1/token?grant_type=password')) {
    const body = JSON.parse(options.body || '{}')
    const user = users[String(body.email || '').toLowerCase()]
    return user ? json(authResponse(user)) : json({ message: 'invalid credentials' }, 401)
  }
  if (target.includes('/auth/v1/token?grant_type=refresh_token')) {
    const body = JSON.parse(options.body || '{}')
    const accountId = String(body.refresh_token || '').replace(/^refresh-/, '')
    const user = Object.values(users).find((candidate) => candidate.id === accountId)
    return user ? json(authResponse(user)) : json({ message: 'invalid refresh token' }, 401)
  }
  if (target.endsWith('/auth/v1/user')) {
    const user = userFromAuthorization(options)
    return user ? json(user) : json({}, 401)
  }
  if (target.endsWith('/auth/v1/logout')) return new Response(null, { status: 204 })
  if (target.endsWith('/rest/v1/rpc/my_billing_snapshot')) {
    const user = userFromAuthorization(options)
    billingChecks += 1
    return user ? json({
      as_of: new Date().toISOString(),
      profile: {
        user_id: user.id,
        email: user.email,
        platform_role: user.id === revokedAccountId ? 'customer' : 'admin',
      },
      account: {
        account_id: '30000000-0000-4000-8000-000000000003',
        available_microcredits: 0,
        subscription_microcredits: 0,
        purchased_microcredits: 0,
        other_microcredits: 0,
      },
      subscription: null,
      next_expiring_lot: null,
      auto_reload: null,
    }) : json({}, 401)
  }
  if (target.includes('/rest/v1/partner_entitlements?')) return json([])
  if (target.endsWith('/direct-access')) {
    const user = userFromAuthorization(options)
    return user ? json({ accountId: user.id, allowed: user.id !== revokedAccountId }) : json({}, 401)
  }
  throw new Error('Unexpected account request: ' + target)
}

const fakeHttps = {
  ...realHttps,
  request: (options, callback) => {
    const request = new PassThrough()
    request.setTimeout = () => request
    request.on('finish', () => {
      void (async () => {
        const authorization = String(options.headers?.authorization || options.headers?.Authorization || '')
        const isCredentialCheck = options.path === '/api/v1/chat/credit' && !options.headers?.origin
        if (isCredentialCheck) validatedCredentials.push(authorization)
        else forwardedCredentials.push(authorization)
        if (isCredentialCheck && credentialValidationHook) {
          const hook = credentialValidationHook
          credentialValidationHook = null
          await hook()
        }
        const invalid = authorization === 'Bearer invalid-secret'
        const response = Readable.from([Buffer.from(JSON.stringify(
          isCredentialCheck
            ? invalid ? { code: 401, msg: 'rejected' } : { code: 200, data: authorization.includes('account-a') ? 321 : 654 }
            : { ok: true },
        ))])
        response.statusCode = invalid ? 401 : 200
        response.headers = { 'content-type': 'application/json' }
        callback(response)
      })().catch((error) => request.emit('error', error))
    })
    return request
  },
}
const fakeDns = {
  ...realDns,
  promises: {
    ...realDns.promises,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  },
}
const handlers = new Map()
const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from('encrypted:' + Buffer.from(value).toString('base64')),
  decryptString: (bytes) => Buffer.from(String(Buffer.from(bytes)).slice('encrypted:'.length), 'base64').toString(),
}
const shell = { openExternal: async () => {} }

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.id = 11
    this.mainFrame = { url: '' }
    this.session = { webRequest: { onBeforeSendHeaders: () => {} } }
  }
  setWindowOpenHandler() {}
  getURL() { return this.mainFrame.url }
  send(channel, payload) { rendererMessages.push({ channel, payload }) }
}
class FakeBrowserWindow extends EventEmitter {
  static last = null
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    this.destroyed = false
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
    FakeBrowserWindow.last = this
  }
  setMenu() {}
  getBounds() { return { ...this.bounds } }
  setBounds(bounds) { this.bounds = { ...bounds } }
  setMinimumSize() {}
  setMaximumSize() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  isFocused() { return false }
  isDestroyed() { return this.destroyed }
  loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve() }
}
const app = new EventEmitter()
app.whenReady = () => Promise.resolve()
app.quit = () => {}
app.getPath = () => process.env.EF_TEST_USER_DATA
const screen = new EventEmitter()
screen.getPrimaryDisplay = () => ({ id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } })
screen.getDisplayMatching = () => screen.getPrimaryDisplay()

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app, BrowserWindow: FakeBrowserWindow, ipcMain, safeStorage, screen, shell }
  if (request === 'https' || request === 'node:https') return fakeHttps
  if (request === 'dns' || request === 'node:dns') return fakeDns
  if (request.endsWith('WorkflowIntegration.node')) throw new Error('native Resolve bridge disabled by test')
  return originalLoad.call(this, request, parent, isMain)
}

require(process.argv[1])

async function waitForReady() {
  for (let i = 0; i < 100; i += 1) {
    if (
      FakeBrowserWindow.last
      && handlers.has('ef:direct-cloud:connect')
      && handlers.has('ef:direct-cloud:has-existing')
      && handlers.has('ef:direct-cloud:has-scoped')
      && handlers.has('ef:direct-cloud:adopt-existing')
      && handlers.has('ef:account:sign-in')
    ) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Main IPC did not become ready')
}
async function proxyRequest() {
  const response = await realFetch('http://127.0.0.1:' + process.env.EF_PORT + '/provider/api/v1/chat/credit', {
    headers: {
      Authorization: 'Bearer __easyfield_secure__',
      Origin: 'http://localhost:5173',
      'X-EF-Bridge-Token': process.env.EF_BRIDGE_TOKEN,
    },
  })
  await response.arrayBuffer()
  return response.status
}
function scopedCredentialPath(accountId) {
  const digest = crypto.createHash('sha256').update(accountId.toLowerCase(), 'utf8').digest('hex')
  return path.join(process.env.EF_TEST_USER_DATA, 'cloud-generation-api-key.account.' + digest + '.safe')
}

void (async () => {
  await waitForReady()
  const win = FakeBrowserWindow.last
  const trusted = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const canonicalPath = path.join(process.env.EF_TEST_USER_DATA, 'cloud-generation-api-key.safe')
  const compatibilityPath = path.join(
    process.env.EF_TEST_USER_DATA,
    String.fromCharCode(107, 105, 101, 45, 97, 112, 105, 45, 107, 101, 121) + '.safe',
  )
  fs.mkdirSync(process.env.EF_TEST_USER_DATA, { recursive: true })
  fs.writeFileSync(canonicalPath, safeStorage.encryptString('invalid-secret'), { mode: 0o600 })

  await handlers.get('ef:account:sign-in')(trusted, { email: 'admin-a@example.com', password: 'password-a' })
  const configuredLegacyValueIgnored = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === ''
  const invalidLegacyAvailable = await handlers.get('ef:direct-cloud:has-existing')(trusted) === true
  let configuredGenericWriteRejected = false
  try { await handlers.get('ef:credentials:set')(trusted, 'cloud-generation-api-key', 'unvalidated-secret') }
  catch { configuredGenericWriteRejected = true }
  const invalidLegacyBytes = fs.readFileSync(canonicalPath)
  let invalidLegacyRejected = false
  let invalidLegacyErrorSanitized = false
  try { await handlers.get('ef:direct-cloud:adopt-existing')(trusted) }
  catch (error) {
    invalidLegacyRejected = true
    invalidLegacyErrorSanitized = !String(error?.message || error).includes('invalid-secret')
  }
  const invalidLegacyPreserved = fs.existsSync(canonicalPath)
    && fs.readFileSync(canonicalPath).equals(invalidLegacyBytes)
    && !fs.existsSync(scopedCredentialPath(users['admin-a@example.com'].id))

  const adoptedSecret = 'account-a-legacy-secret'
  fs.writeFileSync(canonicalPath, safeStorage.encryptString(adoptedSecret), { mode: 0o600 })
  fs.writeFileSync(compatibilityPath, safeStorage.encryptString(adoptedSecret), { mode: 0o600 })
  const validLegacyAvailable = await handlers.get('ef:direct-cloud:has-existing')(trusted) === true
  const beforeFailedCanonicalDelete = fs.readFileSync(canonicalPath)
  const beforeFailedCompatibilityDelete = fs.readFileSync(compatibilityPath)
  blockedGlobalDeletionPath = compatibilityPath
  let partialDeleteRejected = false
  let partialDeleteErrorSanitized = false
  try { await handlers.get('ef:direct-cloud:adopt-existing')(trusted) }
  catch (error) {
    partialDeleteRejected = true
    partialDeleteErrorSanitized = !String(error?.message || error).includes(adoptedSecret)
  }
  const partialDeleteRestoredEveryCiphertext = fs.existsSync(canonicalPath)
    && fs.existsSync(compatibilityPath)
    && fs.readFileSync(canonicalPath).equals(beforeFailedCanonicalDelete)
    && fs.readFileSync(compatibilityPath).equals(beforeFailedCompatibilityDelete)
    && !fs.existsSync(scopedCredentialPath(users['admin-a@example.com'].id))
  const accountAAdoption = await handlers.get('ef:direct-cloud:adopt-existing')(trusted)
  const accountAAdoptionSanitized = JSON.stringify(accountAAdoption) === JSON.stringify({ credits: 321 })
    && !JSON.stringify(accountAAdoption).includes(adoptedSecret)
  const accountAPath = scopedCredentialPath(users['admin-a@example.com'].id)
  const accountAScopedRecord = JSON.parse(safeStorage.decryptString(fs.readFileSync(accountAPath)))
  const accountAScopedVerified = accountAScopedRecord.version === 1
    && accountAScopedRecord.accountId === users['admin-a@example.com'].id
    && accountAScopedRecord.credential === adoptedSecret
    && (fs.statSync(accountAPath).mode & 0o777) === 0o600
    && !fs.readFileSync(accountAPath).includes(Buffer.from(adoptedSecret))
  const adoptedGlobalRemoved = !fs.existsSync(canonicalPath)
  const adoptedLegacyNoLongerAvailable = await handlers.get('ef:direct-cloud:has-existing')(trusted) === false
  const accountAReturnedOnlySentinel = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === '__easyfield_secure__'
  const accountAScopedPresence = await handlers.get('ef:direct-cloud:has-scoped')(trusted) === true
  const checksBeforeA = billingChecks
  const accountAStatus = await proxyRequest()
  const accountAWasFreshlyChecked = billingChecks > checksBeforeA

  await handlers.get('ef:account:sign-out')(trusted)
  await handlers.get('ef:account:sign-in')(trusted, { email: 'admin-b@example.com', password: 'password-b' })
  const accountBInheritedCredential = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') !== ''
  const accountBInitiallyHasNoScopedCredential = await handlers.get('ef:direct-cloud:has-scoped')(trusted) === false
  const accountBWithoutKeyStatus = await proxyRequest()

  const raceSecret = 'race-global-secret'
  fs.writeFileSync(canonicalPath, safeStorage.encryptString(raceSecret), { mode: 0o600 })
  const raceLegacyBytes = fs.readFileSync(canonicalPath)
  const raceLegacyAvailable = await handlers.get('ef:direct-cloud:has-existing')(trusted) === true
  credentialValidationHook = async () => {
    await handlers.get('ef:account:sign-out')(trusted)
    await handlers.get('ef:account:sign-in')(trusted, { email: 'admin-a@example.com', password: 'password-a' })
  }
  let switchedAdoptionRejected = false
  let switchedAdoptionErrorSanitized = false
  try { await handlers.get('ef:direct-cloud:adopt-existing')(trusted) }
  catch (error) {
    switchedAdoptionRejected = true
    switchedAdoptionErrorSanitized = !String(error?.message || error).includes(raceSecret)
  }
  const switchedAdoptionPreservedGlobal = fs.existsSync(canonicalPath)
    && fs.readFileSync(canonicalPath).equals(raceLegacyBytes)
  const switchedAdoptionPreservedAccountA = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === '__easyfield_secure__'
  await handlers.get('ef:account:sign-out')(trusted)
  await handlers.get('ef:account:sign-in')(trusted, { email: 'admin-b@example.com', password: 'password-b' })
  const switchedAdoptionDidNotWriteAccountB = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === ''

  let invalidReplacementRejected = false
  try { await handlers.get('ef:direct-cloud:connect')(trusted, 'invalid-secret') }
  catch { invalidReplacementRejected = true }
  const accountBStillEmptyAfterInvalid = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === ''
  const accountBConnect = await handlers.get('ef:direct-cloud:connect')(trusted, 'account-b-secret')
  const accountBConnectSanitized = JSON.stringify(accountBConnect) === JSON.stringify({ credits: 654 })
  const accountBPath = scopedCredentialPath(users['admin-b@example.com'].id)
  try { await handlers.get('ef:direct-cloud:connect')(trusted, 'invalid-secret') } catch {}
  const failedReplacementPreservedCredential = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === '__easyfield_secure__'
  const accountBStatus = await proxyRequest()

  revokedAccountId = users['admin-b@example.com'].id
  const revokedAccountCanStillSeeOwnScopedCredential = await handlers.get('ef:direct-cloud:has-scoped')(trusted) === true
  const validationsBeforeRevokedConnect = validatedCredentials.length
  let revokedConnectRejected = false
  try { await handlers.get('ef:direct-cloud:connect')(trusted, 'revoked-candidate') }
  catch { revokedConnectRejected = true }
  const revokedConnectReachedProvider = validatedCredentials.length !== validationsBeforeRevokedConnect
  const checksBeforeRevoked = billingChecks
  const upstreamCountBeforeRevoked = forwardedCredentials.length
  const revokedStatus = await proxyRequest()
  const revocationWasFreshlyChecked = billingChecks > checksBeforeRevoked
  const revokedRequestReachedProvider = forwardedCredentials.length !== upstreamCountBeforeRevoked

  revokedAccountId = ''
  await handlers.get('ef:account:sign-out')(trusted)
  await handlers.get('ef:account:sign-in')(trusted, { email: 'admin-a@example.com', password: 'password-a' })
  const accountARetainedOwnCredential = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key') === '__easyfield_secure__'
  blockedGlobalDeletionPath = accountAPath
  let scopedDeleteFailureRejected = false
  let scopedDeleteFailureSanitized = false
  try { await handlers.get('ef:credentials:delete')(trusted, 'cloud-generation-api-key') }
  catch (error) {
    scopedDeleteFailureRejected = true
    scopedDeleteFailureSanitized = !String(error?.message || error).includes(accountAPath)
      && !String(error?.message || error).includes(adoptedSecret)
  }
  const scopedDeleteFailurePreservedCredential = fs.existsSync(accountAPath)
    && await handlers.get('ef:direct-cloud:has-scoped')(trusted) === true
  await handlers.get('ef:credentials:delete')(trusted, 'cloud-generation-api-key')
  const scopedDeleteRemovedOnlyCurrentAccount = !fs.existsSync(accountAPath)
    && fs.existsSync(accountBPath)
    && await handlers.get('ef:direct-cloud:has-scoped')(trusted) === false
  const rendererPayloadsContainNoCredential = !JSON.stringify(rendererMessages).includes(adoptedSecret)
    && !JSON.stringify(rendererMessages).includes(raceSecret)
    && !JSON.stringify(rendererMessages).includes('invalid-secret')

  console.log(JSON.stringify({
    configuredLegacyValueIgnored,
    invalidLegacyAvailable,
    configuredGenericWriteRejected,
    invalidLegacyRejected,
    invalidLegacyErrorSanitized,
    invalidLegacyPreserved,
    validLegacyAvailable,
    partialDeleteRejected,
    partialDeleteErrorSanitized,
    partialDeleteRestoredEveryCiphertext,
    accountAAdoptionSanitized,
    accountAScopedVerified,
    adoptedGlobalRemoved,
    adoptedLegacyNoLongerAvailable,
    accountAReturnedOnlySentinel,
    accountAScopedPresence,
    accountAStatus,
    accountAWasFreshlyChecked,
    accountBInheritedCredential,
    accountBInitiallyHasNoScopedCredential,
    accountBWithoutKeyStatus,
    raceLegacyAvailable,
    switchedAdoptionRejected,
    switchedAdoptionErrorSanitized,
    switchedAdoptionPreservedGlobal,
    switchedAdoptionPreservedAccountA,
    switchedAdoptionDidNotWriteAccountB,
    invalidReplacementRejected,
    accountBStillEmptyAfterInvalid,
    accountBConnectSanitized,
    failedReplacementPreservedCredential,
    accountBStatus,
    revokedConnectRejected,
    revokedAccountCanStillSeeOwnScopedCredential,
    revokedConnectReachedProvider,
    revokedStatus,
    revocationWasFreshlyChecked,
    revokedRequestReachedProvider,
    accountARetainedOwnCredential,
    scopedDeleteFailureRejected,
    scopedDeleteFailureSanitized,
    scopedDeleteFailurePreservedCredential,
    scopedDeleteRemovedOnlyCurrentAccount,
    rendererPayloadsContainNoCredential,
    providerUsedOnlyScopedCredentials: JSON.stringify(forwardedCredentials) === JSON.stringify([
      'Bearer account-a-legacy-secret',
      'Bearer account-b-secret',
    ]),
    validationSawExpectedCandidates: JSON.stringify(validatedCredentials) === JSON.stringify([
      'Bearer invalid-secret',
      'Bearer account-a-legacy-secret',
      'Bearer account-a-legacy-secret',
      'Bearer race-global-secret',
      'Bearer invalid-secret',
      'Bearer account-b-secret',
      'Bearer invalid-secret',
    ]),
  }))
  process.exit(0)
})().catch((error) => {
  console.error(error && error.stack || error)
  process.exit(1)
})
`

test('configured direct credentials are account-scoped and freshly authorized per provider request', async (t) => {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'easyfield-account-scope-'))
  t.after(() => rm(temporaryHome, { recursive: true, force: true }))
  const port = await reservePort()
  const child = spawn(process.execPath, ['-e', ACCOUNT_SCOPE_BOOTSTRAP, pluginMain], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: temporaryHome,
      EF_PORT: String(port),
      EF_TEST_USER_DATA: path.join(temporaryHome, 'user-data'),
      EF_BRIDGE_TOKEN: 'account-scope-bridge-token',
      EF_DEV: '1',
      EF_SUPABASE_URL: 'https://project.example.test',
      EF_SUPABASE_ANON_KEY: 'public-anon-key',
      EF_ACCOUNT_API_URL: 'https://project.example.test/functions/v1/easyfield-account',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await once(child, 'exit')
  clearTimeout(timer)
  assert.equal(child.exitCode, 0, output)

  const resultLine = output.trim().split('\n').findLast((line) => line.startsWith('{'))
  assert(resultLine, output)
  assert.deepEqual(JSON.parse(resultLine), {
    configuredLegacyValueIgnored: true,
    invalidLegacyAvailable: true,
    configuredGenericWriteRejected: true,
    invalidLegacyRejected: true,
    invalidLegacyErrorSanitized: true,
    invalidLegacyPreserved: true,
    validLegacyAvailable: true,
    partialDeleteRejected: true,
    partialDeleteErrorSanitized: true,
    partialDeleteRestoredEveryCiphertext: true,
    accountAAdoptionSanitized: true,
    accountAScopedVerified: true,
    adoptedGlobalRemoved: true,
    adoptedLegacyNoLongerAvailable: true,
    accountAReturnedOnlySentinel: true,
    accountAScopedPresence: true,
    accountAStatus: 200,
    accountAWasFreshlyChecked: true,
    accountBInheritedCredential: false,
    accountBInitiallyHasNoScopedCredential: true,
    accountBWithoutKeyStatus: 401,
    raceLegacyAvailable: true,
    switchedAdoptionRejected: true,
    switchedAdoptionErrorSanitized: true,
    switchedAdoptionPreservedGlobal: true,
    switchedAdoptionPreservedAccountA: true,
    switchedAdoptionDidNotWriteAccountB: true,
    invalidReplacementRejected: true,
    accountBStillEmptyAfterInvalid: true,
    accountBConnectSanitized: true,
    failedReplacementPreservedCredential: true,
    accountBStatus: 200,
    revokedConnectRejected: true,
    revokedAccountCanStillSeeOwnScopedCredential: true,
    revokedConnectReachedProvider: false,
    revokedStatus: 403,
    revocationWasFreshlyChecked: true,
    revokedRequestReachedProvider: false,
    accountARetainedOwnCredential: true,
    scopedDeleteFailureRejected: true,
    scopedDeleteFailureSanitized: true,
    scopedDeleteFailurePreservedCredential: true,
    scopedDeleteRemovedOnlyCurrentAccount: true,
    rendererPayloadsContainNoCredential: true,
    providerUsedOnlyScopedCredentials: true,
    validationSawExpectedCandidates: true,
  })
})
