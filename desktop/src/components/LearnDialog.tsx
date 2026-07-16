import { useState } from 'react'
import { useStore } from '../store/useStore'

export default function LearnDialog() {
  const [isOpen, setIsOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const piStatus = useStore((s) => s.piStatus)

  const trigger = async () => {
    if (!window.electronAPI) return
    setRunning(true)
    setResult(null)
    try {
      const res = await window.electronAPI.triggerLearn()
      if (res.error) {
        setResult(`Error: ${res.error}`)
      } else {
        setResult('Learnings distilled successfully. Check the Memory panel for new files.')
      }
    } catch (err: any) {
      setResult(`Error: ${err.message}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <button
        className="context-action"
        onClick={() => setIsOpen(true)}
        disabled={piStatus !== 'idle'}
        title="Distill session into learnings"
        aria-label="Learn from session"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        Learn
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">📚 Distill Session into Learnings</span>
              <button className="modal-close" onClick={() => setIsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p>
                Pi will analyze this session and create learning files in{' '}
                <code>.pi/memory/learnings/</code>.
              </p>
              <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                <li>Patterns and conventions discovered</li>
                <li>Architectural decisions made</li>
                <li>Recurring issues and fixes</li>
              </ul>

              {result && (
                <div
                  className={`learn-result ${result.startsWith('Error') ? 'learn-result--error' : 'learn-result--ok'}`}
                  style={{
                    marginTop: 12,
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: result.startsWith('Error') ? 'rgba(248,81,73,0.1)' : 'rgba(63,185,80,0.1)',
                    border: `1px solid ${result.startsWith('Error') ? 'var(--error)' : 'var(--success)'}`,
                    fontSize: 13,
                  }}
                >
                  {result}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary btn-sm" onClick={() => setIsOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary btn-sm"
                onClick={trigger}
                disabled={running}
              >
                {running ? 'Running…' : 'Start /learn'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
