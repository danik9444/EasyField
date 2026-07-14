import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginMain = path.join(projectRoot, 'plugin', 'main.cjs')
const require = createRequire(import.meta.url)
const { createStateStore } = require('../plugin/state-store.cjs')

// Deliberately synthetic: bridge tests must never depend on a user credential.
const TEST_TOKEN = 'easyfield-bridge-regression-token'

// main.cjs only needs Electron's lifecycle surface in server-only mode. Keeping
// the stub in the child bootstrap lets the test exercise the real HTTP router
// without opening a window or loading Resolve's native integration.
const SERVER_BOOTSTRAP = String.raw`
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')

const app = new EventEmitter()
app.whenReady = () => Promise.resolve()
app.quit = () => {}
app.getPath = () => process.env.EF_TEST_USER_DATA
const ipcMain = { handle: () => {} }
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => Buffer.from(value).toString(),
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app, BrowserWindow: class BrowserWindow {}, ipcMain, safeStorage }
  if (request.endsWith('WorkflowIntegration.node')) {
    if (process.env.EF_TEST_HANG_INIT === '1') {
      return {
        InitializePromise: () => new Promise(() => {}),
        CleanUp: () => {},
      }
    }
    if (process.env.EF_TEST_RESOLVE_PLACEMENT === '1') {
      const writeEvent = (event) => {
        if (process.env.EF_TEST_RESOLVE_LOG) fs.appendFileSync(process.env.EF_TEST_RESOLVE_LOG, JSON.stringify(event) + '\n')
      }
      const trackState = { video: [], audio: [] }
      const makeItem = ({ id, start, end, sourceStart = 0, sourceEnd = end - start - 1, mediaPoolId = 'fixture-media', trackType = 'video', trackIndex = 1 }) => ({
        GetUniqueId: () => id,
        GetStart: () => start,
        GetEnd: () => end,
        GetSourceStartFrame: () => sourceStart,
        GetSourceEndFrame: () => sourceEnd,
        GetMediaPoolItem: () => ({ GetUniqueId: () => mediaPoolId }),
        GetTrackTypeAndIndex: () => [trackType, trackIndex],
      })
      const pushTrack = (type, values = {}) => {
        const track = { name: '', locked: false, enabled: true, subtype: type === 'audio' ? 'stereo' : '', items: [], ...values }
        trackState[type].push(track)
        return track
      }
      if (process.env.EF_TEST_TRACK_SCENARIO === 'busy-locked-disabled') {
        pushTrack('video', { name: 'EasyField V1', items: [makeItem({ id: 'busy-video', start: 30, end: 80, trackIndex: 1 })] })
        pushTrack('video', { name: 'EasyField V2', enabled: false })
        pushTrack('audio', { name: 'EasyField A1', locked: true })
        pushTrack('audio', { name: 'EasyField A2', enabled: false })
      }
      if (process.env.EF_TEST_ANCHOR_FIXTURES === '1') {
        while (trackState.video.length < 2) pushTrack('video', { name: 'User video' })
        const mutate = process.env.EF_TEST_MUTATE_ANCHOR || ''
        trackState.video[1].items.push(
          makeItem({
            id: 'item-7', start: 100, end: 200,
            sourceStart: mutate === 'item-7-source' ? 21 : 20,
            sourceEnd: 119, mediaPoolId: 'media-7', trackIndex: 2,
          }),
          makeItem({
            id: 'item-8', start: 200, end: 320,
            sourceStart: 48, sourceEnd: 167,
            mediaPoolId: mutate === 'item-8-media' ? 'media-relinked' : 'media-8', trackIndex: 2,
          }),
        )
      }
      const mediaHasAudio = process.env.EF_TEST_MEDIA_AUDIO === '1'
      const importedItem = {
        GetUniqueId: () => 'imported-media',
        GetClipProperty: (key) => {
          if (key === 'Online Status') return 'Online'
          if (key === 'Frames') return process.env.EF_TEST_MEDIA_FRAMES || '48'
          if (key === 'FPS') return '24'
          if (key === 'Audio Ch') return mediaHasAudio ? '2' : '0'
          return ''
        },
        GetAudioMapping: () => JSON.stringify({
          embedded_audio_channels: mediaHasAudio ? 2 : 0,
          linked_audio: {},
          track_mapping: mediaHasAudio ? { 1: { channel_idx: [1, 2], mute: false, type: 'Stereo' } } : {},
        }),
      }
      const sourceMediaPoolItem = {
        GetClipProperty: (key) => {
          if (key === 'File Path') return process.env.EF_TEST_SOURCE_FILE || ''
          if (key === 'FPS') return '24'
          return ''
        },
      }
      const sourceTimelineItem = {
        GetMediaPoolItem: () => sourceMediaPoolItem,
        GetSourceStartFrame: () => 24,
        GetSourceEndFrame: () => 47,
        GetName: () => 'Trimmed source',
      }
      const timeline = {
        GetUniqueId: () => 'timeline-test',
        GetName: () => 'Artifact placement test',
        GetCurrentTimecode: () => '00:00:00:00',
        GetCurrentVideoItem: () => process.env.EF_TEST_GRAB_CLIP === '1' ? sourceTimelineItem : null,
        GetSetting: (key) => key === 'timelineFrameRate' ? '24' : '',
        GetTrackCount: (type) => trackState[type]?.length || 0,
        GetTrackName: (type, index) => trackState[type]?.[index - 1]?.name || '',
        GetItemListInTrack: (type, index) => trackState[type]?.[index - 1]?.items || [],
        GetIsTrackLocked: (type, index) => !!trackState[type]?.[index - 1]?.locked,
        GetIsTrackEnabled: (type, index) => trackState[type]?.[index - 1]?.enabled !== false,
        GetTrackSubType: (type, index) => trackState[type]?.[index - 1]?.subtype || '',
        AddTrack: (type, subtype) => { pushTrack(type, { subtype: subtype || (type === 'audio' ? 'mono' : '') }); return true },
        SetTrackName: (type, index, name) => { trackState[type][index - 1].name = name; return true },
        SetClipsLinked: (items, linked) => {
          writeEvent({ type: 'link', itemIds: items.map((item) => item.GetUniqueId()), linked })
          return process.env.EF_TEST_LINK_FAILURE !== '1'
        },
        DeleteClips: (items) => {
          writeEvent({ type: 'rollback', itemIds: items.map((item) => item.GetUniqueId()) })
          for (const type of ['video', 'audio']) {
            for (const track of trackState[type]) track.items = track.items.filter((candidate) => !items.includes(candidate))
          }
          return true
        },
      }
      const mediaPool = {
        ImportMedia: (paths) => {
          writeEvent({ type: 'import', paths })
          return [importedItem]
        },
        AppendToTimeline: (entries) => {
          writeEvent({
            type: 'append',
            entries: entries.map(({ recordFrame, trackIndex, mediaType }) => ({ recordFrame, trackIndex, mediaType })),
          })
          const acceptedEntries = process.env.EF_TEST_PARTIAL_APPEND === '1' ? entries.slice(0, 1) : entries
          const appended = acceptedEntries.map((entry, index) => {
            const trackType = entry.mediaType === 2 ? 'audio' : 'video'
            const item = makeItem({
              id: 'appended-' + index,
              start: entry.recordFrame,
              end: entry.recordFrame + Number(process.env.EF_TEST_MEDIA_FRAMES || 48),
              sourceStart: 0,
              sourceEnd: Number(process.env.EF_TEST_MEDIA_FRAMES || 48) - 1,
              mediaPoolId: 'imported-media',
              trackType,
              trackIndex: entry.trackIndex,
            })
            trackState[trackType][entry.trackIndex - 1].items.push(item)
            return item
          })
          return appended
        },
      }
      const project = {
        GetUniqueId: () => 'project-test',
        GetName: () => 'Artifact project',
        GetCurrentTimeline: () => timeline,
        GetMediaPool: () => mediaPool,
      }
      return {
        InitializePromise: () => Promise.resolve(true),
        GetResolve: () => Promise.resolve({
          GetVersionString: () => '21.0.2',
          GetProjectManager: () => ({ GetCurrentProject: () => project }),
        }),
        CleanUp: () => {},
      }
    }
    throw new Error('native Resolve bridge disabled by the security test')
  }
  return originalLoad.call(this, request, parent, isMain)
}

require(process.argv[1])
`

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

async function startBridgeServer(extraEnv = {}) {
  const port = await reservePort()
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'easyfield-bridge-test-'))
  const userDataPath = path.join(temporaryHome, 'user-data')
  const resolveLogPath = path.join(temporaryHome, 'resolve-events.ndjson')
  const child = spawn(process.execPath, ['-e', SERVER_BOOTSTRAP, pluginMain], {
    cwd: projectRoot,
    env: {
      ...process.env,
      EF_BRIDGE_TOKEN: TEST_TOKEN,
      EF_MAX_MEDIA_BYTES: '128',
      EF_PORT: String(port),
      EF_SERVER_ONLY: '1',
      EF_TEST_USER_DATA: userDataPath,
      EF_TEST_RESOLVE_LOG: resolveLogPath,
      HOME: temporaryHome,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  const readyLine = `[EasyField] server on http://127.0.0.1:${port}`
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`bridge server did not start\n${output}`))
    }, 5_000)

    const onData = () => {
      if (!output.includes(readyLine)) return
      cleanup()
      resolve()
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`bridge server exited before listening (${code ?? signal})\n${output}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', onExit)
    onData()
  })

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    temporaryHome,
    userDataPath,
    resolveLogPath,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([
          once(child, 'exit'),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ])
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await rm(temporaryHome, { force: true, recursive: true })
    },
  }
}

function bridgeRequest(baseUrl, { token, origin }) {
  const headers = {}
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/bridge/status`, { headers })
}

function shotEndRequest(baseUrl, { token, origin }) {
  const headers = {}
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/bridge/grab/shot-end-frame`, { headers })
}

function shotStartRequest(baseUrl, { token, origin }) {
  const headers = {}
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/bridge/grab/shot-start-frame`, { headers })
}

function editImageSourceRequest(baseUrl, { token, origin }) {
  const headers = {}
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/bridge/grab/edit-image-source`, { headers })
}

function editVideoSourceRequest(baseUrl, { token, origin }) {
  const headers = {}
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/bridge/grab/edit-video-source`, { headers })
}

function placeRequest(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/bridge/place`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'X-EF-Bridge-Token': TEST_TOKEN,
      ...headers,
    },
    body,
  })
}

function renderRequest(baseUrl, { token, origin, contentType = 'text/plain' }) {
  const headers = { 'Content-Type': contentType }
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/api/render`, { method: 'POST', headers, body: 'invalid render request' })
}

function beatStatusRequest(baseUrl, { token, origin }) {
  const headers = {}
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/api/beat-detect/status`, { headers })
}

function beatMarkerRequest(baseUrl, { token, origin }) {
  const headers = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/bridge/beat/apply-markers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: '/tmp/not-easyfield.wav', target: 'timeline', analysisId: 'beat-security-test', color: 'Cyan', markers: [{ time: 1, confidence: 1, name: 'Beat' }] }),
  })
}

function urlContextRequest(baseUrl, { token, origin, url = 'http://unsafe.example.com/' }) {
  const headers = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/api/url-context`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  })
}

function secureProxyRequest(baseUrl, { token, origin }) {
  const headers = { Authorization: 'Bearer __easyfield_secure__' }
  if (token !== undefined) headers['X-EF-Bridge-Token'] = token
  if (origin !== undefined) headers.Origin = origin
  return fetch(`${baseUrl}/provider/api/v1/chat/credit`, { headers })
}

async function assertJsonError(response, status, code) {
  assert.equal(response.status, status)
  const payload = await response.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.code, code)
}

test('the real /bridge HTTP boundary enforces its security policy', async (t) => {
  const server = await startBridgeServer()
  t.after(server.stop)
  const legitimateOrigin = server.baseUrl

  await t.test('rejects a request without a bridge token', async () => {
    const response = await bridgeRequest(server.baseUrl, { origin: legitimateOrigin })
    assert.equal(response.status, 401)
  })

  await t.test('rejects a request with the wrong bridge token', async () => {
    const response = await bridgeRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: `${TEST_TOKEN}-wrong`,
    })
    assert.equal(response.status, 401)
  })

  await t.test('rejects a malicious Origin even when the token is correct', async () => {
    const response = await bridgeRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    assert.equal(response.status, 403)
  })

  await t.test('allows the legitimate panel to reach the status handler', async () => {
    const response = await bridgeRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      connected: false,
    })
  })

  await t.test('protects the rendered shot-end capture endpoint with the same bridge boundary', async () => {
    const missing = await shotEndRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await shotEndRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await shotEndRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    await assertJsonError(authorized, 200, 'RESOLVE_CLOSED')
  })

  await t.test('protects the rendered shot-start capture endpoint with the same bridge boundary', async () => {
    const missing = await shotStartRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await shotStartRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await shotStartRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    await assertJsonError(authorized, 200, 'RESOLVE_CLOSED')
  })

  await t.test('protects the media-aware Edit Image source endpoint with the same bridge boundary', async () => {
    const missing = await editImageSourceRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await editImageSourceRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await editImageSourceRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    await assertJsonError(authorized, 200, 'RESOLVE_CLOSED')
  })

  await t.test('protects the exact-trim Edit Video source endpoint with the same bridge boundary', async () => {
    const missing = await editVideoSourceRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await editVideoSourceRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await editVideoSourceRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    await assertJsonError(authorized, 200, 'RESOLVE_CLOSED')
  })

  await t.test('does not advertise wildcard CORS', async () => {
    const response = await bridgeRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })

  await t.test('serves the packaged UI with a restrictive security policy', async () => {
    const response = await fetch(`${server.baseUrl}/`)
    assert.equal(response.status, 200)
    const policy = response.headers.get('content-security-policy') ?? ''
    assert.match(policy, /default-src 'self'/)
    assert.match(policy, /object-src 'none'/)
    assert.match(policy, /frame-ancestors 'none'/)
    const connectDirective = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('connect-src')) ?? ''
    assert.match(connectDirective, /(?:^|\s)blob:(?:\s|$)/, 'local media blobs must remain fetchable before provider upload')
    assert.doesNotMatch(connectDirective, /(?:^|\s)data:(?:\s|$)/, 'connect-src should not permit arbitrary data URLs')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  })

  await t.test('rejects encoded traversal and malformed paths without crashing the server', async () => {
    const traversal = await fetch(`${server.baseUrl}/..%2fmain.cjs`)
    await assertJsonError(traversal, 400, 'BAD_REQUEST')

    const malformed = await fetch(`${server.baseUrl}/%E0%A4%A`)
    await assertJsonError(malformed, 400, 'BAD_REQUEST')

    const stillAlive = await bridgeRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    assert.equal(stillAlive.status, 200)
  })

  await t.test('serves only regular artifact files contained by the managed artifact root', async () => {
    const artifactRoot = path.join(server.temporaryHome, 'Movies', 'EasyField', '_Artifacts')
    await mkdir(artifactRoot, { recursive: true })
    const store = createStateStore(server.userDataPath)

    const validId = randomUUID()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const validPath = path.join(artifactRoot, `${validId}.png`)
    await writeFile(validPath, png)
    store.set('artifacts', validId, { id: validId, localPath: validPath })

    const response = await fetch(`${server.baseUrl}/artifacts/${validId}`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(response.status, 206)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png.subarray(0, 4))
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')

    const siblingId = randomUUID()
    const siblingRoot = `${artifactRoot}-escape`
    await mkdir(siblingRoot, { recursive: true })
    const siblingPath = path.join(siblingRoot, `${siblingId}.png`)
    await writeFile(siblingPath, png)
    store.set('artifacts', siblingId, { id: siblingId, localPath: siblingPath })
    assert.equal((await fetch(`${server.baseUrl}/artifacts/${siblingId}`)).status, 404)

    const symlinkId = randomUUID()
    const outside = path.join(server.temporaryHome, 'outside.png')
    await writeFile(outside, png)
    const linkedPath = path.join(artifactRoot, `${symlinkId}.png`)
    await symlink(outside, linkedPath)
    store.set('artifacts', symlinkId, { id: symlinkId, localPath: linkedPath })
    assert.equal((await fetch(`${server.baseUrl}/artifacts/${symlinkId}`)).status, 404)
    store.close()
  })

  await t.test('protects the packaged animation render route with the same boundary', async () => {
    const missing = await renderRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await renderRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await renderRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    await assertJsonError(authorized, 415, 'UNSUPPORTED_MEDIA')
  })

  await t.test('protects local beat analysis with the same boundary', async () => {
    const missing = await beatStatusRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await beatStatusRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await beatStatusRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    assert.equal(authorized.status, 200)
    const payload = await authorized.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.engine, 'librosa')
    assert.equal(typeof payload.available, 'boolean')
  })

  await t.test('protects Beat marker mutation with the bridge token and origin boundary', async () => {
    const missing = await beatMarkerRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await beatMarkerRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')
  })

  await t.test('protects packaged URL context with the same boundary', async () => {
    const missing = await urlContextRequest(server.baseUrl, { origin: legitimateOrigin })
    await assertJsonError(missing, 401, 'UNAUTHORIZED')

    const malicious = await urlContextRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await urlContextRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    await assertJsonError(authorized, 400, 'UNSAFE_URL')
  })

  await t.test('does not let another loopback process spend through the stored cloud credential', async () => {
    const missing = await secureProxyRequest(server.baseUrl, { origin: legitimateOrigin })
    assert.equal(missing.status, 401)
    const missingPayload = await missing.json()
    assert.equal(missingPayload.code, 'UNAUTHORIZED')
    assert.match(missingPayload.error, /authentication required/i)

    const malicious = await secureProxyRequest(server.baseUrl, {
      origin: 'https://attacker.invalid',
      token: TEST_TOKEN,
    })
    await assertJsonError(malicious, 403, 'FORBIDDEN')

    const authorized = await secureProxyRequest(server.baseUrl, {
      origin: legitimateOrigin,
      token: TEST_TOKEN,
    })
    const payload = await authorized.json()
    assert.equal(authorized.status, 401)
    assert.match(payload.error, /not connected/i, 'authorized request should reach secure credential lookup')
  })

  await t.test('rejects an authenticated JSON placement using plain HTTP', async () => {
    const response = await placeRequest(
      server.baseUrl,
      JSON.stringify({
        url: 'http://media.example.test/output.png',
        name: 'unsafe HTTP result',
        kind: 'image',
      }),
      { 'Content-Type': 'application/json' },
    )
    await assertJsonError(response, 400, 'UNSAFE_URL')
  })

  await t.test('rejects an HTTPS placement targeting a loopback IP literal', async () => {
    const response = await placeRequest(
      server.baseUrl,
      JSON.stringify({
        url: 'https://127.0.0.1/private.png',
        name: 'loopback result',
        kind: 'image',
      }),
      { 'Content-Type': 'application/json' },
    )
    await assertJsonError(response, 400, 'UNSAFE_URL')
  })

  await t.test('rejects a hostname that resolves to loopback', async () => {
    const response = await placeRequest(
      server.baseUrl,
      JSON.stringify({
        url: 'https://localhost/private.png',
        name: 'loopback DNS result',
        kind: 'image',
      }),
      { 'Content-Type': 'application/json' },
    )
    await assertJsonError(response, 400, 'UNSAFE_URL')
  })

  await t.test('rejects an oversized JSON placement body', async () => {
    const response = await placeRequest(
      server.baseUrl,
      JSON.stringify({
        url: 'https://media.example.test/output.png',
        name: 'x'.repeat(70 * 1024),
        kind: 'image',
      }),
      { 'Content-Type': 'application/json' },
    )
    await assertJsonError(response, 413, 'PAYLOAD_TOO_LARGE')
  })

  await t.test('rejects unsupported raw bytes before attempting Resolve import', async () => {
    const response = await placeRequest(
      server.baseUrl,
      Buffer.from('not a media file'),
      {
        'Content-Type': 'application/octet-stream',
        'X-EF-Kind': 'image',
        'X-EF-Name': encodeURIComponent('unsupported bytes'),
      },
    )
    await assertJsonError(response, 415, 'UNSUPPORTED_MEDIA')
  })

  await t.test('preserves a legitimate authenticated media upload', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
    const response = await placeRequest(server.baseUrl, png, {
      'Content-Type': 'image/png',
      'X-EF-Kind': 'image',
      'X-EF-Name': encodeURIComponent('valid image'),
    })
    assert.equal(response.status, 503)
    const payload = await response.json()
    assert.equal(payload.code, 'RESOLVE_CLOSED')
    assert.match(payload.path, /valid image-[a-z0-9]+\.png$/)
    assert.deepEqual(await readFile(payload.path), png)
  })
})

test('managed Artifact Store placement resolves only a verified Main-owned artifact id', async (t) => {
  const server = await startBridgeServer({ EF_TEST_RESOLVE_PLACEMENT: '1' })
  t.after(server.stop)

  const artifactDirectory = path.join(server.temporaryHome, 'Movies', 'EasyField', '_Artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
  const checksum = createHash('sha256').update(png).digest('hex')
  const artifactId = randomUUID()
  const artifactPath = path.join(artifactDirectory, `${artifactId}.png`)
  await writeFile(artifactPath, png)

  const store = createStateStore(server.userDataPath)
  t.after(() => store.close())
  store.set('artifacts', artifactId, {
    id: artifactId,
    name: 'Managed frame',
    kind: 'image',
    localPath: artifactPath,
    checksum,
    bytes: png.length,
    createdAt: Date.now(),
    referenced: true,
  })

  await t.test('rejects a traversal-shaped artifact id before any filesystem access', async () => {
    const response = await placeRequest(server.baseUrl, JSON.stringify({
      artifactId: '../../etc/passwd',
      name: 'malicious id',
      kind: 'image',
    }), { 'Content-Type': 'application/json' })
    await assertJsonError(response, 400, 'INVALID_ARTIFACT_ID')
  })

  await t.test('rejects a renderer-supplied path even beside a valid artifact id', async () => {
    const response = await placeRequest(server.baseUrl, JSON.stringify({
      artifactId,
      localPath: '/etc/passwd',
      name: 'malicious path',
      kind: 'image',
    }), { 'Content-Type': 'application/json' })
    await assertJsonError(response, 400, 'BAD_REQUEST')
  })

  await t.test('rejects a managed row whose path escapes the Artifact Store', async () => {
    const escapedId = randomUUID()
    const escapedPath = path.join(server.temporaryHome, `${escapedId}.png`)
    await writeFile(escapedPath, png)
    store.set('artifacts', escapedId, {
      id: escapedId,
      name: 'Escaped frame',
      kind: 'image',
      localPath: escapedPath,
      checksum,
      bytes: png.length,
      createdAt: Date.now(),
      referenced: true,
    })
    const response = await placeRequest(server.baseUrl, JSON.stringify({
      artifactId: escapedId,
      name: 'escaped row',
      kind: 'image',
    }), { 'Content-Type': 'application/json' })
    await assertJsonError(response, 409, 'ARTIFACT_INVALID')
  })

  await t.test('imports and places the verified local artifact without a URL or path from renderer', async () => {
    const response = await placeRequest(server.baseUrl, JSON.stringify({
      artifactId,
      name: 'Managed frame',
      kind: 'image',
      placement: 'playhead',
    }), { 'Content-Type': 'application/json' })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.appended, true)
    assert.equal(payload.path, artifactPath)

    const events = (await readFile(server.resolveLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.deepEqual(events[0], { type: 'import', paths: [artifactPath] })
    assert.deepEqual(events[1], {
      type: 'append',
      entries: [{ recordFrame: 0, trackIndex: 1, mediaType: 1 }],
    })
  })
})

test('managed video placement preserves embedded audio on interval-safe unlocked tracks', async (t) => {
  const server = await startBridgeServer({
    EF_TEST_RESOLVE_PLACEMENT: '1',
    EF_TEST_MEDIA_AUDIO: '1',
    EF_TEST_MEDIA_FRAMES: '48',
    EF_TEST_TRACK_SCENARIO: 'busy-locked-disabled',
  })
  t.after(server.stop)

  const artifactDirectory = path.join(server.temporaryHome, 'Movies', 'EasyField', '_Artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  const bytes = Buffer.from('synthetic managed video bytes')
  const artifactId = randomUUID()
  const artifactPath = path.join(artifactDirectory, `${artifactId}.mp4`)
  await writeFile(artifactPath, bytes)
  const store = createStateStore(server.userDataPath)
  t.after(() => store.close())
  store.set('artifacts', artifactId, {
    id: artifactId,
    name: 'Video with sound',
    kind: 'video',
    localPath: artifactPath,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    createdAt: Date.now(),
    referenced: true,
  })

  const response = await placeRequest(server.baseUrl, JSON.stringify({
    artifactId,
    name: 'Video with sound',
    kind: 'video',
    placement: 'playhead',
    recordFrame: 0,
  }), { 'Content-Type': 'application/json' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)

  const events = (await readFile(server.resolveLogPath, 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(events[1], {
    type: 'append',
    entries: [
      { recordFrame: 0, trackIndex: 3, mediaType: 1 },
      { recordFrame: 0, trackIndex: 3, mediaType: 2 },
    ],
  })
  assert.deepEqual(events[2], {
    type: 'link',
    itemIds: ['appended-0', 'appended-1'],
    linked: true,
  })
})

test('failed A/V linking rolls back both placed timeline items', async (t) => {
  const server = await startBridgeServer({
    EF_TEST_RESOLVE_PLACEMENT: '1',
    EF_TEST_MEDIA_AUDIO: '1',
    EF_TEST_LINK_FAILURE: '1',
  })
  t.after(server.stop)

  const artifactDirectory = path.join(server.temporaryHome, 'Movies', 'EasyField', '_Artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  const bytes = Buffer.from('synthetic video for link rollback')
  const artifactId = randomUUID()
  const artifactPath = path.join(artifactDirectory, `${artifactId}.mp4`)
  await writeFile(artifactPath, bytes)
  const store = createStateStore(server.userDataPath)
  t.after(() => store.close())
  store.set('artifacts', artifactId, {
    id: artifactId,
    name: 'Rollback A/V',
    kind: 'video',
    localPath: artifactPath,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    createdAt: Date.now(),
    referenced: true,
  })

  const response = await placeRequest(server.baseUrl, JSON.stringify({
    artifactId,
    name: 'Rollback A/V',
    kind: 'video',
    placement: 'playhead',
    recordFrame: 0,
  }), { 'Content-Type': 'application/json' })
  await assertJsonError(response, 500, 'PLACE_LINK_ROLLED_BACK')

  const events = (await readFile(server.resolveLogPath, 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(events.at(-1), {
    type: 'rollback',
    itemIds: ['appended-0', 'appended-1'],
  })
})

test('generic timeline clip Grab fails closed when both exact-trim exports fail', async (t) => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'easyfield-exact-trim-'))
  t.after(() => rm(fixtureDirectory, { force: true, recursive: true }))
  const sourcePath = path.join(fixtureDirectory, 'whole-source.mp4')
  const fakeFfmpeg = path.join(fixtureDirectory, 'ffmpeg-fail')
  await writeFile(sourcePath, Buffer.from('WHOLE SOURCE MUST NEVER BE RETURNED'))
  await writeFile(fakeFfmpeg, '#!/bin/sh\nexit 1\n')
  await chmod(fakeFfmpeg, 0o755)

  const server = await startBridgeServer({
    EF_TEST_RESOLVE_PLACEMENT: '1',
    EF_TEST_GRAB_CLIP: '1',
    EF_TEST_SOURCE_FILE: sourcePath,
    EF_FFMPEG_PATH: fakeFfmpeg,
  })
  t.after(server.stop)

  const response = await fetch(`${server.baseUrl}/bridge/grab/clip`, {
    headers: { Origin: server.baseUrl, 'X-EF-Bridge-Token': TEST_TOKEN },
  })
  assert.equal(response.status, 500)
  const payload = await response.json()
  assert.equal(payload.code, 'FFMPEG_FAILED')
  assert.match(payload.error, /full source was not substituted/i)
})

test('transition placement rejects either captured shot after trim or relink mutation', async (t) => {
  const server = await startBridgeServer({
    EF_TEST_RESOLVE_PLACEMENT: '1',
    EF_TEST_ANCHOR_FIXTURES: '1',
    EF_TEST_MUTATE_ANCHOR: 'item-7-source',
  })
  t.after(server.stop)

  const artifactDirectory = path.join(server.temporaryHome, 'Movies', 'EasyField', '_Artifacts')
  await mkdir(artifactDirectory, { recursive: true })
  const bytes = Buffer.from('synthetic transition bytes')
  const artifactId = randomUUID()
  const artifactPath = path.join(artifactDirectory, `${artifactId}.mp4`)
  await writeFile(artifactPath, bytes)
  const store = createStateStore(server.userDataPath)
  t.after(() => store.close())
  store.set('artifacts', artifactId, {
    id: artifactId,
    name: 'Transition',
    kind: 'video',
    localPath: artifactPath,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    createdAt: Date.now(),
    referenced: true,
  })

  const response = await placeRequest(server.baseUrl, JSON.stringify({
    artifactId,
    name: 'Transition',
    kind: 'video',
    placement: 'playhead',
    recordFrame: 200,
    projectId: 'project-test',
    timelineId: 'timeline-test',
    validationAnchors: [
      { itemId: 'item-7', startFrame: 100, endFrame: 200, sourceStartFrame: 20, sourceEndFrame: 119, mediaPoolItemId: 'media-7', trackIndex: 2 },
      { itemId: 'item-8', startFrame: 200, endFrame: 320, sourceStartFrame: 48, sourceEndFrame: 167, mediaPoolItemId: 'media-8', trackIndex: 2 },
    ],
  }), { 'Content-Type': 'application/json' })
  await assertJsonError(response, 409, 'TIMELINE_CHANGED')

  const events = (await readFile(server.resolveLogPath, 'utf8'))
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.deepEqual(events, [{ type: 'import', paths: [artifactPath] }])
})

test('a hung native Resolve initialization cannot hang /bridge/status', async (t) => {
  const server = await startBridgeServer({ EF_TEST_HANG_INIT: '1' })
  t.after(server.stop)
  const started = Date.now()
  const response = await bridgeRequest(server.baseUrl, {
    origin: server.baseUrl,
    token: TEST_TOKEN,
  })
  const elapsed = Date.now() - started
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, connected: false })
  assert(elapsed >= 2_000, `expected the native timeout path, got ${elapsed}ms`)
  assert(elapsed < 3_500, `status request remained hung for ${elapsed}ms`)
})

test('EF_DEV loopback origin does not bypass secure cloud proxy authentication', async (t) => {
  const server = await startBridgeServer({ EF_DEV: '1' })
  t.after(server.stop)
  const viteOrigin = 'http://localhost:5173'

  const missing = await secureProxyRequest(server.baseUrl, { origin: viteOrigin })
  await assertJsonError(missing, 401, 'UNAUTHORIZED')

  const wrong = await secureProxyRequest(server.baseUrl, {
    origin: viteOrigin,
    token: `${TEST_TOKEN}-wrong`,
  })
  await assertJsonError(wrong, 401, 'UNAUTHORIZED')

  const authenticated = await secureProxyRequest(server.baseUrl, {
    origin: viteOrigin,
    token: TEST_TOKEN,
  })
  assert.equal(authenticated.status, 401)
  const payload = await authenticated.json()
  assert.match(payload.error, /not connected/i, 'valid Main token should reach encrypted credential lookup')
})
