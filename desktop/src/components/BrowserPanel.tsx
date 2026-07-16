import { useState, useEffect } from 'react'

export default function BrowserPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [url, setUrl] = useState('about:blank')

  useEffect(() => {
    if (isOpen && window.electronAPI) {
      window.electronAPI.getBrowserUrl().then(setUrl)
      const interval = setInterval(() => {
        window.electronAPI!.getBrowserUrl().then(setUrl)
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [isOpen])

  if (!isOpen) {
    return (
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        title="Open embedded browser"
        aria-label="Browser"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        Browser
      </button>
    )
  }

  return (
    <div className="modal-overlay" onClick={() => setIsOpen(false)}>
      <div
        className="modal"
        style={{ maxWidth: 900, width: '95%', height: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">🌐 Embedded Browser</span>
          <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
        </div>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <input
            className="config-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && window.electronAPI) {
                window.electronAPI.sendMessage(`browser_navigate ${url}`)
              }
            }}
            placeholder="Enter URL and press Enter to navigate…"
          />
        </div>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: 'var(--text-muted)',
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{ fontSize: 32, marginBottom: 12 }}>🌐</span>
            <p style={{ fontSize: 13 }}>
              Browser tools drive an external Chromium instance.
            </p>
            <p className="panel-hint" style={{ marginTop: 4 }}>
              Navigate to a URL or use <code>browser_navigate</code> in chat.
              The browser runs at <code>http://localhost:9222</code>.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
