import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

const baseUrl = 'http://127.0.0.1:3210/tools/beat-detection'
let vite: ViteDevServer
let saveUrl: (url: string, filename: string) => void
let validatedDownloadUrl: (rawUrl: string, baseUrl: string) => string

before(async () => {
  vite = await createViteServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    root: process.cwd(),
    server: { middlewareMode: true },
  })
  const run = await vite.ssrLoadModule('/src/services/run.ts')
  saveUrl = run.saveUrl
  validatedDownloadUrl = run.validatedDownloadUrl
})

after(async () => {
  await vite?.close()
})

test('download URLs allow blob, HTTPS and authenticated same-origin relative artifacts', () => {
  assert.equal(
    validatedDownloadUrl('blob:http://127.0.0.1:3210/52dfb3c4', baseUrl),
    'blob:http://127.0.0.1:3210/52dfb3c4',
  )
  assert.equal(
    validatedDownloadUrl('https://cdn.example/result.mp4', baseUrl),
    'https://cdn.example/result.mp4',
  )
  assert.equal(
    validatedDownloadUrl('/artifacts/4ae1141c-a68f-4d6a-9444-b623bd21525e', baseUrl),
    'http://127.0.0.1:3210/artifacts/4ae1141c-a68f-4d6a-9444-b623bd21525e',
  )
})

test('download URLs reject executable, local, insecure and network-path schemes', () => {
  for (const candidate of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'http://cdn.example/result.mp4',
    '//cdn.example/result.mp4',
    '',
  ]) {
    assert.throws(
      () => validatedDownloadUrl(candidate, baseUrl),
      /only blob:, https:, and same-origin relative URLs are allowed/,
      candidate,
    )
  }
})

test('saveUrl validates before touching the DOM and preserves safe filenames', (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const anchor = {
    href: '',
    download: '',
    rel: '',
    target: '',
    clicked: false,
    removed: false,
    click() { this.clicked = true },
    remove() { this.removed = true },
  }
  let createCount = 0
  let appended = false
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      baseURI: baseUrl,
      createElement(tag: string) {
        assert.equal(tag, 'a')
        createCount += 1
        return anchor
      },
      body: {
        appendChild(node: unknown) {
          assert.equal(node, anchor)
          appended = true
        },
      },
    },
  })
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete (globalThis as { document?: unknown }).document
  })

  assert.throws(() => saveUrl('javascript:alert(1)', 'unsafe.html'), /Unsafe download URL/)
  assert.equal(createCount, 0)

  saveUrl('/artifacts/safe-audio', 'voice over (final).wav')
  assert.equal(anchor.href, 'http://127.0.0.1:3210/artifacts/safe-audio')
  assert.equal(anchor.download, 'voice over (final).wav')
  assert.equal(anchor.rel, 'noreferrer')
  assert.equal(anchor.target, '_blank')
  assert.equal(anchor.clicked, true)
  assert.equal(anchor.removed, true)
  assert.equal(appended, true)
})
