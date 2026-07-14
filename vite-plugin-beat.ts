// Development-server counterpart to the packaged Electron beat endpoint.
// It uses the exact same service and Python/librosa contract, so browser-dev
// behavior cannot silently diverge from the Resolve plugin.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

interface BeatService {
  handleRequest: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    pathname: string,
  ) => boolean
}

interface BeatServiceModule {
  createBeatDetectionService: (options: {
    scriptPath: string
    ffmpegPath?: string
    maxBytes?: number
  }) => BeatService
}

const require = createRequire(import.meta.url)
const { createBeatDetectionService } = require('./plugin/beat-detection.cjs') as BeatServiceModule

export function beatDetectionPlugin(): Plugin {
  const homebrewFfmpeg = '/opt/homebrew/bin/ffmpeg'
  const intelHomebrewFfmpeg = '/usr/local/bin/ffmpeg'
  const service = createBeatDetectionService({
    scriptPath: fileURLToPath(new URL('./plugin/python/beat_detect.py', import.meta.url)),
    ffmpegPath: existsSync(homebrewFfmpeg) ? homebrewFfmpeg : existsSync(intelHomebrewFfmpeg) ? intelHomebrewFfmpeg : 'ffmpeg',
    maxBytes: 1024 * 1024 * 1024,
  })

  return {
    name: 'ef-local-beat-detection',
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
