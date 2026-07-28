import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// Electron's renderer receives one of these opaque values instead of a cloud
// credential or account token. In packaged builds the embedded Main server
// consumes them directly. During EF_DEV the renderer is served by Vite, so both
// trusted sentinels must take the same loopback hop through Main.
export const SECURE_PROVIDER_PROXY_TOKEN = '__easyfield_secure__'
export const SECURE_ACCOUNT_PROXY_TOKEN = '__easyfield_account__'

export interface SecureProviderDevMiddlewareOptions {
  /**
   * Browser-only development may deliberately use a session-owned raw key.
   * Keep that escape hatch opt-in so an account sentinel can never fall through
   * to the direct upstream proxy because of a routing typo.
   */
  allowBrowserDirect?: boolean
}

type Next = (error?: unknown) => void
export type SecureProviderDevMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
) => void

function isProviderProxyPath(url: string): boolean {
  let pathname = ''
  try {
    pathname = new URL(url, 'http://127.0.0.1').pathname
  } catch {
    return false
  }
  return pathname === '/provider'
    || pathname.startsWith('/provider/')
    || pathname === '/provider-upload'
    || pathname.startsWith('/provider-upload/')
}

function isPublicPricingPath(url: string): boolean {
  try {
    return new URL(url, 'http://127.0.0.1').pathname === '/provider/client/v1/model-pricing/page'
  } catch {
    return false
  }
}

function proxyHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const forwarded = { ...headers }
  // Node will manage the connection to Main. All end-to-end request headers,
  // including Electron's X-EF-Bridge-Token, remain intact.
  delete forwarded.connection
  delete forwarded['proxy-connection']
  forwarded.host = `127.0.0.1:${port}`
  return forwarded
}

export function createSecureProviderDevMiddleware(
  port = 18832,
  options: SecureProviderDevMiddlewareOptions = {},
): SecureProviderDevMiddleware {
  return (req, res, next) => {
    const authorization = req.headers.authorization
    if (!req.url || !isProviderProxyPath(req.url)) {
      next()
      return
    }

    const isTrustedSentinel = authorization === `Bearer ${SECURE_PROVIDER_PROXY_TOKEN}`
      || authorization === `Bearer ${SECURE_ACCOUNT_PROXY_TOKEN}`
    if (!isTrustedSentinel) {
      // This single endpoint is the public, read-only pricing feed used before
      // sign-in. Keep every task, upload and account endpoint authenticated.
      if (!authorization && isPublicPricingPath(req.url)) {
        next()
        return
      }
      if (options.allowBrowserDirect === true && /^Bearer\s+\S+$/.test(authorization || '')) {
        next()
        return
      }

      const body = Buffer.from(JSON.stringify({
        ok: false,
        error: 'EasyField plugin proxy authentication is required',
        code: 'PLUGIN_PROXY_AUTH_REQUIRED',
      }))
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      res.end(body)
      return
    }

    const upstream = http.request({
      hostname: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req.headers, port),
    }, (response) => {
      if (res.headersSent) {
        response.destroy()
        return
      }
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })

    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const body = Buffer.from(JSON.stringify({
        ok: false,
        error: 'EasyField plugin proxy is unavailable',
        code: 'PLUGIN_PROXY_UNAVAILABLE',
      }))
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      res.end(body)
    })

    req.pipe(upstream)
  }
}

export function secureProviderDevProxyPlugin(): Plugin {
  const configuredPort = Number(process.env.EF_PORT)
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : 18832
  const allowBrowserDirect = process.env.EF_BROWSER_DIRECT_PROVIDER === '1'

  return {
    name: 'easyfield-secure-provider-dev-proxy',
    configureServer(server) {
      // configureServer hooks run before Vite's internal proxy middleware. Raw
      // browser credentials reach that proxy only when explicitly enabled for a
      // browser-only development session.
      server.middlewares.use(createSecureProviderDevMiddleware(port, { allowBrowserDirect }))
    },
  }
}
