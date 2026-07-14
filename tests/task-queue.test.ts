import assert from 'node:assert/strict'
import test from 'node:test'
import { createLimiter, createStartRateLimiter } from '../src/services/taskQueue.ts'

test('provider start limiter preserves every task while enforcing a rolling window', async () => {
  const gate = createStartRateLimiter(2, 30)
  const starts: number[] = []
  await Promise.all(Array.from({ length: 5 }, (_, index) => gate(async () => {
    starts[index] = Date.now()
    return index
  })))

  assert.equal(starts.length, 5)
  assert(starts[2] - starts[0] >= 24, `third start was only ${starts[2] - starts[0]}ms after the first`)
  assert(starts[4] - starts[2] >= 24, `fifth start was only ${starts[4] - starts[2]}ms after the third`)
})

test('a cancelled queued start never invokes its provider request', async () => {
  const gate = createStartRateLimiter(1, 50)
  await gate(async () => undefined)
  const controller = new AbortController()
  let invoked = false
  const queued = gate(async () => { invoked = true }, controller.signal)
  controller.abort()
  await assert.rejects(queued, /Cancelled/)
  assert.equal(invoked, false)
})

test('a cancelled concurrency ticket is removed without waiting for an active generation', async () => {
  const gate = createLimiter(1)
  let releaseActive!: () => void
  const active = gate(() => new Promise<void>((resolve) => { releaseActive = resolve }))
  const controller = new AbortController()
  let invoked = false
  const queued = gate(async () => { invoked = true }, controller.signal)

  controller.abort()
  await assert.rejects(queued, /Cancelled/)
  assert.equal(invoked, false)
  releaseActive()
  await active
})
