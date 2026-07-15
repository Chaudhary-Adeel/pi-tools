import { useStore } from '../store/useStore'

export default function WelcomeScreen() {
  const setProject = useStore((s) => s.setProject)

  const handleOpen = async () => {
    const folder = await window.electronAPI.openFolder()
    if (folder) setProject(folder)
  }

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-logo">π</div>
        <h1 className="welcome-title">Pi Tools Desktop</h1>
        <p className="welcome-subtitle">
          A polished interface for the Pi coding agent with memory, subagent observability,
          and context management.
        </p>

        <div className="welcome-features">
          {[
            { icon: '💬', label: 'Chat', desc: 'Stream Pi responses with collapsible tool cards' },
            { icon: '🧠', label: 'Memory', desc: 'Live memory dashboard with token budget gauge' },
            { icon: '🤖', label: 'Subagents', desc: 'Inspect parallel subagent runs in real time' },
            { icon: '⚡', label: 'CVM', desc: 'Context Virtual Memory stats and controls' },
          ].map((f) => (
            <div key={f.label} className="welcome-feature">
              <span className="welcome-feature-icon">{f.icon}</span>
              <div>
                <div className="welcome-feature-label">{f.label}</div>
                <div className="welcome-feature-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <button className="btn-primary btn-lg" onClick={handleOpen}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Open Project Folder
        </button>

        <p className="welcome-hint">
          Requires <code>pi</code> installed on your PATH.{' '}
          <a href="https://pi.dev" target="_blank" rel="noreferrer">pi.dev →</a>
        </p>
      </div>
    </div>
  )
}
