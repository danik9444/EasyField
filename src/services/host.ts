import type {
  AccountAuthOutcome,
  AccountBridgeApi,
  AccountCheckoutOpened,
  AccountCheckoutRequest,
  AccountOAuthCompletion,
  AccountOAuthStart,
  AccountPasswordRecoveryCompletion,
  AccountPasswordRecoveryStart,
  AccountResult,
  AccountViewSnapshot,
} from '../core/accountBridge'
import type { AutoReloadPolicy } from '../data/subscriptions'

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

function accountUnavailable<T>(): AccountResult<T> {
  return {
    ok: false,
    error: {
      code: 'service-unavailable',
      message: 'EasyField Account is not configured in this build yet.',
      retryable: false,
    },
  }
}

function accountApi(): AccountBridgeApi | undefined {
  return nativeHost()?.account
}

async function callAccount<T>(
  invoke: (api: AccountBridgeApi) => Promise<AccountResult<T>>,
): Promise<AccountResult<T>> {
  const api = accountApi()
  if (!api) return accountUnavailable<T>()
  try {
    return await invoke(api)
  } catch {
    return {
      ok: false,
      error: {
        code: 'service-unavailable',
        message: 'EasyField Account could not be reached.',
        retryable: true,
      },
    }
  }
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

  async connectDirectCloudCredential(candidate: string): Promise<{ credits: number }> {
    const api = nativeHost()
    if (!api?.directCloud) {
      throw new Error('Secure direct cloud connection is available inside DaVinci Resolve.')
    }
    const result = await api.directCloud.connect(candidate)
    if (
      !result
      || typeof result.credits !== 'number'
      || !Number.isFinite(result.credits)
      || result.credits < 0
    ) {
      throw new Error('Direct cloud verification returned an invalid response.')
    }
    return { credits: result.credits }
  },

  async hasExistingDirectCloudCredential(): Promise<boolean> {
    const api = nativeHost()
    if (!api?.directCloud || typeof api.directCloud.hasExisting !== 'function') return false
    try {
      return await api.directCloud.hasExisting() === true
    } catch {
      return false
    }
  },

  async hasCurrentAccountDirectCloudCredential(): Promise<boolean> {
    const api = nativeHost()
    if (!api?.directCloud || typeof api.directCloud.hasScoped !== 'function') return false
    try {
      return await api.directCloud.hasScoped() === true
    } catch {
      return false
    }
  },

  async adoptExistingDirectCloudCredential(): Promise<{ credits: number }> {
    const api = nativeHost()
    if (!api?.directCloud || typeof api.directCloud.adoptExisting !== 'function') {
      throw new Error('Saved Mac connection adoption is available inside DaVinci Resolve.')
    }
    const result = await api.directCloud.adoptExisting()
    if (
      !result
      || Object.keys(result).length !== 1
      || typeof result.credits !== 'number'
      || !Number.isFinite(result.credits)
      || result.credits < 0
    ) {
      throw new Error('Saved Mac connection returned an invalid response.')
    }
    return { credits: result.credits }
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

  async setWindowLayout(mode: 'compact' | 'expanded', heightMode: 'standard' | 'full'): Promise<void> {
    const api = nativeHost()?.window
    if (api?.setLayout) {
      await api.setLayout(mode, heightMode)
      return
    }
    // Compatibility with an older installed preload while an update is being
    // staged: width still changes, and Full height becomes available after the
    // native integration restarts on the matching release.
    await api?.setMode(mode)
  },

  async openCreditPurchase(): Promise<void> {
    const api = nativeHost()
    if (!api?.billing) throw new Error('Open EasyField inside DaVinci Resolve to purchase credits.')
    await api.billing.openCreditPurchase()
  },

  account: {
    isAvailable(): boolean {
      return accountApi() != null
    },

    restore(): Promise<AccountResult<AccountViewSnapshot>> {
      return callAccount((api) => api.restore())
    },

    signIn(input: { email: string; password: string }): Promise<AccountResult<AccountAuthOutcome>> {
      return callAccount((api) => api.signIn(input))
    },

    signUp(input: { email: string; password: string }): Promise<AccountResult<AccountAuthOutcome>> {
      return callAccount((api) => api.signUp(input))
    },

    startOAuth(input: { provider: 'google' | 'apple' }): Promise<AccountResult<AccountOAuthStart>> {
      return callAccount((api) => api.startOAuth(input))
    },

    signOut(): Promise<AccountResult<{ snapshot: AccountViewSnapshot }>> {
      return callAccount((api) => api.signOut())
    },

    requestPasswordReset(input: { email: string }): Promise<AccountResult<AccountPasswordRecoveryStart>> {
      return callAccount((api) => api.requestPasswordReset(input))
    },

    completePasswordRecovery(input: { attemptId: string; password: string }): Promise<AccountResult<{ snapshot: AccountViewSnapshot }>> {
      return callAccount((api) => api.completePasswordRecovery(input))
    },

    cancelPasswordRecovery(input: { attemptId: string }): Promise<AccountResult<{ accepted: true }>> {
      return callAccount((api) => api.cancelPasswordRecovery(input))
    },

    updateProfile(input: { displayName: string }): Promise<AccountResult<AccountViewSnapshot>> {
      return callAccount((api) => api.updateProfile(input))
    },

    resendVerification(input: { email: string }): Promise<AccountResult<{ accepted: true }>> {
      return callAccount((api) => api.resendVerification(input))
    },

    getSnapshot(input?: { force?: boolean }): Promise<AccountResult<AccountViewSnapshot>> {
      return callAccount((api) => api.getSnapshot(input))
    },

    checkout(input: AccountCheckoutRequest): Promise<AccountResult<AccountCheckoutOpened>> {
      return callAccount((api) => api.checkout(input))
    },

    resumeCheckout(): Promise<AccountResult<AccountCheckoutOpened>> {
      return callAccount((api) => api.resumeCheckout())
    },

    saveAutoReload(input: { policy: AutoReloadPolicy }): Promise<AccountResult<AccountViewSnapshot>> {
      return callAccount((api) => api.saveAutoReload(input))
    },

    onChanged(listener: (snapshot: AccountViewSnapshot) => void): () => void {
      const api = accountApi()
      if (!api) return () => undefined
      try {
        return api.onChanged(listener)
      } catch {
        return () => undefined
      }
    },

    onOAuthCompleted(listener: (completion: AccountOAuthCompletion) => void): () => void {
      const api = accountApi()
      if (!api) return () => undefined
      try {
        return api.onOAuthCompleted(listener)
      } catch {
        return () => undefined
      }
    },

    onPasswordRecoveryCompleted(listener: (completion: AccountPasswordRecoveryCompletion) => void): () => void {
      const api = accountApi()
      if (!api) return () => undefined
      try {
        return api.onPasswordRecoveryCompleted(listener)
      } catch {
        return () => undefined
      }
    },
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
