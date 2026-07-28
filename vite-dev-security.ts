import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const DEV_TOKEN_COOKIE = 'ef_vite_analysis_token'
const AUTHENTICATED_PATHS = [
  '/api/beat-detect',
  '/api/transcribe',
  '/api/url-context',
] as const
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export type AuthorizeDevRequest = (req: IncomingMessage, res: ServerResponse) => boolean

export interface ViteDevSecurity {
  authorizeRequest: AuthorizeDevRequest
  plugin: Plugin
}

function sendJson(res: ServerResponse, status: number, payload: object): void {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function requestOriginAllowed(req: IncomingMessage, origin: string): boolean {
  try {
    const originUrl = new URL(origin)
    const requestUrl = new URL(`http://${req.headers.host ?? ''}`)
    return originUrl.protocol === 'http:'
      && LOOPBACK_HOSTS.has(originUrl.hostname)
      && originUrl.host === requestUrl.host
  } catch {
    return false
  }
}

function tokenMatches(candidate: string, expected: Buffer): boolean {
  const supplied = Buffer.from(candidate)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function requestHasToken(req: IncomingMessage, expected: Buffer): boolean {
  const cookie = req.headers.cookie
  if (!cookie) return false

  return cookie.split(';').some((part) => {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== DEV_TOKEN_COOKIE) return false
    return tokenMatches(part.slice(separator + 1).trim(), expected)
  })
}

function isRootDocumentRequest(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false
  try {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/') return false
  } catch {
    return false
  }
  return req.headers['sec-fetch-dest'] === 'document'
    || String(req.headers.accept ?? '').toLowerCase().includes('text/html')
}

function appendSetCookie(res: ServerResponse, values: string[]): void {
  const existing = res.getHeader('Set-Cookie')
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing.map(String), ...values])
    return
  }
  if (existing != null) {
    res.setHeader('Set-Cookie', [String(existing), ...values])
    return
  }
  res.setHeader('Set-Cookie', values)
}

export function createViteDevSecurity(): ViteDevSecurity {
  const token = randomBytes(32).toString('hex')
  const expectedToken = Buffer.from(token)

  const authorizeRequest: AuthorizeDevRequest = (req, res) => {
    const origin = req.headers.origin
    if (origin && !requestOriginAllowed(req, origin)) {
      sendJson(res, 403, { ok: false, error: 'bridge origin rejected', code: 'FORBIDDEN' })
      return false
    }
    if (requestHasToken(req, expectedToken)) return true
    sendJson(res, 401, { ok: false, error: 'bridge authentication required', code: 'UNAUTHORIZED' })
    return false
  }

  return {
    authorizeRequest,
    plugin: {
      name: 'easyfield-vite-dev-security',
      apply: 'serve',
      configResolved(config) {
        if (typeof config.server.host !== 'string' || !LOOPBACK_HOSTS.has(config.server.host)) {
          throw new Error('EasyField development middleware must listen on a loopback host')
        }
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (isRootDocumentRequest(req)) {
            // Keep the random credential out of page JavaScript and scope it
            // away from /provider so it cannot cross either upstream proxy.
            appendSetCookie(res, AUTHENTICATED_PATHS.map((path) => (
              `${DEV_TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=${path}`
            )))
          }
          next()
        })
      },
    },
  }
}
