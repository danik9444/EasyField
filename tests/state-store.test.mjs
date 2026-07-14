import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStateStore } = require('../plugin/state-store.cjs')

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
  assert.equal((await stat(store.databasePath)).mode & 0o777, 0o600)

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
