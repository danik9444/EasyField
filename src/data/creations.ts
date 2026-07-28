// The creations store + folders. Metadata is mirrored to IndexedDB and local
// blob/data URLs are stored as real Blob values, so Library items survive a UI
// reload. Remote URLs are retained as metadata when browser CORS prevents a
// durable byte copy. Every Library item represents real media; failed timeline
// captures are never persisted as pixel-less placeholders.
import { useSyncExternalStore } from 'react'
import { host } from '../services/host.ts'

export type CreationKind = 'image' | 'video' | 'audio'
export type CreationDurability = 'local' | 'link-only'
export type PersistenceState = 'loading' | 'ready' | 'unavailable' | 'error'

export interface BeatCreationCompanion {
  id: string
  kind: 'beat-analysis'
  schemaVersion: 1
  fileName: string
  mimeType: 'application/vnd.easyfield.beats+json'
  data: string
  createdAt: number
  summary: {
    bpm: number
    detectedBeats: number
    markerCount: number
    confidence: number
    durationSeconds: number
    engine: 'librosa'
    engineVersion: string
    markerColor: string
  }
}

export interface TranscriptCreationCompanion {
  id: string
  kind: 'transcript'
  schemaVersion: 1
  fileName: string
  mimeType: 'application/vnd.easyfield.transcript+json'
  data: string
  createdAt: number
  summary: {
    language: string
    model: string
    durationSeconds: number
    segmentCount: number
    wordCount: number
    wordTimestamps: boolean
    sourceKind: 'audio' | 'video'
  }
}

export type CreationCompanion = BeatCreationCompanion | TranscriptCreationCompanion

export interface Creation {
  id: string
  kind: CreationKind
  url: string // blob: (localized) or a remote/provider URL
  model?: string
  prompt?: string
  meta?: string // resolution / duration / timecode
  createdAt: number
  fromTimeline?: boolean
  folderId?: string | null
  durability: CreationDurability
  companions?: CreationCompanion[]
}

export interface Folder {
  id: string
  name: string
  createdAt: number
}

let creations: Creation[] = []
let folders: Folder[] = []
const listeners = new Set<() => void>()
let counter = 0
let persistenceState: PersistenceState = 'loading'

const DB_NAME = 'easyfield-library'
const DB_VERSION = 1
const CREATION_STORE = 'creations'
const FOLDER_STORE = 'folders'
const removedCreationIds = new Set<string>()
const removedFolderIds = new Set<string>()

interface StoredCreation extends Omit<Creation, 'url'> {
  schemaVersion?: 1
  url: string
  blob?: Blob
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string')
}

function hasFiniteNumbers(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

function sanitizeCreationCompanion(value: unknown): CreationCompanion | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !hasStrings(value, ['id', 'fileName', 'mimeType', 'data'])
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
    || !isRecord(value.summary)
  ) return null

  const summary = value.summary
  if (
    value.kind === 'beat-analysis'
    && value.mimeType === 'application/vnd.easyfield.beats+json'
    && hasFiniteNumbers(summary, ['bpm', 'detectedBeats', 'markerCount', 'confidence', 'durationSeconds'])
    && summary.engine === 'librosa'
    && hasStrings(summary, ['engineVersion', 'markerColor'])
  ) {
    return {
      id: value.id as string,
      kind: value.kind,
      schemaVersion: 1,
      fileName: value.fileName as string,
      mimeType: value.mimeType,
      data: value.data as string,
      createdAt: value.createdAt,
      summary: {
        bpm: summary.bpm as number,
        detectedBeats: summary.detectedBeats as number,
        markerCount: summary.markerCount as number,
        confidence: summary.confidence as number,
        durationSeconds: summary.durationSeconds as number,
        engine: summary.engine,
        engineVersion: summary.engineVersion as string,
        markerColor: summary.markerColor as string,
      },
    }
  }

  if (
    value.kind === 'transcript'
    && value.mimeType === 'application/vnd.easyfield.transcript+json'
    && hasStrings(summary, ['language', 'model', 'sourceKind'])
    && hasFiniteNumbers(summary, ['durationSeconds', 'segmentCount', 'wordCount'])
    && typeof summary.wordTimestamps === 'boolean'
    && (summary.sourceKind === 'audio' || summary.sourceKind === 'video')
  ) {
    return {
      id: value.id as string,
      kind: value.kind,
      schemaVersion: 1,
      fileName: value.fileName as string,
      mimeType: value.mimeType,
      data: value.data as string,
      createdAt: value.createdAt,
      summary: {
        language: summary.language as string,
        model: summary.model as string,
        durationSeconds: summary.durationSeconds as number,
        segmentCount: summary.segmentCount as number,
        wordCount: summary.wordCount as number,
        wordTimestamps: summary.wordTimestamps,
        sourceKind: summary.sourceKind,
      },
    }
  }

  return null
}

function sanitizeStoredCreation(value: unknown): StoredCreation | null {
  if (
    !isRecord(value)
    || (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    || typeof value.id !== 'string'
    || !value.id
    || (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio')
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
  ) return null

  const blob = typeof Blob !== 'undefined' && value.blob instanceof Blob ? value.blob : undefined
  const url = typeof value.url === 'string' && value.url.trim() ? value.url : ''
  if (!blob && !url) return null

  const companions = Array.isArray(value.companions)
    ? value.companions.map(sanitizeCreationCompanion).filter((item): item is CreationCompanion => item !== null).slice(0, 8)
    : []
  const durability: CreationDurability = value.durability === 'local' || value.durability === 'link-only'
    ? value.durability
    : blob || !/^https?:\/\//i.test(url) ? 'local' : 'link-only'

  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    url,
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.meta === 'string' ? { meta: value.meta } : {}),
    createdAt: value.createdAt,
    ...(typeof value.fromTimeline === 'boolean' ? { fromTimeline: value.fromTimeline } : {}),
    folderId: typeof value.folderId === 'string' || value.folderId === null ? value.folderId : null,
    durability,
    ...(companions.length ? { companions } : {}),
    ...(blob ? { blob } : {}),
  }
}

function sanitizeFolder(value: unknown): Folder | null {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || typeof value.name !== 'string'
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
  ) return null
  return { id: value.id, name: value.name, createdAt: value.createdAt }
}

function setPersistenceState(next: PersistenceState) {
  if (persistenceState === next) return
  persistenceState = next
  emit()
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    setPersistenceState('unavailable')
    return Promise.resolve(null)
  }
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CREATION_STORE)) db.createObjectStore(CREATION_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(FOLDER_STORE)) db.createObjectStore(FOLDER_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        dbPromise = null
      }
      resolve(request.result)
    }
    request.onerror = () => {
      dbPromise = null
      setPersistenceState('unavailable')
      resolve(null)
    }
    request.onblocked = () => {
      dbPromise = null
      setPersistenceState('unavailable')
      resolve(null)
    }
  })
  return dbPromise
}

async function readStore(name: string): Promise<unknown[]> {
  const db = await openDatabase()
  if (!db) return []
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(name, 'readonly')
    } catch {
      dbPromise = null
      setPersistenceState('error')
      resolve([])
      return
    }
    const request = tx.objectStore(name).getAll()
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
    request.onerror = () => {
      setPersistenceState('error')
      resolve([])
    }
    tx.onabort = () => {
      setPersistenceState('error')
      resolve([])
    }
  })
}

async function writeStore(name: string, action: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDatabase()
  if (!db) return
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(name, 'readwrite')
    } catch {
      dbPromise = null
      setPersistenceState('error')
      resolve()
      return
    }
    action(tx.objectStore(name))
    tx.oncomplete = () => resolve()
    tx.onerror = () => {
      setPersistenceState('error')
      resolve()
    }
    tx.onabort = () => {
      setPersistenceState('error')
      resolve()
    }
  })
}

async function putCreationPreservingBlob(current: Creation, newBlob?: Blob, required = false): Promise<void> {
  const db = await openDatabase()
  if (!db) {
    if (required) throw new Error('The local Library index is unavailable')
    return
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (error && required) reject(error)
      else resolve()
    }
    let tx: IDBTransaction
    try {
      tx = db.transaction(CREATION_STORE, 'readwrite')
    } catch (error) {
      dbPromise = null
      setPersistenceState('error')
      finish(error instanceof Error ? error : new Error('The local Library index could not be opened'))
      return
    }
    const store = tx.objectStore(CREATION_STORE)
    const request = store.get(current.id)
    request.onsuccess = () => {
      const existing = request.result as StoredCreation | undefined
      const blob = newBlob ?? existing?.blob
      const stored: StoredCreation = blob
        ? { schemaVersion: 1, ...current, blob }
        : { schemaVersion: 1, ...current }
      store.put(stored)
    }
    request.onerror = () => {
      setPersistenceState('error')
      finish(request.error ?? new Error('The local Library record could not be read'))
    }
    tx.oncomplete = () => finish()
    tx.onerror = () => {
      setPersistenceState('error')
      finish(tx.error ?? new Error('The local Library record could not be saved'))
    }
    tx.onabort = () => {
      setPersistenceState('error')
      finish(tx.error ?? new Error('The local Library save was aborted'))
    }
  })
}

async function persistCreation(id: string, required = false): Promise<void> {
  let current = creations.find((creation) => creation.id === id)
  if (!current || removedCreationIds.has(id)) return

  let blob: Blob | undefined
  if (current.url && /^(blob:|data:)/i.test(current.url)) {
    try {
      const response = await fetch(current.url)
      if (response.ok) blob = await response.blob()
    } catch {
      // Metadata still persists; the active in-memory URL remains usable.
    }
  }

  // A folder move or deletion may have happened while bytes were being read.
  current = creations.find((creation) => creation.id === id)
  if (!current || removedCreationIds.has(id)) return
  await putCreationPreservingBlob(current, blob, required)
}

function deleteStoredCreations(ids: string[]): void {
  void writeStore(CREATION_STORE, (store) => ids.forEach((id) => store.delete(id)))
}

function persistFolder(folder: Folder): void {
  void writeStore(FOLDER_STORE, (store) => store.put(folder))
}

function deleteStoredFolder(id: string): void {
  void writeStore(FOLDER_STORE, (store) => store.delete(id))
}

function emit() {
  for (const l of listeners) l()
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
// Back-compat alias.
export const subscribeCreations = subscribe

export function getCreations(): Creation[] {
  return creations
}
export function getFolders(): Folder[] {
  return folders
}
export function getPersistenceState(): PersistenceState {
  return persistenceState
}

export interface NewCreation {
  kind: CreationKind
  url: string
  model?: string
  prompt?: string
  meta?: string
  fromTimeline?: boolean
  folderId?: string | null
  durability?: CreationDurability
  companions?: CreationCompanion[]
}

const MANAGED_ARTIFACT_URL = /^\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function mergeCreation(existing: Creation, input: NewCreation): Creation {
  return {
    ...existing,
    kind: input.kind,
    model: input.model ?? existing.model,
    prompt: input.prompt ?? existing.prompt,
    meta: input.meta ?? existing.meta,
    fromTimeline: input.fromTimeline ?? existing.fromTimeline,
    folderId: input.folderId !== undefined ? input.folderId : existing.folderId,
    durability: input.durability ?? existing.durability,
    companions: input.companions ?? existing.companions,
  }
}

function addOrMergeCreations(items: NewCreation[]): Creation[] {
  const validItems = items.filter((item) => typeof item.url === 'string' && item.url.trim().length > 0)
  if (!validItems.length) return []
  const now = Date.now()
  const added: Creation[] = []
  const newlyAdded: Creation[] = []
  const byUrl = new Map(creations.map((creation) => [creation.url, creation]))
  for (const it of validItems) {
    const url = it.url
    const existing = byUrl.get(url)
    if (existing) {
      const merged = mergeCreation(existing, it)
      creations = creations.map((creation) => creation.id === existing.id ? merged : creation)
      const pendingIndex = newlyAdded.findIndex((creation) => creation.id === existing.id)
      if (pendingIndex >= 0) newlyAdded[pendingIndex] = merged
      byUrl.set(url, merged)
      added.push(merged)
      continue
    }
    const creation: Creation = {
      id: `cr-${now}-${counter++}`,
      kind: it.kind,
      url,
      model: it.model,
      prompt: it.prompt,
      meta: it.meta,
      fromTimeline: it.fromTimeline,
      folderId: it.folderId ?? null,
      durability: it.durability ?? (/^(blob:|data:)/i.test(url) ? 'local' : 'link-only'),
      companions: it.companions?.slice(0, 8),
      createdAt: now,
    }
    byUrl.set(url, creation)
    added.push(creation)
    newlyAdded.push(creation)
  }
  // Newest first. Existing records keep their position and stable identity so
  // a screen can enrich the minimal record committed by the paid-job path
  // without duplicating the same managed artifact in Library.
  creations = [...newlyAdded].reverse().concat(creations)
  emit()
  return added
}

export function addCreations(items: NewCreation[]): Creation[] {
  const added = addOrMergeCreations(items)
  added.forEach((creation) => void persistCreation(creation.id))
  added.forEach((creation) => {
    if (creation.durability === 'link-only' && /^https:\/\//i.test(creation.url)) void materializeCreation(creation.id)
  })
  return added
}

/**
 * Commits paid provider outputs to Main's managed Artifact Store before they
 * become Library records. Main downloads to a temporary file, verifies the
 * media signature and SHA-256 checksum, then atomically renames it. Returning
 * from this function therefore means every provider URL or locally rendered
 * Blob/data result has a stable local artifact URL; a failed commit rejects
 * the whole Library batch and leaves tracked work recoverable in Job Center.
 *
 * The standalone Vite development surface has no Main-owned Artifact Store.
 * It retains the existing preview behavior there; release builds run through
 * the plugin branch below.
 */
export interface DurableCreationOptions {
  /** Called after Main verifies every file, before the renderer Library write. */
  onSecured?: (items: readonly NewCreation[]) => void | Promise<void>
}

export async function addCreationsDurably(items: NewCreation[], options: DurableCreationOptions = {}): Promise<Creation[]> {
  const validItems = items.filter((item) => typeof item.url === 'string' && item.url.trim().length > 0)
  if (!validItems.length) return []

  const securedByUrl = new Map<string, string>()
  const secured: NewCreation[] = []
  for (const item of validItems) {
    let url = securedByUrl.get(item.url)
    if (!url) {
      url = item.url
      if (host.isPlugin()) {
        if (/^(?:https:\/\/|blob:|data:)/i.test(item.url)) {
          const artifact = await host.ingestArtifact({
            url: item.url,
            name: item.prompt || item.model || 'EasyField result',
            kind: item.kind,
          })
          if (!artifact || !MANAGED_ARTIFACT_URL.test(artifact.url) || !/^[0-9a-f]{64}$/i.test(artifact.checksum)) {
            throw new Error('The generated result could not be verified in the local Artifact Store.')
          }
          url = artifact.url
        } else if (!MANAGED_ARTIFACT_URL.test(item.url)) {
          throw new Error('A paid result must be committed to the managed Artifact Store before Library can accept it.')
        }
      }
      securedByUrl.set(item.url, url)
    }
    secured.push({
      ...item,
      url,
      durability: MANAGED_ARTIFACT_URL.test(url) || /^(blob:|data:)/i.test(url) ? 'local' : item.durability,
    })
  }

  // Persist opaque artifact receipts into the Job ledger before touching the
  // renderer index. A crash or IndexedDB failure after this point can rebuild
  // Library from Job Center without downloading or regenerating the media.
  await options.onSecured?.(secured)

  const added = addOrMergeCreations(secured)
  // IndexedDB is the renderer's Library index. Await its writes instead of
  // launching them fire-and-forget; the durable job ledger additionally keeps
  // the opaque artifact URLs so startup can reconcile a missing index entry.
  // In the packaged renderer an IndexedDB failure must keep the job
  // recoverable instead of announcing that a result is visible in Library.
  // Node unit tests have no DOM/IndexedDB surface and exercise Main ingestion
  // independently, so strict index persistence applies only to the real panel.
  const requireLibraryIndex = host.isPlugin() && typeof document !== 'undefined'
  await Promise.all(added.map((creation) => persistCreation(creation.id, requireLibraryIndex)))
  return added
}

async function materializeCreation(id: string): Promise<void> {
  const original = creations.find((creation) => creation.id === id)
  if (!original || original.durability !== 'link-only' || !original.url) return
  try {
    const artifact = await host.ingestArtifact({
      url: original.url,
      name: original.prompt || original.model || 'EasyField result',
      kind: original.kind,
    })
    if (!artifact || removedCreationIds.has(id)) return
    creations = creations.map((creation) => creation.id === id ? { ...creation, url: artifact.url, durability: 'local' } : creation)
    emit()
    await persistCreation(id)
  } catch {
    // Keep the temporary link visible and labelled. A future recovery pass can
    // retry while the provider URL is still valid; never claim it is local.
  }
}

export function addCreation(item: NewCreation): Creation | null {
  return addCreations([item])[0] ?? null
}

export function removeCreations(ids: Iterable<string>): void {
  const set = new Set(ids)
  set.forEach((id) => removedCreationIds.add(id))
  for (const c of creations) {
    if (set.has(c.id) && c.url.startsWith('blob:')) URL.revokeObjectURL(c.url)
  }
  creations = creations.filter((c) => !set.has(c.id))
  emit()
  deleteStoredCreations([...set])
}
export function removeCreation(id: string): void {
  removeCreations([id])
}

export function attachCreationCompanion(creationId: string, companion: CreationCompanion): Creation | null {
  let updated: Creation | null = null
  creations = creations.map((creation) => {
    if (creation.id !== creationId) return creation
    const companions = [companion, ...(creation.companions ?? []).filter((item) => item.id !== companion.id)].slice(0, 8)
    updated = { ...creation, companions }
    return updated
  })
  if (!updated) return null
  emit()
  void persistCreation(creationId)
  return updated
}

export function moveCreations(ids: Iterable<string>, folderId: string | null): void {
  const set = new Set(ids)
  creations = creations.map((c) => (set.has(c.id) ? { ...c, folderId } : c))
  emit()
  set.forEach((id) => void persistCreation(id))
}

// ---- Folders ----
export function createFolder(name: string): Folder {
  const folder: Folder = { id: `fd-${Date.now()}-${counter++}`, name: name.trim() || 'Untitled', createdAt: Date.now() }
  folders = [...folders, folder]
  emit()
  persistFolder(folder)
  return folder
}
export function renameFolder(id: string, name: string): void {
  folders = folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f))
  emit()
  const folder = folders.find((item) => item.id === id)
  if (folder) persistFolder(folder)
}
export function deleteFolder(id: string): void {
  // Loose the items back to the root rather than deleting them.
  const affectedIds = creations.filter((creation) => creation.folderId === id).map((creation) => creation.id)
  creations = creations.map((c) => (c.folderId === id ? { ...c, folderId: null } : c))
  folders = folders.filter((f) => f.id !== id)
  removedFolderIds.add(id)
  emit()
  affectedIds.forEach((creationId) => void persistCreation(creationId))
  deleteStoredFolder(id)
}

export function folderCount(id: string | null): number {
  return creations.filter((c) => (id === null ? true : c.folderId === id)).length
}

// React hooks — re-render on any store change.
export function useCreations(): Creation[] {
  return useSyncExternalStore(subscribe, getCreations, getCreations)
}
export function useFolders(): Folder[] {
  return useSyncExternalStore(subscribe, getFolders, getFolders)
}
export function usePersistenceState(): PersistenceState {
  return useSyncExternalStore(subscribe, getPersistenceState, getPersistenceState)
}

async function hydrateFromStorage(): Promise<void> {
  try {
    const [storedCreations, storedFolders] = await Promise.all([
      readStore(CREATION_STORE),
      readStore(FOLDER_STORE),
    ])

    const knownCreations = new Set(creations.map((creation) => creation.id))
    const creationRecords = storedCreations.map((value) => ({ value, creation: sanitizeStoredCreation(value) }))
    const discardedCreationIds = creationRecords.flatMap(({ value, creation }) =>
      !creation && isRecord(value) && typeof value.id === 'string' ? [value.id] : [])
    if (discardedCreationIds.length) deleteStoredCreations(discardedCreationIds)
    const hydratedCreations: Creation[] = creationRecords
      .flatMap(({ creation }) => creation ? [creation] : [])
      .filter((creation) => (creation.blob || creation.url) && !knownCreations.has(creation.id) && !removedCreationIds.has(creation.id))
      .map(({ blob, schemaVersion: _schemaVersion, ...creation }) => ({
        ...creation,
        url: blob ? URL.createObjectURL(blob) : creation.url,
        durability: blob ? 'local' : creation.durability ?? (/^https?:\/\//i.test(creation.url) ? 'link-only' : 'local'),
      }))
    const knownFolders = new Set(folders.map((folder) => folder.id))
    const hydratedFolders = storedFolders
      .map(sanitizeFolder)
      .filter((folder): folder is Folder => folder !== null)
      .filter((folder) => !knownFolders.has(folder.id) && !removedFolderIds.has(folder.id))

    if (hydratedCreations.length || hydratedFolders.length) {
      creations = [...creations, ...hydratedCreations].sort((a, b) => b.createdAt - a.createdAt)
      folders = [...folders, ...hydratedFolders].sort((a, b) => a.createdAt - b.createdAt)
      emit()
      // Older versions could retain temporary remote links. Resolve them into
      // Main-owned artifacts after hydration so successful migrations rewrite
      // both the Library index and future preview traffic to local URLs.
      if (host.isPlugin()) {
        hydratedCreations
          .filter((creation) => creation.durability === 'link-only' && /^https:\/\//i.test(creation.url))
          .forEach((creation) => void materializeCreation(creation.id))
      }
    }
  } finally {
    // `ready` means IndexedDB hydration is complete, not merely that the
    // database connection opened. Screens restoring Library-backed drafts can
    // now safely distinguish an empty store from data that is still loading.
    if (persistenceState === 'loading') setPersistenceState('ready')
  }
}

const libraryHydrationPromise = hydrateFromStorage()

/** Wait until the renderer Library index has finished loading before recovery
 * reconciles durable Job Center artifact references into it. */
export function prepareCreationLibrary(): Promise<void> {
  return libraryHydrationPromise
}
