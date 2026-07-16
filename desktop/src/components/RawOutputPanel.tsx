import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'

export default function RawOutputPanel() {
  const messages = useStore((s) => s.messages)
  const piStatus = useStore((s) => s.piStatus)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)

  // Auto-scroll to bottom
  useEffect(() => {
    if (isVisible) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isVisible])

  // Collapse when idle
  useEffect(() => {
    if (piStatus === 'idle') {
      // Keep visible briefly after completion
      const t = setTimeout(() => setIsVisible(false), 2000)
      return () => clearTimeout(t)
    } else {
      setIsVisible(true)
    }
  }, [piStatus])

  if (!isVisible) return null

  // Render all segments as raw text
  const raw = messages
    .flatMap((m: typeof messages[0]) =>
      m.segments.map((seg: typeof m.segments[0]) => {
        if (seg.type === 'text') return seg.text
        if (seg.type === 'tool-call') {
          const status = (seg as any).status
          return `→ ${seg.tool} ${seg.args} ${status ? (status === 'ok' ? '✓' : '✗') : '…'}`
        }
        return ''
      })
    )
    .filter(Boolean)
    .join('\n')

  return (
    <div className="raw-panel">
      <div className="raw-panel-header">
        <span className="raw-panel-title">📟 Raw Terminal Output</span>
        <button
          className="raw-panel-close"
          onClick={() => setIsVisible(false)}
          aria-label="Close raw output"
        >
          ✕
        </button>
      </div>
      <pre className="raw-panel-body">
        <code>{raw || 'Waiting for output…\n'}</code>
        {piStatus !== 'idle' && <span className="streaming-cursor" />}
        <div ref={bottomRef} />
      </pre>
    </div>
  )
}
