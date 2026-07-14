import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createTask, neutralizeProviderMessage, ProviderError, pollTask, resumeProviderModel, runProviderModel, uploadDataUrl } from '../src/services/providerGateway.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('provider copy sanitizer removes only the standalone legacy brand token', () => {
  const branded = globalThis.atob('S2llLmFpIHJlcXVlc3QgZmFpbGVk')
  assert.equal(neutralizeProviderMessage(branded), 'cloud provider request failed')
  assert.equal(neutralizeProviderMessage('cookie rejected'), 'cookie rejected')
})

test('Market polling surfaces an unrecoverable read response as retryable tracking state after one read', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return json({ code: 401, msg: 'Unauthorized', data: null })
  }) as typeof fetch

  await assert.rejects(
    pollTask('not-a-real-key', 'existing-task', { intervalMs: 1, timeoutMs: 100 }),
    (error: unknown) => error instanceof ProviderError
      && error.code === 401
      && error.kind === 'tracking-recoverable'
      && error.message === 'Unauthorized',
  )
  assert.equal(calls, 1)
})

test('Market polling retries a transient read without creating another task', async () => {
  let calls = 0
  const retries: number[] = []
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) return json({ code: 503, msg: 'Busy', data: null }, 503)
    return json({
      code: 200,
      data: {
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/result.png'] }),
        creditsConsumed: 4,
      },
    })
  }) as typeof fetch

  const result = await pollTask('key', 'existing-task', {
    intervalMs: 1,
    timeoutMs: 100,
    onRetry: (attempt) => retries.push(attempt),
  })
  assert.equal(calls, 2)
  assert.deepEqual(retries, [1])
  assert.deepEqual(result.urls, ['https://cdn.example/result.png'])
  assert.equal(result.creditsConsumed, 4)
})

test('Market polling extracts OmniHuman subject masks from resultObject', async () => {
  globalThis.fetch = (async () => json({
    code: 200,
    data: {
      state: 'success',
      resultJson: JSON.stringify({
        resultObject: {
          mask_urls: [
            'https://cdn.example/subject-left.png',
            null,
            'https://cdn.example/subject-right.png',
          ],
        },
      }),
      creditsConsumed: 1,
    },
  })) as typeof fetch

  const result = await pollTask('key', 'subject-detection-task', { intervalMs: 1, timeoutMs: 100 })
  assert.deepEqual(result.urls, [
    'https://cdn.example/subject-left.png',
    'https://cdn.example/subject-right.png',
  ])
  assert.equal(result.creditsConsumed, 1)
})

test('Market hard-fail state is never retried', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return json({ code: 200, data: { state: 'fail', failMsg: 'Provider rejected media' } })
  }) as typeof fetch

  await assert.rejects(
    pollTask('key', 'existing-task', { intervalMs: 1, timeoutMs: 100 }),
    (error: unknown) => error instanceof ProviderError
      && error.kind === 'provider-terminal'
      && error.message === 'Provider rejected media',
  )
  assert.equal(calls, 1)
})

test('Ambiguous createTask network failure is never submitted twice', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    throw new TypeError('socket closed')
  }) as typeof fetch

  await assert.rejects(
    createTask('key', 'model', { prompt: 'test' }),
    (error: unknown) => error instanceof ProviderError
      && error.kind === 'submission-uncertain'
      && /outcome is unknown/i.test(error.message),
  )
  assert.equal(calls, 1)
})

test('submission lifecycle is awaited before a paid create request leaves the app', async () => {
  let lifecyclePersisted = false
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    assert.equal(lifecyclePersisted, true, 'submission state must be durable before fetch')
    return json({ code: 200, data: { taskId: 'lifecycle-task' } })
  }) as typeof fetch

  const taskId = await createTask('key', 'model', { prompt: 'test' }, {
    onSubmissionStarted: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      lifecyclePersisted = true
    },
  })

  assert.equal(taskId, 'lifecycle-task')
  assert.equal(fetchCalls, 1)
})

test('cancellation during local submission preflight sends no provider request', async () => {
  const controller = new AbortController()
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return json({ code: 200, data: { taskId: 'should-not-exist' } })
  }) as typeof fetch

  await assert.rejects(
    createTask('key', 'model', { prompt: 'test' }, {
      signal: controller.signal,
      onSubmissionStarted: () => controller.abort(),
    }),
    /Cancelled/,
  )
  assert.equal(fetchCalls, 0)
})

test('grabbed timeline PNGs receive a provider-readable filename extension before upload', async () => {
  let uploadedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    uploadedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return json({ code: 200, data: { downloadUrl: 'https://cdn.example/timeline-frame.png' } })
  }) as typeof fetch

  const result = await uploadDataUrl(
    'key',
    'data:image/png;base64,iVBORw0KGgo=',
    'Timeline · 01:02:03:04',
  )

  assert.equal(result, 'https://cdn.example/timeline-frame.png')
  assert.equal(uploadedBody?.fileName, 'Timeline · 01:02:03:04.png')
})

test('grabbed clip media uses its Data URL MIME when the Resolve label has no extension', async () => {
  const uploadedNames: unknown[] = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    uploadedNames.push((JSON.parse(String(init?.body)) as Record<string, unknown>).fileName)
    return json({ code: 200, data: { downloadUrl: 'https://cdn.example/reference' } })
  }) as typeof fetch

  await uploadDataUrl('key', 'data:video/mp4;base64,AAAA', 'Interview.mov · 01:02:03:04')
  await uploadDataUrl('key', 'data:audio/wav;base64,AAAA', 'Interview · 01:02:03:04')
  await uploadDataUrl('key', 'data:image/jpeg;base64,AAAA', 'uploaded-reference.jpeg')

  assert.deepEqual(uploadedNames, [
    'Interview.mov · 01:02:03:04.mp4',
    'Interview · 01:02:03:04.wav',
    'uploaded-reference.jpeg',
  ])
})

test('unknown grab MIME omits an extensionless filename so the endpoint can infer one', async () => {
  let uploadedBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    uploadedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return json({ code: 200, data: { downloadUrl: 'https://cdn.example/generated-name' } })
  }) as typeof fetch

  await uploadDataUrl('key', 'data:application/octet-stream;base64,AAAA', 'Timeline · 01:02:03:04')

  assert.equal(Object.hasOwn(uploadedBody ?? {}, 'fileName'), false)
})

test('Dedicated polling also surfaces permanent errors without retrying creation', async () => {
  let createCalls = 0
  let pollCalls = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/generate/record-info')) {
      pollCalls += 1
      return json({ code: 403, msg: 'Forbidden', data: null })
    }
    createCalls += 1
    return json({ code: 200, data: { taskId: 'accepted-task' } })
  }) as typeof fetch

  await assert.rejects(
    runProviderModel('key', { family: 'suno', body: { prompt: 'test' } }, { intervalMs: 1, timeoutMs: 100 }),
    (error: unknown) => error instanceof ProviderError && error.code === 403,
  )
  assert.equal(createCalls, 1)
  assert.equal(pollCalls, 1)
})

test('resumeProviderModel uses a dedicated record endpoint and never creates another paid task', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    assert.match(url, /\/api\/v1\/generate\/record-info\?taskId=paid-task$/)
    return json({
      code: 200,
      data: {
        status: 'SUCCESS',
        response: { sunoData: [{ audioUrl: 'https://cdn.example/song.mp3' }] },
        creditsConsumed: 12,
      },
    })
  }) as typeof fetch

  const result = await resumeProviderModel('key', 'suno', 'paid-task', { intervalMs: 1, timeoutMs: 100 })
  assert.deepEqual(calls, ['/provider/api/v1/generate/record-info?taskId=paid-task'])
  assert.deepEqual(result.urls, ['https://cdn.example/song.mp3'])
  assert.equal(result.creditsConsumed, 12)
})

test('Suno Sounds uses the sounds create route and persists its recovery family before polling', async () => {
  const calls: string[] = []
  const accepted: Array<[string, string]> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/api/v1/generate/sounds')) {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        prompt: 'Cinematic hit',
        model: 'V5_5',
        soundLoop: false,
        soundTempo: 120,
        grabLyrics: false,
      })
      return json({ code: 200, data: { taskId: 'sounds-task' } })
    }
    assert.match(url, /\/api\/v1\/generate\/record-info\?taskId=sounds-task$/)
    assert.deepEqual(accepted, [['sounds-task', 'sounds']], 'polling must wait for durable family metadata')
    return json({
      code: 200,
      data: {
        status: 'SUCCESS',
        response: { sunoData: [{ audioUrl: 'https://cdn.example/effect.mp3' }] },
        creditsConsumed: 2.5,
      },
    })
  }) as typeof fetch

  const result = await runProviderModel('key', {
    family: 'sounds',
    body: { prompt: 'Cinematic hit', model: 'V5_5', soundLoop: false, soundTempo: 120, grabLyrics: false },
  }, {
    intervalMs: 1,
    timeoutMs: 100,
    onTaskId: async (taskId, family) => accepted.push([taskId, family]),
  })

  assert.deepEqual(calls, [
    '/provider/api/v1/generate/sounds',
    '/provider/api/v1/generate/record-info?taskId=sounds-task',
  ])
  assert.deepEqual(result.urls, ['https://cdn.example/effect.mp3'])
  assert.equal(result.creditsConsumed, 2.5)
})

test('Suno Sounds recovery only polls its persisted task and never creates paid work again', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    return json({
      code: 200,
      data: {
        status: 'SUCCESS',
        response: { sunoData: [{ audioUrl: 'https://cdn.example/recovered-effect.mp3' }] },
      },
    })
  }) as typeof fetch

  const result = await resumeProviderModel('key', 'sounds', 'persisted-sounds-task', { intervalMs: 1, timeoutMs: 100 })
  assert.deepEqual(calls, ['/provider/api/v1/generate/record-info?taskId=persisted-sounds-task'])
  assert.deepEqual(result.urls, ['https://cdn.example/recovered-effect.mp3'])
  assert.equal(calls.some((url) => url.endsWith('/generate/sounds')), false)
})

test('accepted task callback identifies the family needed for durable recovery', async () => {
  const accepted: Array<[string, string]> = []
  let recoveryMetadataFlushed = false
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) return json({ code: 200, data: { taskId: 'market-task' } })
    assert.equal(recoveryMetadataFlushed, true, 'polling must wait until accepted task metadata is durable')
    return json({
      code: 200,
      data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/image.png'] }) },
    })
  }) as typeof fetch

  await runProviderModel('key', { family: 'jobs', model: 'image-model', input: { prompt: 'test' } }, {
    intervalMs: 1,
    timeoutMs: 100,
    onTaskId: async (taskId, family) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      accepted.push([taskId, family])
      recoveryMetadataFlushed = true
    },
  })
  assert.deepEqual(accepted, [['market-task', 'jobs']])
})
