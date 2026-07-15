import { useStore } from '../../store/useStore'

export default function CvmPanel() {
  const piStatus = useStore((s) => s.piStatus)
  const runCommand = (cmd: string) => {
    if (piStatus !== 'idle') return
    window.electronAPI.sendMessage(cmd)
  }

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">⚡ Context Virtual Memory</div>
        <p className="panel-hint">
          CVM stats (tokens saved, cache hit ratios, symbol index size) are reported via the{' '}
          <code>/cvm</code> command in chat.
        </p>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Actions</div>
        <div className="panel-actions panel-actions--col">
          <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm')} title="Show CVM stats">
            /cvm — Stats
          </button>
          <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm index')} title="Force reindex">
            /cvm index — Force reindex
          </button>
          <button className="btn-secondary btn-sm" onClick={() => runCommand('/cvm gc')} title="Reclaim stale cache">
            /cvm gc — Reclaim cache
          </button>
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Storage</div>
        <p className="panel-hint">
          Cache lives in <code>.pi/cvm/</code>. Safe to delete — it rebuilds incrementally.
        </p>
      </div>
    </div>
  )
}
