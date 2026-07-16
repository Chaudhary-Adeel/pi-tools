import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useToastStore } from '../store/toastStore'

export default function ExportDialog() {
  const [isOpen, setIsOpen] = useState(false)
  const messages = useStore((s) => s.messages)
  const addToast = useToastStore((s) => s.addToast)

  const exportMarkdown = () => {
    const md = messages
      .map((m) => {
        const role = m.role === 'user' ? '**You**' : '**Pi**'
        const text = m.segments
          .map((seg) => {
            if (seg.type === 'text') return seg.text
            if (seg.type === 'tool-call') {
              return `> 🔧 \`${seg.tool}\` ${seg.args} ${(seg as any).status === 'ok' ? '✓' : (seg as any).status === 'error' ? '✗' : '…'}`
            }
            return ''
          })
          .join('\n\n')
        return `${role}\n\n${text}`
      })
      .join('\n\n---\n\n')

    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pi-chat-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
    addToast('Conversation exported as Markdown', 'success')
    setIsOpen(false)
  }

  return (
    <>
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        disabled={messages.length === 0}
        title="Export conversation"
        aria-label="Export"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Export
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">📤 Export Conversation</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p>Export the current conversation ({messages.length} messages) as:</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                <button className="btn-secondary" onClick={exportMarkdown}>
                  Markdown (.md)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
