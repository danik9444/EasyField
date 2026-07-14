import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  ANIMATION_DOCUMENT_ACCEPT,
  ANIMATION_DOCUMENT_EXTENSIONS,
  ANIMATION_DOCUMENT_MAX_FILE_BYTES,
  extractAnimationDocument,
  extractAnimationDocumentText,
  isAnimationDocumentFile,
} from '../src/services/animationDocuments.ts'

interface ZipFixtureEntry {
  name: string
  text: string
  deflate?: boolean
}

function uint16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

function uint32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function storedZip(entries: ZipFixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const plain = encoder.encode(entry.text)
    const compressed = entry.deflate ? new Uint8Array(deflateRawSync(plain)) : plain
    const method = entry.deflate ? 8 : 0
    const local = concat([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(method), uint16(0), uint16(0),
      uint32(0), uint32(compressed.byteLength), uint32(plain.byteLength), uint16(name.byteLength), uint16(0),
      name, compressed,
    ])
    localParts.push(local)
    centralParts.push(concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(method), uint16(0), uint16(0),
      uint32(0), uint32(compressed.byteLength), uint32(plain.byteLength), uint16(name.byteLength), uint16(0),
      uint16(0), uint16(0), uint16(0), uint32(0), uint32(localOffset), name,
    ]))
    localOffset += local.byteLength
  }
  const local = concat(localParts)
  const central = concat(centralParts)
  return concat([
    local,
    central,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(central.byteLength), uint32(local.byteLength), uint16(0),
  ])
}

function officeFile(name: string, entries: ZipFixtureEntry[], type = ''): File {
  return new File([storedZip(entries)], name, { type })
}

test('publishes the safe Animation document picker contract', () => {
  assert.deepEqual(ANIMATION_DOCUMENT_EXTENSIONS, ['.txt', '.md', '.csv', '.json', '.docx', '.xlsx'])
  assert.match(ANIMATION_DOCUMENT_ACCEPT, /\.docx/)
  assert.match(ANIMATION_DOCUMENT_ACCEPT, /spreadsheetml/)
  assert.equal(ANIMATION_DOCUMENT_MAX_FILE_BYTES, 16 * 1024 * 1024)
  assert.equal(isAnimationDocumentFile(new File(['ok'], 'brief.MD')), true)
  assert.equal(isAnimationDocumentFile(new File(['no'], 'legacy.doc')), false)
  assert.equal(isAnimationDocumentFile(new File(['no'], 'clip.mov')), false)
})

test('extracts and bounds inert text documents', async () => {
  const result = await extractAnimationDocumentText(
    new File(['First\r\nSecond\u0000\nThird'], 'notes.txt', { type: 'text/plain' }),
    { maxOutputCharacters: 12 },
  )
  assert.equal(result.text, 'First\nSecond')
  assert.equal(result.metadata.kind, 'text')
  assert.equal(result.metadata.truncated, true)
  assert.equal(result.metadata.extractedCharacters, 12)

  const compact = await extractAnimationDocument(new File(['{"safe":true}'], 'data.json'))
  assert.equal(compact.kind, 'text')
  assert.equal(compact.text, '{"safe":true}')
  assert.equal(compact.meta, 'data.json · JSON · 13 characters')
})

test('extracts Word text from a bounded deflated DOCX without interpreting fields', async () => {
  const docx = officeFile('script.docx', [{
    name: 'word/document.xml',
    deflate: true,
    text: `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>
      <w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t><w:tab/><w:t>column</w:t></w:r></w:p>
      <w:fldSimple w:instr="DDEAUTO cmd"><w:r><w:t>Visible result only</w:t></w:r></w:fldSimple>
    </w:body></w:document>`,
  }], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  const result = await extractAnimationDocumentText(docx)
  assert.equal(result.text, 'Hello & welcome\nSecond\tcolumn\nVisible result only')
  assert.equal(result.metadata.kind, 'word')
  assert.equal(result.metadata.archiveEntries, 1)
})

test('extracts Excel values and shared strings but never returns formulas or DDE instructions', async () => {
  const xlsx = officeFile('shots.xlsx', [
    {
      name: 'xl/sharedStrings.xml',
      text: '<sst><si><t>Shot name</t></si><si><r><t>Wide</t></r><r><t> shot</t></r></si></sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      deflate: true,
      text: `<worksheet><sheetData>
        <row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>Duration</t></is></c></row>
        <row><c t="s"><v>1</v></c><c><v>4.5</v></c><c><f>DDE("cmd","/c calc")</f><v>999</v></c></row>
      </sheetData></worksheet>`,
    },
  ], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const result = await extractAnimationDocumentText(xlsx)
  assert.equal(result.text, 'Sheet 1\nShot name\tDuration\nWide shot\t4.5')
  assert.doesNotMatch(result.text, /DDE|999|cmd/i)
  assert.equal(result.metadata.kind, 'spreadsheet')
  assert.equal(result.metadata.sheetCount, 1)
})

test('rejects legacy Office formats, oversized inputs and empty documents clearly', async () => {
  await assert.rejects(extractAnimationDocumentText(new File(['legacy'], 'brief.doc')), /Save the file as \.docx/i)
  await assert.rejects(extractAnimationDocumentText(new File(['legacy'], 'budget.xls')), /Save the file as \.xlsx/i)
  await assert.rejects(extractAnimationDocumentText(new File([''], 'empty.md')), /empty/i)
  await assert.rejects(
    extractAnimationDocumentText(new File(['12345'], 'large.txt'), { maxFileBytes: 4 }),
    /too large/i,
  )
})

test('enforces archive entry and decompressed-size caps before extracting Office text', async () => {
  const docx = officeFile('bounded.docx', [
    { name: 'word/document.xml', text: '<w:document><w:p><w:t>Safe</w:t></w:p></w:document>' },
    { name: 'docProps/core.xml', text: '<metadata />' },
  ])
  await assert.rejects(extractAnimationDocumentText(docx, { maxArchiveEntries: 1 }), /too many archive entries/i)
  await assert.rejects(extractAnimationDocumentText(docx, { maxDecompressedBytes: 20 }), /expanded Office document is too large/i)
})

test('rejects macro, external-link and embedded payload entries even when renamed as modern Office', async () => {
  for (const suspiciousName of [
    'word/vbaProject.bin',
    'xl/externalLinks/externalLink1.xml',
    'word/embeddings/oleObject1.bin',
  ]) {
    const file = officeFile('unsafe.docx', [
      { name: 'word/document.xml', text: '<w:document><w:p><w:t>Text</w:t></w:p></w:document>' },
      { name: suspiciousName, text: 'not executed' },
    ])
    await assert.rejects(extractAnimationDocumentText(file), /Macro-enabled, externally linked or embedded/i)
  }
})

test('rejects malformed and unsupported archives without falling back to binary text', async () => {
  await assert.rejects(
    extractAnimationDocumentText(new File(['not a zip'], 'fake.docx')),
    /not a valid DOCX\/XLSX archive/i,
  )
  await assert.rejects(
    extractAnimationDocumentText(new File(['video'], 'clip.mp4')),
    /Unsupported document type/i,
  )
})
