import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import {
  DEFAULT_SETTINGS,
  currentApiKey,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  setCurrentApiKey,
} from '../src/settings.ts'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

beforeEach(() => {
  storage.clear()
  setCurrentApiKey('')
})

after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else delete (globalThis as { localStorage?: Storage }).localStorage
})

test('persisted settings are validated before reaching the UI', () => {
  const settings = sanitizeSettings({
    accent: 'not-a-color',
    glow: 'yes',
    apiKey: 12,
    windowMode: 'gigantic',
    placementMode: 'ripple',
    // Retired persisted fields are ignored.
    spendLimit: Number.POSITIVE_INFINITY,
    telemetry: 'yes',
    artifactRoot: '   ',
  })

  assert.deepEqual(settings, DEFAULT_SETTINGS)
})

test('valid persisted values round-trip while the credential never reaches localStorage', () => {
  saveSettings({
    ...DEFAULT_SETTINGS,
    accent: '#5B8CFF',
    apiKey: 'must-not-be-persisted',
    windowMode: 'expanded',
    windowHeightMode: 'full',
    placementMode: 'media-pool',
    telemetry: true,
  })

  const raw = storage.getItem('ef-settings')
  assert.ok(raw)
  assert.equal(raw.includes('must-not-be-persisted'), false)
  assert.equal(Object.hasOwn(JSON.parse(raw), 'apiKey'), false)
  assert.equal(Object.hasOwn(JSON.parse(raw), 'spendLimit'), false)
  assert.equal(Object.hasOwn(JSON.parse(raw), 'artifactRoot'), false)
  assert.deepEqual(loadSettings(), {
    ...DEFAULT_SETTINGS,
    accent: '#5B8CFF',
    windowMode: 'expanded',
    windowHeightMode: 'full',
    placementMode: 'media-pool',
    telemetry: true,
  })
})

test('older persisted settings load supported values and shed retired fields', () => {
  storage.setItem('ef-settings', JSON.stringify({
    ...DEFAULT_SETTINGS,
    accent: '#3ED598',
    windowMode: 'expanded',
    spendLimit: 99,
    artifactRoot: '/Volumes/Legacy EasyField',
  }))

  const settings = loadSettings()
  assert.deepEqual(settings, {
    ...DEFAULT_SETTINGS,
    accent: '#3ED598',
    windowMode: 'expanded',
  })

  saveSettings(settings)
  const rewritten = JSON.parse(storage.getItem('ef-settings') ?? '{}')
  assert.equal(Object.hasOwn(rewritten, 'spendLimit'), false)
  assert.equal(Object.hasOwn(rewritten, 'artifactRoot'), false)
})

test('the connected credential lives only in session memory', () => {
  setCurrentApiKey('  runtime-only  ')
  assert.equal(currentApiKey(), 'runtime-only')
  assert.equal(storage.getItem('ef-settings'), null)
})

test('legacy destructive replacement defaults migrate to safe playhead placement', () => {
  const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, placementMode: 'replace' })
  assert.equal(settings.placementMode, 'playhead')
})
