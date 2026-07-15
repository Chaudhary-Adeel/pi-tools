import { useStore } from '../../store/useStore'
import MemoryPanel from './MemoryPanel'
import SubagentsPanel from './SubagentsPanel'
import CvmPanel from './CvmPanel'
import ConfigPanel from './ConfigPanel'

const TABS = [
  { id: 'memory' as const, icon: '🧠', label: 'Memory' },
  { id: 'subagents' as const, icon: '🤖', label: 'Subagents' },
  { id: 'cvm' as const, icon: '⚡', label: 'CVM' },
  { id: 'config' as const, icon: '⚙️', label: 'Config' },
]

export default function Sidebar() {
  const { sidebarTab, setSidebarTab } = useStore()

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
        {sidebarTab === 'subagents' && <SubagentsPanel />}
        {sidebarTab === 'cvm' && <CvmPanel />}
        {sidebarTab === 'config' && <ConfigPanel />}
      </div>
    </aside>
  )
}
