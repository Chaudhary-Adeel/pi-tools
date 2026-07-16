import { useState } from 'react'
import { useStore } from '../store/useStore'

// Subagent presets from pi-tools
const PRESETS = [
  { name: 'auditor', description: 'Audit code for bugs, security issues, and anti-patterns' },
  { name: 'tester', description: 'Write and run tests for existing code' },
  { name: 'docs', description: 'Write documentation, READMEs, and API docs' },
  { name: 'refactor', description: 'Refactor code for readability and maintainability' },
  { name: 'researcher', description: 'Research a topic and report findings' },
]

export default function AgentPresets() {
  const [isOpen, setIsOpen] = useState(false)
  const piStatus = useStore((s) => s.piStatus)

  const launch = (preset: string) => {
    if (!window.electronAPI || piStatus !== 'idle') return
    window.electronAPI.sendMessage(`/newTask ${preset}: `)
    setIsOpen(false)
  }

  return (
    <>
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        disabled={piStatus !== 'idle'}
        title="Launch subagent preset"
        aria-label="Agent presets"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Agents
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🤖 Agent Presets</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="panel-hint" style={{ marginBottom: 12 }}>
                Launch a subagent with a preset role. The agent will run in a subprocess.
              </p>
              <ul className="file-list">
                {PRESETS.map((p) => (
                  <li
                    key={p.name}
                    className="file-item"
                    style={{ cursor: 'pointer' }}
                    onClick={() => launch(p.name)}
                  >
                    <div className="file-name" style={{ color: 'var(--accent)' }}>
                      /newTask {p.name}:
                    </div>
                    <div className="file-desc">{p.description}</div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary btn-sm" onClick={() => setIsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
