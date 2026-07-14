import assert from 'node:assert/strict'
import test from 'node:test'
import { canBackgroundJob, canCancelJob, cancelJob, continueJobInBackground, getJobs, hydrateJobs, removeJob, retryJobRecovery, startJob } from '../src/services/jobCenter.ts'
import { getCreations, removeCreations } from '../src/data/creations.ts'
import { setCurrentApiKey } from '../src/settings.ts'

test('a cancelled job cannot be resurrected by late provider callbacks', () => {
  let cancelled = false
  const job = startJob({ title: 'Late callback test', kind: 'image', onCancel: () => { cancelled = true } })

  assert.equal(cancelJob(job.id), 'cancelled')
  assert.equal(cancelJob(job.id), 'terminal')
  job.update({ status: 'running', detail: 'Late poll' })
  job.succeed(1)

  const record = getJobs().find((item) => item.id === job.id)
  assert.equal(cancelled, true)
  assert.equal(record?.status, 'cancelled')
  assert.equal(record?.detail, 'Cancelled')
  removeJob(job.id)
})

test('accepted provider work keeps tracking instead of offering false cancellation', async () => {
  let cancelled = false
  const job = startJob({ title: 'Accepted task test', kind: 'video', onCancel: () => { cancelled = true } })
  await assert.rejects(job.acceptTask('provider-task-1', 'jobs'), /ledger was not ready/i)

  const cancellation = cancelJob(job.id)
  let record = getJobs().find((item) => item.id === job.id)
  assert.equal(cancellation, 'already-submitted')
  assert.equal(cancelled, false)
  assert.equal(record?.status, 'running')
  assert.match(record?.detail ?? '', /tracking continues/i)
  assert.equal(canCancelJob(record!), false)
  assert.equal(canBackgroundJob(record!), true)
  assert.equal(continueJobInBackground(job.id), 'backgrounded')

  job.succeed(1)
  record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'succeeded')
  removeJob(job.id)
})

test('inline micro-jobs persist their opt-out while normal jobs default to Activity auto-open', () => {
  const audition = startJob({ title: 'Voice audition', kind: 'audio', autoOpen: false })
  const normal = startJob({ title: 'Full generation', kind: 'audio' })
  assert.equal(getJobs().find((job) => job.id === audition.id)?.autoOpen, false)
  assert.equal(getJobs().find((job) => job.id === normal.id)?.autoOpen, true)
  removeJob(audition.id)
  removeJob(normal.id)
})

test('restart recovery resumes every persisted provider family without submitting paid work again', async (t) => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  const storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    globalThis.fetch = originalFetch
    setCurrentApiKey('')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  const now = Date.now()
  storage.setItem('ef-state:jobs:ledger', JSON.stringify([
    {
      id: 'persisted-fanout',
      title: 'Persisted fan-out',
      kind: 'audio',
      status: 'running',
      submissionState: 'accepted',
      startedAt: now,
      updatedAt: now,
      providerTasks: [
        { taskId: 'market-task', family: 'jobs' },
        { taskId: 'music-task', family: 'suno' },
        { taskId: 'sound-task', family: 'sounds' },
      ],
    },
    {
      id: 'ambiguous-submission',
      title: 'Interrupted submission',
      kind: 'video',
      status: 'queued',
      submissionState: 'submitting',
      startedAt: now - 1,
      updatedAt: now - 1,
    },
  ]))
  setCurrentApiKey('synthetic-test-key')

  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/jobs/recordInfo')) {
      return new Response(JSON.stringify({
        code: 200,
        data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/recovered.png'] }) },
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/generate/record-info')) {
      return new Response(JSON.stringify({
        code: 200,
        data: {
          status: 'SUCCESS',
          response: { sunoData: [{ audioUrl: url.includes('sound-task') ? 'https://cdn.example/recovered-effect.mp3' : 'https://cdn.example/recovered.mp3' }] },
        },
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  await hydrateJobs()

  assert.deepEqual(calls.sort(), [
    '/provider/api/v1/generate/record-info?taskId=music-task',
    '/provider/api/v1/generate/record-info?taskId=sound-task',
    '/provider/api/v1/jobs/recordInfo?taskId=market-task',
  ])
  const resubmittedPaidWork = calls.some((url) => url.includes('createTask') || url.endsWith('/generate'))
  assert.equal(resubmittedPaidWork, false, 'recovery must never submit paid work again')
  const recovered = getJobs().find((job) => job.id === 'persisted-fanout')
  assert.equal(recovered?.status, 'succeeded')
  assert.equal(recovered?.resultCount, 3)
  const ambiguous = getJobs().find((job) => job.id === 'ambiguous-submission')
  assert.equal(ambiguous?.status, 'failed')
  assert.match(ambiguous?.detail ?? '', /outcome unknown/i)
  assert.match(ambiguous?.error ?? '', /task ID/i)
  const creationIds = getCreations()
    .filter((creation) => creation.prompt === 'Recovered after restart')
    .map((creation) => creation.id)
  assert.equal(creationIds.length, 3)
  removeCreations(creationIds)
  removeJob('persisted-fanout')
  removeJob('ambiguous-submission')
})

test('partial restart recovery preserves completed results and keeps only unresolved paid tasks retryable', async (t) => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, value) },
    },
  })
  t.after(() => {
    globalThis.fetch = originalFetch
    setCurrentApiKey('')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  const job = startJob({ title: 'Partial recovery', kind: 'audio' })
  await job.acceptTask('market-part', 'jobs')
  await job.acceptTask('suno-part', 'suno')
  setCurrentApiKey('synthetic-test-key')

  let sunoRecovered = false
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/jobs/recordInfo')) {
      return new Response(JSON.stringify({
        code: 200,
        data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/partial.png'] }) },
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (!sunoRecovered) {
      return new Response(JSON.stringify({ code: 401, msg: 'Temporary credential problem', data: null }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      code: 200,
      data: { status: 'SUCCESS', response: { sunoData: [{ audioUrl: 'https://cdn.example/partial.mp3' }] } },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  await retryJobRecovery(job.id)
  let record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'queued')
  assert.equal(record?.resultCount, 1)
  assert.deepEqual(record?.providerTasks, [{ taskId: 'suno-part', family: 'suno' }])

  sunoRecovered = true
  await retryJobRecovery(job.id)
  record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'succeeded')
  assert.equal(record?.resultCount, 2)
  assert.equal(calls.filter((url) => url.includes('/jobs/recordInfo')).length, 1, 'completed siblings must not be polled twice')
  assert.equal(calls.filter((url) => url.includes('/generate/record-info')).length, 2)

  const creationIds = getCreations()
    .filter((creation) => creation.prompt === 'Recovered after restart')
    .map((creation) => creation.id)
  removeCreations(creationIds)
  removeJob(job.id)
})

test('explicit provider failure becomes terminal instead of retrying forever', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    setCurrentApiKey('')
  })

  const job = startJob({ title: 'Provider terminal failure', kind: 'video' })
  await job.acceptTask('failed-provider-task', 'jobs')
  setCurrentApiKey('synthetic-test-key')
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 200,
    data: { state: 'fail', failMsg: 'Provider rejected the source media' },
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  await retryJobRecovery(job.id)
  const record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'failed')
  assert.match(record?.error ?? '', /rejected the source/i)
  removeJob(job.id)
})

test('submitting is persisted as a non-cancellable boundary and can detach to background', async () => {
  let cancelled = 0
  let backgrounded = 0
  const job = startJob({
    title: 'Submission boundary',
    kind: 'image',
    onCancel: () => { cancelled += 1 },
    onBackground: () => { backgrounded += 1 },
  })

  await job.beginSubmission()
  let record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.submissionState, 'submitting')
  assert.equal(canCancelJob(record!), false)
  assert.equal(canBackgroundJob(record!), true)
  assert.equal(cancelJob(job.id), 'already-submitted')
  assert.equal(cancelled, 0)
  assert.equal(continueJobInBackground(job.id), 'backgrounded')
  assert.equal(backgrounded, 1)

  job.fail(new Error('Synthetic provider refusal'))
  record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'failed')
  removeJob(job.id)
})

test('settled fan-out children leave only unresolved accepted tasks recoverable', async () => {
  const job = startJob({ title: 'Fan-out child ledger', kind: 'image' })
  await job.acceptTask('finished-child', 'jobs')
  await job.acceptTask('pending-child', 'jobs')
  await job.settleTask('finished-child', 'jobs')

  let record = getJobs().find((item) => item.id === job.id)
  assert.deepEqual(record?.providerTasks, [{ taskId: 'pending-child', family: 'jobs' }])
  assert.equal(record?.taskId, 'pending-child')

  job.pause(new Error('Temporary tracking failure'))
  record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'queued')
  assert.match(record?.error ?? '', /tracking failure/i)
  assert.equal(canCancelJob(record!), false)
  assert.equal(canBackgroundJob(record!), true)

  job.fail(new Error('Synthetic cleanup'))
  removeJob(job.id)
})

test('restart recovery keeps a paid task retryable until its result is verified in Artifact Store', async (t) => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let rejectArtifact = true
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      easyfield: {
        plugin: true,
        artifacts: {
          ingestUrl: async () => {
            if (rejectArtifact) throw new Error('Synthetic disk-full failure')
            return {
              id: 'd70d4f1c-79e7-410e-8282-696e14dc9aea',
              url: '/artifacts/d70d4f1c-79e7-410e-8282-696e14dc9aea',
              checksum: 'b'.repeat(64),
            }
          },
        },
      },
    },
  })
  setCurrentApiKey('synthetic-test-key')
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 200,
    data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/paid-result.png'] }) },
  }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    setCurrentApiKey('')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const job = startJob({ title: 'Artifact recovery gate', kind: 'image' })
  await job.acceptTask('paid-artifact-task', 'jobs')

  await retryJobRecovery(job.id)
  let record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'queued')
  assert.deepEqual(record?.providerTasks, [{ taskId: 'paid-artifact-task', family: 'jobs' }])
  assert.equal(record?.resultUrls, undefined)

  rejectArtifact = false
  await retryJobRecovery(job.id)
  record = getJobs().find((item) => item.id === job.id)
  assert.equal(record?.status, 'succeeded')
  assert.deepEqual(record?.resultUrls, ['/artifacts/d70d4f1c-79e7-410e-8282-696e14dc9aea'])
  const recovered = getCreations().find((creation) => creation.url === record?.resultUrls?.[0])
  assert.ok(recovered)
  assert.equal(recovered.durability, 'local')

  removeCreations([recovered.id])
  removeJob(job.id)
})
