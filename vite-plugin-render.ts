// Dev-server middleware that renders an animation to MP4 with the LOCAL engines:
//   HyperFrames -> `hyperframes render <html> -o out.mp4`
//   Remotion    -> `remotion render src/remotion/index.ts Animation out.mp4 --props=…`
// POST /api/render { engine, html?, props? } -> MP4 bytes. In a packaged plugin
// this same shell-out runs from the plugin backend (deps installed on install).
import type { Plugin } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_RENDER_BODY_BYTES = 64 * 1024 * 1024
// Base64 expands this to at most 32 MB, leaving ample room for the rest of the
// render JSON beneath the endpoint's 64 MB request cap.
export const MAX_ANIMATION_AUDIO_BYTES = 24 * 1024 * 1024
const ALLOWED_AUDIO_DURATIONS = new Set([3, 5, 8, 10, 15])

const AUDIO_MIME_TYPES: Record<string, { extension: string; format: string }> = {
  'audio/mpeg': { extension: 'mp3', format: 'mp3' },
  'audio/mp3': { extension: 'mp3', format: 'mp3' },
  'audio/wav': { extension: 'wav', format: 'wav' },
  'audio/wave': { extension: 'wav', format: 'wav' },
  'audio/x-wav': { extension: 'wav', format: 'wav' },
  'audio/vnd.wave': { extension: 'wav', format: 'wav' },
  'audio/mp4': { extension: 'm4a', format: 'mov' },
  'audio/x-m4a': { extension: 'm4a', format: 'mov' },
  'audio/aac': { extension: 'aac', format: 'aac' },
  'audio/ogg': { extension: 'ogg', format: 'ogg' },
  'audio/opus': { extension: 'opus', format: 'ogg' },
  'audio/webm': { extension: 'webm', format: 'matroska' },
  'audio/flac': { extension: 'flac', format: 'flac' },
  'audio/x-flac': { extension: 'flac', format: 'flac' },
  'audio/aiff': { extension: 'aiff', format: 'aiff' },
  'audio/x-aiff': { extension: 'aiff', format: 'aiff' },
}

export interface EmbeddedAudio {
  bytes: Buffer
  extension: string
  format: string
}

class RenderRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RenderRequestError'
    this.status = status
  }
}

export function validateAnimationAudioDataUrl(value: unknown): EmbeddedAudio | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new RenderRequestError('Animation audio must be an embedded base64 audio file')

  const comma = value.indexOf(',')
  const header = comma >= 0 ? value.slice(0, comma) : ''
  const payload = comma >= 0 ? value.slice(comma + 1) : ''
  const match = /^data:(audio\/[a-z0-9.+-]+);base64$/i.exec(header)
  const type = match ? AUDIO_MIME_TYPES[match[1].toLowerCase()] : undefined
  if (!type) throw new RenderRequestError('Animation audio must be a supported data:audio base64 URL')

  const maximumEncodedBytes = 4 * Math.ceil(MAX_ANIMATION_AUDIO_BYTES / 3)
  if (payload.length > maximumEncodedBytes) throw new RenderRequestError('Animation audio exceeds the 24 MB limit', 413)
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new RenderRequestError('Animation audio contains invalid base64 data')
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  const byteLength = (payload.length / 4) * 3 - padding
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw new RenderRequestError('Animation audio is empty')
  if (byteLength > MAX_ANIMATION_AUDIO_BYTES) throw new RenderRequestError('Animation audio exceeds the 24 MB limit', 413)

  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length !== byteLength || bytes.toString('base64') !== payload) {
    throw new RenderRequestError('Animation audio contains invalid base64 data')
  }
  return { bytes, extension: type.extension, format: type.format }
}

export function buildAnimationAudioMuxArgs(
  silentVideoPath: string,
  audioPath: string,
  audioFormat: string,
  durationSec: number,
  outputPath: string,
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', silentVideoPath,
    '-f', audioFormat,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-af', 'apad',
    '-t', String(durationSec),
    '-movflags', '+faststart',
    outputPath,
  ]
}

function ffmpegPath(): string {
  if (process.env.EF_FFMPEG_PATH) return process.env.EF_FFMPEG_PATH
  if (existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg'
  if (existsSync('/usr/local/bin/ffmpeg')) return '/usr/local/bin/ffmpeg'
  return 'ffmpeg'
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env })
    let err = ''
    child.stdout.on('data', (d) => process.stdout.write(d))
    child.stderr.on('data', (d) => {
      err += d
      process.stderr.write(d)
    })
    child.on('close', (code) => resolve({ code: code ?? 1, err }))
    child.on('error', (e) => resolve({ code: 1, err: String(e) }))
  })
}

export function renderPlugin(): Plugin {
  return {
    name: 'ef-animation-render',
    configureServer(server) {
      server.middlewares.use('/api/render', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end('POST only')
        }
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          res.statusCode = 415
          return res.end('application/json required')
        }
        const declaredLength = Number.parseInt(String(req.headers['content-length'] ?? ''), 10)
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RENDER_BODY_BYTES) {
          res.statusCode = 413
          req.resume()
          return res.end('Render request is too large')
        }
        const chunks: Buffer[] = []
        let bodyBytes = 0
        let bodyTooLarge = false
        req.on('data', (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bodyBytes += bytes.length
          if (bodyBytes > MAX_RENDER_BODY_BYTES) {
            bodyTooLarge = true
            return
          }
          chunks.push(bytes)
        })
        req.on('end', async () => {
          const fail = (msg: string, code = 500) => {
            if (res.writableEnded) return
            res.statusCode = code
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: msg }))
          }
          if (bodyTooLarge) return fail('Render request is too large', 413)

          let dir: string | null = null
          try {
            let parsed: unknown
            try {
              parsed = JSON.parse(Buffer.concat(chunks, bodyBytes).toString('utf8'))
            } catch {
              throw new RenderRequestError('Render request contains invalid JSON')
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new RenderRequestError('Render request must be a JSON object')
            }
            const { engine, html, props, audioDataUrl, durationSec } = parsed as {
              engine: string
              html?: string
              props?: unknown
              audioDataUrl?: string
              durationSec?: number
            }
            if (engine !== 'HyperFrames' && engine !== 'Remotion') return fail('Unsupported animation engine', 400)
            const audio = validateAnimationAudioDataUrl(audioDataUrl)
            const duration = Number(durationSec)
            if (audio && !ALLOWED_AUDIO_DURATIONS.has(duration)) return fail('Unsupported animation duration', 400)

            dir = mkdtempSync(join(tmpdir(), 'ef-render-'))
            const out = join(dir, 'out.mp4')
            const silentOut = audio ? join(dir, 'silent.mp4') : out
            let r: { code: number; err: string }
            if (engine === 'HyperFrames') {
              // `hyperframes render <projectDir>` renders the dir's index.html.
              writeFileSync(join(dir, 'index.html'), html ?? '')
              r = await run('npx', ['--no-install', 'hyperframes', 'render', dir, '-o', silentOut, '--quiet'], process.cwd())
            } else {
              r = await run(
                'npx',
                ['--no-install', 'remotion', 'render', 'src/remotion/index.ts', 'Animation', silentOut, `--props=${JSON.stringify(props ?? {})}`],
                process.cwd(),
              )
            }
            if (r.code !== 0 || !existsSync(silentOut)) {
              return fail(r.err.split('\n').slice(-6).join('\n') || 'Render failed')
            }

            if (audio) {
              const audioPath = join(dir, `animation-audio.${audio.extension}`)
              writeFileSync(audioPath, audio.bytes, { flag: 'wx', mode: 0o600 })
              audio.bytes.fill(0)
              r = await run(
                ffmpegPath(),
                buildAnimationAudioMuxArgs(silentOut, audioPath, audio.format, duration, out),
                process.cwd(),
              )
              if (r.code !== 0 || !existsSync(out)) {
                return fail(r.err.split('\n').slice(-6).join('\n') || 'Audio mux failed')
              }
            }

            const buf = readFileSync(out)
            res.statusCode = 200
            res.setHeader('Content-Type', 'video/mp4')
            res.end(buf)
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            fail(message, e instanceof RenderRequestError ? e.status : 500)
          } finally {
            if (dir) rmSync(dir, { recursive: true, force: true })
          }
        })
      })
    },
  }
}
