import { useEffect } from 'react'
import { useStore } from '../../store/useStore'

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function formatNum(n: number): string {
  return n.toLocaleString()
}

export default function CvmPanel() {
  const projectPath = useStore((s) => s.projectPath)
  const stats = useStore((s) => s.cvmStats)
  const setStats = useStore((s) => s.setCvmStats)
  const piStatus = useStore((s) => s.piStatus)

  useEffect(() => {
    if (!projectPath || !window.electronAPI) return
    window.electronAPI!.getCvmStats().then(setStats)
    const interval = setInterval(() => {
      window.electronAPI!.getCvmStats().then(setStats)
    }, 5000)
    return () => clearInterval(interval)
  }, [projectPath])

  const runCommand = (cmd: string) => {
    if (piStatus !== 'idle' || !window.electronAPI) return
    window.electronAPI.sendMessage(cmd)
  }

  if (!projectPath) {
    return (
      <div className="panel-empty">
        <p>No project open.</p>
        <p className="panel-hint">Open a project to see CVM stats.</p>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="panel">
        <div className="panel-section">
          <div className="panel-section-title">⚡ Context Virtual Memory</div>
          <div className="panel-empty-inline">
            <p>No CVM data yet. The cache initializes on first use.</p>
            <p className="panel-hint">
              Run <code>/cvm index</code> to build the symbol index.
            </p>
          </div>
        </div>
        <div className="panel-actions panel-actions--col">
          <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm index')}>
            /cvm index — Build index
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      {/* Storage tiers */}
      <div className="panel-section">
        <div className="panel-section-title">📦 Storage Tiers</div>

        <div className="panel-row">
          <span className="panel-label">Warm store (SQLite)</span>
          <span className="panel-value">{formatBytes(stats.warmStoreSize)}</span>
        </div>

        <div className="panel-row">
          <span className="panel-label">Cold objects</span>
          <span className="panel-value">
            {stats.coldObjectCount} files · {formatBytes(stats.coldBytesTotal)}
          </span>
        </div>

        <div className="panel-row">
          <span className="panel-label">Symbol index</span>
          <span className="panel-value">
            {formatNum(stats.symbolIndexSize)} symbols · {stats.indexFileCount} files
          </span>
        </div>
      </div>

      {/* Session delta */}
      <div className="panel-section">
        <div className="panel-section-title">📊 Session Delta</div>

        <div className="panel-row">
          <span className="panel-label">Stubs served</span>
          <span className="panel-value">{formatNum(stats.deltaStubs)}</span>
        </div>

        <div className="panel-row">
          <span className="panel-label">Diffs served</span>
          <span className="panel-value">{formatNum(stats.deltaDiffs)}</span>
        </div>

        <div className="panel-row">
          <span className="panel-label">Tokens saved</span>
          <span className="panel-value" style={{ color: 'var(--success)' }}>
            ~{formatNum(stats.tokensSaved)}
          </span>
        </div>
      </div>

      {/* Performance */}
      <div className="panel-section">
        <div className="panel-section-title">⚡ Performance</div>

        <div className="panel-row">
          <span className="panel-label">HTTP cache hit</span>
          <span className="panel-value">{Math.round(stats.httpHitRatio * 100)}%</span>
        </div>

        {stats.lastReindex && (
          <div className="panel-row">
            <span className="panel-label">Last reindex</span>
            <span className="panel-value">
              {new Date(stats.lastReindex).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="panel-actions">
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm')}>
          /cvm
        </button>
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm index')}>
          Reindex
        </button>
        <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm gc')}>
          GC
        </button>
      </div>
    </div>
  )
}
