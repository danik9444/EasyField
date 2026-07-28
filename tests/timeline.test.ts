import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import test, { before } from 'node:test'

interface TestPlaceInput {
  url: string
  name: string
}

interface TestTimelineItem {
  url: string
  name: string
}

interface TestTimelinePlacementContext {
  recordFrame: number
  projectId?: string
  timelineId?: string
}

let resolve: {
  isBridgeConnected: () => boolean
  placeToTimeline: (input: TestPlaceInput) => Promise<{ ok: boolean; error?: string }>
}
let sendToTimeline: (
  items: TestTimelineItem[],
  kind: 'image' | 'video' | 'audio',
  toast: (message: string) => void,
  context?: TestTimelinePlacementContext,
) => Promise<void>

before(async () => {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && path.extname(specifier) === '') {
        return nextResolve(`${specifier}.ts`, context)
      }
      return nextResolve(specifier, context)
    },
  })
  const timelineModule = await import('../src/services/timeline.ts')
  const resolveModule = await import('../src/services/resolve.ts')
  sendToTimeline = timelineModule.sendToTimeline
  resolve = resolveModule.resolve
})

test('identical in-flight timeline sends execute each item only once', async (t) => {
  const originalIsBridgeConnected = resolve.isBridgeConnected
  const originalPlaceToTimeline = resolve.placeToTimeline
  t.after(() => {
    resolve.isBridgeConnected = originalIsBridgeConnected
    resolve.placeToTimeline = originalPlaceToTimeline
  })

  let releaseFirst!: () => void
  const firstPlacement = new Promise<void>((resolveFirst) => {
    releaseFirst = resolveFirst
  })
  const placements: TestPlaceInput[] = []
  const toasts: string[] = []
  resolve.isBridgeConnected = () => true
  resolve.placeToTimeline = async (input) => {
    placements.push(input)
    if (placements.length === 1) await firstPlacement
    return { ok: true }
  }

  const items = [
    { url: 'https://media.example/first.png', name: 'First' },
    { url: 'https://media.example/second.png', name: 'Second' },
  ]
  const context = { recordFrame: 48, projectId: 'project-1', timelineId: 'timeline-1' }
  const first = sendToTimeline(items, 'image', (message) => toasts.push(message), context)
  const duplicate = sendToTimeline(items, 'image', (message) => toasts.push(message), context)

  await Promise.resolve()
  assert.equal(placements.length, 1)
  releaseFirst()
  await Promise.all([first, duplicate])

  assert.deepEqual(placements.map(({ name }) => name), ['First', 'Second'])
  assert.deepEqual(toasts, ['2 sent to timeline'])

  await sendToTimeline(items, 'image', (message) => toasts.push(message), context)
  assert.deepEqual(placements.map(({ name }) => name), ['First', 'Second', 'First', 'Second'])
  assert.deepEqual(toasts, ['2 sent to timeline', '2 sent to timeline'])
})

test('the bridge waits for a terminal placement result instead of timing out a live mutation', async () => {
  const source = await readFile(new URL('../plugin/main.cjs', import.meta.url), 'utf8')
  assert.match(source, /pathname === '\/bridge\/place'[^\n]+run\(place\);/)
  assert.doesNotMatch(source, /pathname === '\/bridge\/place'[^\n]+run\(place,\s*\d/)
})
