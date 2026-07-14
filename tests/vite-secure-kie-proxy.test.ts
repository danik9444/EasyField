import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import {
  createSecureKieDevMiddleware,
  SECURE_KIE_PROXY_TOKEN,
} from '../vite-plugin-secure-kie.ts'

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

test('Vite routes only Electron sentinel requests back through secure Main', async (t) => {
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
  const middleware = createSecureKieDevMiddleware(mainPort)
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

  const sentinel = `Bearer ${SECURE_KIE_PROXY_TOKEN}`
  const account = await call(vitePort, '/kie/api/v1/chat/credit?source=dev', sentinel)
  assert.equal(account.status, 200)
  assert.deepEqual(JSON.parse(account.body), { proxiedByMain: true })

  const uploadBody = JSON.stringify({ file: 'synthetic-data-only' })
  const upload = await call(vitePort, '/kie-upload/api/file-base64-upload', sentinel, uploadBody)
  assert.equal(upload.status, 200)

  assert.deepEqual(captured, [
    {
      method: 'GET',
      url: '/kie/api/v1/chat/credit?source=dev',
      authorization: sentinel,
      bridgeToken: 'synthetic-main-boundary-token',
      body: '',
    },
    {
      method: 'POST',
      url: '/kie-upload/api/file-base64-upload',
      authorization: sentinel,
      bridgeToken: 'synthetic-main-boundary-token',
      body: uploadBody,
    },
  ])

  // A browser-only Vite session owns its raw key in sessionStorage. It must
  // continue to the existing direct provider proxy, never through Electron.
  const browser = await call(vitePort, '/kie/api/v1/chat/credit', 'Bearer synthetic-browser-session-key')
  assert.equal(browser.status, 204)
  assert.equal(fallthroughs, 1)
  assert.equal(captured.length, 2)

  // The sentinel is scoped to the two provider routes, not a general-purpose
  // tunnel into Main.
  const unrelated = await call(vitePort, '/api/render', sentinel)
  assert.equal(unrelated.status, 204)
  assert.equal(fallthroughs, 2)
  assert.equal(captured.length, 2)
})
