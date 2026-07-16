import { useState } from 'react'

const MODELS = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'Anthropic' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'DeepSeek' },
]

export default function ModelSelector() {
  const [isOpen, setIsOpen] = useState(false)
  const [current, setCurrent] = useState(
    () => localStorage.getItem('pi-model') ?? MODELS[0]!.id
  )

  const select = (id: string) => {
    setCurrent(id)
    localStorage.setItem('pi-model', id)
    setIsOpen(false)
    // Send /model command to switch
    if (window.electronAPI) {
      window.electronAPI.sendMessage(`/model ${id}`)
    }
  }

  return (
    <>
      <button
        className="context-pill"
        onClick={() => setIsOpen(true)}
        title="Switch model"
        style={{ gap: 4 }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        {MODELS.find((m) => m.id === current)?.name ?? 'Claude Sonnet 4'}
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🤖 Model</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <ul className="file-list">
                {MODELS.map((m) => (
                  <li
                    key={m.id}
                    className="file-item"
                    style={{
                      cursor: 'pointer',
                      background: m.id === current ? 'var(--accent-dim)' : undefined,
                    }}
                    onClick={() => select(m.id)}
                  >
                    <div className="file-name" style={{ color: m.id === current ? 'var(--accent)' : undefined }}>
                      {m.name}
                    </div>
                    <div className="file-meta">{m.provider}</div>
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
