import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}
const outputDirectory = path.resolve(projectRoot, option('--out-dir', 'release/keys'))
const force = args.includes('--force')
const privatePath = path.join(outputDirectory, 'easyfield-update-private.pem')
const publicPath = path.join(outputDirectory, 'easyfield-update-public.pem')
const publicBase64Path = path.join(outputDirectory, 'easyfield-update-public.spki.b64')

fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
for (const filePath of [privatePath, publicPath, publicBase64Path]) {
  if (!force && fs.existsSync(filePath)) throw new Error(`Refusing to overwrite ${filePath}; pass --force only for an intentional key rotation`)
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' })
const publicPem = publicKey.export({ format: 'pem', type: 'spki' })
const publicDer = publicKey.export({ format: 'der', type: 'spki' })
const fingerprint = crypto.createHash('sha256').update(publicDer).digest('hex')

function write(filePath, contents, mode) {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, contents, { mode })
  fs.chmodSync(temporary, mode)
  fs.renameSync(temporary, filePath)
}

write(privatePath, privatePem, 0o600)
write(publicPath, publicPem, 0o644)
write(publicBase64Path, `${publicDer.toString('base64')}\n`, 0o644)

console.log(`Generated Ed25519 update publisher key in ${outputDirectory}`)
console.log(`Public-key SHA-256 fingerprint: ${fingerprint}`)
console.log('Keep the private PEM offline or in GitHub Actions secrets; never commit it.')
