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
