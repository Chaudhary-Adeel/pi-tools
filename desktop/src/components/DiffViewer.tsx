import { useState } from 'react'

interface Props {
  isOpen: boolean
  filename: string
  diff: string | null
  onClose: () => void
}

export default function DiffViewer({ isOpen, filename, diff, onClose }: Props) {
  if (!isOpen) return null

  const lines = diff?.split('\n') ?? []

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📄 Diff: {filename}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 0, maxHeight: '60vh', overflow: 'auto' }}>
          {!diff ? (
            <p style={{ padding: 24, color: 'var(--text-muted)' }}>No changes found.</p>
          ) : (
            <pre className="diff-view" style={{
              margin: 0,
              padding: '12px 16px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11.5,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              {lines.map((line, i) => {
                let cls = ''
                if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add'
                else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-del'
                else if (line.startsWith('@@')) cls = 'diff-hunk'

                return (
                  <div
                    key={i}
                    className={cls}
                    style={{
                      background: cls === 'diff-add' ? 'rgba(63,185,80,0.15)'
                        : cls === 'diff-del' ? 'rgba(248,81,73,0.15)'
                        : cls === 'diff-hunk' ? 'rgba(124,92,252,0.1)'
                        : 'transparent',
                      paddingLeft: 4,
                    }}
                  >
                    {line || ' '}
                  </div>
                )
              })}
            </pre>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
