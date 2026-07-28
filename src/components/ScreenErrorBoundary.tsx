import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ScreenErrorBoundaryProps {
  children: ReactNode
  onReturnHome: () => void
  onClearSavedState?: () => Promise<void>
}

interface ScreenErrorBoundaryState {
  error: Error | null
  clearing: boolean
  recoveryError: string
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class ScreenErrorBoundary extends Component<ScreenErrorBoundaryProps, ScreenErrorBoundaryState> {
  state: ScreenErrorBoundaryState = {
    error: null,
    clearing: false,
    recoveryError: '',
  }

  static getDerivedStateFromError(error: unknown): Partial<ScreenErrorBoundaryState> {
    return { error: normalizeError(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('EasyField screen crashed', error, info.componentStack)
  }

  private returnHome = () => {
    this.props.onReturnHome()
    this.setState({ error: null, clearing: false, recoveryError: '' })
  }

  private clearSavedState = async () => {
    if (!this.props.onClearSavedState) return
    this.setState({ clearing: true, recoveryError: '' })
    try {
      await this.props.onClearSavedState()
      this.returnHome()
    } catch (error) {
      this.setState({
        clearing: false,
        recoveryError: normalizeError(error).message,
      })
    }
  }

  render() {
    const { error, clearing, recoveryError } = this.state
    if (!error) return this.props.children

    return (
      <main className="ef-screen ef-error-screen" role="alert">
        <div className="ef-error-card">
          <span className="ef-error-mark" aria-hidden="true">!</span>
          <span className="ef-error-kicker">SCREEN RECOVERY</span>
          <h1>This screen ran into a problem</h1>
          <p>Your other EasyField screens are still available.</p>
          <code className="ef-error-detail">{error.message || 'An unknown error occurred.'}</code>
          {recoveryError && <p className="ef-error-recovery-detail">Could not clear the saved data: {recoveryError}</p>}
          <div className="ef-error-actions">
            <button type="button" className="ef-send-btn" onClick={this.returnHome}>Return to Home</button>
            {this.props.onClearSavedState && (
              <button type="button" className="ef-ghost-btn danger" disabled={clearing} onClick={() => void this.clearSavedState()}>
                {clearing ? 'Clearing…' : 'Clear saved screen data'}
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }
}
