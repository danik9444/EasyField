// Development counterpart to the packaged Resolve URL-context endpoint.
// Both runtimes load the exact same Node-only implementation, keeping SSRF and
// content-sanitisation policy identical during browser development.
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

interface UrlContextService {
  handleRequest: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    pathname: string,
  ) => boolean
}

interface UrlContextModule {
  createUrlContextService: () => UrlContextService
}

const require = createRequire(import.meta.url)
const { createUrlContextService } = require('./plugin/url-context.cjs') as UrlContextModule

export function urlContextPlugin(): Plugin {
  const service = createUrlContextService()

  return {
    name: 'ef-safe-url-context',
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
