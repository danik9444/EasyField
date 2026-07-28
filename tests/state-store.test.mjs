import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStateStore } = require('../plugin/state-store.cjs')
const { createStateDocumentStore, isDocumentReference } = require('../plugin/state-document-store.cjs')

test('SQLite state store persists namespaced records and updates atomically', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easyfield-state-test-'))
  let store = createStateStore(directory)
  t.after(async () => {
    try { store.close() } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true })
  })

  assert.equal(store.get('jobs', 'ledger'), null)
  assert.equal(store.set('jobs', 'ledger', [{ id: 'job-1', status: 'running' }]), true)
  assert.deepEqual(store.get('jobs', 'ledger'), [{ id: 'job-1', status: 'running' }])

  store.set('jobs', 'ledger', [{ id: 'job-1', status: 'succeeded' }])
  assert.deepEqual(store.get('jobs', 'ledger'), [{ id: 'job-1', status: 'succeeded' }])
  assert.equal(store.list('jobs').length, 1)
  assert.equal(store.list('jobs')[0].key, 'ledger')

  store.set('drafts', 'project-a:culling', { recipeId: 'review' })
  assert.deepEqual(store.list('drafts').map((item) => item.key), ['project-a:culling'])
  assert.equal(store.list('jobs').length, 1, 'namespaces must not leak into each other')

  store.delete('jobs', 'ledger')
  assert.equal(store.get('jobs', 'ledger'), null)

  assert.throws(() => store.set('settings', 'invalid', undefined), /not JSON serializable/)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(store.databasePath)).mode & 0o777, 0o600)
  for (const name of await readdir(directory)) {
    if (!name.startsWith('easyfield.sqlite3')) continue
    assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600, `${name} must remain private`)
  }

  const { DatabaseSync } = require('node:sqlite')
  const inspection = new DatabaseSync(store.databasePath)
  assert.equal(inspection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 1').get().count, 1)
  inspection.close()

  store.set('projects', 'restart-proof', { name: 'Persistent project' })
  store.close()
  store = createStateStore(directory)
  assert.deepEqual(store.get('projects', 'restart-proof'), { name: 'Persistent project' })
  assert.equal(store.list('projects').length, 1, 'reopening must not duplicate or erase migrated state')
})

test('SQLite state store rejects a symlinked user-data boundary', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easyfield-state-symlink-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  const linked = path.join(root, 'linked')
  await chmod(root, 0o700)
  await mkdir(target, { mode: 0o700 })
  await symlink(target, linked)
  assert.equal((await lstat(linked)).isSymbolicLink(), true)
  assert.throws(() => createStateStore(linked), /state directory must be a local directory/)
})

test('large document state is private, checksum-backed, and atomically replaceable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easyfield-document-state-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const documents = createStateDocumentStore(directory)
  const value = {
    id: 'legal-storyboard',
    promptSnapshot: 'x'.repeat(7_600_000),
    approvals: ['scene-1', 'scene-2'],
  }
  const json = JSON.stringify(value)
  const reference = documents.write(json)

  assert.equal(isDocumentReference(reference), true)
  assert.deepEqual(documents.read(reference), value)
  assert.equal((await stat(documents.rootPath)).mode & 0o777, 0o700)
  const files = await readdir(documents.rootPath)
  assert.deepEqual(files, [`${reference.id}.json`])
  const filePath = path.join(documents.rootPath, files[0])
  const handle = await open(filePath, 'r+')
  try {
    assert.equal((await handle.stat()).mode & 0o777, 0o600)
    assert.equal((await handle.readFile('utf8')).length, json.length)
    const corrupted = Buffer.from(json)
    corrupted[corrupted.length - 20] = corrupted[corrupted.length - 20] === 0x78 ? 0x79 : 0x78
    await handle.write(corrupted, 0, corrupted.length, 0)
  } finally {
    await handle.close()
  }
  assert.throws(() => documents.read(reference), /corrupt/)
  assert.equal(documents.deleteReference(reference), true)
  assert.deepEqual(await readdir(documents.rootPath), [])
})

test('large document state rejects a symlinked user-data boundary', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easyfield-document-state-symlink-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = path.join(root, 'target')
  const linked = path.join(root, 'linked')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, linked)
  assert.throws(() => createStateDocumentStore(linked), /boundary must be a local directory/)
})
