import assert from 'node:assert/strict'
import test from 'node:test'

test('timeline grabs return an honest failure instead of a placeholder artifact', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })

  let response = new Response(JSON.stringify({ connected: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  globalThis.fetch = async () => response.clone()

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts')
  response = new Response(JSON.stringify({ ok: false, error: 'Nothing is available under the playhead', code: 'NO_ITEM' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  const failed = await resolve.grabFrame()
  assert.equal(failed.ok, false)
  assert.equal(failed.blobUrl, undefined)
  assert.equal(failed.error, 'Nothing is available under the playhead')

  response = new Response(new Blob(['frame-bytes'], { type: 'image/png' }), {
    status: 200,
    headers: {
      'X-EF-Timecode': '01%3A02%3A03%3A04',
      'X-EF-Timeline': 'Edit%20One',
    },
  })
  const captured = await resolve.grabFrame()
  assert.equal(captured.ok, true)
  assert.match(captured.name, /Edit One · 01:02:03:04/)
  assert.match(captured.blobUrl ?? '', /^blob:/)
  if (captured.blobUrl) URL.revokeObjectURL(captured.blobUrl)
})

test('Edit Image uses its media-aware grab endpoint and decodes source semantics', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-edit-image-source', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/edit-image-source')
    return new Response(new Blob(['original-still'], { type: 'image/png' }), {
      status: 200,
      headers: {
        'X-EF-Name': 'portrait.png',
        'X-EF-Timecode': '01%3A00%3A00%3A12',
        'X-EF-Timeline': 'Main%20edit',
        'X-EF-Capture-Kind': 'source',
        'X-EF-Source-Kind': 'still-image',
      },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?edit-image-source')
  await resolve.refreshStatus()
  const captured = await resolve.grabEditImageSource()
  assert.equal(captured.ok, true)
  assert.equal(captured.name, 'portrait.png · 01:00:00:12')
  assert.equal(captured.captureKind, 'source')
  assert.equal(captured.sourceKind, 'still-image')
  assert.equal(requests.includes('/bridge/grab/edit-image-source'), true)
  if (captured.blobUrl) URL.revokeObjectURL(captured.blobUrl)
})

test('an older Resolve plugin blocks only the adaptive Edit Image grab', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Legacy bridge',
        capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/frame')
    return new Response(new Blob(['generic-frame'], { type: 'image/png' }), {
      status: 200,
      headers: { 'X-EF-Timecode': '01%3A00%3A00%3A00', 'X-EF-Timeline': 'Legacy%20bridge' },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?legacy-edit-image-source')
  await resolve.refreshStatus()
  const blocked = await resolve.grabEditImageSource()
  assert.equal(blocked.ok, false)
  assert.match(blocked.error ?? '', /update.*Edit Image source/i)
  assert.equal(requests.includes('/bridge/grab/edit-image-source'), false)

  const generic = await resolve.grabFrame()
  assert.equal(generic.ok, true)
  assert.equal(requests.includes('/bridge/grab/frame'), true)
  if (generic.blobUrl) URL.revokeObjectURL(generic.blobUrl)
})

test('Edit Video uses the exact-trim endpoint and preserves trim metadata', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-edit-video-source', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/edit-video-source')
    return new Response(new Blob(['trimmed-video'], { type: 'video/mp4' }), {
      status: 200,
      headers: {
        'X-EF-Name': 'Shot%20A',
        'X-EF-Timecode': '01%3A00%3A04%3A04',
        'X-EF-Timeline': 'Main%20edit',
        'X-EF-Capture-Kind': 'source',
        'X-EF-Source-Kind': 'video',
        'X-EF-Trimmed': 'true',
        'X-EF-Source-Start-Frame': '48',
        'X-EF-Source-End-Frame': '167',
        'X-EF-Duration-Seconds': '5',
        'X-EF-Timeline-Fps': '24',
      },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?edit-video-source')
  await resolve.refreshStatus()
  const captured = await resolve.grabEditVideoSource()
  assert.equal(captured.ok, true)
  assert.equal(captured.name, 'Shot A · 01:00:04:04')
  assert.equal(captured.sourceKind, 'video')
  assert.equal(captured.trimmed, true)
  assert.equal(captured.sourceStartFrame, 48)
  assert.equal(captured.sourceEndFrame, 167)
  assert.equal(captured.timelineFps, 24)
  assert.equal(captured.durationSeconds, 5)
  assert.equal(requests.includes('/bridge/grab/edit-video-source'), true)
  if (captured.blobUrl) URL.revokeObjectURL(captured.blobUrl)
})

test('adaptive Upscale Grab keeps original still bytes without asking for a video render', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        capabilities: ['grab-frame', 'grab-edit-image-source', 'grab-edit-video-source', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/edit-image-source')
    return new Response(new Blob(['original-still'], { type: 'image/png' }), {
      status: 200,
      headers: {
        'X-EF-Name': 'poster.png',
        'X-EF-Timecode': '01%3A00%3A01%3A00',
        'X-EF-Source-Kind': 'still-image',
        'X-EF-Capture-Kind': 'source',
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?upscale-still-source')
  await resolve.refreshStatus()
  const grabbed = await resolve.grabUpscaleSource()
  assert.equal(grabbed.ok, true)
  assert.equal(grabbed.sourceKind, 'still-image')
  assert.equal(grabbed.captureKind, 'source')
  assert.equal(requests.filter((url) => url === '/bridge/grab/edit-video-source').length, 0)
  if (grabbed.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
})

test('adaptive Upscale Grab replaces a video probe with the exact trimmed timeline clip', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  const originalRevoke = URL.revokeObjectURL
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  const requests: string[] = []
  const revoked: string[] = []
  URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url) }
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        capabilities: ['grab-frame', 'grab-edit-image-source', 'grab-edit-video-source', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const sharedHeaders = {
      'X-EF-Name': 'Shot%20A',
      'X-EF-Timecode': '01%3A00%3A04%3A04',
      'X-EF-Source-Kind': 'video',
      'X-EF-Project-Id': 'project-1',
      'X-EF-Timeline-Id': 'timeline-1',
      'X-EF-Item-Id': 'item-1',
    }
    if (url === '/bridge/grab/edit-image-source') {
      return new Response(new Blob(['probe-frame'], { type: 'image/png' }), { status: 200, headers: sharedHeaders })
    }
    assert.equal(url, '/bridge/grab/edit-video-source')
    return new Response(new Blob(['exact-trim'], { type: 'video/mp4' }), {
      status: 200,
      headers: { ...sharedHeaders, 'X-EF-Trimmed': 'true', 'X-EF-Duration-Seconds': '4.5' },
    })
  }
  t.after(() => {
    URL.revokeObjectURL = originalRevoke
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?upscale-exact-video')
  await resolve.refreshStatus()
  const grabbed = await resolve.grabUpscaleSource()
  assert.equal(grabbed.ok, true)
  assert.equal(grabbed.sourceKind, 'video')
  assert.equal(grabbed.trimmed, true)
  assert.equal(grabbed.durationSeconds, 4.5)
  assert.deepEqual(requests.filter((url) => url.startsWith('/bridge/grab/')), [
    '/bridge/grab/edit-image-source',
    '/bridge/grab/edit-video-source',
  ])
  assert.equal(revoked.length, 1)
  assert.notEqual(revoked[0], grabbed.blobUrl)
  if (grabbed.blobUrl) URL.revokeObjectURL(grabbed.blobUrl)
})

test('adaptive Upscale Grab fails closed when the playhead changes between probe and video capture', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        capabilities: ['grab-frame', 'grab-edit-image-source', 'grab-edit-video-source', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const itemId = url === '/bridge/grab/edit-image-source' ? 'item-before' : 'item-after'
    return new Response(new Blob([url.endsWith('image-source') ? 'probe' : 'video'], { type: url.endsWith('image-source') ? 'image/png' : 'video/mp4' }), {
      status: 200,
      headers: {
        'X-EF-Source-Kind': 'video',
        'X-EF-Project-Id': 'project-1',
        'X-EF-Timeline-Id': 'timeline-1',
        'X-EF-Item-Id': itemId,
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?upscale-source-changed')
  await resolve.refreshStatus()
  const grabbed = await resolve.grabUpscaleSource()
  assert.equal(grabbed.ok, false)
  assert.equal(grabbed.blobUrl, undefined)
  assert.match(grabbed.error ?? '', /source changed/i)
})

test('timeline audio Grab preserves the exact cut metadata returned by Resolve', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/audio')
    return new Response(new Blob(['wav-bytes'], { type: 'audio/wav' }), {
      status: 200,
      headers: {
        'X-EF-Name': 'Dialogue%20A1',
        'X-EF-Timecode': '01%3A00%3A04%3A14',
        'X-EF-Timeline': 'Main%20edit',
        'X-EF-Capture-Kind': 'source',
        'X-EF-Source-Kind': 'audio',
        'X-EF-Trimmed': 'true',
        'X-EF-Source-Start-Frame': '48',
        'X-EF-Source-End-Frame': '167',
        'X-EF-Duration-Seconds': '5',
        'X-EF-Track-Type': 'audio',
        'X-EF-Track-Index': '1',
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?audio-grab-metadata')
  await resolve.refreshStatus()
  const captured = await resolve.grabAudio()
  assert.equal(captured.ok, true)
  assert.equal(captured.name, 'Dialogue A1 · 01:00:04:14')
  assert.equal(captured.sourceKind, 'audio')
  assert.equal(captured.trimmed, true)
  assert.equal(captured.sourceStartFrame, 48)
  assert.equal(captured.sourceEndFrame, 167)
  assert.equal(captured.durationSeconds, 5)
  assert.equal(captured.trackType, 'audio')
  assert.equal(captured.trackIndex, 1)
  assert.equal(requests.includes('/bridge/grab/audio'), true)
  if (captured.blobUrl) URL.revokeObjectURL(captured.blobUrl)
})

test('reviewed beat markers use the dedicated capability-gated Resolve endpoint', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  let markerBody: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'beat-markers', 'media-pool', 'append', 'place-at-playhead'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/beat/apply-markers')
    markerBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ ok: true, target: 'timeline', applied: 2, operationId: 'operation-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?beat-markers')
  await resolve.refreshStatus()
  const result = await resolve.applyBeatMarkers({
    path: '/tmp/easyfield-track.wav',
    target: 'timeline',
    analysisId: 'beat-analysis-1',
    color: 'Cyan',
    markers: [{ time: 1, confidence: 0.9, name: 'Beat 001' }, { time: 2, confidence: 0.8, name: 'Beat 002' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.applied, 2)
  assert.equal(markerBody?.target, 'timeline')
  assert.equal(Array.isArray(markerBody?.markers), true)
})

test('an older Resolve integration cannot pretend Beat marker import is supported', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    return new Response(JSON.stringify({
      connected: true,
      capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?legacy-beat-markers')
  await resolve.refreshStatus()
  const result = await resolve.applyBeatMarkers({ path: '/tmp/track.wav', target: 'media-pool', analysisId: 'beat-analysis-1', color: 'Cyan', markers: [{ time: 1, confidence: 1, name: 'Beat' }] })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /update.*Beat Detection markers/i)
  assert.equal(requests.includes('/bridge/beat/apply-markers'), false)
})

test('an older Resolve plugin cannot silently use an imprecise Edit Video grab', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    return new Response(JSON.stringify({
      connected: true,
      timeline: 'Legacy bridge',
      capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?legacy-edit-video-source')
  await resolve.refreshStatus()
  const blocked = await resolve.grabEditVideoSource()
  assert.equal(blocked.ok, false)
  assert.match(blocked.error ?? '', /update.*trimmed Edit Video source/i)
  assert.equal(requests.includes('/bridge/grab/edit-video-source'), false)
})

test('a cold Resolve bridge may use its full initialization window without appearing disconnected', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })

  globalThis.fetch = async (_input, init) => await new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({
      connected: true,
      timeline: 'Cold start',
      capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead'],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })), 1_650)
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  // Add a query so this test owns an isolated status cache even when Node runs
  // both tests in the same worker.
  const { resolve } = await import('../src/services/resolve.ts?cold-start')
  const status = await resolve.refreshStatus()
  assert.equal(status.connected, true)
  assert.equal(status.timeline, 'Cold start')
})

test('shot-end grab uses the rendered timeline endpoint and preserves capture metadata', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-shot-start-frame', 'grab-shot-end-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead', 'place-at-frame', 'place-linked-av', 'place-interval-safe', 'validate-placement-anchor', 'validate-placement-anchor-v2'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/shot-end-frame')
    return new Response(new Blob(['rendered-frame'], { type: 'image/png' }), {
      status: 200,
      headers: {
        'X-EF-Name': 'Shot%20A',
        'X-EF-Timecode': '01%3A00%3A08%3A11',
        'X-EF-Original-Timecode': '01%3A00%3A04%3A00',
        'X-EF-Project-Id': 'project-1',
        'X-EF-Timeline': 'Main%20edit',
        'X-EF-Timeline-Id': 'timeline-1',
        'X-EF-Item-Id': 'item-7',
        'X-EF-Item-Start-Frame': '100',
        'X-EF-Item-End-Frame': '200',
        'X-EF-Capture-Frame': '199',
        'X-EF-Capture-Edge': 'end',
        'X-EF-Track-Type': 'video',
        'X-EF-Track-Index': '2',
        'X-EF-Capture-Kind': 'timeline-output',
      },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?shot-end-frame')
  await resolve.refreshStatus()
  const captured = await resolve.grabShotEndFrame()
  assert.equal(captured.ok, true)
  assert.equal(captured.captureKind, 'timeline-output')
  assert.equal(captured.captureEdge, 'end')
  assert.equal(captured.name, 'Shot A · 01:00:08:11')
  assert.equal(captured.originalTimecode, '01:00:04:00')
  assert.equal(captured.projectId, 'project-1')
  assert.equal(captured.timelineId, 'timeline-1')
  assert.equal(captured.itemId, 'item-7')
  assert.equal(captured.itemStartFrame, 100)
  assert.equal(captured.itemEndFrame, 200)
  assert.equal(captured.captureFrame, 199)
  assert.equal(captured.trackIndex, 2)
  assert.equal(requests.includes('/bridge/grab/shot-end-frame'), true)
  if (captured.blobUrl) URL.revokeObjectURL(captured.blobUrl)
})

test('shot-start grab uses the rendered timeline endpoint for the incoming Transition frame', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-shot-start-frame', 'grab-shot-end-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead', 'place-at-frame', 'place-linked-av', 'place-interval-safe', 'validate-placement-anchor', 'validate-placement-anchor-v2'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/grab/shot-start-frame')
    return new Response(new Blob(['rendered-frame'], { type: 'image/png' }), {
      status: 200,
      headers: {
        'X-EF-Name': 'Shot%20B',
        'X-EF-Timecode': '01%3A00%3A08%3A12',
        'X-EF-Original-Timecode': '01%3A00%3A10%3A00',
        'X-EF-Project-Id': 'project-1',
        'X-EF-Timeline': 'Main%20edit',
        'X-EF-Timeline-Id': 'timeline-1',
        'X-EF-Item-Id': 'item-8',
        'X-EF-Item-Start-Frame': '200',
        'X-EF-Item-End-Frame': '320',
        'X-EF-Capture-Frame': '200',
        'X-EF-Capture-Edge': 'start',
        'X-EF-Track-Type': 'video',
        'X-EF-Track-Index': '2',
        'X-EF-Capture-Kind': 'timeline-output',
      },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?shot-start-frame')
  await resolve.refreshStatus()
  const captured = await resolve.grabShotStartFrame()
  assert.equal(captured.ok, true)
  assert.equal(captured.captureKind, 'timeline-output')
  assert.equal(captured.captureEdge, 'start')
  assert.equal(captured.name, 'Shot B · 01:00:08:12')
  assert.equal(captured.projectId, 'project-1')
  assert.equal(captured.timelineId, 'timeline-1')
  assert.equal(captured.itemId, 'item-8')
  assert.equal(captured.captureFrame, 200)
  assert.equal(requests.includes('/bridge/grab/shot-start-frame'), true)
  if (captured.blobUrl) URL.revokeObjectURL(captured.blobUrl)
})

test('captured-cut placement sends the frozen project, timeline and record frame', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  let placementBody: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-shot-start-frame', 'grab-shot-end-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead', 'place-at-frame', 'place-linked-av', 'place-interval-safe', 'validate-placement-anchor', 'validate-placement-anchor-v2'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/place')
    placementBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ ok: true, path: '/tmp/transition.mp4' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?captured-cut-placement')
  await resolve.refreshStatus()
  const placed = await resolve.placeToTimeline({
    url: 'https://cdn/transition.mp4',
    name: 'Bridge',
    kind: 'video',
    placement: 'playhead',
    recordFrame: 200,
    projectId: 'project-1',
    timelineId: 'timeline-1',
    anchorItemId: 'item-8',
    anchorItemStartFrame: 200,
    anchorItemEndFrame: 320,
    anchorItemSourceStartFrame: 48,
    anchorItemSourceEndFrame: 167,
    anchorMediaPoolItemId: 'media-8',
    anchorTrackIndex: 2,
    validationAnchors: [
      {
        itemId: 'item-7',
        startFrame: 100,
        endFrame: 200,
        sourceStartFrame: 20,
        sourceEndFrame: 119,
        mediaPoolItemId: 'media-7',
        trackIndex: 2,
      },
      {
        itemId: 'item-8',
        startFrame: 200,
        endFrame: 320,
        sourceStartFrame: 48,
        sourceEndFrame: 167,
        mediaPoolItemId: 'media-8',
        trackIndex: 2,
      },
    ],
  })
  assert.equal(placed.ok, true)
  assert.equal(placementBody?.recordFrame, 200)
  assert.equal(placementBody?.projectId, 'project-1')
  assert.equal(placementBody?.timelineId, 'timeline-1')
  assert.equal(placementBody?.anchorItemId, 'item-8')
  assert.equal(placementBody?.anchorItemSourceStartFrame, 48)
  assert.equal(placementBody?.anchorItemSourceEndFrame, 167)
  assert.equal(placementBody?.anchorMediaPoolItemId, 'media-8')
  assert.equal(placementBody?.anchorTrackIndex, 2)
  assert.deepEqual(placementBody?.validationAnchors, [
    {
      itemId: 'item-7',
      startFrame: 100,
      endFrame: 200,
      sourceStartFrame: 20,
      sourceEndFrame: 119,
      mediaPoolItemId: 'media-7',
      trackIndex: 2,
    },
    {
      itemId: 'item-8',
      startFrame: 200,
      endFrame: 320,
      sourceStartFrame: 48,
      sourceEndFrame: 167,
      mediaPoolItemId: 'media-8',
      trackIndex: 2,
    },
  ])
})

test('saved Library artifacts place through an opaque artifactId without exposing a path or URL', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  let placementBody: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead', 'place-managed-artifact', 'place-interval-safe'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url, '/bridge/place')
    placementBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ ok: true, path: '/managed/artifact.png' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const artifactId = '709f1476-0fd9-4c83-8916-e001edc5465d'
  const { resolve } = await import('../src/services/resolve.ts?managed-artifact-placement')
  await resolve.refreshStatus()
  const placed = await resolve.placeToTimeline({
    url: `/artifacts/${artifactId}`,
    name: 'Saved frame',
    kind: 'image',
    placement: 'playhead',
  })
  assert.equal(placed.ok, true)
  assert.equal(placementBody?.artifactId, artifactId)
  assert.equal(Object.hasOwn(placementBody ?? {}, 'url'), false)
  assert.equal(Object.hasOwn(placementBody ?? {}, 'path'), false)
  assert.equal(Object.hasOwn(placementBody ?? {}, 'localPath'), false)
})

test('malformed managed Library paths are rejected before the bridge placement endpoint', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  let placementRequests = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead', 'place-managed-artifact', 'place-interval-safe'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    placementRequests += 1
    throw new Error(`unexpected placement request: ${url}`)
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?invalid-managed-artifact-placement')
  await resolve.refreshStatus()
  const placed = await resolve.placeToTimeline({
    url: '/artifacts/../../etc/passwd',
    name: 'must not place',
    kind: 'image',
  })
  assert.equal(placed.ok, false)
  assert.match(placed.error ?? '', /invalid managed Library artifact/i)
  assert.equal(placementRequests, 0)
})

test('timed Foley placement sends and capability-gates the frozen source-item anchor', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { easyfield: undefined } })
  let placementBody: Record<string, unknown> | undefined
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/bridge/status')) {
      return new Response(JSON.stringify({
        connected: true,
        timeline: 'Main edit',
        capabilities: ['grab-frame', 'grab-clip', 'grab-audio', 'media-pool', 'append', 'place-at-playhead', 'place-at-frame', 'place-interval-safe', 'validate-placement-anchor'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    placementBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?timed-foley-placement')
  await resolve.refreshStatus()
  const placed = await resolve.placeToTimeline({
    url: 'https://cdn.example/step.wav',
    name: 'Footstep',
    kind: 'audio',
    placement: 'playhead',
    recordFrame: 160,
    projectId: 'project-1',
    timelineId: 'timeline-1',
    anchorItemId: 'item-7',
    anchorItemStartFrame: 100,
    anchorItemEndFrame: 220,
  })
  assert.equal(placed.ok, true)
  assert.equal(placementBody?.anchorItemId, 'item-7')
  assert.equal(placementBody?.anchorItemStartFrame, 100)
  assert.equal(placementBody?.anchorItemEndFrame, 220)
})

test('an installed bridge without capability handshake is blocked before any media access or placement', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })

  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(JSON.stringify({
      connected: true,
      product: 'DaVinci Resolve Studio 21',
      timeline: 'Legacy bridge',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const { resolve } = await import('../src/services/resolve.ts?legacy-capabilities')
  const status = await resolve.refreshStatus()
  assert.equal(status.connected, false)
  assert.match(status.compatibilityError ?? '', /outdated/i)
  const requestsAfterStatus = requests

  const grabbed = await resolve.grabFrame()
  assert.equal(grabbed.ok, false)
  assert.match(grabbed.error ?? '', /install the current plugin/i)

  const placed = await resolve.placeToTimeline({
    url: 'https://media.example.test/result.png',
    name: 'must-not-place.png',
    kind: 'image',
    placement: 'playhead',
  })
  assert.equal(placed.ok, false)
  assert.match(placed.error ?? '', /install the current plugin/i)
  assert.equal(requests, requestsAfterStatus)
})
