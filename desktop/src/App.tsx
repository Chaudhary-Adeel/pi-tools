import { useEffect, useRef } from 'react'
import { useStore } from './store/useStore'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar/Sidebar'
import ChatPanel from './components/Chat/ChatPanel'
import InputBar from './components/InputBar'
import ContextBar from './components/ContextBar'
import WelcomeScreen from './components/WelcomeScreen'

declare global {
  interface Window {
    electronAPI: typeof import('../electron/preload').default extends never
      ? Record<string, unknown>
      : import('../electron/preload').ElectronAPI
  }
}

export default function App() {
  const { projectPath, setProject, setPiStatus, setMemory, appendEvent, piFound, setPiFound } =
    useStore()
  const cleanupRef = useRef<(() => void)[]>([])

  useEffect(() => {
    const api = window.electronAPI
    if (!api) {
      console.error('electronAPI not available — preload script may not have loaded.')
      return
    }

    // Check Pi is installed
    api.checkPi().then(({ found }) => setPiFound(found))

    // Re-attach any previously open project
    api.getProject().then((p) => {
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
          <Sidebar />
          <main className="main">
            <ChatPanel />
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
    </div>
  )
}
