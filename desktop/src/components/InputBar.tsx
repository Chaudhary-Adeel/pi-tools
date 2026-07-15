import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'

export default function InputBar() {
  const [value, setValue] = useState('')
  const piStatus = useStore((s) => s.piStatus)
  const addUserMessage = useStore((s) => s.addUserMessage)
  const appendEvent = useStore((s) => s.appendEvent)
  const projectPath = useStore((s) => s.projectPath)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isRunning = piStatus === 'thinking' || piStatus === 'calling-tool'

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [value])

  const send = async () => {
    const text = value.trim()
    if (!text || isRunning || !projectPath || !window.electronAPI) return
    setValue('')
    addUserMessage(text)
    const result = await window.electronAPI.sendMessage(text)
    if (result.error) {
      appendEvent({ kind: 'error', text: result.error })
    }
  }

  const abort = () => window.electronAPI?.abort()

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="input-bar">
      <div className="input-bar-inner">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            !projectPath
              ? 'Open a project folder first…'
              : isRunning
              ? 'Pi is running…'
              : 'Message Pi… (Shift+Enter for new line)'
          }
          disabled={!projectPath}
          rows={1}
          aria-label="Message input"
        />

        {isRunning ? (
          <button className="send-btn send-btn--abort" onClick={abort} aria-label="Stop">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className={`send-btn ${value.trim() ? 'send-btn--active' : ''}`}
            onClick={send}
            disabled={!value.trim() || !projectPath}
            aria-label="Send message"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        )}
      </div>
      <div className="input-hint">
        <span>Enter to send · Shift+Enter for new line</span>
        {isRunning && <span className="input-status">Pi is {piStatus === 'calling-tool' ? 'calling a tool' : 'thinking'}…</span>}
      </div>
    </div>
  )
}
