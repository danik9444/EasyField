import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  MODELS,
  WHISPER_LANGUAGES,
  WHISPER_LANGUAGE_CODES,
  createTranscriptionService,
  normalizeTranscription,
  parseOptions,
  runProcess,
} = require('../plugin/whisper-transcription.cjs')

async function startService(service) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (!service.handleRequest(request, response, pathname)) {
      response.writeHead(404)
      response.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function markModelReady(modelRoot, model = 'tiny') {
  const definition = MODELS[model]
  fs.mkdirSync(modelRoot, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(modelRoot, definition.file), '')
  fs.truncateSync(path.join(modelRoot, definition.file), definition.bytes)
  fs.writeFileSync(
    path.join(modelRoot, `.easyfield-${model}.ready.json`),
    JSON.stringify({ schemaVersion: 1, model, bytes: definition.bytes, sha256: definition.sha256 }),
    { mode: 0o600 },
  )
}

test('strict Whisper options include requested controls and reject unsupported combinations', () => {
  assert.deepEqual(parseOptions({
    model: 'small',
    language: 'he',
    task: 'transcribe',
    wordTimestamps: true,
    initialVocabulary: 'EasyField, דה וינצ׳י',
    beamSize: 7,
    temperature: 0.25,
    conditionOnPreviousText: false,
  }), {
    model: 'small',
    language: 'he',
    task: 'transcribe',
    wordTimestamps: true,
    initialVocabulary: 'EasyField, דה וינצ׳י',
    beamSize: 7,
    temperature: 0.25,
    conditionOnPreviousText: false,
  })
  assert.throws(() => parseOptions({ model: 'turbo', task: 'translate' }), /does not support translation/i)
  assert.equal(parseOptions({ model: 'base', language: 'fr' }).language, 'fr')
  assert.equal(parseOptions({ model: 'small', language: 'JA' }).language, 'ja')
  assert.equal(parseOptions({ model: 'large', language: 'yue' }).language, 'yue')
  assert.throws(() => parseOptions({ model: 'base', language: 'yue' }), /requires whisper large v3 or turbo/i)
  assert.throws(() => parseOptions({ model: 'base', language: 'xx' }), /unsupported whisper language code/i)
  assert.throws(() => parseOptions({ model: 'base', beamSize: 0 }), /beam size/i)
})

test('language catalog matches the complete canonical OpenAI Whisper token list', () => {
  const expectedCodes = [
    'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr',
    'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
    'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
    'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
    'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk',
    'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
    'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc',
    'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
    'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl',
    'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
  ]
  assert.deepEqual(WHISPER_LANGUAGE_CODES, expectedCodes)
  assert.equal(WHISPER_LANGUAGE_CODES.length, 100)
  assert.equal(new Set(WHISPER_LANGUAGE_CODES).size, 100)
  assert.equal(WHISPER_LANGUAGES.he, 'hebrew')
  assert.equal(WHISPER_LANGUAGES.haw, 'hawaiian')
  assert.equal(WHISPER_LANGUAGES.yue, 'cantonese')
  for (const language of WHISPER_LANGUAGE_CODES) {
    const model = language === 'yue' ? 'large' : 'base'
    assert.equal(parseOptions({ model, language }).language, language)
  }
  assert.equal(parseOptions({ model: 'base', language: 'auto' }).language, 'auto')
})

test('whisper.cpp JSON is normalized without exposing native paths', () => {
  const result = normalizeTranscription({
    result: { language: 'he' },
    transcription: [{
      offsets: { from: 500, to: 1800 },
      text: ' שלום עולם',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 500, to: 500 }, p: 1 },
        { text: ' שלום', offsets: { from: 500, to: 1000 }, p: 0.91 },
        { text: ' עולם', offsets: { from: 1000, to: 1800 }, p: 0.82 },
      ],
    }],
  }, parseOptions({ model: 'tiny', language: 'he', wordTimestamps: true }))
  assert.equal(result.engine, 'whisper.cpp')
  assert.equal(result.language, 'he')
  assert.equal(result.text, 'שלום עולם')
  assert.equal(result.words.some((word) => word.text.includes('_BEG_')), false)
  assert.deepEqual(result.words.map(({ text, startSeconds, endSeconds }) => ({ text, startSeconds, endSeconds })), [
    { text: ' שלום', startSeconds: 0.5, endSeconds: 1 },
    { text: ' עולם', startSeconds: 1, endSeconds: 1.8 },
  ])
  assert.equal(JSON.stringify(result).includes('/Users/'), false)
})

test('status and no-admin install endpoint never expose runtime or model paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easyfield-whisper-status-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = createTranscriptionService({
    runtimeRoot: path.join(root, 'runtime'),
    modelRoot: path.join(root, 'models'),
    cliCandidates: [path.join(root, 'missing-whisper-cli')],
  })
  const server = await startService(service)
  t.after(server.close)

  const statusResponse = await fetch(`${server.baseUrl}/api/transcribe/status`)
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.equal(status.engine, 'whisper.cpp')
  assert.equal(status.runtime.available, false)
  assert.equal(status.runtime.installable, false)
  assert.deepEqual(Object.keys(status.models), ['tiny', 'base', 'small', 'medium', 'large', 'turbo'])
  assert.equal(JSON.stringify(status).includes(root), false)

  const installResponse = await fetch(`${server.baseUrl}/api/transcribe/runtime/install`, { method: 'POST' })
  assert.equal(installResponse.status, 409)
  const install = await installResponse.json()
  assert.equal(install.code, 'RUNTIME_PACK_UNAVAILABLE')
  assert.equal(install.requiresAdmin, false)
  assert.equal(JSON.stringify(install).includes(root), false)
})

test('the packaged service can require Main-process authorization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easyfield-whisper-auth-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = createTranscriptionService({
    runtimeRoot: path.join(root, 'runtime'),
    modelRoot: path.join(root, 'models'),
    authorizeRequest(_request, response) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' }))
      return false
    },
  })
  const server = await startService(service)
  t.after(server.close)
  const response = await fetch(`${server.baseUrl}/api/transcribe/status`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'UNAUTHORIZED')
})

test('model download endpoint is explicit and reports only verified public state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easyfield-whisper-model-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const modelRoot = path.join(root, 'models')
  let calls = 0
  const service = createTranscriptionService({
    runtimeRoot: path.join(root, 'runtime'),
    modelRoot,
    async downloadModel(receivedRoot, model) {
      calls += 1
      assert.equal(receivedRoot, modelRoot)
      assert.equal(model, 'tiny')
      markModelReady(modelRoot, model)
      return { bytes: MODELS[model].bytes, alreadyReady: false }
    },
  })
  const server = await startService(service)
  t.after(server.close)

  const response = await fetch(`${server.baseUrl}/api/transcribe/model/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tiny' }),
  })
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
  const payload = await response.json()
  assert.deepEqual(payload, { ok: true, model: 'tiny', state: 'ready', bytes: MODELS.tiny.bytes, alreadyReady: false })
  const status = await fetch(`${server.baseUrl}/api/transcribe/status`).then((result) => result.json())
  assert.equal(status.models.tiny.state, 'ready')
  assert.equal(JSON.stringify(status).includes(root), false)
})

test('raw media endpoint decodes locally and invokes the fixed whisper.cpp contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easyfield-whisper-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const modelRoot = path.join(root, 'models')
  markModelReady(modelRoot, 'tiny')
  const cli = path.join(root, 'fake-whisper-cli')
  const ffmpeg = path.join(root, 'fake-ffmpeg')
  await writeFile(cli, `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
if (args.includes('--help')) { console.log('usage: whisper-cli [options] whisper.cpp version test'); process.exit(0) }
for (const required of ['-m','-f','-l','-bs','-tp','-ojf','-of','-ml','-sow','--prompt','-mc']) if (!args.includes(required)) process.exit(9)
if (args[args.indexOf('-l') + 1] !== 'he' || args[args.indexOf('-bs') + 1] !== '7' || args[args.indexOf('-tp') + 1] !== '0.2' || args[args.indexOf('-mc') + 1] !== '0') process.exit(8)
const output = args[args.indexOf('-of') + 1] + '.json'
fs.writeFileSync(output, JSON.stringify({ result:{language:'he'}, transcription:[{offsets:{from:250,to:1250},text:' בדיקה',tokens:[{text:' בדיקה',offsets:{from:250,to:1250},p:0.95}]}] }))
`)
  await writeFile(ffmpeg, `#!/usr/bin/env node
const fs = require('fs')
const output = process.argv.at(-1)
fs.writeFileSync(output, Buffer.alloc(128, 1))
`)
  fs.chmodSync(cli, 0o700)
  fs.chmodSync(ffmpeg, 0o700)

  const service = createTranscriptionService({
    runtimeRoot: path.join(root, 'runtime'),
    modelRoot,
    cliCandidates: [cli],
    ffmpegPath: ffmpeg,
    maxBytes: 1024,
    timeoutMs: 10000,
  })
  const server = await startService(service)
  t.after(server.close)

  const response = await fetch(`${server.baseUrl}/api/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4',
      'X-EF-Whisper-Model': 'tiny',
      'X-EF-Whisper-Language': 'he',
      'X-EF-Whisper-Task': 'transcribe',
      'X-EF-Whisper-Word-Timestamps': 'true',
      'X-EF-Whisper-Initial-Vocabulary': encodeURIComponent('EasyField בדיקה'),
      'X-EF-Whisper-Beam-Size': '7',
      'X-EF-Whisper-Temperature': '0.2',
      'X-EF-Whisper-Condition-On-Previous-Text': 'false',
    },
    body: Buffer.from('synthetic video bytes'),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.ok, true)
  assert.equal(result.model, 'tiny')
  assert.equal(result.language, 'he')
  assert.equal(result.words.length, 1)
  assert.equal(result.words[0].text, ' בדיקה')
  assert.equal(result.durationSeconds, 1.25)

  const tooLarge = await fetch(`${server.baseUrl}/api/transcribe`, {
    method: 'POST',
    headers: { 'X-EF-Whisper-Model': 'tiny' },
    body: Buffer.alloc(2048),
  })
  assert.equal(tooLarge.status, 413)
})

test('process cancellation kills a running whisper.cpp child promptly', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    timeoutMs: 10000,
  })
  setTimeout(() => controller.abort(), 50)
  const result = await running
  assert.equal(result.cancelled, true)
  assert.ok(Date.now() - started < 2000)
})
