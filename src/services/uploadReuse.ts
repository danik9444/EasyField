// Coalesces identical, short-lived media uploads without retaining credentials.
// The caller supplies the upload closure only while an entry is pending; after
// success the closure (and anything it captured) is replaced by the public URL.

interface PendingUpload {
  state: 'pending'
  controller: AbortController
  promise: Promise<string>
  waiters: number
}

interface ReadyUpload {
  state: 'ready'
  url: string
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout> | null
}

type UploadEntry = PendingUpload | ReadyUpload

export interface UploadReuseCache {
  getOrUpload(
    sourceId: string,
    signal: AbortSignal | undefined,
    upload: (sharedSignal: AbortSignal) => Promise<string>,
  ): Promise<string>
  clear(): void
  readonly size: number
}

interface UploadReuseOptions {
  ttlMs: number
  maxReadyEntries: number
}

const cancelled = () => new Error('Cancelled')

export function createUploadReuseCache(options: UploadReuseOptions): UploadReuseCache {
  const ttlMs = Math.max(1, options.ttlMs)
  const maxReadyEntries = Math.max(1, Math.floor(options.maxReadyEntries))
  const entries = new Map<string, UploadEntry>()

  const removeReady = (sourceId: string, entry: ReadyUpload) => {
    if (entries.get(sourceId) !== entry) return
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer)
    entries.delete(sourceId)
  }

  const scheduleReadyExpiry = (sourceId: string, entry: ReadyUpload) => {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer)
    entry.expiryTimer = setTimeout(() => removeReady(sourceId, entry), ttlMs)
  }

  const touchReady = (sourceId: string, entry: ReadyUpload): string => {
    entry.expiresAt = Date.now() + ttlMs
    scheduleReadyExpiry(sourceId, entry)
    // Map insertion order doubles as an inexpensive LRU list.
    entries.delete(sourceId)
    entries.set(sourceId, entry)
    return entry.url
  }

  const pruneReady = () => {
    const now = Date.now()
    for (const [sourceId, entry] of entries) {
      if (entry.state === 'ready' && entry.expiresAt <= now) removeReady(sourceId, entry)
    }
  }

  const enforceReadyLimit = () => {
    let readyCount = 0
    for (const entry of entries.values()) {
      if (entry.state === 'ready') readyCount += 1
    }
    if (readyCount <= maxReadyEntries) return
    for (const [sourceId, entry] of entries) {
      if (entry.state !== 'ready') continue
      removeReady(sourceId, entry)
      readyCount -= 1
      if (readyCount <= maxReadyEntries) return
    }
  }

  const waitForPending = (sourceId: string, entry: PendingUpload, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) return Promise.reject(cancelled())
    entry.waiters += 1
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const release = (aborted: boolean) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        entry.waiters = Math.max(0, entry.waiters - 1)
        // One cancelled scene must not cancel a shared upload still needed by a
        // sibling. Abort only when every subscriber has left.
        if (aborted && entry.waiters === 0 && entries.get(sourceId) === entry) {
          entries.delete(sourceId)
          entry.controller.abort()
        }
      }
      const onAbort = () => {
        release(true)
        reject(cancelled())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      entry.promise.then(
        (url) => {
          if (settled) return
          release(false)
          resolve(url)
        },
        (error) => {
          if (settled) return
          release(false)
          reject(error)
        },
      )
    })
  }

  return {
    get size() {
      return entries.size
    },

    getOrUpload(sourceId, signal, upload) {
      if (signal?.aborted) return Promise.reject(cancelled())
      pruneReady()
      const existing = entries.get(sourceId)
      if (existing?.state === 'ready') return Promise.resolve(touchReady(sourceId, existing))
      if (existing?.state === 'pending') return waitForPending(sourceId, existing, signal)

      const controller = new AbortController()
      const pending: PendingUpload = {
        state: 'pending',
        controller,
        // Starting in a microtask lets a second synchronous caller subscribe to
        // the entry before the transport begins.
        promise: Promise.resolve().then(() => upload(controller.signal)),
        waiters: 0,
      }
      entries.set(sourceId, pending)
      void pending.promise.then(
        (url) => {
          if (entries.get(sourceId) !== pending) return
          const ready: ReadyUpload = {
            state: 'ready',
            url,
            expiresAt: Date.now() + ttlMs,
            expiryTimer: null,
          }
          entries.set(sourceId, ready)
          scheduleReadyExpiry(sourceId, ready)
          enforceReadyLimit()
        },
        () => {
          // A rejected/aborted upload is never poisoned into the cache; the next
          // caller gets a clean retry.
          if (entries.get(sourceId) === pending) entries.delete(sourceId)
        },
      )
      return waitForPending(sourceId, pending, signal)
    },

    clear() {
      for (const entry of entries.values()) {
        if (entry.state === 'pending') entry.controller.abort()
        else if (entry.expiryTimer) clearTimeout(entry.expiryTimer)
      }
      entries.clear()
    },
  }
}
