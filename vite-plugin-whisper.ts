import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'
import type { AuthorizeDevRequest } from './vite-dev-security'

interface WhisperService {
  handleRequest: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    pathname: string,
  ) => boolean
}

interface WhisperModule {
  createTranscriptionService: (options: {
    authorizeRequest: AuthorizeDevRequest
    ffmpegPath: string
    maxBytes: number
  }) => WhisperService
}

const require = createRequire(import.meta.url)
const { createTranscriptionService } = require('./plugin/whisper-transcription.cjs') as WhisperModule

export function whisperTranscriptionPlugin(authorizeRequest: AuthorizeDevRequest): Plugin {
  if (typeof authorizeRequest !== 'function') throw new TypeError('Whisper development authorization is required')
  const homebrewFfmpeg = '/opt/homebrew/bin/ffmpeg'
  const intelHomebrewFfmpeg = '/usr/local/bin/ffmpeg'
  const service = createTranscriptionService({
    authorizeRequest,
    ffmpegPath: existsSync(homebrewFfmpeg) ? homebrewFfmpeg : existsSync(intelHomebrewFfmpeg) ? intelHomebrewFfmpeg : 'ffmpeg',
    maxBytes: 1024 * 1024 * 1024,
  })

  return {
    name: 'ef-local-whisper-transcription',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname: string
        try {
          pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        } catch {
          next()
          return
        }
        if (!service.handleRequest(req, res, pathname)) next()
      })
    },
  }
}
