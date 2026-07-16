import { useEffect, useRef, useCallback } from 'react'
import { useStore } from './store/useStore'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar/Sidebar'
import ChatPanel from './components/Chat/ChatPanel'
import InputBar from './components/InputBar'
import ContextBar from './components/ContextBar'
import WelcomeScreen from './components/WelcomeScreen'
import RawOutputPanel from './components/RawOutputPanel'
import ToastContainer from './components/ToastContainer'
import { ErrorBoundary } from './components/ErrorBoundary'

declare global {
  interface Window {
    electronAPI: import('../electron/preload').ElectronAPI | undefined
  }
}

export default function App() {
  const { projectPath, setProject, setPiStatus, setMemory, appendEvent, piFound, setPiFound, setConnectors, clearMessages, sidebarTab, setSidebarTab } =
    useStore()
  const cleanupRef = useRef<(() => void)[]>([])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ctrl+K or Cmd+K — focus input
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        document.querySelector<HTMLTextAreaElement>('.input-textarea')?.focus()
      }
      // Ctrl+L — clear chat
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        clearMessages()
      }
      // Ctrl+O — open folder
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault()
        window.electronAPI?.openFolder().then((f) => { if (f) setProject(f) })
      }
      // Ctrl+B — toggle sidebar
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        const sidebar = document.querySelector('.sidebar') as HTMLElement
        if (sidebar) sidebar.style.display = sidebar.style.display === 'none' ? '' : 'none'
      }
      // Ctrl+Escape — abort Pi
      if ((e.ctrlKey || e.metaKey) && e.key === 'Escape') {
        e.preventDefault()
        window.electronAPI?.abort()
      }
      // Ctrl+1-6 — switch sidebar tabs
      const tabs = ['memory', 'subagents', 'tasks', 'cvm', 'connectors', 'config'] as const
      for (let i = 0; i < tabs.length; i++) {
        if ((e.ctrlKey || e.metaKey) && e.key === String(i + 1)) {
          e.preventDefault()
          setSidebarTab(tabs[i]!)
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [clearMessages, setSidebarTab, setProject])

  useEffect(() => {
    const api = window.electronAPI
    if (!api) {
      console.error('electronAPI not available — preload script may not have loaded.')
      return
    }

    // Check Pi is installed
    api.checkPi().then(({ found }: { found: boolean }) => setPiFound(found))

    // Load connectors
    api.getConnectors().then(setConnectors)

    // Re-attach any previously open project
    api.getProject().then((p: string | null) => {
      if (p) setProject(p)
    })

    // Subscribe to IPC events
    const offOutput = api.onPiOutput((ev) => appendEvent(ev))
    const offStatus = api.onPiStatus((s) => setPiStatus(s))
    const offMemory = api.onMemoryUpdate((m) => setMemory(m))

    cleanupRef.current = [offOutput, offStatus, offMemory]
    return () => cleanupRef.current.forEach((fn) => fn())
  }, [])

  return (
    <div className="app">
      <TitleBar />
      {!projectPath ? (
        <WelcomeScreen />
      ) : (
        <div className="app-body">
          <ErrorBoundary>
            <Sidebar />
          </ErrorBoundary>
          <main className="main">
            <ErrorBoundary>
              <ChatPanel />
            </ErrorBoundary>
            <RawOutputPanel />
            <div className="input-area">
              {!piFound && (
                <div className="pi-not-found">
                  ⚠️ <code>pi</code> not found on PATH.{' '}
                  <a href="https://pi.dev" target="_blank" rel="noreferrer">
                    Install Pi
                  </a>{' '}
                  to use this app.
                </div>
              )}
              <InputBar />
              <ContextBar />
            </div>
          </main>
        </div>
      )}
      <ToastContainer />
    </div>
  )
}
