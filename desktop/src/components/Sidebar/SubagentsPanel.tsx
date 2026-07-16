import { useEffect } from 'react'
import { useStore } from '../../store/useStore'
import type { SubagentRunInfo } from '../../../electron/preload'

function formatAge(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function SubagentsPanel() {
  const projectPath = useStore((s) => s.projectPath)
  const runs = useStore((s) => s.subagentRuns)
  const setRuns = useStore((s) => s.setSubagentRuns)
  const piStatus = useStore((s) => s.piStatus)

  // Poll subagent runs every 2s while running
  useEffect(() => {
    if (!projectPath || !window.electronAPI) return
    const load = () => {
      window.electronAPI!.getSubagentRuns().then(setRuns)
    }
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [projectPath])

  const viewTrace = async (runId: string) => {
    if (!window.electronAPI) return
    const trace = await window.electronAPI.getSubagentTrace(runId)
    if (trace) {
      // Show trace in chat as a command result
      window.electronAPI.sendMessage(`/subagents ${runId}`)
    }
  }

  if (!projectPath) {
    return (
      <div className="panel-empty">
        <p>No project open.</p>
        <p className="panel-hint">Open a project to see subagent runs.</p>
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="panel">
        <div className="panel-section">
          <div className="panel-section-title">🤖 Subagent Runs</div>
          <div className="panel-empty-inline">
            <p>No subagent runs yet.</p>
            <p className="panel-hint">
              Subagents spawn when the agent uses <code>spawn_subagents</code> or{' '}
              <code>/newTask</code>.
            </p>
          </div>
        </div>
        <div className="panel-section">
          <div className="panel-section-title">Launch Subagent</div>
          <div className="panel-actions panel-actions--col">
            <button
              className="btn-secondary btn-sm"
              onClick={() => window.electronAPI?.sendMessage('/newTask ')}
              disabled={piStatus !== 'idle'}
              title="Spawn a new background task"
            >
              /newTask — Spawn task
            </button>
            <button
              className="btn-secondary btn-sm"
              onClick={() => window.electronAPI?.sendMessage('/agents')}
              disabled={piStatus !== 'idle'}
              title="List agent presets"
            >
              /agents — List presets
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">
          🤖 Subagent Runs{' '}
          <span className="panel-count">({runs.length})</span>
        </div>
      </div>

      <div className="panel-section">
        <ul className="file-list">
          {runs.map((run) => (
            <SubagentRunCard key={run.runId} run={run} onView={viewTrace} />
          ))}
        </ul>
      </div>

      <div className="panel-actions">
        <button
          className="btn-secondary btn-sm"
          onClick={() => window.electronAPI?.sendMessage('/subagents')}
          disabled={piStatus !== 'idle'}
        >
          /subagents — Full report
        </button>
      </div>
    </div>
  )
}

function SubagentRunCard({ run, onView }: { run: SubagentRunInfo; onView: (id: string) => void }) {
  const statusIcon = run.status === 'running' ? '🔄' : run.status === 'error' ? '❌' : '✅'
  const statusClass = `subagent-status subagent-status--${run.status}`

  return (
    <li className="file-item" style={{ cursor: 'pointer' }} onClick={() => onView(run.runId)}>
      <div className="file-name">
        <span className={statusClass}>{statusIcon}</span>{' '}
        {run.runId.slice(0, 8)}…
      </div>
      <div className="file-meta">
        {run.status} · {formatAge(run.createdAt)}
        {run.tokensUsed !== undefined && ` · ${run.tokensUsed.toLocaleString()} tokens`}
      </div>
    </li>
  )
}
