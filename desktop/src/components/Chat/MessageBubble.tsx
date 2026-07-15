import type { Message, TextSegment, ToolCallSegment } from '../../store/useStore'
import ToolCallCard from './ToolCallCard'

interface Props {
  message: Message
  isStreaming: boolean
}

export default function MessageBubble({ message, isStreaming }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`message message--${message.role} ${isStreaming ? 'message--streaming' : ''}`}>
      <div className="message-avatar">{isUser ? '👤' : 'π'}</div>
      <div className="message-body">
        {message.segments.map((seg, i) => {
          if (seg.type === 'text') {
            return <TextBlock key={i} seg={seg} />
          }
          if (seg.type === 'tool-call') {
            return <ToolCallCard key={i} seg={seg} />
          }
          return null
        })}
        {isStreaming && message.segments.length === 0 && (
          <span className="streaming-cursor" />
        )}
      </div>
    </div>
  )
}

function TextBlock({ seg }: { seg: TextSegment }) {
  // Parse out <think> blocks (handles streaming gracefully)
  const parts: { type: 'normal' | 'think'; content: string; isStreaming?: boolean }[] = []
  let text = seg.text

  while (text) {
    const startMatch = text.indexOf('<think>')
    if (startMatch === -1) {
      if (text.trim()) parts.push({ type: 'normal', content: text })
      break
    }
    
    // Push everything before <think>
    if (startMatch > 0) {
      const pre = text.substring(0, startMatch)
      if (pre.trim()) parts.push({ type: 'normal', content: pre })
    }
    
    const endMatch = text.indexOf('</think>', startMatch)
    if (endMatch === -1) {
      // Streaming thinking block
      parts.push({ type: 'think', content: text.substring(startMatch + 7), isStreaming: true })
      break
    } else {
      // Complete thinking block
      parts.push({ type: 'think', content: text.substring(startMatch + 7, endMatch), isStreaming: false })
      text = text.substring(endMatch + 8)
    }
  }

  return (
    <>
      {parts.map((p, i) =>
        p.type === 'think' ? (
          <ThinkingAccordion key={i} content={p.content} isStreaming={p.isStreaming} />
        ) : (
          <NormalText key={i} content={p.content} />
        )
      )}
    </>
  )
}

function NormalText({ content }: { content: string }) {
  const lines = content.trim().split('\n')
  const isCode = lines.length > 1 && (
    lines.some((l) => /^(```|    |\t)/.test(l)) ||
    lines[0]?.startsWith('```')
  )

  if (isCode || content.includes('```')) {
    return <pre className="msg-code"><code>{content}</code></pre>
  }

  return <p className="msg-text">{content}</p>
}

import { useState, useEffect } from 'react'

function ThinkingAccordion({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [isOpen, setIsOpen] = useState(true)

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (!isStreaming) {
      setIsOpen(false)
    }
  }, [isStreaming])

  return (
    <div className="think-accordion">
      <button className="think-header" onClick={() => setIsOpen(!isOpen)}>
        <span className={`think-chevron ${isOpen ? 'think-chevron--open' : ''}`}>▶</span>
        <span className="think-title">
          {isStreaming ? 'Thinking...' : 'Thought process'}
        </span>
        {isStreaming && (
          <span className="tool-spinner" style={{ marginLeft: 6, opacity: 0.6 }} />
        )}
      </button>
      
      {isOpen && (
        <div className="think-body">
          {content.trim()}
          {isStreaming && <span className="streaming-cursor" />}
        </div>
      )}
    </div>
  )
}
