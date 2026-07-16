import { useState } from 'react'

const THEMES = {
  dark: {
    '--bg': '#0d1117',
    '--bg-surface': '#161b22',
    '--bg-elevated': '#21262d',
    '--bg-hover': '#262c36',
    '--border': '#30363d',
    '--border-subtle': '#21262d',
    '--text': '#e6edf3',
    '--text-muted': '#8b949e',
    '--text-dim': '#484f58',
    '--accent': '#7c5cfc',
    '--accent-hover': '#9171fd',
    '--user-msg-bg': '#1c2f4a',
  },
  light: {
    '--bg': '#ffffff',
    '--bg-surface': '#f6f8fa',
    '--bg-elevated': '#eaeef2',
    '--bg-hover': '#dde3e8',
    '--border': '#d0d7de',
    '--border-subtle': '#e8ecf0',
    '--text': '#1f2328',
    '--text-muted': '#656d76',
    '--text-dim': '#8c959f',
    '--accent': '#6e40c9',
    '--accent-hover': '#8256d0',
    '--user-msg-bg': '#ddf4ff',
  },
} as const

type ThemeName = keyof typeof THEMES

export default function ThemePicker() {
  const [isOpen, setIsOpen] = useState(false)
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(
    (localStorage.getItem('pi-theme') as ThemeName) ?? 'dark'
  )

  const apply = (name: ThemeName) => {
    setCurrentTheme(name)
    setIsOpen(false)
    localStorage.setItem('pi-theme', name)
    const vars = THEMES[name]
    for (const [key, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(key, value)
    }
  }

  return (
    <>
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        title="Change theme"
        aria-label="Theme"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
        </svg>
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🎨 Theme</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 10 }}>
                {(Object.keys(THEMES) as ThemeName[]).map((name) => (
                  <button
                    key={name}
                    onClick={() => apply(name)}
                    style={{
                      flex: 1,
                      padding: '12px 8px',
                      borderRadius: 8,
                      border: currentTheme === name
                        ? '2px solid var(--accent)'
                        : '2px solid var(--border)',
                      background: THEMES[name]['--bg-surface'],
                      color: THEMES[name]['--text'],
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: currentTheme === name ? 600 : 400,
                    }}
                  >
                    <div style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: THEMES[name]['--accent'],
                      margin: '0 auto 6px',
                    }} />
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
