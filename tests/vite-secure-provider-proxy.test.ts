import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import {
  createSecureProviderDevMiddleware,
  SECURE_ACCOUNT_PROXY_TOKEN,
  SECURE_PROVIDER_PROXY_TOKEN,
} from '../vite-plugin-secure-provider.ts'

interface CapturedRequest {
  method: string
  url: string
  authorization: string
  bridgeToken: string
  body: string
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  return address.port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function call(
  port: number,
  path: string,
  authorization: string,
  body = '',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: authorization,
        Origin: 'http://localhost:5173',
        'X-EF-Bridge-Token': 'synthetic-main-boundary-token',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let output = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { output += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: output }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('Vite routes both Electron sentinels through Main and blocks implicit direct credentials', async (t) => {
  const captured: CapturedRequest[] = []
  const main = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization ?? '',
        bridgeToken: String(req.headers['x-ef-bridge-token'] ?? ''),
        body,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ proxiedByMain: true }))
    })
  })
  const mainPort = await listen(main)

  let fallthroughs = 0
  const middleware = createSecureProviderDevMiddleware(mainPort)
  const vite = createServer((req, res) => middleware(req, res, () => {
    fallthroughs += 1
    res.writeHead(204)
    res.end()
  }))
  const vitePort = await listen(vite)
  t.after(async () => {
    await close(vite)
    await close(main)
  })

  const directSentinel = `Bearer ${SECURE_PROVIDER_PROXY_TOKEN}`
  const accountSentinel = `Bearer ${SECURE_ACCOUNT_PROXY_TOKEN}`
  const direct = await call(vitePort, '/provider/api/v1/chat/credit?source=direct', directSentinel)
  assert.equal(direct.status, 200)
  assert.deepEqual(JSON.parse(direct.body), { proxiedByMain: true })

  const account = await call(vitePort, '/provider/api/v1/chat/credit?source=account', accountSentinel)
  assert.equal(account.status, 200)
  assert.deepEqual(JSON.parse(account.body), { proxiedByMain: true })

  const uploadBody = JSON.stringify({ file: 'synthetic-data-only' })
  const directUpload = await call(
    vitePort,
    '/provider-upload/api/file-base64-upload?source=direct',
    directSentinel,
    uploadBody,
  )
  assert.equal(directUpload.status, 200)
  const accountUpload = await call(
    vitePort,
    '/provider-upload/api/file-base64-upload?source=account',
    accountSentinel,
    uploadBody,
  )
  assert.equal(accountUpload.status, 200)

  assert.deepEqual(captured, [
    {
      method: 'GET',
      url: '/provider/api/v1/chat/credit?source=direct',
      authorization: directSentinel,
      bridgeToken: 'synthetic-main-boundary-token',
      body: '',
    },
    {
      method: 'GET',
      url: '/provider/api/v1/chat/credit?source=account',
      authorization: accountSentinel,
      bridgeToken: 'synthetic-main-boundary-token',
      body: '',
    },
    {
      method: 'POST',
      url: '/provider-upload/api/file-base64-upload?source=direct',
      authorization: directSentinel,
      bridgeToken: 'synthetic-main-boundary-token',
      body: uploadBody,
    },
    {
      method: 'POST',
      url: '/provider-upload/api/file-base64-upload?source=account',
      authorization: accountSentinel,
      bridgeToken: 'synthetic-main-boundary-token',
      body: uploadBody,
    },
  ])

  // A raw browser key cannot silently fall through to the direct provider
  // proxy. Browser-only development must opt in explicitly.
  const browser = await call(vitePort, '/provider/api/v1/chat/credit', 'Bearer synthetic-browser-session-key')
  assert.equal(browser.status, 403)
  assert.equal(JSON.parse(browser.body).code, 'PLUGIN_PROXY_AUTH_REQUIRED')
  assert.equal(fallthroughs, 0)
  assert.equal(captured.length, 4)

  // The sentinel is scoped to the two provider routes, not a general-purpose
  // tunnel into Main.
  const unrelated = await call(vitePort, '/api/render', accountSentinel)
  assert.equal(unrelated.status, 204)
  assert.equal(fallthroughs, 1)
  assert.equal(captured.length, 4)

  const publicPricing = await call(vitePort, '/provider/client/v1/model-pricing/page', '')
  assert.equal(publicPricing.status, 204)
  assert.equal(fallthroughs, 2)
  assert.equal(captured.length, 4)

  const unauthenticatedTask = await call(vitePort, '/provider/api/v1/jobs/createTask', '')
  assert.equal(unauthenticatedTask.status, 403)
  assert.equal(fallthroughs, 2)
})

test('browser direct credentials fall through only with an explicit development opt-in', async (t) => {
  let fallthroughs = 0
  const middleware = createSecureProviderDevMiddleware(18_832, { allowBrowserDirect: true })
  const vite = createServer((req, res) => middleware(req, res, () => {
    fallthroughs += 1
    res.writeHead(204)
    res.end()
  }))
  const vitePort = await listen(vite)
  t.after(async () => close(vite))

  const browser = await call(vitePort, '/provider/api/v1/chat/credit', 'Bearer synthetic-browser-session-key')
  assert.equal(browser.status, 204)
  assert.equal(fallthroughs, 1)

  const missing = await call(vitePort, '/provider/api/v1/chat/credit', '')
  assert.equal(missing.status, 403)
  assert.equal(JSON.parse(missing.body).code, 'PLUGIN_PROXY_AUTH_REQUIRED')
  assert.equal(fallthroughs, 1)
})
