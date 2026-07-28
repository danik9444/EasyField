import assert from 'node:assert/strict'
import test from 'node:test'
import { loadGenPrefs } from '../src/data/prefs.ts'

test('generation preferences ignore valid JSON with the wrong runtime shape', (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
    },
  })
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  values.set('ef-prefs-invalid-root', JSON.stringify([]))
  assert.deepEqual(loadGenPrefs('invalid-root'), {})

  values.set('ef-prefs-invalid-fields', JSON.stringify({
    model: {},
    style: 1,
    prompt: [],
    count: { value: 4 },
    perModel: [],
  }))
  assert.deepEqual(loadGenPrefs('invalid-fields'), {})
})

test('generation preferences retain only scalar fields and record-shaped model settings', (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => JSON.stringify({
        model: 'Example',
        style: 'Cinematic',
        prompt: 'A valid prompt',
        count: '4',
        perModel: {
          Example: { resolution: '1080p' },
          Broken: 'not an object',
        },
        ignored: true,
      }),
    },
  })
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  assert.deepEqual(loadGenPrefs<{ resolution: string }>('valid'), {
    model: 'Example',
    style: 'Cinematic',
    prompt: 'A valid prompt',
    count: '4',
    perModel: {
      Example: { resolution: '1080p' },
    },
  })
})
