import { useEffect, useRef } from 'react'
import { useStore } from '../../store/useStore'
import MessageBubble from './MessageBubble'
import ThinkingDot from './ThinkingDot'

export default function ChatPanel() {
  const messages = useStore((s) => s.messages)
  const piStatus = useStore((s) => s.piStatus)
  const activeId = useStore((s) => s.activeAssistantId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  // Auto-scroll unless the user scrolled up manually
  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const scrollTickRef = useRef<number | null>(null)
  const handleScroll = () => {
    if (scrollTickRef.current) return
    scrollTickRef.current = requestAnimationFrame(() => {
      scrollTickRef.current = null
      const el = containerRef.current
      if (!el) return
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      userScrolledUp.current = distFromBottom > 100
    })
  }

  const scrollToBottom = () => {
    userScrolledUp.current = false
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const isThinking = piStatus === 'thinking' || piStatus === 'calling-tool'

  return (
    <div className="chat-panel" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div className="chat-empty">
          <div className="chat-empty-icon">π</div>
          <p>Start a conversation. Pi will use your project memory for context.</p>
        </div>
      )}

      <div className="messages">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} isStreaming={msg.id === activeId} />
        ))}

        {isThinking && activeId === null && (
          <div className="message message--assistant">
            <div className="message-avatar">π</div>
            <div className="message-body">
              <ThinkingDot />
            </div>
          </div>
        )}
      </div>

      <div ref={bottomRef} />

      {userScrolledUp.current && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} aria-label="Scroll to bottom">
          ↓
        </button>
      )}
    </div>
  )
}
