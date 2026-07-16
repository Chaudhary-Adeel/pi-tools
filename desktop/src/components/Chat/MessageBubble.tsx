import { useState, useEffect, useMemo } from 'react'
import type { Message, TextSegment, ToolCallSegment } from '../../store/useStore'
import ToolCallCard from './ToolCallCard'
import MarkdownText from './MarkdownText'

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
    const match = text.match(/<(think|thought)>/)
    if (!match) {
      if (text.trim()) parts.push({ type: 'normal', content: text })
      break
    }
    
    const startMatch = match.index!
    const tag = match[1]
    const openTag = `<${tag}>`
    const closeTag = `</${tag}>`
    
    if (startMatch > 0) {
      const pre = text.substring(0, startMatch)
      if (pre.trim()) parts.push({ type: 'normal', content: pre })
    }
    
    const endMatch = text.indexOf(closeTag, startMatch)
    if (endMatch === -1) {
      parts.push({ type: 'think', content: text.substring(startMatch + openTag.length), isStreaming: true })
      break
    } else {
      parts.push({ type: 'think', content: text.substring(startMatch + openTag.length, endMatch), isStreaming: false })
      text = text.substring(endMatch + closeTag.length)
    }
  }

  return (
    <>
      {parts.map((p, i) =>
        p.type === 'think' ? (
          <ThinkingAccordion key={i} content={p.content} isStreaming={p.isStreaming} />
        ) : (
          <MarkdownText key={i} content={p.content} />
        )
      )}
    </>
  )
}

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
