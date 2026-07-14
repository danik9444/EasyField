import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AnimationUrlContextError,
  fetchAnimationUrlContext,
} from '../src/services/urlContext.ts'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('renderer URL-context service uses the local endpoint and returns sanitized text', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedInit = init
    return new Response(JSON.stringify({
      ok: true,
      context: {
        sourceUrl: 'https://page.example.com/',
        finalUrl: 'https://page.example.com/final',
        title: 'Example',
        text: 'Plain text only',
        contentType: 'text/html',
        truncated: false,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  const result = await fetchAnimationUrlContext('https://page.example.com/')
  assert.equal(capturedUrl, '/api/url-context')
  assert.equal(capturedInit?.method, 'POST')
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { url: 'https://page.example.com/' })
  assert.equal(result.text, 'Plain text only')
  assert.equal('html' in result, false)
})

test('renderer URL-context service preserves safe backend error codes', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: false,
    error: 'This URL host is not allowed.',
    code: 'UNSAFE_URL',
  }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  await assert.rejects(
    fetchAnimationUrlContext('https://localhost/'),
    (error: unknown) => error instanceof AnimationUrlContextError
      && error.code === 'UNSAFE_URL'
      && error.status === 400,
  )
})

test('renderer rejects an unexpected raw-HTML response field', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    context: {
      sourceUrl: 'https://page.example.com/',
      finalUrl: 'https://page.example.com/',
      title: 'Unsafe',
      text: 'text',
      html: '<script>unsafe()</script>',
      contentType: 'text/html',
      truncated: false,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  await assert.rejects(fetchAnimationUrlContext('https://page.example.com/'), {
    code: 'INVALID_RESPONSE',
  })
})
