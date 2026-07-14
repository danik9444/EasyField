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
const pluginPreload = path.join(projectRoot, 'plugin', 'preload.cjs')

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

// Runs the real Main/preload boundary with a synthetic Electron shell. The
// credential and HTTPS response are deliberately fake; this test never reads a
// developer or user API key and never makes a network request.
const IPC_BOOTSTRAP = String.raw`
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough, Readable } = require('node:stream')
const fs = require('node:fs')
const path = require('node:path')
const realHttps = require('node:https')
const realDns = require('node:dns')

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
let capturedProxyAuthorization = ''
let capturedProxyBridgeToken = ''
const fakeHttps = {
  ...realHttps,
  get: (_options, callback) => {
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.destroy = (error) => { if (error) request.emit('error', error) }
    queueMicrotask(() => {
      const response = Readable.from([png])
      response.statusCode = 200
      response.headers = { 'content-type': 'image/png', 'content-length': String(png.length) }
      callback(response)
    })
    return request
  },
  request: (options, callback) => {
    const request = new PassThrough()
    request.on('finish', () => {
      capturedProxyAuthorization = String(options.headers?.authorization ?? '')
      capturedProxyBridgeToken = String(options.headers?.['x-ef-bridge-token'] ?? '')
      const response = Readable.from([JSON.stringify({ code: 200, data: { credits: 123 } })])
      response.statusCode = 200
      response.headers = { 'content-type': 'application/json' }
      queueMicrotask(() => callback(response))
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

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.id = 77
    this.mainFrame = { url: '' }
    this.openHandler = null
    this.session = { webRequest: { onBeforeSendHeaders: (filter, listener) => { this.requestFilter = filter; this.requestListener = listener } } }
  }
  setWindowOpenHandler(handler) { this.openHandler = handler }
  getURL() { return this.mainFrame.url }
}
class FakeBrowserWindow extends EventEmitter {
  static last = null
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    this.destroyed = false
    FakeBrowserWindow.last = this
  }
  setMenu() {}
  setContentSize() {}
  isDestroyed() { return this.destroyed }
  loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve() }
  destroy() { this.destroyed = true }
}

const app = new EventEmitter()
app.whenReady = () => Promise.resolve()
app.quit = () => {}
app.getPath = () => process.env.EF_TEST_USER_DATA

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app, BrowserWindow: FakeBrowserWindow, ipcMain, safeStorage }
  if (request === 'https' || request === 'node:https') return fakeHttps
  if (request === 'dns' || request === 'node:dns') return fakeDns
  if (request.endsWith('WorkflowIntegration.node')) throw new Error('native Resolve bridge disabled by the IPC test')
  return originalLoad.call(this, request, parent, isMain)
}

require(process.argv[1])

async function waitForReady() {
  for (let i = 0; i < 100; i += 1) {
    if (FakeBrowserWindow.last && handlers.has('ef:artifacts:ingest-url')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Main IPC did not become ready')
}

void (async () => {
  await waitForReady()
  const win = FakeBrowserWindow.last
  const trusted = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const secret = 'synthetic-ipc-test-secret'

  const legacyCredentialName = Buffer.from('a2llLWFwaS1rZXk=', 'base64').toString()
  const legacyCredentialPath = path.join(process.env.EF_TEST_USER_DATA, legacyCredentialName + '.safe')
  const credentialPath = path.join(process.env.EF_TEST_USER_DATA, 'cloud-generation-api-key.safe')
  fs.mkdirSync(process.env.EF_TEST_USER_DATA, { recursive: true })
  fs.writeFileSync(credentialPath, Buffer.from('encrypted:'), { mode: 0o600 })
  fs.writeFileSync(legacyCredentialPath, safeStorage.encryptString(secret), { mode: 0o600 })
  const rendererCredential = await handlers.get('ef:credentials:get')(trusted, 'cloud-generation-api-key')
  const legacyCredentialMigrated = fs.existsSync(credentialPath) && !fs.existsSync(legacyCredentialPath)
  await handlers.get('ef:credentials:set')(trusted, 'cloud-generation-api-key', secret)
  const stored = fs.readFileSync(credentialPath)
  const credentialMode = fs.statSync(credentialPath).mode & 0o777

  const proxyResponse = await fetch('http://127.0.0.1:' + process.env.EF_PORT + '/provider/api/v1/chat/credit', {
    headers: {
      Authorization: 'Bearer __easyfield_secure__',
      Origin: 'http://localhost:5173',
      'X-EF-Bridge-Token': process.env.EF_BRIDGE_TOKEN,
    },
  })
  await proxyResponse.arrayBuffer()
  await handlers.get('ef:credentials:set')(trusted, 'cloud-generation-api-key', '')
  const emptyCredentialClearedAllCopies = !fs.existsSync(credentialPath) && !fs.existsSync(legacyCredentialPath)

  let untrustedRejected = false
  try { await handlers.get('ef:credentials:get')({ sender: {}, senderFrame: { url: 'https://attacker.invalid' } }, 'cloud-generation-api-key') }
  catch { untrustedRejected = true }

  let artifactNamespaceRejected = false
  try { await handlers.get('ef:state:list')(trusted, 'artifacts') }
  catch { artifactNamespaceRejected = true }

  let navigationPrevented = false
  win.webContents.emit('will-navigate', { preventDefault: () => { navigationPrevented = true } }, 'https://attacker.invalid/phish')
  let webviewPrevented = false
  win.webContents.emit('will-attach-webview', { preventDefault: () => { webviewPrevented = true } })
  const injectedHeaders = await new Promise((resolve) => {
    win.webContents.requestListener(
      { webContentsId: win.webContents.id, requestHeaders: { Accept: 'application/json' } },
      ({ requestHeaders }) => resolve(requestHeaders),
    )
  })

  const artifact = await handlers.get('ef:artifacts:ingest-url')(trusted, {
    url: 'https://media.example.test/result.png',
    name: 'Synthetic result',
    kind: 'image',
  })
  const response = await fetch('http://127.0.0.1:' + process.env.EF_PORT + artifact.url)
  const bytes = Buffer.from(await response.arrayBuffer())
  const artifactDir = path.join(process.env.HOME, 'Movies', 'EasyField', '_Artifacts')
  const partials = fs.readdirSync(artifactDir).filter((name) => name.endsWith('.download') || name.endsWith('.tmp'))

  console.log(JSON.stringify({
    rendererGotSentinel: rendererCredential === '__easyfield_secure__',
    rendererGotSecret: rendererCredential === secret,
    legacyCredentialMigrated,
    emptyCredentialClearedAllCopies,
    plaintextOnDisk: stored.includes(Buffer.from(secret)),
    credentialMode,
    untrustedRejected,
    artifactNamespaceRejected,
    navigationPrevented,
    webviewPrevented,
    newWindowDenied: win.webContents.openHandler?.({ url: 'https://attacker.invalid' }).action === 'deny',
    sandbox: win.options.webPreferences.sandbox,
    contextIsolation: win.options.webPreferences.contextIsolation,
    nodeIntegration: win.options.webPreferences.nodeIntegration,
    bridgeTokenInjectedByMain: injectedHeaders['X-EF-Bridge-Token'] === process.env.EF_BRIDGE_TOKEN,
    devProviderAuthenticatedByMain: win.webContents.requestFilter.urls.includes('http://localhost:5173/provider/*'),
    devUploadAuthenticatedByMain: win.webContents.requestFilter.urls.includes('http://localhost:5173/provider-upload/*'),
    loadedDevOrigin: win.webContents.getURL() === 'http://localhost:5173',
    secureProxyStatus: proxyResponse.status,
    secureProxyUsedStoredCredential: capturedProxyAuthorization === 'Bearer ' + secret,
    secureProxyForwardedSentinel: capturedProxyAuthorization === 'Bearer __easyfield_secure__',
    secureProxyForwardedBridgeToken: capturedProxyBridgeToken !== '',
    bridgeTokenArgumentExposed: Array.isArray(win.options.webPreferences.additionalArguments),
    artifactStatus: response.status,
    artifactMatches: bytes.equals(png),
    checksumLength: artifact.checksum.length,
    partialCount: partials.length,
  }))
  process.exit(0)
})().catch((error) => {
  console.error(error && error.stack || error)
  process.exit(1)
})
`

test('Electron Main keeps credentials and artifact paths behind trusted IPC', async (t) => {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'easyfield-ipc-test-'))
  t.after(() => rm(temporaryHome, { recursive: true, force: true }))
  const userDataPath = path.join(temporaryHome, 'user-data')
  const port = await reservePort()
  const child = spawn(process.execPath, ['-e', IPC_BOOTSTRAP, pluginMain], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: temporaryHome,
      EF_PORT: String(port),
      EF_TEST_USER_DATA: userDataPath,
      EF_BRIDGE_TOKEN: 'synthetic-ipc-bridge-token',
      EF_DEV: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
  await once(child, 'exit')
  clearTimeout(timer)
  assert.equal(child.exitCode, 0, output)

  const resultLine = output.trim().split('\n').findLast((line) => line.startsWith('{'))
  assert(resultLine, output)
  const result = JSON.parse(resultLine)
  assert.deepEqual(result, {
    rendererGotSentinel: true,
    rendererGotSecret: false,
    legacyCredentialMigrated: true,
    emptyCredentialClearedAllCopies: true,
    plaintextOnDisk: false,
    credentialMode: 0o600,
    untrustedRejected: true,
    artifactNamespaceRejected: true,
    navigationPrevented: true,
    webviewPrevented: true,
    newWindowDenied: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    bridgeTokenInjectedByMain: true,
    devProviderAuthenticatedByMain: true,
    devUploadAuthenticatedByMain: true,
    loadedDevOrigin: true,
    secureProxyStatus: 200,
    secureProxyUsedStoredCredential: true,
    secureProxyForwardedSentinel: false,
    secureProxyForwardedBridgeToken: false,
    bridgeTokenArgumentExposed: false,
    artifactStatus: 200,
    artifactMatches: true,
    checksumLength: 64,
    partialCount: 0,
  })
})

test('the sandboxed preload does not expose the Main-only bridge token', async () => {
  const bootstrap = String.raw`
const Module = require('node:module')
let exposed
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value } },
      ipcRenderer: { invoke: async () => null },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
process.argv.push('--ef-bridge-token=synthetic-token-that-must-stay-hidden')
require(process.argv[1])
console.log(JSON.stringify({
  keys: Object.keys(exposed).sort(),
  frozen: Object.isFrozen(exposed),
  hasBridgeToken: Object.prototype.hasOwnProperty.call(exposed, 'bridgeToken'),
  hasCredentials: typeof exposed.credentials?.get === 'function',
}))
`
  const child = spawn(process.execPath, ['-e', bootstrap, pluginPreload], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await once(child, 'exit')
  assert.equal(child.exitCode, 0, output)
  const result = JSON.parse(output.trim())
  assert.equal(result.frozen, true)
  assert.equal(result.hasBridgeToken, false)
  assert.equal(result.hasCredentials, true)
  assert.deepEqual(result.keys, ['artifacts', 'credentials', 'plugin', 'state', 'updates', 'window'])
})
