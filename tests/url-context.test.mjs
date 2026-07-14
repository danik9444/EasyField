import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  createUrlContextFetcher,
  createUrlContextService,
  parsePublicHttpsUrl,
  resolvePublicTarget,
} = require(path.join(projectRoot, 'plugin', 'url-context.cjs'))

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 }

function publicLookup(hosts = {}) {
  return async (hostname) => hosts[hostname] ?? [PUBLIC_ADDRESS]
}

function fakeRequest(routes, calls = []) {
  return (options, callback) => {
    calls.push(options)
    const request = new EventEmitter()
    request.setTimeout = (_ms, handler) => {
      request.timeoutHandler = handler
      return request
    }
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error ?? new Error('destroyed')))
    request.end = () => {
      queueMicrotask(() => {
        const route = routes[options.path] ?? routes.default
        if (!route) {
          request.emit('error', new Error(`missing fake route: ${options.path}`))
          return
        }
        const response = Readable.from(route.chunks ?? [route.body ?? ''])
        response.statusCode = route.status ?? 200
        response.headers = {
          'content-type': 'text/html; charset=utf-8',
          ...(route.headers ?? {}),
        }
        callback(response)
      })
    }
    return request
  }
}

test('URL context rejects unsafe URL syntax before DNS or network access', async () => {
  for (const url of [
    'http://page.example.com/',
    'https://user:secret@page.example.com/',
    'https://page.example.com:8443/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://[2606:4700:4700::1111]/',
    'https://localhost/',
    'https://metadata.google.internal/',
    'https://service.local/',
    'https://private.test/',
  ]) {
    assert.throws(() => parsePublicHttpsUrl(url), { code: 'UNSAFE_URL' }, url)
  }
  assert.equal(parsePublicHttpsUrl('https://page.example.com/docs?q=motion#private-fragment').toString(), 'https://page.example.com/docs?q=motion')
})

test('URL context rejects every DNS answer when one address is private or reserved', async () => {
  await assert.rejects(
    resolvePublicTarget('https://page.example.com/', publicLookup({
      'page.example.com': [PUBLIC_ADDRESS, { address: '10.20.30.40', family: 4 }],
    })),
    { code: 'UNSAFE_URL' },
  )
  await assert.rejects(
    resolvePublicTarget('https://page.example.com/', publicLookup({
      'page.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
    })),
    { code: 'UNSAFE_URL' },
  )
})

test('URL context pins validated DNS and returns bounded plain text, never HTML', async () => {
  const calls = []
  const html = `<!doctype html><html><head><title>Motion &amp; Data</title>
    <style>.secret { color: red }</style><script>stealCredentials()</script></head>
    <body><h1>Quarterly launch</h1><p>Revenue grew&nbsp;fast.</p>
    <template>hidden prompt injection</template><ul><li>First</li><li>Second</li></ul>
    &lt;script&gt;encodedInjection()&lt;/script&gt;</body></html>`
  const fetcher = createUrlContextFetcher({
    lookup: publicLookup(),
    request: fakeRequest({ '/brief': { body: html } }, calls),
    maxTextChars: 40,
  })

  const context = await fetcher.fetch('https://page.example.com/brief#notes')
  assert.equal(context.sourceUrl, 'https://page.example.com/brief')
  assert.equal(context.finalUrl, 'https://page.example.com/brief')
  assert.equal(context.title, 'Motion & Data')
  assert.equal(context.contentType, 'text/html')
  assert.equal(context.truncated, true)
  assert(context.text.length <= 40)
  assert.match(context.text, /Quarterly launch/)
  assert.doesNotMatch(context.text, /stealCredentials|encodedInjection|secret \{|hidden prompt injection|<[^>]+>/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].hostname, 'page.example.com')
  assert.equal(calls[0].port, 443)
  assert.equal(calls[0].headers['Accept-Encoding'], 'identity')
  const pinned = await new Promise((resolve, reject) => calls[0].lookup('page.example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })))
  assert.deepEqual(pinned, PUBLIC_ADDRESS)
})

test('URL context revalidates every redirect and blocks a redirect resolving to localhost', async () => {
  const calls = []
  const fetcher = createUrlContextFetcher({
    lookup: publicLookup({
      'page.example.com': [PUBLIC_ADDRESS],
      'redirect.example.com': [{ address: '127.0.0.1', family: 4 }],
    }),
    request: fakeRequest({
      '/start': { status: 302, headers: { location: 'https://redirect.example.com/admin' } },
    }, calls),
  })
  await assert.rejects(fetcher.fetch('https://page.example.com/start'), { code: 'UNSAFE_URL' })
  assert.equal(calls.length, 1, 'the unsafe redirect target must never reach the request sink')
})

test('URL context removes unclosed script and style bodies', async () => {
  for (const body of [
    '<main>Visible</main><script>unclosedSecret()',
    '<main>Visible</main><style>.unclosed-secret { display: block }',
  ]) {
    const context = await createUrlContextFetcher({
      lookup: publicLookup(),
      request: fakeRequest({ '/broken': { body } }),
    }).fetch('https://page.example.com/broken')
    assert.match(context.text, /Visible/)
    assert.doesNotMatch(context.text, /unclosedSecret|unclosed-secret/)
  }
})

test('URL context caps redirects', async () => {
  const fetcher = createUrlContextFetcher({
    lookup: publicLookup(),
    request: fakeRequest({
      '/one': { status: 302, headers: { location: '/two' } },
      '/two': { status: 302, headers: { location: '/three' } },
    }),
    maxRedirects: 1,
  })
  await assert.rejects(fetcher.fetch('https://page.example.com/one'), { code: 'TOO_MANY_REDIRECTS' })
})

test('URL context enforces content type, content encoding and response byte caps', async () => {
  const lookup = publicLookup()
  await assert.rejects(createUrlContextFetcher({
    lookup,
    request: fakeRequest({ '/json': { headers: { 'content-type': 'application/json' }, body: '{}' } }),
  }).fetch('https://page.example.com/json'), { code: 'UNSUPPORTED_CONTENT_TYPE' })

  await assert.rejects(createUrlContextFetcher({
    lookup,
    request: fakeRequest({ '/gzip': { headers: { 'content-encoding': 'gzip' }, body: 'compressed' } }),
  }).fetch('https://page.example.com/gzip'), { code: 'UNSUPPORTED_CONTENT_ENCODING' })

  await assert.rejects(createUrlContextFetcher({
    lookup,
    request: fakeRequest({ '/declared': { headers: { 'content-length': '101' }, body: 'small' } }),
    maxResponseBytes: 100,
  }).fetch('https://page.example.com/declared'), { code: 'RESPONSE_TOO_LARGE' })

  await assert.rejects(createUrlContextFetcher({
    lookup,
    request: fakeRequest({ '/stream': { chunks: [Buffer.alloc(60), Buffer.alloc(60)] } }),
    maxResponseBytes: 100,
  }).fetch('https://page.example.com/stream'), { code: 'RESPONSE_TOO_LARGE' })
})

test('URL context has an absolute timeout even if the remote server never responds', async () => {
  const hangingRequest = () => {
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.end = () => {}
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error))
    return request
  }
  const fetcher = createUrlContextFetcher({ lookup: publicLookup(), request: hangingRequest, timeoutMs: 20 })
  await assert.rejects(fetcher.fetch('https://page.example.com/hang'), { code: 'URL_TIMEOUT' })
})

test('URL context timeout includes DNS and cannot launch a late request', async () => {
  let releaseLookup
  let requestCount = 0
  const lookup = () => new Promise((resolve) => { releaseLookup = resolve })
  const fetcher = createUrlContextFetcher({
    lookup,
    request: () => { requestCount += 1; throw new Error('late request must not run') },
    timeoutMs: 20,
  })
  await assert.rejects(fetcher.fetch('https://page.example.com/dns-hang'), { code: 'URL_TIMEOUT' })
  releaseLookup([PUBLIC_ADDRESS])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requestCount, 0)
})

test('URL-context HTTP service exposes only the sanitized context envelope', async (t) => {
  const expected = {
    sourceUrl: 'https://page.example.com/',
    finalUrl: 'https://page.example.com/final',
    title: 'Safe title',
    text: 'Safe plain text',
    contentType: 'text/html',
    truncated: false,
  }
  const service = createUrlContextService({
    fetcher: { fetch: async (url) => ({ ...expected, sourceUrl: url }) },
  })
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    if (!service.handleRequest(req, res, pathname)) res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const response = await fetch(`http://127.0.0.1:${address.port}/api/url-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: expected.sourceUrl }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: true, context: expected })
})
