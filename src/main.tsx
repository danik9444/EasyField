import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './redesign.css'

const renderJobId = new URLSearchParams(window.location.search).get('efRenderJob')
const root = createRoot(document.getElementById('root')!)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function StartupError({ error }: { error: unknown }) {
  return (
    <div className="ef-panel">
      <main className="ef-screen ef-error-screen" role="alert">
        <div className="ef-error-card">
          <span className="ef-error-mark" aria-hidden="true">!</span>
          <span className="ef-error-kicker">STARTUP RECOVERY</span>
          <h1>EasyField could not start</h1>
          <p>The panel code did not load. Reloading will retry it without restarting DaVinci Resolve.</p>
          <code className="ef-error-detail">{errorMessage(error) || 'An unknown loading error occurred.'}</code>
          <div className="ef-error-actions">
            <button type="button" className="ef-send-btn" onClick={() => window.location.reload()}>Reload panel</button>
          </div>
        </div>
      </main>
    </div>
  )
}

function showStartupError(error: unknown) {
  console.error('EasyField failed to start', error)
  root.render(<StartupError error={error} />)
}

if (renderJobId) {
  void import('./render/AnimationRenderHost').then(({ AnimationRenderHost }) => {
    root.render(<AnimationRenderHost jobId={renderJobId} />)
  }).catch(showStartupError)
} else {
  void import('./App').then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  }).catch(showStartupError)
}
