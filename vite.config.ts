import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { renderPlugin } from './vite-plugin-render'
import { beatDetectionPlugin } from './vite-plugin-beat'
import { whisperTranscriptionPlugin } from './vite-plugin-whisper'
import { secureKieDevProxyPlugin } from './vite-plugin-secure-kie'
import { urlContextPlugin } from './vite-plugin-url-context'

// Dev proxies let the browser call kie.ai without hitting CORS. Browser-only
// development uses these provider targets with its session key. The secure
// Kie plugin above diverts Electron's opaque sentinel to Main before these
// rules run, so neither the real stored key nor Main's decrypt step enters Vite.
//  - /kie/api/v1/...  -> https://api.kie.ai        (account + generation API)
//  - /kie-upload/...  -> https://kieai.redpandaai.co (File Upload API)
// renderPlugin adds POST /api/render for local HyperFrames/Remotion MP4 export.
export default defineConfig({
  plugins: [react(), secureKieDevProxyPlugin(), urlContextPlugin(), whisperTranscriptionPlugin(), beatDetectionPlugin(), renderPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/kie-upload': {
        target: 'https://kieai.redpandaai.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/kie-upload/, ''),
      },
      '/kie': {
        target: 'https://api.kie.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/kie/, ''),
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
