export default function SubagentsPanel() {
  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-section-title">🤖 Subagent Runs</div>
        <div className="panel-empty-inline">
          <p>Subagent runs will appear here when you use <code>spawn_subagents</code> or <code>/newTask</code>.</p>
          <p className="panel-hint">Inspect full prompts and activity traces via the <code>/subagents</code> command in chat.</p>
        </div>
      </div>
    </div>
  )
}
