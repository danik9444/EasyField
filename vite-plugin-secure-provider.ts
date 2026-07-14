import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// Electron's renderer receives this opaque value instead of the real cloud key.
// In packaged builds the embedded Main server consumes it directly. During
// EF_DEV the renderer is served by Vite, so only sentinel-authenticated provider
// requests take this extra loopback hop; browser-only development with a raw
// session key keeps using Vite's normal provider proxies.
export const SECURE_PROVIDER_PROXY_TOKEN = '__easyfield_secure__'

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

function proxyHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const forwarded = { ...headers }
  // Node will manage the connection to Main. All end-to-end request headers,
  // including Electron's X-EF-Bridge-Token, remain intact.
  delete forwarded.connection
  delete forwarded['proxy-connection']
  forwarded.host = `127.0.0.1:${port}`
  return forwarded
}

export function createSecureProviderDevMiddleware(port = 18832): SecureProviderDevMiddleware {
  return (req, res, next) => {
    const authorization = req.headers.authorization
    if (
      authorization !== `Bearer ${SECURE_PROVIDER_PROXY_TOKEN}`
      || !req.url
      || !isProviderProxyPath(req.url)
    ) {
      next()
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

  return {
    name: 'easyfield-secure-provider-dev-proxy',
    configureServer(server) {
      // configureServer hooks run before Vite's internal proxy middleware. A
      // non-sentinel request calls next() and reaches the existing provider proxy.
      server.middlewares.use(createSecureProviderDevMiddleware(port))
    },
  }
}
