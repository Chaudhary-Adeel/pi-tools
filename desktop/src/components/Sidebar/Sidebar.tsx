import { useStore } from '../../store/useStore'
import MemoryPanel from './MemoryPanel'
import SubagentsPanel from './SubagentsPanel'
import CvmPanel from './CvmPanel'
import ConfigPanel from './ConfigPanel'
import ConnectorsPanel from './ConnectorsPanel'
import FileTree from './FileTree'
import GitPanel from './GitPanel'
import TaskBoard from '../TaskBoard'

const TABS = [
  { id: 'memory' as const, icon: '🧠', label: 'Memory' },
  { id: 'files' as const, icon: '📁', label: 'Files' },
  { id: 'git' as const, icon: '🔀', label: 'Git' },
  { id: 'subagents' as const, icon: '🤖', label: 'Subagents' },
  { id: 'tasks' as const, icon: '✅', label: 'Tasks' },
  { id: 'cvm' as const, icon: '⚡', label: 'CVM' },
  { id: 'connectors' as const, icon: '🔌', label: 'Connect' },
  { id: 'config' as const, icon: '⚙️', label: 'Config' },
]

export default function Sidebar() {
  const { sidebarTab, setSidebarTab } = useStore()

  const handleFileSelect = (filePath: string) => {
    if (window.electronAPI) {
      window.electronAPI.sendMessage(`read_file ${filePath}`)
    }
  }

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`sidebar-tab ${sidebarTab === tab.id ? 'sidebar-tab--active' : ''}`}
            onClick={() => setSidebarTab(tab.id)}
            title={tab.label}
            aria-label={tab.label}
          >
            <span className="sidebar-tab-icon">{tab.icon}</span>
            <span className="sidebar-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-panel">
        {sidebarTab === 'memory' && <MemoryPanel />}
        {sidebarTab === 'files' && <FileTree onFileSelect={handleFileSelect} />}
        {sidebarTab === 'git' && <GitPanel />}
        {sidebarTab === 'subagents' && <SubagentsPanel />}
        {sidebarTab === 'tasks' && <TaskBoard />}
        {sidebarTab === 'cvm' && <CvmPanel />}
        {sidebarTab === 'connectors' && <ConnectorsPanel />}
        {sidebarTab === 'config' && <ConfigPanel />}
      </div>
    </aside>
  )
}
