import assert from 'node:assert/strict'
import test from 'node:test'
import { readAnimationRenderResult } from '../src/services/animationRenderResult.ts'

test('packaged animation render accepts only an opaque managed artifact receipt', async () => {
  const artifactUrl = '/artifacts/8c560c3a-d511-40c9-b497-5d23d46a8c63'
  const result = await readAnimationRenderResult(new Response(
    JSON.stringify({ ok: true, artifactUrl }),
    { headers: { 'Content-Type': 'application/json' } },
  ))
  assert.deepEqual(result, { url: artifactUrl, managed: true })

  await assert.rejects(
    readAnimationRenderResult(new Response(
      JSON.stringify({ ok: true, artifactUrl: 'file:///private/output.mp4' }),
      { headers: { 'Content-Type': 'application/json' } },
    )),
    /invalid local artifact receipt/i,
  )
})

test('development animation render keeps a real MP4 Blob preview fallback', async () => {
  const result = await readAnimationRenderResult(new Response(
    new Blob([Buffer.from('synthetic-mp4')], { type: 'video/mp4' }),
    { headers: { 'Content-Type': 'video/mp4' } },
  ))
  try {
    assert.equal(result.managed, false)
    assert.match(result.url, /^blob:/)
  } finally {
    URL.revokeObjectURL(result.url)
  }
})
