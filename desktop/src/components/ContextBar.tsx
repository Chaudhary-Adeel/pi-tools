import { useStore } from '../store/useStore'
import LearnDialog from './LearnDialog'
import ChatHistory from './ChatHistory'
import AgentPresets from './AgentPresets'
import BrowserPanel from './BrowserPanel'
import ThemePicker from './ThemePicker'
import ModelSelector from './ModelSelector'
import ExportDialog from './ExportDialog'
import PromptTemplates from './PromptTemplates'
import ApiKeyManager from './ApiKeyManager'
import { ErrorBoundary } from './ErrorBoundary'

export default function ContextBar() {
  const projectPath = useStore((s) => s.projectPath)
  const piStatus = useStore((s) => s.piStatus)
  const clearMessages = useStore((s) => s.clearMessages)
  const setProject = useStore((s) => s.setProject)

  const folderName = projectPath ? projectPath.split(/[\\/]/).pop() : null

  const handleOpenFolder = async () => {
    if (!window.electronAPI) return
    const folder = await window.electronAPI.openFolder()
    if (folder) setProject(folder)
  }

  const handleClear = () => {
    clearMessages()
  }

  return (
    <div className="context-bar">
      <div className="context-bar-left">
        {folderName ? (
          <>
            <ModelSelector />
            <button className="context-pill" onClick={handleOpenFolder} title={projectPath ?? ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {folderName}
          </button>
          </>
        ) : (
          <button className="context-pill context-pill--muted" onClick={handleOpenFolder}>
            Open folder
          </button>
        )}

        <div
          className={`status-dot ${
            piStatus === 'idle'
              ? 'status-dot--idle'
              : piStatus === 'error'
              ? 'status-dot--error'
              : 'status-dot--active'
          }`}
          title={`Pi: ${piStatus}`}
        />
      </div>

      <div className="context-bar-right">
        <ErrorBoundary>
          <ApiKeyManager />
        </ErrorBoundary>
        <BrowserPanel />
        <AgentPresets />
        <PromptTemplates />
        <ChatHistory />
        <ExportDialog />
        <LearnDialog />
        <ThemePicker />
        <button
          className="context-action"
          onClick={handleClear}
          title="Clear chat"
          aria-label="Clear chat"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4h6v2" />
          </svg>
          Clear
        </button>
      </div>
    </div>
  )
}
