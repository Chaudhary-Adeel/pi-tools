import { useState, useEffect } from 'react'

interface Props {
  filePath: string
  fileName: string
  onClose: () => void
}

export default function MemoryFileEditor({ filePath, fileName, onClose }: Props) {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.readMemoryFile(filePath).then((c) => {
        setContent(c ?? '')
        setOriginal(c ?? '')
        setLoading(false)
      })
    }
  }, [filePath])

  const save = async () => {
    if (!window.electronAPI) return
    setSaving(true)
    // Use write tool through pi
    await window.electronAPI.sendMessage(`write ${filePath}\n${content}`)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const hasChanges = content !== original

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 720, height: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">
            📝 {fileName}
            {hasChanges && <span style={{ color: 'var(--warning)', fontSize: 11, marginLeft: 8 }}>Modified</span>}
          </span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ flex: 1, padding: 0, display: 'flex', flexDirection: 'column' }}>
          {loading ? (
            <p className="panel-hint" style={{ padding: 24 }}>Loading…</p>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{
                flex: 1,
                background: 'var(--bg)',
                color: 'var(--text)',
                border: 'none',
                padding: 16,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12.5,
                resize: 'none',
                outline: 'none',
                lineHeight: 1.6,
              }}
              spellCheck={false}
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary btn-sm" onClick={onClose}>
            {hasChanges ? 'Discard' : 'Close'}
          </button>
          <button
            className="btn-primary btn-sm"
            onClick={save}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving…' : saved ? '✓ Sent' : 'Save via Write'}
          </button>
        </div>
      </div>
    </div>
  )
}
