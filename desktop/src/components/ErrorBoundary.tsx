import React from 'react'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{
          padding: 24,
          textAlign: 'center',
          color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <p style={{ fontSize: 14, marginBottom: 12 }}>
            Something went wrong in this panel.
          </p>
          <pre style={{
            fontSize: 11,
            color: 'var(--error)',
            background: 'rgba(248,81,73,0.1)',
            padding: 8,
            borderRadius: 6,
            maxWidth: 400,
            margin: '0 auto 12px',
          }}>
            {this.state.error?.message}
          </pre>
          <button
            className="btn-secondary btn-sm"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
