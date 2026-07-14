export type StateNamespace = 'settings' | 'drafts' | 'jobs' | 'recipes' | 'transcripts' | 'projects'

interface PersistedStateItem<T> {
  key: string
  value: T
  updatedAt: number
}

export interface PluginUpdateStatus {
  supported: boolean
  available: boolean
  currentVersion: string
  candidateVersion: string | null
  currentBuildId: string | null
  candidateBuildId: string | null
  checkedAt: number
  sourceKind?: 'local-release' | 'local-workspace' | 'github-release'
  releaseNotes?: string
  reason?: string
}

export interface PluginUpdateInstallResult {
  installed: boolean
  restartRequired: boolean
  version: string
  buildId: string
}

const memory = new Map<string, unknown>()
const credentialMemory = new Map<string, string>()

function nativeHost() {
  return typeof window !== 'undefined' ? window.easyfield : undefined
}

function composite(namespace: StateNamespace, key: string): string {
  return `${namespace}:${key}`
}

export const host = {
  isPlugin: (): boolean => nativeHost()?.plugin === true,

  async getCredential(name: string): Promise<string> {
    const api = nativeHost()
    if (api?.credentials) return api.credentials.get(name)
    return credentialMemory.get(name) ?? ''
  },

  async setCredential(name: string, value: string): Promise<void> {
    const api = nativeHost()
    if (api?.credentials) return api.credentials.set(name, value)
    if (value) credentialMemory.set(name, value)
    else credentialMemory.delete(name)
  },

  async deleteCredential(name: string): Promise<void> {
    const api = nativeHost()
    if (api?.credentials) return api.credentials.delete(name)
    credentialMemory.delete(name)
  },

  async getState<T>(namespace: StateNamespace, key: string): Promise<T | null> {
    const api = nativeHost()
    if (api?.state) return api.state.get(namespace, key) as Promise<T | null>
    const value = memory.get(composite(namespace, key))
    if (value !== undefined) return value as T
    try {
      const raw = localStorage.getItem(`ef-state:${namespace}:${key}`)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  },

  async listState<T>(namespace: StateNamespace): Promise<Array<PersistedStateItem<T>>> {
    const api = nativeHost()
    if (api?.state) return api.state.list(namespace) as Promise<Array<PersistedStateItem<T>>>
    const prefix = `ef-state:${namespace}:`
    const out: Array<PersistedStateItem<T>> = []
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const storageKey = localStorage.key(i)
        if (!storageKey?.startsWith(prefix)) continue
        const raw = localStorage.getItem(storageKey)
        if (raw) out.push({ key: storageKey.slice(prefix.length), value: JSON.parse(raw) as T, updatedAt: 0 })
      }
    } catch {
      return out
    }
    return out
  },

  async setState<T>(namespace: StateNamespace, key: string, value: T): Promise<void> {
    const api = nativeHost()
    if (api?.state) return api.state.set(namespace, key, value)
    memory.set(composite(namespace, key), value)
    try { localStorage.setItem(`ef-state:${namespace}:${key}`, JSON.stringify(value)) } catch { /* memory fallback */ }
  },

  async deleteState(namespace: StateNamespace, key: string): Promise<void> {
    const api = nativeHost()
    if (api?.state) return api.state.delete(namespace, key)
    memory.delete(composite(namespace, key))
    try { localStorage.removeItem(`ef-state:${namespace}:${key}`) } catch { /* ignore */ }
  },

  async setWindowMode(mode: 'compact' | 'expanded'): Promise<void> {
    await nativeHost()?.window?.setMode(mode)
  },

  async checkForUpdates(): Promise<PluginUpdateStatus> {
    const api = nativeHost()
    if (api?.updates) return api.updates.check()
    return {
      supported: false,
      available: false,
      currentVersion: 'development',
      candidateVersion: null,
      currentBuildId: null,
      candidateBuildId: null,
      checkedAt: Date.now(),
      reason: 'Updates are available from the installed DaVinci Resolve integration.',
    }
  },

  async installUpdate(): Promise<PluginUpdateInstallResult> {
    const api = nativeHost()
    if (!api?.updates) throw new Error('Open EasyField inside DaVinci Resolve to install updates.')
    return api.updates.install()
  },

  async ingestArtifact(input: { url: string; name: string; kind: 'image' | 'video' | 'audio' }): Promise<{ id: string; url: string; checksum: string } | null> {
    const api = nativeHost()
    if (!api?.artifacts) return null
    if (/^https:\/\//i.test(input.url)) return api.artifacts.ingestUrl(input)
    if (!/^(?:blob:|data:)/i.test(input.url) || !api.artifacts.ingestBytes) return null

    const response = await fetch(input.url)
    if (!response.ok) throw new Error('The local result could not be read before saving.')
    const bytes = await response.arrayBuffer()
    if (!bytes.byteLength) throw new Error('The local result was empty.')
    return api.artifacts.ingestBytes({
      bytes,
      name: input.name,
      kind: input.kind,
    })
  },
}
