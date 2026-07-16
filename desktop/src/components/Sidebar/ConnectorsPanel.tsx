import { useEffect } from 'react'
import { useStore } from '../../store/useStore'

export default function ConnectorsPanel() {
  const connectors = useStore((s) => s.connectors)
  const setConnectors = useStore((s) => s.setConnectors)

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI!.getConnectors().then(setConnectors)
    }
  }, [])

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">🔌 Connectors</div>
        <p className="panel-hint">
          External systems pi-tools can interact with.
        </p>
      </div>

      <div className="panel-section">
        {connectors.length === 0 ? (
          <p className="panel-hint">Loading connectors…</p>
        ) : (
          <ul className="file-list">
            {connectors.map((c) => (
              <li key={c.name} className="file-item">
                <div className="file-name">
                  <span
                    className={`connector-dot ${c.available ? 'connector-dot--ok' : 'connector-dot--missing'}`}
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      marginRight: 8,
                      background: c.available ? 'var(--success)' : 'var(--error)',
                    }}
                  />
                  {c.name}
                </div>
                <div className="file-desc">{c.what}</div>
                {c.needs && (
                  <div className="file-meta" style={{ color: c.available ? 'var(--text-muted)' : 'var(--error)' }}>
                    {c.available ? '✓ ' : '✗ Needs: '}{c.needs}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Setup</div>
        <p className="panel-hint">
          Run <code>/connectors</code> in chat for full setup instructions.
        </p>
      </div>
    </div>
  )
}
