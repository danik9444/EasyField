import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addCreation,
  addCreations,
  addCreationsDurably,
  attachCreationCompanion,
  getCreations,
  removeCreations,
} from '../src/data/creations.ts'

test('paid provider outputs enter Library only after Main verifies a managed artifact', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let releaseIngest!: () => void
  const ingestGate = new Promise<void>((resolve) => { releaseIngest = resolve })
  const ingested: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      easyfield: {
        plugin: true,
        artifacts: {
          ingestUrl: async ({ url }: { url: string }) => {
            ingested.push(url)
            await ingestGate
            return {
              id: '4ae1141c-a68f-4d6a-9444-b623bd21525e',
              url: '/artifacts/4ae1141c-a68f-4d6a-9444-b623bd21525e',
              checksum: 'a'.repeat(64),
            }
          },
        },
      },
    },
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const pending = addCreationsDurably([{
    kind: 'video',
    url: 'https://cdn.example.test/paid-result.mp4',
    model: 'Test model',
    prompt: 'Durability test',
  }])
  await Promise.resolve()
  assert.deepEqual(ingested, ['https://cdn.example.test/paid-result.mp4'])
  assert.equal(getCreations().some((creation) => creation.prompt === 'Durability test'), false)

  releaseIngest()
  const [creation] = await pending
  try {
    assert.equal(creation.url, '/artifacts/4ae1141c-a68f-4d6a-9444-b623bd21525e')
    assert.equal(creation.durability, 'local')

    const [enriched] = addCreations([{
      kind: 'video',
      url: creation.url,
      model: 'Test model',
      prompt: 'Screen metadata',
      meta: '1080p',
    }])
    assert.equal(enriched.id, creation.id, 'the screen must enrich, not duplicate, the committed artifact')
    assert.equal(getCreations().filter((item) => item.url === creation.url).length, 1)
  } finally {
    removeCreations([creation.id])
  }
})

test('a failed Artifact Store verification creates no Library record', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      easyfield: {
        plugin: true,
        artifacts: {
          ingestUrl: async () => { throw new Error('disk full') },
        },
      },
    },
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  await assert.rejects(
    addCreationsDurably([{
      kind: 'image',
      url: 'https://cdn.example.test/uncommitted.png',
      prompt: 'Must not appear',
    }]),
    /disk full/i,
  )
  assert.equal(getCreations().some((creation) => creation.prompt === 'Must not appear'), false)
})

test('locally rendered Blob/data output is copied into Main before Library accepts it', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let receivedBytes = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      easyfield: {
        plugin: true,
        artifacts: {
          ingestUrl: async () => { throw new Error('remote ingestion must not be used') },
          ingestBytes: async ({ bytes }: { bytes: ArrayBuffer }) => {
            receivedBytes = bytes.byteLength
            return {
              id: '9af1218d-606f-4f0e-993d-4944678346da',
              url: '/artifacts/9af1218d-606f-4f0e-993d-4944678346da',
              checksum: 'b'.repeat(64),
            }
          },
        },
      },
    },
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
  })

  const [creation] = await addCreationsDurably([{
    kind: 'image',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    prompt: 'Local storyboard export',
  }])
  try {
    assert.ok(receivedBytes > 0)
    assert.equal(creation.url, '/artifacts/9af1218d-606f-4f0e-993d-4944678346da')
    assert.equal(creation.durability, 'local')
  } finally {
    removeCreations([creation.id])
  }
})

test('packaged Library commit fails closed when its local index cannot be opened', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      easyfield: {
        plugin: true,
        artifacts: {
          ingestUrl: async () => ({
            id: '2c70d740-0f78-485e-a814-477be521c510',
            url: '/artifacts/2c70d740-0f78-485e-a814-477be521c510',
            checksum: 'c'.repeat(64),
          }),
        },
      },
    },
  })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request: { onerror?: () => void } = {}
        queueMicrotask(() => request.onerror?.())
        return request
      },
    },
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete (globalThis as { window?: unknown }).window
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete (globalThis as { document?: unknown }).document
    if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb)
    else delete (globalThis as { indexedDB?: unknown }).indexedDB
  })

  const prompt = 'Index failure must remain recoverable'
  let securedBeforeIndexFailure: readonly { url: string }[] = []
  await assert.rejects(
    addCreationsDurably([{
      kind: 'video',
      url: 'https://cdn.example.test/result-without-index.mp4',
      prompt,
    }], {
      onSecured: (items) => { securedBeforeIndexFailure = items },
    }),
    /local Library index is unavailable/i,
  )
  assert.deepEqual(securedBeforeIndexFailure.map((item) => item.url), ['/artifacts/2c70d740-0f78-485e-a814-477be521c510'])
  const record = getCreations().find((creation) => creation.prompt === prompt)
  if (record) removeCreations([record.id])
})

test('creation helpers return stable records without changing newest-first Library order', () => {
  const added = addCreations([
    { kind: 'image', url: 'https://media.example.test/scene-one.png', prompt: 'Scene one' },
    { kind: 'image', url: 'https://media.example.test/scene-two.png', prompt: 'Scene two' },
  ])
  const createdIds = added.map((creation) => creation.id)

  try {
    assert.equal(added.length, 2)
    assert.deepEqual(added.map((creation) => creation.prompt), ['Scene one', 'Scene two'])

    const ids = new Set(added.map((creation) => creation.id))
    const stored = getCreations().filter((creation) => ids.has(creation.id))
    assert.deepEqual(stored.map((creation) => creation.id), [added[1].id, added[0].id])

    const single = addCreation({ kind: 'image', url: 'https://media.example.test/scene-three.png', prompt: 'Scene three' })
    assert.ok(single)
    assert.equal(single.prompt, 'Scene three')
    createdIds.push(single.id)

    assert.equal(addCreation({ kind: 'image', url: '' }), null)
  } finally {
    removeCreations(createdIds)
  }
})

test('Beat Detection companions stay linked to their media Library item', () => {
  const creation = addCreation({ kind: 'audio', url: 'data:audio/wav;base64,UklGRg==', prompt: 'Track.wav' })
  assert.ok(creation)
  try {
    const updated = attachCreationCompanion(creation.id, {
      id: 'beat-revision-1',
      kind: 'beat-analysis',
      schemaVersion: 1,
      fileName: 'Track.easyfield-beats.json',
      mimeType: 'application/vnd.easyfield.beats+json',
      data: '{"schemaVersion":1}',
      createdAt: 1,
      summary: { bpm: 120, detectedBeats: 8, markerCount: 4, confidence: 0.9, durationSeconds: 4, engine: 'librosa', engineVersion: '0.11', markerColor: 'Cyan' },
    })
    assert.equal(updated?.companions?.length, 1)
    assert.equal(getCreations().find((item) => item.id === creation.id)?.companions?.[0].summary.markerCount, 4)
  } finally {
    removeCreations([creation.id])
  }
})
