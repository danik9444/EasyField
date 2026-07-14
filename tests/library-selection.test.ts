import assert from 'node:assert/strict'
import test from 'node:test'
import type { Creation } from '../src/data/creations.ts'
import {
  copyLibraryCreationToFile,
  inferLibraryKindsFromAccept,
  libraryCreationDisplayName,
} from '../src/data/librarySelection.ts'

function creation(overrides: Partial<Creation> = {}): Creation {
  return {
    id: 'cr-library-1',
    kind: 'image',
    url: 'blob:library-owned-url',
    prompt: 'City at night',
    createdAt: 1234,
    durability: 'local',
    ...overrides,
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1,
])

test('infers Library media kinds from file-input accept syntax', () => {
  assert.deepEqual(inferLibraryKindsFromAccept(undefined), ['image', 'video', 'audio'])
  assert.deepEqual(inferLibraryKindsFromAccept('*/*,.pdf'), ['image', 'video', 'audio'])
  assert.deepEqual(inferLibraryKindsFromAccept('image/*,.jpeg,.avif'), ['image'])
  assert.deepEqual(inferLibraryKindsFromAccept('audio/wav, video/quicktime, .m4a'), ['video', 'audio'])
  assert.deepEqual(inferLibraryKindsFromAccept('.pdf,text/plain'), [])
})

test('creates a concise Library display name with stable fallbacks', () => {
  assert.equal(libraryCreationDisplayName(creation({ prompt: '  Neon\n\nportrait   study  ' })), 'Neon portrait study')
  assert.equal(libraryCreationDisplayName(creation({ prompt: '', model: 'Seedream 5' })), 'Seedream 5 Image')
  assert.equal(libraryCreationDisplayName(creation({ prompt: undefined, model: undefined, kind: 'audio' })), 'Audio result')
})

test('copies bytes into a new workspace-owned File and derives a safe filename', async () => {
  const libraryItem = creation({ prompt: '../City: night? <final>' })
  const originalUrl = libraryItem.url
  let fetched = ''
  const file = await copyLibraryCreationToFile(libraryItem, {
    fetchImpl: async (input) => {
      fetched = String(input)
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
    },
  })

  assert.equal(fetched, originalUrl)
  assert.equal(libraryItem.url, originalUrl)
  assert.equal(file.name, 'City night final.png')
  assert.equal(file.type, 'image/png')
  assert.equal(file.size, PNG_BYTES.byteLength)
  assert.equal(file.lastModified, 1234)
  assert.notEqual(file, libraryItem)
})

test('rejects empty and kind-mismatched Library bytes', async () => {
  await assert.rejects(
    copyLibraryCreationToFile(creation(), {
      fetchImpl: async () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } }),
    }),
    /no media bytes/i,
  )
  await assert.rejects(
    copyLibraryCreationToFile(creation(), {
      fetchImpl: async () => new Response(WAV_BYTES, { headers: { 'content-type': 'audio/wav' } }),
    }),
    /contains audio media/i,
  )
})

test('uses a trusted extension when a server returns generic MIME', async () => {
  const file = await copyLibraryCreationToFile(creation({
    kind: 'video',
    url: 'https://media.example/final-cut.mp4?token=short-lived',
  }), {
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'application/octet-stream' },
    }),
  })
  assert.equal(file.type, 'video/mp4')
  assert.match(file.name, /\.mp4$/)
})

test('falls back to localizing an HTTPS link without mutating the Library item', async () => {
  const item = creation({ url: 'https://provider.example/temporary/image' })
  const requests: string[] = []
  const localized: Array<[string, string]> = []
  const file = await copyLibraryCreationToFile(item, {
    fetchImpl: async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.startsWith('https://')) throw new TypeError('CORS blocked')
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
    },
    localizeUrl: async (url, selected) => {
      localized.push([url, selected.id])
      return 'easyfield-artifact://library-copy/image.png'
    },
  })

  assert.deepEqual(requests, [item.url, 'easyfield-artifact://library-copy/image.png'])
  assert.deepEqual(localized, [[item.url, item.id]])
  assert.equal(item.url, 'https://provider.example/temporary/image')
  assert.equal(file.type, 'image/png')
})

test('does not invoke the remote localizer for failed local URLs', async () => {
  let localized = false
  await assert.rejects(copyLibraryCreationToFile(creation(), {
    fetchImpl: async () => { throw new Error('missing blob') },
    localizeUrl: async () => {
      localized = true
      return 'blob:replacement'
    },
  }), /missing blob/)
  assert.equal(localized, false)
})

test('rejects conflicting MIME and filename evidence', async () => {
  await assert.rejects(copyLibraryCreationToFile(creation({
    kind: 'image',
    url: 'https://media.example/not-an-image.mp4',
  }), {
    fetchImpl: async () => new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }),
  }), /contains video media/i)
})
