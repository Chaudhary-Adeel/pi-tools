import { useState, useEffect } from 'react'
import { useStore } from '../../store/useStore'

interface Config {
  gitName?: string
  gitEmail?: string
  greetingName?: string
  subagentModel?: string
  autoDelegate?: boolean
  memoryHealth?: boolean
  quietOutput?: boolean
}

export default function ConfigPanel() {
  const projectPath = useStore((s) => s.projectPath)
  const [config, setConfig] = useState<Config>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (projectPath && window.electronAPI) {
      window.electronAPI.getConfig().then((c) => setConfig(c as Config))
    }
  }, [projectPath])

  const set = (key: keyof Config, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const save = async () => {
    if (!window.electronAPI) return
    setSaving(true)
    for (const [key, value] of Object.entries(config)) {
      await window.electronAPI.setConfig(key, value)
    }
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">⚙️ pi-tools Config</div>
        <p className="panel-hint">Saved to <code>.pi/pi-tools.json</code></p>
      </div>

      <div className="panel-section">
        <div className="config-group">
          <label className="config-label">Git Name</label>
          <input
            className="config-input"
            value={config.gitName ?? ''}
            placeholder="adeel.bot"
            onChange={(e) => set('gitName', e.target.value)}
          />
        </div>
        <div className="config-group">
          <label className="config-label">Git Email</label>
          <input
            className="config-input"
            value={config.gitEmail ?? ''}
            placeholder="bot@example.com"
            onChange={(e) => set('gitEmail', e.target.value)}
          />
        </div>
        <div className="config-group">
          <label className="config-label">Greeting Name</label>
          <input
            className="config-input"
            value={config.greetingName ?? ''}
            placeholder="Your name"
            onChange={(e) => set('greetingName', e.target.value)}
          />
        </div>
        <div className="config-group">
          <label className="config-label">Subagent Model</label>
          <input
            className="config-input"
            value={config.subagentModel ?? ''}
            placeholder="inherit (same as main)"
            onChange={(e) => set('subagentModel', e.target.value)}
          />
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Toggles</div>
        {(
          [
            { key: 'autoDelegate', label: 'Auto-delegate (behavioral harness)' },
            { key: 'memoryHealth', label: 'Memory Health Engine' },
            { key: 'quietOutput', label: 'Quiet Output (compact tool output)' },
          ] as { key: keyof Config; label: string }[]
        ).map(({ key, label }) => (
          <label key={key} className="config-toggle">
            <input
              type="checkbox"
              checked={config[key] !== false}
              onChange={(e) => set(key, e.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div className="panel-actions">
        <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
