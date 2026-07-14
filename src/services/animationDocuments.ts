export const ANIMATION_DOCUMENT_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.docx',
  '.xlsx',
] as const

export const ANIMATION_DOCUMENT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

export const ANIMATION_DOCUMENT_ACCEPT = [
  ...ANIMATION_DOCUMENT_EXTENSIONS,
  ...ANIMATION_DOCUMENT_MIME_TYPES,
].join(',')

export const DEFAULT_ANIMATION_DOCUMENT_LIMITS = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxArchiveEntries: 512,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxOutputCharacters: 200_000,
})

export const ANIMATION_DOCUMENT_MAX_FILE_BYTES = DEFAULT_ANIMATION_DOCUMENT_LIMITS.maxFileBytes

export type AnimationDocumentExtension = typeof ANIMATION_DOCUMENT_EXTENSIONS[number]
export type AnimationDocumentKind = 'text' | 'word' | 'spreadsheet'

export interface AnimationDocumentLimits {
  maxFileBytes?: number
  maxArchiveEntries?: number
  maxDecompressedBytes?: number
  maxOutputCharacters?: number
}

export interface AnimationDocumentMetadata {
  fileName: string
  extension: AnimationDocumentExtension
  mimeType: string
  kind: AnimationDocumentKind
  sourceBytes: number
  extractedCharacters: number
  truncated: boolean
  archiveEntries?: number
  decompressedBytes?: number
  sheetCount?: number
}

export interface AnimationDocumentText {
  text: string
  metadata: AnimationDocumentMetadata
}

export interface AnimationDocumentExtraction {
  kind: AnimationDocumentKind
  text: string
  meta: string
}

type ResolvedLimits = Required<AnimationDocumentLimits>

interface ArchiveEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

interface ParsedArchive {
  bytes: Uint8Array<ArrayBuffer>
  entries: Map<string, ArchiveEntry>
  entryCount: number
  declaredDecompressedBytes: number
  centralOffset: number
}

const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls'])
const TEXT_EXTENSIONS = new Set<AnimationDocumentExtension>(['.txt', '.md', '.csv', '.json'])
const UTF8 = new TextDecoder('utf-8')
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP64_SENTINEL_16 = 0xffff
const ZIP64_SENTINEL_32 = 0xffffffff
const MAX_ZIP_COMMENT_BYTES = 65_535
const SUSPICIOUS_OFFICE_ENTRY = /(?:^|\/)(?:vbaproject\.bin|macrosheets?|externallinks?|embeddings?)(?:\/|$)/i

function resolveLimits(overrides: AnimationDocumentLimits | undefined): ResolvedLimits {
  const limits = { ...DEFAULT_ANIMATION_DOCUMENT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`)
    }
  }
  return limits
}

function extensionOf(fileName: string): string {
  const normalized = fileName.trim().toLowerCase()
  const dot = normalized.lastIndexOf('.')
  return dot >= 0 ? normalized.slice(dot) : ''
}

function supportedExtension(fileName: string): AnimationDocumentExtension {
  const extension = extensionOf(fileName)
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    const modern = extension === '.doc' ? '.docx' : '.xlsx'
    throw new Error(`Legacy ${extension} files are not supported. Save the file as ${modern} and try again.`)
  }
  if (!ANIMATION_DOCUMENT_EXTENSIONS.includes(extension as AnimationDocumentExtension)) {
    throw new Error(`Unsupported document type "${extension || 'unknown'}". Choose TXT, MD, CSV, JSON, DOCX or XLSX.`)
  }
  return extension as AnimationDocumentExtension
}

export function isAnimationDocumentFile(file: Pick<File, 'name'>): boolean {
  return ANIMATION_DOCUMENT_EXTENSIONS.includes(extensionOf(file.name) as AnimationDocumentExtension)
}

function documentKind(extension: AnimationDocumentExtension): AnimationDocumentKind {
  if (extension === '.docx') return 'word'
  if (extension === '.xlsx') return 'spreadsheet'
  return 'text'
}

function ensureSize(size: number, limits: ResolvedLimits): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('The selected document has an invalid file size.')
  if (size === 0) throw new Error('The selected document is empty.')
  if (size > limits.maxFileBytes) {
    throw new Error(`The selected document is too large. The limit is ${limits.maxFileBytes} bytes.`)
  }
}

function decodePlainText(bytes: Uint8Array<ArrayBuffer>): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2)
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]
      swapped[index - 1] = bytes[index]
    }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return UTF8.decode(bytes.subarray(start))
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function capText(value: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (value.length <= maxCharacters) return { text: value, truncated: false }
  let end = maxCharacters
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? '')) end -= 1
  return { text: value.slice(0, end).trimEnd(), truncated: true }
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error('The Office document archive is malformed.')
  return view.getUint16(offset, true)
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('The Office document archive is malformed.')
  return view.getUint32(offset, true)
}

function safeArchiveName(rawName: string): string {
  const name = rawName.replace(/\\/g, '/')
  if (!name || name.startsWith('/') || name.includes('\u0000')) {
    throw new Error('The Office document contains an unsafe archive path.')
  }
  const segments = name.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error('The Office document contains an unsafe archive path.')
  }
  return segments.filter((segment) => segment && segment !== '.').join('/')
}

function findZipEnd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - MAX_ZIP_COMMENT_BYTES - 22)
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      readUint32(view, offset) === ZIP_END_SIGNATURE
      && offset + 22 + readUint16(view, offset + 20) === view.byteLength
    ) return offset
  }
  throw new Error('The selected Office document is not a valid DOCX/XLSX archive.')
}

function parseArchive(buffer: ArrayBuffer, limits: ResolvedLimits): ParsedArchive {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const endOffset = findZipEnd(view)
  const diskNumber = readUint16(view, endOffset + 4)
  const centralDisk = readUint16(view, endOffset + 6)
  const entriesOnDisk = readUint16(view, endOffset + 8)
  const entryCount = readUint16(view, endOffset + 10)
  const centralSize = readUint32(view, endOffset + 12)
  const centralOffset = readUint32(view, endOffset + 16)

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-part Office document archives are not supported.')
  }
  if (
    entryCount === ZIP64_SENTINEL_16
    || centralSize === ZIP64_SENTINEL_32
    || centralOffset === ZIP64_SENTINEL_32
  ) {
    throw new Error('ZIP64 Office document archives are not supported.')
  }
  if (entryCount > limits.maxArchiveEntries) {
    throw new Error(`The Office document contains too many archive entries. The limit is ${limits.maxArchiveEntries}.`)
  }
  if (centralOffset + centralSize > endOffset || centralOffset < 0) {
    throw new Error('The Office document archive directory is malformed.')
  }

  const entries = new Map<string, ArchiveEntry>()
  let cursor = centralOffset
  let declaredDecompressedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, cursor) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new Error('The Office document archive directory is malformed.')
    }
    const flags = readUint16(view, cursor + 8)
    const method = readUint16(view, cursor + 10)
    const compressedSize = readUint32(view, cursor + 20)
    const uncompressedSize = readUint32(view, cursor + 24)
    const fileNameLength = readUint16(view, cursor + 28)
    const extraLength = readUint16(view, cursor + 30)
    const commentLength = readUint16(view, cursor + 32)
    const localOffset = readUint32(view, cursor + 42)
    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength
    if (entryEnd > centralOffset + centralSize) throw new Error('The Office document archive directory is malformed.')

    const name = safeArchiveName(UTF8.decode(bytes.subarray(cursor + 46, cursor + 46 + fileNameLength)))
    if (entries.has(name)) throw new Error(`The Office document contains a duplicate archive entry: ${name}.`)
    if ((flags & 0x0001) !== 0) throw new Error('Password-protected Office documents are not supported.')
    if (SUSPICIOUS_OFFICE_ENTRY.test(name)) {
      throw new Error('Macro-enabled, externally linked or embedded Office content is not supported.')
    }

    declaredDecompressedBytes += uncompressedSize
    if (!Number.isSafeInteger(declaredDecompressedBytes) || declaredDecompressedBytes > limits.maxDecompressedBytes) {
      throw new Error(`The expanded Office document is too large. The limit is ${limits.maxDecompressedBytes} bytes.`)
    }
    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset })
    cursor = entryEnd
  }
  if (cursor !== centralOffset + centralSize) throw new Error('The Office document archive directory is malformed.')
  return { bytes, entries, entryCount, declaredDecompressedBytes, centralOffset }
}

async function inflateRawBounded(compressed: Uint8Array<ArrayBuffer>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This system cannot safely open compressed Office documents.')
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`The expanded Office document is too large. The limit is ${maxBytes} bytes.`)
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function readArchiveEntry(
  archive: ParsedArchive,
  entry: ArchiveEntry,
  limits: ResolvedLimits,
): Promise<Uint8Array<ArrayBuffer>> {
  const view = new DataView(archive.bytes.buffer)
  if (readUint32(view, entry.localOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error(`The Office document entry "${entry.name}" is malformed.`)
  }
  const localFlags = readUint16(view, entry.localOffset + 6)
  const localMethod = readUint16(view, entry.localOffset + 8)
  const fileNameLength = readUint16(view, entry.localOffset + 26)
  const extraLength = readUint16(view, entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + fileNameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (entry.localOffset >= archive.centralOffset || dataStart < 0 || dataEnd > archive.centralOffset) {
    throw new Error(`The Office document entry "${entry.name}" is malformed.`)
  }
  const localName = safeArchiveName(UTF8.decode(archive.bytes.subarray(
    entry.localOffset + 30,
    entry.localOffset + 30 + fileNameLength,
  )))
  if (localName !== entry.name || localMethod !== entry.method || (localFlags & 0x0001) !== 0) {
    throw new Error(`The Office document entry "${entry.name}" has conflicting archive metadata.`)
  }
  const compressed = archive.bytes.slice(dataStart, dataEnd)
  let result: Uint8Array<ArrayBuffer>
  if (entry.method === 0) result = compressed
  else if (entry.method === 8) result = await inflateRawBounded(compressed, limits.maxDecompressedBytes)
  else throw new Error(`The Office document uses an unsupported compression method (${entry.method}).`)

  if (result.byteLength !== entry.uncompressedSize) {
    throw new Error(`The Office document entry "${entry.name}" has an invalid expanded size.`)
  }
  return result
}

async function readArchiveText(
  archive: ParsedArchive,
  name: string,
  limits: ResolvedLimits,
): Promise<string | null> {
  const entry = archive.entries.get(name)
  if (!entry) return null
  return UTF8.decode(await readArchiveEntry(archive, entry, limits))
}

function decodeXml(value: string): string {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (entity, numeric: string | undefined) => {
    if (numeric) {
      const codePoint = numeric[0]?.toLowerCase() === 'x'
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10)
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return String.fromCodePoint(codePoint)
      }
      return ''
    }
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    return named[entity.toLowerCase()] ?? ''
  })
}

function xmlTagText(xml: string, localName: string): string[] {
  const matcher = new RegExp(`<(?:(?:[\\w.-]+):)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${localName}>`, 'gi')
  return Array.from(xml.matchAll(matcher), (match) => decodeXml((match[1] ?? '').replace(/<[^>]*>/g, '')))
}

function extractWordText(xml: string): string {
  const tokens = /<(?:(?:[\w.-]+):)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:[\w.-]+):)?t>|<(?:(?:[\w.-]+):)?(?:tab)\b[^>]*\/?\s*>|<(?:(?:[\w.-]+):)?(?:br|cr)\b[^>]*\/?\s*>|<\/(?:(?:[\w.-]+):)?(?:p|tr|tc)>/gi
  const output: string[] = []
  for (const match of xml.matchAll(tokens)) {
    const token = match[0]
    if (match[1] !== undefined) output.push(decodeXml(match[1].replace(/<[^>]*>/g, '')))
    else if (/<\/(?:(?:[\w.-]+):)?tc>/i.test(token)) output.push('\t')
    else if (/<(?:(?:[\w.-]+):)?tab\b/i.test(token)) output.push('\t')
    else output.push('\n')
  }
  return output.join('')
}

function extractSharedStrings(xml: string): string[] {
  return Array.from(xml.matchAll(/<(?:(?:[\w.-]+):)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:[\w.-]+):)?si>/gi), (match) => (
    xmlTagText(match[1] ?? '', 't').join('')
  ))
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  return match ? decodeXml(match[1] ?? match[2] ?? '') : undefined
}

function extractWorksheetRows(xml: string, sharedStrings: string[]): string[] {
  const rows: string[] = []
  const rowMatcher = /<(?:(?:[\w.-]+):)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:[\w.-]+):)?row>/gi
  for (const rowMatch of xml.matchAll(rowMatcher)) {
    const values: string[] = []
    const rowXml = rowMatch[1] ?? ''
    const cellMatcher = /<(?:(?:[\w.-]+):)?c(\s[^>]*)?>([\s\S]*?)<\/(?:(?:[\w.-]+):)?c>/gi
    for (const cellMatch of rowXml.matchAll(cellMatcher)) {
      const attributes = cellMatch[1] ?? ''
      const cellXml = cellMatch[2] ?? ''
      if (/<(?:(?:[\w.-]+):)?f(?:\s[^>]*)?>/i.test(cellXml)) continue
      const type = attributeValue(attributes, 't') ?? ''
      let value = ''
      if (type === 'inlineStr') value = xmlTagText(cellXml, 't').join('')
      else {
        const raw = xmlTagText(cellXml, 'v')[0] ?? ''
        if (type === 's') {
          const index = Number.parseInt(raw, 10)
          value = Number.isSafeInteger(index) && index >= 0 ? (sharedStrings[index] ?? '') : ''
        } else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : ''
        else value = raw
      }
      if (value) values.push(value)
    }
    if (values.length) rows.push(values.join('\t'))
  }
  return rows
}

async function extractDocx(
  archive: ParsedArchive,
  limits: ResolvedLimits,
): Promise<string> {
  const documentXml = await readArchiveText(archive, 'word/document.xml', limits)
  if (!documentXml) throw new Error('The DOCX file does not contain a readable Word document.')
  return extractWordText(documentXml)
}

function worksheetSort(left: string, right: string): number {
  const leftNumber = Number.parseInt(/sheet(\d+)\.xml$/i.exec(left)?.[1] ?? '', 10)
  const rightNumber = Number.parseInt(/sheet(\d+)\.xml$/i.exec(right)?.[1] ?? '', 10)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left.localeCompare(right)
}

async function extractXlsx(
  archive: ParsedArchive,
  limits: ResolvedLimits,
): Promise<{ text: string; sheetCount: number }> {
  const sharedXml = await readArchiveText(archive, 'xl/sharedStrings.xml', limits)
  const sharedStrings = sharedXml ? extractSharedStrings(sharedXml) : []
  const sheets = Array.from(archive.entries.keys())
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(worksheetSort)
  if (!sheets.length) throw new Error('The XLSX file does not contain a readable worksheet.')

  const output: string[] = []
  for (let index = 0; index < sheets.length; index += 1) {
    const sheetXml = await readArchiveText(archive, sheets[index]!, limits)
    if (!sheetXml) continue
    const rows = extractWorksheetRows(sheetXml, sharedStrings)
    if (!rows.length) continue
    output.push(`Sheet ${index + 1}\n${rows.join('\n')}`)
  }
  return { text: output.join('\n\n'), sheetCount: sheets.length }
}

export async function extractAnimationDocumentText(
  file: File,
  limitOverrides?: AnimationDocumentLimits,
): Promise<AnimationDocumentText> {
  const limits = resolveLimits(limitOverrides)
  const extension = supportedExtension(file.name)
  ensureSize(file.size, limits)
  const buffer = await file.arrayBuffer()
  ensureSize(buffer.byteLength, limits)

  const kind = documentKind(extension)
  let extracted = ''
  let archive: ParsedArchive | undefined
  let sheetCount: number | undefined
  if (TEXT_EXTENSIONS.has(extension)) extracted = decodePlainText(new Uint8Array(buffer))
  else {
    archive = parseArchive(buffer, limits)
    if (extension === '.docx') extracted = await extractDocx(archive, limits)
    else {
      const workbook = await extractXlsx(archive, limits)
      extracted = workbook.text
      sheetCount = workbook.sheetCount
    }
  }

  const normalized = normalizeExtractedText(extracted)
  if (!normalized) throw new Error('No readable text was found in the selected document.')
  const capped = capText(normalized, limits.maxOutputCharacters)
  return {
    text: capped.text,
    metadata: {
      fileName: file.name,
      extension,
      mimeType: file.type || 'application/octet-stream',
      kind,
      sourceBytes: file.size,
      extractedCharacters: capped.text.length,
      truncated: capped.truncated,
      ...(archive ? {
        archiveEntries: archive.entryCount,
        decompressedBytes: archive.declaredDecompressedBytes,
      } : {}),
      ...(sheetCount === undefined ? {} : { sheetCount }),
    },
  }
}

export async function extractAnimationDocument(
  file: File,
  limitOverrides?: AnimationDocumentLimits,
): Promise<AnimationDocumentExtraction> {
  const result = await extractAnimationDocumentText(file, limitOverrides)
  const format = result.metadata.extension.slice(1).toUpperCase()
  const truncation = result.metadata.truncated ? ' · truncated safely' : ''
  return {
    kind: result.metadata.kind,
    text: result.text,
    meta: `${result.metadata.fileName} · ${format} · ${result.metadata.extractedCharacters} characters${truncation}`,
  }
}
