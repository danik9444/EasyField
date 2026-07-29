import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Build configuration for the local admin console.
 *
 * The console is served on loopback and is never deployed. Loopback alone is
 * not a trust boundary — plugin/main.cjs already records why: any web page can
 * attempt requests to 127.0.0.1. What actually protects this app is that it
 * holds no credential worth stealing. Authority lives in the operator's own
 * Supabase session, and every privileged action is authorised server-side by
 * billing_private.is_active_admin.
 */

/**
 * Injects a content security policy naming the one remote origin this console
 * may talk to. An admin screen has no reason to reach a CDN, a font host, or an
 * analytics endpoint, so everything except the configured Supabase project is
 * refused by the browser rather than by convention.
 */
function adminCsp(connectOrigins: readonly string[]): Plugin {
  const connectSrc = ["'self'", ...connectOrigins].join(' ')
  const policy = [
    "default-src 'self'",
    // Vite inlines a small style block; scripts stay strictly same-origin.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ')

  return {
    name: 'easyfield-admin-csp',
    // Build only. The dev server injects an inline react-refresh preamble that
    // `script-src 'self'` blocks, which silently prevents the app from mounting
    // at all. The policy protects the artifact that actually gets run; the dev
    // server is loopback-only and short-lived.
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

function originOf(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  // Only the origins actually configured are allowed through, so an unset
  // deployment produces a console that can reach nothing rather than one that
  // can reach everything.
  const connectOrigins = [originOf(env.VITE_SUPABASE_URL), originOf(env.VITE_ADMIN_API_URL)]
    .filter((origin): origin is string => origin !== null)

  return {
    root: 'admin',
    base: './',
    plugins: [react(), adminCsp([...new Set(connectOrigins)])],
    server: {
      host: '127.0.0.1',
      port: 5199,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 5199,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Source maps would ship the console's logic to anyone who obtains the
      // build. There is no crash reporter consuming them here.
      sourcemap: false,
    },
  }
})
