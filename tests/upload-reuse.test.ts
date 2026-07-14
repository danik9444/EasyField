import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createUploadReuseCache } from '../src/services/uploadReuse.ts'

test('concurrent subscribers upload one blob and reuse its hosted URL', async () => {
  const cache = createUploadReuseCache({ ttlMs: 1_000, maxReadyEntries: 8 })
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const upload = async () => {
    calls += 1
    await gate
    return 'https://cdn.example/reference.png'
  }

  const first = cache.getOrUpload('blob:shared-reference', undefined, upload)
  const second = cache.getOrUpload('blob:shared-reference', undefined, upload)
  await delay(0)
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    'https://cdn.example/reference.png',
    'https://cdn.example/reference.png',
  ])

  assert.equal(await cache.getOrUpload('blob:shared-reference', undefined, upload), 'https://cdn.example/reference.png')
  assert.equal(calls, 1)
  cache.clear()
})

test('one cancelled subscriber does not abort an upload still needed by a sibling', async () => {
  const cache = createUploadReuseCache({ ttlMs: 1_000, maxReadyEntries: 8 })
  const firstController = new AbortController()
  const secondController = new AbortController()
  let transportAborted = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const upload = async (signal: AbortSignal) => {
    signal.addEventListener('abort', () => { transportAborted = true }, { once: true })
    await gate
    return 'https://cdn.example/reference.png'
  }

  const first = cache.getOrUpload('blob:shared-reference', firstController.signal, upload)
  const second = cache.getOrUpload('blob:shared-reference', secondController.signal, upload)
  firstController.abort()
  await assert.rejects(first, /Cancelled/)
  assert.equal(transportAborted, false)
  release()
  assert.equal(await second, 'https://cdn.example/reference.png')
  assert.equal(transportAborted, false)
  cache.clear()
})

test('failed uploads are removed so a later caller can retry cleanly', async () => {
  const cache = createUploadReuseCache({ ttlMs: 1_000, maxReadyEntries: 8 })
  let calls = 0
  const upload = async () => {
    calls += 1
    if (calls === 1) throw new Error('temporary upload failure')
    return 'https://cdn.example/recovered.png'
  }

  const first = cache.getOrUpload('blob:retry-reference', undefined, upload)
  const sibling = cache.getOrUpload('blob:retry-reference', undefined, upload)
  await assert.rejects(first, /temporary upload failure/)
  await assert.rejects(sibling, /temporary upload failure/)
  assert.equal(cache.size, 0)
  assert.equal(await cache.getOrUpload('blob:retry-reference', undefined, upload), 'https://cdn.example/recovered.png')
  assert.equal(calls, 2)
  cache.clear()
})

test('the transport is aborted and the entry removed when every subscriber cancels', async () => {
  const cache = createUploadReuseCache({ ttlMs: 1_000, maxReadyEntries: 8 })
  const controller = new AbortController()
  let transportAborted = false
  const upload = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      transportAborted = true
      reject(new Error('transport cancelled'))
    }, { once: true })
  })

  const pending = cache.getOrUpload('blob:cancelled-reference', controller.signal, upload)
  await delay(0)
  controller.abort()
  await assert.rejects(pending, /Cancelled/)
  await delay(0)
  assert.equal(transportAborted, true)
  assert.equal(cache.size, 0)
  cache.clear()
})

test('ready uploads expire after the TTL and are uploaded again', async () => {
  const cache = createUploadReuseCache({ ttlMs: 40, maxReadyEntries: 8 })
  let calls = 0
  const upload = async () => `https://cdn.example/reference-${++calls}.png`

  assert.equal(await cache.getOrUpload('blob:expiring-reference', undefined, upload), 'https://cdn.example/reference-1.png')
  assert.equal(await cache.getOrUpload('blob:expiring-reference', undefined, upload), 'https://cdn.example/reference-1.png')
  await delay(70)
  assert.equal(cache.size, 0)
  assert.equal(await cache.getOrUpload('blob:expiring-reference', undefined, upload), 'https://cdn.example/reference-2.png')
  cache.clear()
})
