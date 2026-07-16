import { useState } from 'react'

const TEMPLATES = [
  { name: 'Code Review', prompt: 'Review the following code for bugs, security issues, and code quality. Suggest improvements:\n\n' },
  { name: 'Write Tests', prompt: 'Write comprehensive tests for the following code. Cover edge cases and error handling:\n\n' },
  { name: 'Explain Code', prompt: 'Explain what this code does in detail:\n\n' },
  { name: 'Refactor', prompt: 'Refactor this code to improve readability, performance, and maintainability. Preserve all existing behavior:\n\n' },
  { name: 'Debug', prompt: 'Debug this issue. Here is the error and relevant code:\n\n' },
  { name: 'Document', prompt: 'Write clear documentation (JSDoc/TSDoc) for this code:\n\n' },
  { name: 'Fix TypeScript', prompt: 'Fix all TypeScript errors and improve type safety:\n\n' },
  { name: 'Optimize', prompt: 'Optimize this code for performance. Identify bottlenecks and suggest improvements:\n\n' },
]

export default function PromptTemplates() {
  const [isOpen, setIsOpen] = useState(false)

  const apply = (prompt: string) => {
    const ta = document.querySelector<HTMLTextAreaElement>('.input-textarea')
    if (ta) {
      ta.value = prompt
      ta.focus()
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setIsOpen(false)
  }

  return (
    <>
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        title="Prompt templates"
        aria-label="Templates"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
        </svg>
        Templates
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">📋 Prompt Templates</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="panel-hint">Click a template to fill the input bar.</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    className="btn-secondary btn-sm"
                    onClick={() => apply(t.prompt)}
                    title={t.prompt.slice(0, 100)}
                  >
                    {t.name}
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
