#!/usr/bin/env node

// Paid, resumable cloud-provider smoke test for the production request builders.
// Nothing runs unless --execute is supplied. The credential is read directly
// from macOS Keychain into this process and is never printed or persisted.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildImageRequest,
  buildMusicRequest,
  buildTtsRequest,
  buildVideoRequest,
} from '../src/data/providerModels.ts'
import {
  fetchCredits,
  fetchModelPrices,
  resumeProviderModel,
  runProviderModel,
} from '../src/services/providerGateway.ts'
import { DEFAULT_VOICE } from '../src/data/elevenLabsConfig.ts'

const args = new Set(process.argv.slice(2))
if (!args.has('--execute')) {
  console.error('Refusing to create paid tasks without --execute.')
  process.exit(2)
}

const includeMusic = args.has('--include-music')
const fresh = args.has('--fresh')
const root = fileURLToPath(new URL('..', import.meta.url))
const outputRoot = join(root, 'output', 'e2e')
const manifestPath = join(outputRoot, 'provider-live-manifest.json')
const cloudApiHost = (process.env.EF_CLOUD_API_HOST || Buffer.from('YXBpLmtpZS5haQ==', 'base64').toString('utf8')).trim()
const cloudUploadHost = (process.env.EF_CLOUD_UPLOAD_HOST || Buffer.from('a2llYWkucmVkcGFuZGFhaS5jbw==', 'base64').toString('utf8')).trim()
const cloudKeychainService = String.fromCharCode(107, 105, 101, 46, 97, 105)
mkdirSync(outputRoot, { recursive: true })

const nativeFetch = globalThis.fetch
globalThis.fetch = ((input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const mapped = raw.startsWith('/provider-upload')
    ? `https://${cloudUploadHost}${raw.slice('/provider-upload'.length)}`
    : raw.startsWith('/provider')
      ? `https://${cloudApiHost}${raw.slice('/provider'.length)}`
      : raw
  return nativeFetch(mapped, init)
})

const nowId = () => new Date().toISOString().replace(/[:.]/g, '-')

function loadKey() {
  const key = execFileSync('/usr/bin/security', ['find-generic-password', '-s', cloudKeychainService, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!key) throw new Error('The EasyField Cloud Keychain entry is empty.')
  return key
}

function atomicWriteJson(path, value) {
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

function newManifest() {
  const runId = nowId()
  return {
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    outputDirectory: relative(root, join(outputRoot, runId)),
    pricing: {},
    balanceBefore: null,
    balanceAfter: null,
    jobs: {},
  }
}

let manifest
if (!fresh && existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} else {
  manifest = newManifest()
  atomicWriteJson(manifestPath, manifest)
}
const runDir = join(root, manifest.outputDirectory)
mkdirSync(runDir, { recursive: true })

function saveManifest() {
  atomicWriteJson(manifestPath, manifest)
}

async function currentBalance(key) {
  const response = await fetchCredits(key)
  if (!response.ok || typeof response.credits !== 'number') {
    throw new Error(`EasyField Cloud authentication failed: ${response.error || 'credit balance unavailable'}`)
  }
  return response.credits
}

const normal = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim()
function exactPrice(rows, description) {
  const row = rows.find((candidate) => normal(candidate.modelDescription) === normal(description))
  if (!row) throw new Error(`Live price missing for ${description}; no paid task was submitted.`)
  return { credits: row.credits, unit: row.unit, usd: row.usd }
}

function extensionFor(contentType, fallback) {
  const type = contentType.toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  if (type.includes('webp')) return 'webp'
  if (type.includes('quicktime')) return 'mov'
  if (type.includes('webm')) return 'webm'
  if (type.includes('mp4')) return 'mp4'
  if (type.includes('wav')) return 'wav'
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  return fallback
}

function inspectWithFfprobe(path) {
  try {
    const stdout = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration,size:stream=codec_type,codec_name,width,height,sample_rate,channels',
      '-of', 'json',
      path,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(stdout)
  } catch (error) {
    return { error: error instanceof Error ? error.message.split('\n')[0] : 'ffprobe failed' }
  }
}

async function downloadAndInspect(url, baseName, fallbackExtension) {
  const response = await nativeFetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Result download failed (${response.status})`)
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 512) throw new Error(`Result download was unexpectedly small (${bytes.length} bytes)`)
  const extension = extensionFor(contentType, fallbackExtension)
  const path = join(runDir, `${baseName}.${extension}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  const fileType = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' }).trim()
  return {
    path: relative(root, path),
    name: basename(path),
    contentType,
    contentLengthHeader: response.headers.get('content-length'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fileType,
    ffprobe: inspectWithFfprobe(path),
  }
}

const imageRequest = buildImageRequest('Nano Banana 2 Lite', {
  prompt: 'A single matte blue paper cube centered on a clean white studio background, soft shadow, no text',
  aspect: '1:1',
  resolution: '1K',
  extras: { format: 'PNG' },
  imageUrls: [],
})

const videoRequest = buildVideoRequest('Grok Imagine Video', {
  prompt: 'Locked camera shot of a small blue paper cube rotating slowly on a plain white studio background. No text, no people.',
  negativePrompt: '',
  aspect: '16:9',
  resolution: '480p',
  duration: '6',
  extras: { mode: 'Normal' },
  imageUrls: [],
  videoUrls: [],
  audioUrls: [],
  webSearch: false,
})

const ttsText = 'EasyField test complete.'
const ttsRequest = buildTtsRequest('turbo-2-5', DEFAULT_VOICE, ttsText, {
  stability: 0.5,
  similarity: 0.75,
  style: 0,
  speed: 1,
  timestamps: false,
  previousText: '',
  nextText: '',
  languageCode: '',
})

const musicRequest = buildMusicRequest({
  version: 'V5',
  mode: 'Simple',
  instrumental: true,
  prompt: 'Minimal instrumental ambient interface cue with a soft synth pulse and no vocals',
  style: '',
  title: '',
  negativeTags: '',
  vocalGender: 'Any',
  sliders: { styleWeight: 0.65, weirdness: 0.5, audioWeight: 0.65 },
})

const definitions = [
  {
    id: 'image',
    label: 'Nano Banana 2 Lite · 1K image',
    request: imageRequest,
    priceDescription: 'nano-banana-2-lite, 1k',
    priceMultiplier: 1,
    extension: 'png',
  },
  {
    id: 'video',
    label: 'Grok Imagine · 6s 480p text-to-video',
    request: videoRequest,
    priceDescription: 'grok-imagine, text-to-video, 480p',
    priceMultiplier: 6,
    extension: 'mp4',
  },
  {
    id: 'tts',
    label: 'ElevenLabs Turbo 2.5 · short TTS',
    request: ttsRequest,
    priceDescription: 'Elevenlabs Text to Speech, turbo 2.5',
    priceMultiplier: ttsText.length / 1000,
    extension: 'mp3',
  },
  ...(includeMusic ? [{
    id: 'music',
    label: 'Suno V5 · simple instrumental',
    request: musicRequest,
    priceDescription: 'Suno, Generate Music',
    priceMultiplier: 1,
    extension: 'mp3',
  }] : []),
]

async function runDefinition(key, definition) {
  const existing = manifest.jobs[definition.id]
  if (existing?.status === 'succeeded') {
    console.log(`${definition.label}: already succeeded; skipping paid creation.`)
    return
  }
  if (existing?.status === 'submitting' && !existing.taskId) {
    throw new Error(`${definition.label} stopped during an ambiguous submission; refusing to submit again automatically.`)
  }
  if (existing?.status === 'failed' && !args.has('--retry-failed')) {
    throw new Error(`${definition.label} previously failed; pass --retry-failed only after reviewing the manifest.`)
  }

  const balanceBefore = existing?.balanceBefore ?? await currentBalance(key)
  let result
  try {
    if (existing?.taskId && existing?.family) {
      console.log(`${definition.label}: resuming accepted task.`)
      result = await resumeProviderModel(key, existing.family, existing.taskId, {
        onState: (state) => console.log(`${definition.id}: ${state}`),
      })
    } else {
      manifest.jobs[definition.id] = {
        label: definition.label,
        status: 'submitting',
        balanceBefore,
        estimatedCredits: manifest.pricing[definition.id].estimatedCredits,
        startedAt: new Date().toISOString(),
      }
      saveManifest()
      console.log(`${definition.label}: submitting one paid task.`)
      result = await runProviderModel(key, definition.request, {
        onTaskId: (taskId, family) => {
          manifest.jobs[definition.id] = {
            ...manifest.jobs[definition.id],
            status: 'accepted',
            taskId,
            family,
            acceptedAt: new Date().toISOString(),
          }
          saveManifest()
        },
        onState: (state) => console.log(`${definition.id}: ${state}`),
        onRetry: (attempt) => console.log(`${definition.id}: transient retry ${attempt}`),
      })
    }

    if (!result.urls.length) throw new Error('Provider reported success without a media URL.')
    const artifacts = []
    for (let index = 0; index < result.urls.length; index += 1) {
      artifacts.push(await downloadAndInspect(
        result.urls[index],
        `${definition.id}-${index + 1}`,
        definition.extension,
      ))
    }
    const balanceAfter = await currentBalance(key)
    manifest.jobs[definition.id] = {
      ...manifest.jobs[definition.id],
      status: 'succeeded',
      completedAt: new Date().toISOString(),
      creditsConsumedReported: result.creditsConsumed,
      balanceAfter,
      balanceDelta: Math.max(0, balanceBefore - balanceAfter),
      artifacts,
    }
    saveManifest()
    console.log(`${definition.label}: succeeded; ${artifacts.length} artifact(s) verified.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const accepted = manifest.jobs[definition.id]?.taskId
    const recoverable = accepted && /network|connection|timed out|download/i.test(message)
    manifest.jobs[definition.id] = {
      ...manifest.jobs[definition.id],
      status: recoverable ? 'accepted' : 'failed',
      lastError: message,
      failedAt: new Date().toISOString(),
    }
    saveManifest()
    throw error
  }
}

let key = ''
try {
  key = loadKey()
  const rows = await fetchModelPrices()
  for (const definition of definitions) {
    const price = exactPrice(rows, definition.priceDescription)
    manifest.pricing[definition.id] = {
      description: definition.priceDescription,
      unit: price.unit,
      unitCredits: price.credits,
      unitUsd: price.usd,
      multiplier: definition.priceMultiplier,
      estimatedCredits: price.credits * definition.priceMultiplier,
      estimatedUsd: price.usd == null ? null : price.usd * definition.priceMultiplier,
      fetchedAt: new Date().toISOString(),
    }
  }
  saveManifest()

  const estimatedCredits = definitions.reduce((sum, definition) => sum + manifest.pricing[definition.id].estimatedCredits, 0)
  const balance = await currentBalance(key)
  manifest.balanceBefore ??= balance
  saveManifest()
  console.log(`Authenticated. Planned maximum: ${estimatedCredits.toFixed(3)} credits across ${definitions.length} jobs.`)
  for (const definition of definitions) await runDefinition(key, definition)
  manifest.balanceAfter = await currentBalance(key)
  manifest.status = 'succeeded'
  manifest.completedAt = new Date().toISOString()
  manifest.totalBalanceDelta = Math.max(0, manifest.balanceBefore - manifest.balanceAfter)
  saveManifest()
  console.log(`Live E2E complete. Manifest: ${relative(root, manifestPath)}`)
} catch (error) {
  manifest.status = 'blocked'
  manifest.lastError = error instanceof Error ? error.message : String(error)
  saveManifest()
  console.error(manifest.lastError)
  process.exitCode = 1
} finally {
  key = ''
  globalThis.fetch = nativeFetch
}
