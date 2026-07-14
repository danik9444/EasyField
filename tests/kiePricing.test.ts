import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fetchModelPrices } from '../src/services/kie.ts'

const originalFetch = globalThis.fetch

after(() => {
  globalThis.fetch = originalFetch
})

test('live pricing fetch follows every public pricing page without authentication', async () => {
  const calls: Array<{ pageNum: number; authorization: string | null }> = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { pageNum: number }
    const headers = new Headers(init?.headers)
    calls.push({ pageNum: body.pageNum, authorization: headers.get('Authorization') })
    const description = body.pageNum === 1 ? 'Model A, 1K' : 'Model B, 720p'
    return new Response(JSON.stringify({
      code: 200,
      data: {
        pages: 2,
        records: [{
          modelDescription: description,
          interfaceType: 'image',
          provider: 'Kie',
          creditPrice: body.pageNum === 1 ? '5.5' : '20',
          creditUnit: body.pageNum === 1 ? 'per image' : 'per second',
          usdPrice: body.pageNum === 1 ? '0.0275' : '',
          anchor: '',
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  const rows = await fetchModelPrices()
  assert.deepEqual(calls.map((call) => call.pageNum), [1, 2])
  assert.ok(calls.every((call) => call.authorization == null))
  assert.deepEqual(rows.map((row) => [row.modelDescription, row.credits, row.usd]), [
    ['Model A, 1K', 5.5, 0.0275],
    ['Model B, 720p', 20, null],
  ])
})
