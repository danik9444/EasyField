import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { host } from '../src/services/host.ts'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let webStorageReads = 0

function installWebStorageTripwire(name: 'sessionStorage' | 'localStorage') {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      webStorageReads += 1
      throw new Error(`${name} must not be accessed for credentials`)
    },
  })
}

function restoreGlobal(name: 'window' | 'sessionStorage' | 'localStorage', descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else delete (globalThis as Record<string, unknown>)[name]
}

beforeEach(async () => {
  webStorageReads = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { easyfield: undefined },
  })
  installWebStorageTripwire('sessionStorage')
  installWebStorageTripwire('localStorage')
  await host.deleteCredential('cloud-generation-api-key')
  await host.deleteCredential('voice-provider-api-key')
})

after(() => {
  restoreGlobal('window', originalWindow)
  restoreGlobal('sessionStorage', originalSessionStorage)
  restoreGlobal('localStorage', originalLocalStorage)
})

test('browser fallback keeps credentials in module memory without accessing Web Storage', async () => {
  await host.setCredential('cloud-generation-api-key', 'provider-session-secret')
  await host.setCredential('voice-provider-api-key', 'voice-session-secret')

  assert.equal(await host.getCredential('cloud-generation-api-key'), 'provider-session-secret')
  assert.equal(await host.getCredential('voice-provider-api-key'), 'voice-session-secret')

  await host.setCredential('cloud-generation-api-key', '')
  await host.deleteCredential('voice-provider-api-key')

  assert.equal(await host.getCredential('cloud-generation-api-key'), '')
  assert.equal(await host.getCredential('voice-provider-api-key'), '')
  assert.equal(webStorageReads, 0)
})

test('plugin credentials continue to forward through the host IPC contract', async () => {
  const calls: Array<[operation: string, name: string, value?: string]> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      easyfield: {
        plugin: true,
        credentials: {
          get: async (name: string) => {
            calls.push(['get', name])
            return 'secure-host-value'
          },
          set: async (name: string, value: string) => {
            calls.push(['set', name, value])
          },
          delete: async (name: string) => {
            calls.push(['delete', name])
          },
        },
      },
    },
  })

  assert.equal(await host.getCredential('cloud-generation-api-key'), 'secure-host-value')
  await host.setCredential('cloud-generation-api-key', 'new-secure-value')
  await host.deleteCredential('cloud-generation-api-key')

  assert.deepEqual(calls, [
    ['get', 'cloud-generation-api-key'],
    ['set', 'cloud-generation-api-key', 'new-secure-value'],
    ['delete', 'cloud-generation-api-key'],
  ])
  assert.equal(webStorageReads, 0)
})
