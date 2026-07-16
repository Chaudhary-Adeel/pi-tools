import { useStore } from '../../store/useStore'
import { useState } from 'react'
import MemoryFileEditor from '../MemoryFileEditor'

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function formatAge(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const BUDGET = 4000 // default token budget

export default function MemoryPanel() {
  const memory = useStore((s) => s.memory)
  const piStatus = useStore((s) => s.piStatus)
  const projectPath = useStore((s) => s.projectPath)
  const [editingFile, setEditingFile] = useState<{ path: string; name: string } | null>(null)

  const runCommand = (cmd: string) => {
    if (piStatus !== 'idle' || !window.electronAPI) return
    window.electronAPI.sendMessage(cmd)
  }

  if (!memory) {
    return (
      <div className="panel-empty">
        <p>No memory loaded.</p>
        <p className="panel-hint">Open a project to see its Pi memory.</p>
      </div>
    )
  }

  if (!memory.hasMemory) {
    return (
      <div className="panel-empty">
        <p>No <code>.pi/memory/</code> found.</p>
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/init')}>
          /init — Bootstrap memory
        </button>
      </div>
    )
  }

  // Estimate tokens
  const systemTokens = memory.systemFiles.reduce((s, f) => s + Math.ceil(f.size / 4), 0)
  const totalTokens = systemTokens + memory.learningFiles.reduce((s, f) => s + Math.ceil(f.size / 4), 0)
  const budgetPct = Math.min(100, (systemTokens / BUDGET) * 100)
  const budgetColor = budgetPct < 60 ? 'var(--success)' : budgetPct < 85 ? 'var(--warning)' : 'var(--error)'

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-row">
          <span className="panel-label">Token budget</span>
          <span className="panel-value" style={{ color: budgetColor }}>
            ~{systemTokens.toLocaleString()} / {BUDGET.toLocaleString()}
          </span>
        </div>
        <div className="budget-bar">
          <div
            className="budget-bar-fill"
            style={{ width: `${budgetPct}%`, background: budgetColor }}
          />
        </div>
        <div className="panel-row" style={{ marginTop: 4 }}>
          <span className="panel-hint">{budgetPct.toFixed(0)}% of budget used by system files</span>
          <span className="panel-hint">{formatBytes(memory.systemFiles.reduce((s, f) => s + f.size, 0) + memory.learningFiles.reduce((s, f) => s + f.size, 0))} total</span>
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">
          🧠 System Memory <span className="panel-count">({memory.systemFiles.length})</span>
        </div>
        {memory.systemFiles.length === 0 ? (
          <p className="panel-hint">No system files yet.</p>
        ) : (
          <ul className="file-list">
            {memory.systemFiles.map((f) => (
              <li
                key={f.path}
                className="file-item"
                style={{ cursor: 'pointer' }}
                onClick={() => setEditingFile({
                  path: (projectPath ?? '') + '/' + f.path,
                  name: f.name,
                })}
                title="Click to edit"
              >
                <div className="file-name">{f.name}</div>
                {f.description && <div className="file-desc">{f.description}</div>}
                <div className="file-meta">{formatBytes(f.size)} · {formatAge(f.modified)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-section">
        <div className="panel-section-title">
          📚 Learnings <span className="panel-count">({memory.learningFiles.length})</span>
        </div>
        {memory.learningFiles.length === 0 ? (
          <p className="panel-hint">No learnings yet. Run <code>/learn</code> after a session.</p>
        ) : (
          <ul className="file-list">
            {memory.learningFiles.map((f) => (
              <li
                key={f.path}
                className="file-item"
                style={{ cursor: 'pointer' }}
                onClick={() => setEditingFile({
                  path: (projectPath ?? '') + '/' + f.path,
                  name: f.name,
                })}
                title="Click to edit"
              >
                <div className="file-name">{f.name}</div>
                {f.description && <div className="file-desc">{f.description}</div>}
                <div className="file-meta">{formatBytes(f.size)} · {formatAge(f.modified)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-actions">
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/learn')} title="Distill session into learnings">/learn</button>
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/doctor')} title="Memory health audit">/doctor</button>
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/heal')} title="Heal memory">/heal</button>
      </div>

      {editingFile && (
        <MemoryFileEditor
          filePath={editingFile.path}
          fileName={editingFile.name}
          onClose={() => setEditingFile(null)}
        />
      )}
    </div>
  )
}
