import { useState, useEffect } from 'react'

interface ApiKey {
  key: string
  label: string
  value: string
  masked: boolean
}

const KEYS: ApiKey[] = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', value: '', masked: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', value: '', masked: true },
  { key: 'GOOGLE_API_KEY', label: 'Google AI', value: '', masked: true },
  { key: 'TAVILY_API_KEY', label: 'Tavily Search', value: '', masked: true },
  { key: 'GITHUB_TOKEN', label: 'GitHub', value: '', masked: true },
]

export default function ApiKeyManager() {
  const [isOpen, setIsOpen] = useState(false)
  const [keys, setKeys] = useState<ApiKey[]>(KEYS)
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  useEffect(() => {
    if (!window.electronAPI) return
    const keyNames = KEYS.map((k) => k.key)
    window.electronAPI.getEnvAll(keyNames).then((envVals) => {
      setKeys(
        KEYS.map((k) => ({
          ...k,
          value: envVals[k.key] ?? '',
        }))
      )
    })
  }, [])

  const save = (key: string) => {
    // In production, save to .env or keychain
    // For now, show a message about setting via terminal
    setEditing(null)
  }

  return (
    <>
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        title="API Keys"
        aria-label="API Keys"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
        Keys
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🔑 API Keys</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="panel-hint">
                Set API keys via terminal: <code>export KEY=value</code> or your shell profile.
              </p>
              <ul className="file-list" style={{ marginTop: 10 }}>
                {keys.map((k) => (
                  <li key={k.key} className="file-item">
                    <div className="file-name">{k.label}</div>
                    <div className="file-meta" style={{ fontFamily: 'monospace' }}>
                      {k.value ? k.value + '****' : (
                        <span style={{ color: 'var(--error)' }}>Not set</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
