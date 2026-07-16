import { useState, useEffect } from 'react'
import { useStore } from '../../store/useStore'
import DiffViewer from '../DiffViewer'

const GIT_ICONS: Record<string, string> = {
  ' M': '📝',
  ' A': '➕',
  ' D': '🗑️',
  ' R': '🔄',
  '??': '❓',
  'AM': '📝',
}

function parseStatus(output: string): { status: string; file: string }[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim()
      const file = line.slice(3).trim()
      return { status: status || '??', file }
    })
}

export default function GitPanel() {
  const projectPath = useStore((s) => s.projectPath)
  const piStatus = useStore((s) => s.piStatus)
  const [branch, setBranch] = useState<string | null>(null)
  const [status, setStatus] = useState<{ status: string; file: string }[]>([])
  const [staged, setStaged] = useState<{ status: string; file: string }[]>([])
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [showStagedDiff, setShowStagedDiff] = useState(false)
  const [stagedDiff, setStagedDiff] = useState<string | null>(null)

  const refresh = async () => {
    if (!projectPath || !window.electronAPI) return
    // Use existing pi:send to run git commands
    // For the panel we simulate — in production add git:branch and git:status IPC
    try {
      // Check if git repo exists by trying a simple command
      // We use the existing chat mechanism for heavy git ops
    } catch { /* not a git repo */ }
  }

  useEffect(() => {
    refresh()
  }, [projectPath])

  const viewDiff = async (file: string) => {
    if (!window.electronAPI) return
    const diff = await window.electronAPI.gitDiff(file)
    setDiffFile(file)
    setDiffContent(diff)
  }

  const viewStaged = async () => {
    if (!window.electronAPI) return
    const diff = await window.electronAPI.gitDiffStaged()
    setStagedDiff(diff)
    setShowStagedDiff(true)
  }

  const stageFile = (file: string) => {
    if (!window.electronAPI || piStatus !== 'idle') return
    window.electronAPI.sendMessage(`git add "${file}"`)
  }

  const unstageFile = (file: string) => {
    if (!window.electronAPI || piStatus !== 'idle') return
    window.electronAPI.sendMessage(`git restore --staged "${file}"`)
  }

  if (!projectPath) {
    return (
      <div className="panel-empty">
        <p>No project open.</p>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">🔀 Git</div>
        {branch && (
          <div className="panel-row">
            <span className="panel-label">Branch</span>
            <span className="panel-value" style={{ color: 'var(--accent)' }}>
              {branch}
            </span>
          </div>
        )}
      </div>

      {/* Staged changes */}
      {staged.length > 0 && (
        <div className="panel-section">
          <div className="panel-section-title">
            ✅ Staged <span className="panel-count">({staged.length})</span>
          </div>
          <ul className="file-list">
            {staged.map((f) => (
              <li key={f.file} className="file-item" style={{ cursor: 'pointer' }}>
                <div className="file-name">
                  {GIT_ICONS[f.status] ?? '📄'} {f.file}
                </div>
                <div className="file-meta" onClick={() => unstageFile(f.file)}>
                  Click to unstage
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Unstaged changes */}
      {status.length > 0 && (
        <div className="panel-section">
          <div className="panel-section-title">
            📝 Changes <span className="panel-count">({status.length})</span>
          </div>
          <ul className="file-list">
            {status.map((f) => (
              <li key={f.file} className="file-item" style={{ cursor: 'pointer' }}>
                <div className="file-name" onClick={() => viewDiff(f.file)}>
                  {GIT_ICONS[f.status] ?? '📄'} {f.file}
                </div>
                <div className="file-meta">
                  <span onClick={() => stageFile(f.file)} style={{ cursor: 'pointer', color: 'var(--accent)' }}>
                    Stage
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.length === 0 && staged.length === 0 && (
        <div className="panel-section">
          <p className="panel-hint">No changes detected.</p>
          <p className="panel-hint">Run <code>git status</code> in chat to refresh.</p>
        </div>
      )}

      {/* Actions */}
      <div className="panel-actions">
        <button
          className="btn-secondary btn-sm"
          onClick={() => window.electronAPI?.sendMessage('git status')}
          disabled={piStatus !== 'idle'}
        >
          git status
        </button>
        {(status.length > 0 || staged.length > 0) && (
          <button className="btn-secondary btn-sm" onClick={viewStaged}>
            View diff
          </button>
        )}
      </div>

      {/* Diff viewer modals */}
      {diffFile && (
        <DiffViewer
          isOpen={true}
          filename={diffFile}
          diff={diffContent}
          onClose={() => { setDiffFile(null); setDiffContent(null) }}
        />
      )}

      {showStagedDiff && (
        <DiffViewer
          isOpen={true}
          filename="Staged changes"
          diff={stagedDiff}
          onClose={() => { setShowStagedDiff(false); setStagedDiff(null) }}
        />
      )}
    </div>
  )
}
