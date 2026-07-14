import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './redesign.css'

const renderJobId = new URLSearchParams(window.location.search).get('efRenderJob')
const root = createRoot(document.getElementById('root')!)

if (renderJobId) {
  void import('./render/AnimationRenderHost').then(({ AnimationRenderHost }) => {
    root.render(<AnimationRenderHost jobId={renderJobId} />)
  })
} else {
  void import('./App').then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
}
