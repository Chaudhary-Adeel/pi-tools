import { useState } from 'react'
import { useStore } from '../store/useStore'

export default function FirstRunWizard() {
  const [step, setStep] = useState(0)
  const setProject = useStore((s) => s.setProject)
  const piFound = useStore((s) => s.piFound)

  const steps = [
    {
      title: 'Welcome to Pi Tools Desktop',
      body: (
        <div>
          <p>A polished interface for the Pi coding agent with memory, subagent observability, and context management.</p>
        </div>
      ),
    },
    {
      title: '1. Check Pi Installation',
      body: (
        <div>
          {piFound ? (
            <p style={{ color: 'var(--success)' }}>✅ Pi found on your PATH. Ready to go!</p>
          ) : (
            <div>
              <p style={{ color: 'var(--error)' }}>❌ Pi not found on PATH.</p>
              <p style={{ marginTop: 8 }}>
                Install Pi from{' '}
                <a href="https://pi.dev" target="_blank" rel="noreferrer">pi.dev</a>
              </p>
            </div>
          )}
        </div>
      ),
    },
    {
      title: '2. Open a Project',
      body: (
        <div>
          <p>Open a project folder to get started. Pi will use your project's <code>.pi/</code> memory for context.</p>
          <button
            className="btn-primary btn-lg"
            style={{ marginTop: 12 }}
            onClick={async () => {
              if (window.electronAPI) {
                const folder = await window.electronAPI.openFolder()
                if (folder) setProject(folder)
              }
            }}
          >
            Open Project Folder
          </button>
        </div>
      ),
    },
    {
      title: '3. Ready!',
      body: (
        <div>
          <p>You're all set. Start a conversation with Pi and explore the sidebar panels:</p>
          <ul style={{ marginTop: 8, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
            <li>🧠 <strong>Memory</strong> — Token budget and memory files</li>
            <li>📁 <strong>Files</strong> — Browse project tree</li>
            <li>🔀 <strong>Git</strong> — Stage, unstage, view diffs</li>
            <li>🤖 <strong>Subagents</strong> — Parallel task monitoring</li>
            <li>✅ <strong>Tasks</strong> — Kanban board</li>
          </ul>
        </div>
      ),
    },
  ]

  if (step >= steps.length) return null

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🚀 {steps[step]!.title}</span>
        </div>
        <div className="modal-body">
          {steps[step]!.body}
        </div>
        <div className="modal-footer">
          {step > 0 && (
            <button className="btn-secondary btn-sm" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          <button
            className="btn-primary btn-sm"
            onClick={() => setStep((s) => s + 1)}
          >
            {step < steps.length - 1 ? 'Next' : 'Get Started'}
          </button>
        </div>
      </div>
    </div>
  )
}
