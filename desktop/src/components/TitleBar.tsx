/** Custom frameless title bar with Pi branding and window controls. */
export default function TitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar-drag" />
      <div className="titlebar-brand">
        <span className="titlebar-logo">π</span>
        <span className="titlebar-name">Pi Tools</span>
      </div>
      <div className="titlebar-drag" />
      <div className="titlebar-controls">
        <button
          className="wc-btn wc-minimize"
          onClick={() => window.electronAPI?.minimize()}
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" rx="0.5" fill="currentColor" /></svg>
        </button>
        <button
          className="wc-btn wc-maximize"
          onClick={() => window.electronAPI?.maximize()}
          aria-label="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" /></svg>
        </button>
        <button
          className="wc-btn wc-close"
          onClick={() => window.electronAPI?.close()}
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  )
}
