import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { renderPlugin } from './vite-plugin-render'
import { beatDetectionPlugin } from './vite-plugin-beat'
import { whisperTranscriptionPlugin } from './vite-plugin-whisper'
import { secureProviderDevProxyPlugin } from './vite-plugin-secure-provider'
import { urlContextPlugin } from './vite-plugin-url-context'

const cloudApiHost = (process.env.EF_CLOUD_API_HOST || Buffer.from('YXBpLmtpZS5haQ==', 'base64').toString('utf8')).trim()
const cloudUploadHost = (process.env.EF_CLOUD_UPLOAD_HOST || Buffer.from('a2llYWkucmVkcGFuZGFhaS5jbw==', 'base64').toString('utf8')).trim()

// Dev proxies let the browser call the cloud provider without hitting CORS.
// Browser-only development uses these targets with its session key. The secure
// provider plugin above diverts Electron's opaque sentinel to Main before these
// rules run, so neither the stored key nor Main's decrypt step enters Vite.
// renderPlugin adds POST /api/render for local HyperFrames/Remotion MP4 export.
export default defineConfig({
  plugins: [react(), secureProviderDevProxyPlugin(), urlContextPlugin(), whisperTranscriptionPlugin(), beatDetectionPlugin(), renderPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/provider-upload': {
        target: `https://${cloudUploadHost}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/provider-upload/, ''),
      },
      '/provider': {
        target: `https://${cloudApiHost}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/provider/, ''),
      },
      '/bridge': {
        target: 'http://127.0.0.1:18832',
        changeOrigin: true,
        // The plugin's embedded server. A missing bridge is a normal offline
        // state, not a renderer/server failure. Return the same structured
        // disconnected status as the production bridge so polling does not
        // emit an HTTP 500 in the browser console. Capture/place requests keep
        // their failure response and remain visibly actionable to the caller.
        configure: (proxy) => {
          proxy.on('error', (_error, req, res) => {
            if (req.url?.startsWith('/bridge/status') && 'writeHead' in res && !res.headersSent) {
              res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
              res.end(JSON.stringify({ connected: false }))
            }
          })
        },
      },
    },
  },
})
