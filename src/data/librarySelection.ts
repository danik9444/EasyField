import type { Creation, CreationKind } from './creations.ts'

const LIBRARY_KINDS: readonly CreationKind[] = ['image', 'video', 'audio']

const EXTENSION_MEDIA: Record<string, { kind: CreationKind; mime: string; extension: string }> = {
  png: { kind: 'image', mime: 'image/png', extension: 'png' },
  jpg: { kind: 'image', mime: 'image/jpeg', extension: 'jpg' },
  jpeg: { kind: 'image', mime: 'image/jpeg', extension: 'jpg' },
  webp: { kind: 'image', mime: 'image/webp', extension: 'webp' },
  gif: { kind: 'image', mime: 'image/gif', extension: 'gif' },
  avif: { kind: 'image', mime: 'image/avif', extension: 'avif' },
  heic: { kind: 'image', mime: 'image/heic', extension: 'heic' },
  heif: { kind: 'image', mime: 'image/heif', extension: 'heif' },
  bmp: { kind: 'image', mime: 'image/bmp', extension: 'bmp' },
  tif: { kind: 'image', mime: 'image/tiff', extension: 'tif' },
  tiff: { kind: 'image', mime: 'image/tiff', extension: 'tif' },
  svg: { kind: 'image', mime: 'image/svg+xml', extension: 'svg' },
  mp4: { kind: 'video', mime: 'video/mp4', extension: 'mp4' },
  m4v: { kind: 'video', mime: 'video/x-m4v', extension: 'm4v' },
  mov: { kind: 'video', mime: 'video/quicktime', extension: 'mov' },
  webm: { kind: 'video', mime: 'video/webm', extension: 'webm' },
  mkv: { kind: 'video', mime: 'video/x-matroska', extension: 'mkv' },
  avi: { kind: 'video', mime: 'video/x-msvideo', extension: 'avi' },
  wav: { kind: 'audio', mime: 'audio/wav', extension: 'wav' },
  mp3: { kind: 'audio', mime: 'audio/mpeg', extension: 'mp3' },
  m4a: { kind: 'audio', mime: 'audio/mp4', extension: 'm4a' },
  aac: { kind: 'audio', mime: 'audio/aac', extension: 'aac' },
  ogg: { kind: 'audio', mime: 'audio/ogg', extension: 'ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg', extension: 'ogg' },
  opus: { kind: 'audio', mime: 'audio/opus', extension: 'opus' },
  flac: { kind: 'audio', mime: 'audio/flac', extension: 'flac' },
}

const MIME_MEDIA: Record<string, { kind: CreationKind; mime: string; extension: string }> = {
  'image/png': EXTENSION_MEDIA.png,
  'image/jpeg': EXTENSION_MEDIA.jpg,
  'image/jpg': EXTENSION_MEDIA.jpg,
  'image/webp': EXTENSION_MEDIA.webp,
  'image/gif': EXTENSION_MEDIA.gif,
  'image/avif': EXTENSION_MEDIA.avif,
  'image/heic': EXTENSION_MEDIA.heic,
  'image/heif': EXTENSION_MEDIA.heif,
  'image/bmp': EXTENSION_MEDIA.bmp,
  'image/x-ms-bmp': EXTENSION_MEDIA.bmp,
  'image/tiff': EXTENSION_MEDIA.tif,
  'image/svg+xml': EXTENSION_MEDIA.svg,
  'video/mp4': EXTENSION_MEDIA.mp4,
  'video/x-m4v': EXTENSION_MEDIA.m4v,
  'video/quicktime': EXTENSION_MEDIA.mov,
  'video/webm': EXTENSION_MEDIA.webm,
  'video/x-matroska': EXTENSION_MEDIA.mkv,
  'application/x-matroska': EXTENSION_MEDIA.mkv,
  'video/x-msvideo': EXTENSION_MEDIA.avi,
  'audio/wav': EXTENSION_MEDIA.wav,
  'audio/wave': EXTENSION_MEDIA.wav,
  'audio/x-wav': EXTENSION_MEDIA.wav,
  'audio/mpeg': EXTENSION_MEDIA.mp3,
  'audio/mp3': EXTENSION_MEDIA.mp3,
  'audio/mp4': EXTENSION_MEDIA.m4a,
  'audio/x-m4a': EXTENSION_MEDIA.m4a,
  'audio/aac': EXTENSION_MEDIA.aac,
  'audio/ogg': EXTENSION_MEDIA.ogg,
  'application/ogg': EXTENSION_MEDIA.ogg,
  'audio/opus': EXTENSION_MEDIA.opus,
  'audio/flac': EXTENSION_MEDIA.flac,
  'audio/x-flac': EXTENSION_MEDIA.flac,
}

const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

type MediaIdentity = { kind: CreationKind; mime: string; extension: string }

export interface LibrarySelectionAdapters {
  fetchImpl?: typeof fetch
  localizeUrl?: (url: string, creation: Creation) => Promise<string | null | undefined>
}

function normalizedMime(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase()
}

function extensionIdentity(url: string): MediaIdentity | null {
  if (/^(blob:|data:)/i.test(url)) return null
  try {
    const parsed = new URL(url, 'https://easyfield.local')
    const match = parsed.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)
    return match ? EXTENSION_MEDIA[match[1]] ?? null : null
  } catch {
    return null
  }
}

function mimeIdentity(mime: string): MediaIdentity | null {
  return MIME_MEDIA[normalizedMime(mime)] ?? null
}

function mimeKind(mime: string): CreationKind | null {
  const normalized = normalizedMime(mime)
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  if (normalized === 'application/ogg') return 'audio'
  if (normalized === 'application/x-matroska') return 'video'
  return null
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length))
}

function sniffMedia(bytes: Uint8Array): MediaIdentity | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return EXTENSION_MEDIA.png
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return EXTENSION_MEDIA.jpg
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return EXTENSION_MEDIA.gif
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return EXTENSION_MEDIA.webp
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return EXTENSION_MEDIA.wav
  if (ascii(bytes, 0, 4) === 'fLaC') return EXTENSION_MEDIA.flac
  if (ascii(bytes, 0, 4) === 'OggS') return EXTENSION_MEDIA.ogg
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return EXTENSION_MEDIA.mp3
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return EXTENSION_MEDIA.webm
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase()
    if (['avif', 'avis'].includes(brand)) return EXTENSION_MEDIA.avif
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return EXTENSION_MEDIA.heic
    if (brand === 'm4a ' || brand === 'm4b ') return EXTENSION_MEDIA.m4a
    return brand.startsWith('qt') ? EXTENSION_MEDIA.mov : EXTENSION_MEDIA.mp4
  }
  return null
}

function kindLabel(kind: CreationKind): string {
  return `${kind[0].toUpperCase()}${kind.slice(1)}`
}

export function inferLibraryKindsFromAccept(accept?: string | null): CreationKind[] {
  const value = accept?.trim().toLowerCase() ?? ''
  if (!value || value.split(',').some((token) => token.trim() === '*/*')) return [...LIBRARY_KINDS]

  const matches = new Set<CreationKind>()
  for (const rawToken of value.split(',')) {
    const token = rawToken.trim()
    if (!token) continue
    if (token === 'image/*') matches.add('image')
    else if (token === 'video/*') matches.add('video')
    else if (token === 'audio/*') matches.add('audio')
    else if (token.startsWith('.')) {
      const match = EXTENSION_MEDIA[token.slice(1)]
      if (match) matches.add(match.kind)
    } else {
      const match = mimeIdentity(token)
      const kind = match?.kind ?? mimeKind(token)
      if (kind) matches.add(kind)
    }
  }
  return LIBRARY_KINDS.filter((kind) => matches.has(kind))
}

export function libraryCreationDisplayName(creation: Creation): string {
  const prompt = creation.prompt?.replace(/\s+/g, ' ').trim()
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 79).trimEnd()}…` : prompt
  const model = creation.model?.replace(/\s+/g, ' ').trim()
  if (model) return `${model} ${kindLabel(creation.kind)}`
  return `${kindLabel(creation.kind)} result`
}

function safeFilenameBase(creation: Creation): string {
  const safe = libraryCreationDisplayName(creation)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M} ._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|[. ]+$/g, '')
    .trim()
    .slice(0, 72)
    .replace(/[. ]+$/g, '')
  return safe || `EasyField ${kindLabel(creation.kind)}`
}

async function fetchMedia(url: string, fetchImpl: typeof fetch): Promise<{ blob: Blob; responseMime: string }> {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Media request failed (${response.status || 'unknown status'}).`)
  const blob = await response.blob()
  return { blob, responseMime: normalizedMime(response.headers.get('content-type')) }
}

export async function copyLibraryCreationToFile(
  creation: Creation,
  adapters: LibrarySelectionAdapters = {},
): Promise<File> {
  if (!creation.url?.trim()) throw new Error('This Library item has no media URL.')
  const fetchImpl = adapters.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('Media loading is not available in this environment.')

  let sourceUrl = creation.url
  let loaded: { blob: Blob; responseMime: string }
  try {
    loaded = await fetchMedia(sourceUrl, fetchImpl)
  } catch (directError) {
    if (!/^https:\/\//i.test(sourceUrl) || !adapters.localizeUrl) throw directError
    const localizedUrl = await adapters.localizeUrl(sourceUrl, creation)
    if (!localizedUrl?.trim()) throw new Error('EasyField could not make this linked Library item available locally.')
    sourceUrl = localizedUrl
    loaded = await fetchMedia(sourceUrl, fetchImpl)
  }

  if (loaded.blob.size <= 0) throw new Error('This Library item contains no media bytes.')
  const bytes = new Uint8Array(await loaded.blob.slice(0, 32).arrayBuffer())
  const blobMime = normalizedMime(loaded.blob.type)
  const responseMime = loaded.responseMime
  const explicitMimes = new Set([blobMime, responseMime].filter(Boolean))
  for (const mime of explicitMimes) {
    if (GENERIC_MIMES.has(mime)) continue
    const kind = mimeKind(mime)
    if (!kind) throw new Error(`Unsupported Library media type: ${mime}.`)
    if (kind !== creation.kind) throw new Error(`This ${creation.kind} Library item contains ${kind} media.`)
  }

  const magic = sniffMedia(bytes)
  const byMime = mimeIdentity(blobMime) ?? mimeIdentity(responseMime)
  const byExtension = extensionIdentity(sourceUrl) ?? extensionIdentity(creation.url)
  for (const identity of [magic, byMime, byExtension]) {
    if (identity && identity.kind !== creation.kind) {
      throw new Error(`This ${creation.kind} Library item contains ${identity.kind} media.`)
    }
  }

  const identity = magic ?? byMime ?? byExtension
  const hasCompatibleMime = [...explicitMimes].some((mime) => mimeKind(mime) === creation.kind)
  if (!identity && !hasCompatibleMime) {
    throw new Error(`EasyField could not verify this item as ${creation.kind} media.`)
  }

  const mime = identity?.mime ?? [...explicitMimes].find((value) => mimeKind(value) === creation.kind) ?? loaded.blob.type
  const extension = identity?.extension ?? ({ image: 'png', video: 'mp4', audio: 'wav' } as const)[creation.kind]
  const filename = `${safeFilenameBase(creation)}.${extension}`
  return new File([loaded.blob], filename, { type: mime, lastModified: creation.createdAt })
}
