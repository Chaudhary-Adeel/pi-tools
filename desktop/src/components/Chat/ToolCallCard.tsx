import { useState } from 'react'
import type { ToolCallSegment } from '../../store/useStore'

const TOOL_ICONS: Record<string, string> = {
  web_fetch: '🌐',
  web_search: '🔍',
  read_file: '📄',
  grep_search: '🔎',
  glob_files: '📁',
  bash: '💻',
  edit: '✏️',
  write: '📝',
  spawn_subagents: '🤖',
  browser_navigate: '🌍',
  browser_screenshot: '📸',
  browser_click: '🖱️',
  github_explore: '🐙',
  memory_map: '🧠',
  memory_search: '🔮',
  context_resolve: '⚡',
  code_references: '🔗',
  tasks: '✅',
  ask_user: '💬',
}

interface Props {
  seg: ToolCallSegment
}

export default function ToolCallCard({ seg }: Props) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[seg.tool] ?? '🔧'
  const isPending = !seg.status
  const isError = seg.status === 'error'

  return (
    <div
      className={`tool-card ${isError ? 'tool-card--error' : ''} ${isPending ? 'tool-card--pending' : ''}`}
    >
      <button className="tool-card-header" onClick={() => setExpanded((v) => !v)}>
        <span className="tool-card-icon">{icon}</span>
        <span className="tool-card-name">{seg.tool}</span>
        {seg.args && <span className="tool-card-args">{seg.args.slice(0, 60)}{seg.args.length > 60 ? '…' : ''}</span>}
        <span className="tool-card-status">
          {isPending ? (
            <span className="tool-spinner" />
          ) : isError ? (
            <span className="tool-status-err">✗</span>
          ) : (
            <span className="tool-status-ok">✓</span>
          )}
        </span>
        <span className="tool-card-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (seg.summary || seg.args) && (
        <div className="tool-card-body">
          {seg.summary && <div className="tool-result-text">{seg.summary}</div>}
          {seg.args && !seg.summary && <div className="tool-args-full">{seg.args}</div>}
        </div>
      )}
    </div>
  )
}
