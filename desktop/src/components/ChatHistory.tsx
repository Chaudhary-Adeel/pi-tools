import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../store/useStore'
import type { Message } from '../store/useStore'

function saveHistory(projectPath: string, messages: Message[]) {
  try {
    const key = `pi-chat-${btoa(projectPath)}`
    localStorage.setItem(key, JSON.stringify(messages.slice(-200))) // Keep last 200
  } catch { /* storage full */ }
}

function loadHistory(projectPath: string): Message[] {
  try {
    const key = `pi-chat-${btoa(projectPath)}`
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export default function ChatHistory() {
  const projectPath = useStore((s) => s.projectPath)
  const messages = useStore((s) => s.messages)
  const clearMessages = useStore((s) => s.clearMessages)
  const [storedMessages, setStoredMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)

  // Load history on project change
  useEffect(() => {
    if (projectPath) {
      setStoredMessages(loadHistory(projectPath))
    }
  }, [projectPath])

  // Save history when messages change
  useEffect(() => {
    if (projectPath && messages.length > 0) {
      saveHistory(projectPath, messages)
      setStoredMessages(loadHistory(projectPath))
    }
  }, [messages, projectPath])

  const filtered = useMemo(() => {
    if (!search.trim()) return storedMessages.slice(-50)
    const q = search.toLowerCase()
    return storedMessages
      .filter((m) =>
        m.segments.some((seg) =>
          seg.type === 'text'
            ? seg.text.toLowerCase().includes(q)
            : 'tool' in seg ? seg.tool.toLowerCase().includes(q) : false
        )
      )
      .slice(-50)
  }, [storedMessages, search])

  const handleLoad = (msg: Message) => {
    // Copy message text to clipboard for reuse
    const text = msg.segments
      .filter((s) => s.type === 'text')
      .map((s) => s.text)
      .join('\n')
    if (text) {
      navigator.clipboard.writeText(text).catch(() => {})
    }
  }

  if (!showSearch) {
    return (
      <button
        className="context-action"
        onClick={() => setShowSearch(true)}
        title="Search chat history"
        aria-label="Search history"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        History
      </button>
    )
  }

  return (
    <div className="modal-overlay" onClick={() => setShowSearch(false)}>
      <div className="modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">💬 Chat History</span>
          <button className="modal-close" onClick={() => setShowSearch(false)}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 12 }}>
          <input
            className="config-input"
            placeholder="Search messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{ marginBottom: 12 }}
          />

          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <p className="panel-hint">
                {storedMessages.length === 0
                  ? 'No chat history yet. Send a message first.'
                  : 'No messages match your search.'}
              </p>
            ) : (
              filtered.map((msg) => (
                <div
                  key={msg.id}
                  className="file-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleLoad(msg)}
                >
                  <div className="file-name" style={{ fontSize: 12 }}>
                    <span style={{ color: msg.role === 'user' ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {msg.role === 'user' ? '👤' : 'π'}
                    </span>{' '}
                    {msg.segments
                      .filter((s) => s.type === 'text')
                      .slice(0, 1)
                      .map((s) => (s as { text: string }).text.slice(0, 80))}
                    {(msg.segments.filter((s) => s.type === 'text').length > 1 || 
                      msg.segments.some((s) => s.type !== 'text')) && '…'}
                  </div>
                  <div className="file-meta">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                    {msg.segments.filter((s) => s.type === 'tool-call').length > 0 &&
                      ` · ${msg.segments.filter((s) => s.type === 'tool-call').length} tools`}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="btn-secondary btn-sm"
            onClick={() => {
              if (projectPath) {
                localStorage.removeItem(`pi-chat-${btoa(projectPath)}`)
                setStoredMessages([])
              }
            }}
            title="Clear stored history"
          >
            Clear History
          </button>
          <button className="btn-secondary btn-sm" onClick={() => setShowSearch(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
