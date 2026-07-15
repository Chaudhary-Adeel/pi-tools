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
  const lines = seg.text.split('\n')
  const isCode = lines.length > 1 && (
    lines.some((l) => /^(```|    |\t)/.test(l)) ||
    lines[0]?.startsWith('```')
  )

  if (isCode || seg.text.includes('```')) {
    return <pre className="msg-code"><code>{seg.text}</code></pre>
  }

  return (
    <p className="msg-text">
      {seg.text}
    </p>
  )
}
