import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const legacyToken = Buffer.from('a2ll', 'base64').toString('utf8')
const brandedText = new RegExp(`(^|[^a-z0-9])${legacyToken}(?:[.]?ai)?(?=$|[^a-z0-9])`, 'i')
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sh', '.ts', '.tsx', '.txt', '.xml', '.yml', '.yaml',
])
const productRoots = [
  'src',
  'plugin',
  'scripts',
  'tests',
  'docs',
]
const rootFiles = [
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'vite.config.ts',
  'vite-plugin-secure-provider.ts',
]

function collectFiles(relativeRoot) {
  const absoluteRoot = path.join(projectRoot, relativeRoot)
  if (!fs.existsSync(absoluteRoot)) return []
  const stat = fs.lstatSync(absoluteRoot)
  if (stat.isSymbolicLink()) return []
  if (stat.isFile()) return [relativeRoot]
  const files = []
  for (const name of fs.readdirSync(absoluteRoot)) {
    if (name === 'node_modules' || name === '.venv' || name === '__pycache__') continue
    files.push(...collectFiles(path.join(relativeRoot, name)))
  }
  return files
}

test('source, shipped plugin UI and filenames do not expose the cloud supplier brand', () => {
  const files = [...rootFiles, ...productRoots.flatMap(collectFiles)]
  const contentLeaks = []
  const filenameLeaks = []
  for (const relativePath of files) {
    const base = path.basename(relativePath).toLowerCase()
    if (base.startsWith(legacyToken) || base.includes(`-${legacyToken}`) || base.includes(`_${legacyToken}`)) {
      filenameLeaks.push(relativePath)
    }
    if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue
    const content = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
    if (brandedText.test(content)) contentLeaks.push(relativePath)
  }
  assert.deepEqual(filenameLeaks, [])
  assert.deepEqual(contentLeaks, [])
})
