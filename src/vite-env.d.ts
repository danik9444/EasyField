/// <reference types="vite/client" />

interface Window {
  easyfield?: {
    plugin: boolean
    credentials?: {
      get: (name: string) => Promise<string>
      set: (name: string, value: string) => Promise<void>
      delete: (name: string) => Promise<void>
    }
    state?: {
      get: (namespace: string, key: string) => Promise<unknown | null>
      list: (namespace: string) => Promise<Array<{ key: string; value: unknown; updatedAt: number }>>
      set: (namespace: string, key: string, value: unknown) => Promise<void>
      delete: (namespace: string, key: string) => Promise<void>
    }
    window?: {
      setMode: (mode: 'compact' | 'expanded') => Promise<void>
    }
    billing?: {
      openCreditPurchase: () => Promise<void>
    }
    updates?: {
      check: () => Promise<import('./services/host').PluginUpdateStatus>
      install: () => Promise<import('./services/host').PluginUpdateInstallResult>
    }
    artifacts?: {
      ingestUrl: (input: { url: string; name: string; kind: 'image' | 'video' | 'audio' }) => Promise<{ id: string; url: string; checksum: string }>
      ingestBytes: (input: { bytes: ArrayBuffer; name: string; kind: 'image' | 'video' | 'audio' }) => Promise<{ id: string; url: string; checksum: string }>
    }
  }
}
