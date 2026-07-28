import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import htmlInline from 'html-inline'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parcelDirectory = path.join(root, '.parcel-dist')
const parcelBinary = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'parcel.cmd' : 'parcel')

rmSync(parcelDirectory, { recursive: true, force: true })
execFileSync(parcelBinary, ['build', 'index.html', '--dist-dir', '.parcel-dist', '--no-source-maps'], {
  cwd: root,
  stdio: 'inherit',
})

const transform = createReadStream(path.join(parcelDirectory, 'index.html'))
  .pipe(htmlInline({ basedir: parcelDirectory }))
const inlined = await new Promise((resolve, reject) => {
  const chunks = []
  transform.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  transform.on('end', () => resolve(Buffer.concat(chunks)))
  transform.on('error', reject)
})

let html = inlined.toString('utf8')
const fonts = [...new Set(
  [...html.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1].replace(/["']/g, '')),
)]

for (const font of fonts) {
  const data = readFileSync(path.join(parcelDirectory, font)).toString('base64')
  html = html.replaceAll(font, `data:font/woff2;base64,${data}`)
}

const rasterAssets = [...new Set(
  [...html.matchAll(/\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)/g)].map((match) => match[0]),
)]

for (const asset of rasterAssets) {
  const file = path.join(parcelDirectory, asset.replace(/^\//, ''))
  if (!existsSync(file)) continue
  const extension = path.extname(file).slice(1).replace('jpg', 'jpeg')
  const data = readFileSync(file).toString('base64')
  html = html.replaceAll(asset, `data:image/${extension};base64,${data}`)
}

const socialCard = readFileSync(path.join(root, 'brand', 'easyfield-social-card.svg')).toString('base64')
html = html.replaceAll('/brand/easyfield-social-card.svg', `data:image/svg+xml;base64,${socialCard}`)

const socialCardPng = readFileSync(path.join(root, 'brand', 'easyfield-social-card.png')).toString('base64')
html = html.replaceAll('/brand/easyfield-social-card.png', `data:image/png;base64,${socialCardPng}`)

const pageTitle = 'EasyField — AI Plugin for DaVinci Resolve 21'
if (!/<title(?:\s|>)/i.test(html)) {
  html = html.replace(`${pageTitle}</title>`, `<title>${pageTitle}</title>`)
}

const output = path.join(root, 'bundle.html')
writeFileSync(output, html)

const distDirectory = path.join(root, 'dist')
if (existsSync(distDirectory)) {
  writeFileSync(path.join(distDirectory, 'easyfield.html'), html)
}

const sizeKb = Math.round(statSync(output).size / 1024)
console.log(`Created bundle.html (${sizeKb} KB, ${fonts.length} embedded font assets) and copied it to dist/easyfield.html.`)
