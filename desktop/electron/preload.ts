import { contextBridge, ipcRenderer } from 'electron'

export type PiStatus = 'idle' | 'thinking' | 'calling-tool' | 'error'

export interface ParsedEvent {
  kind: 'text' | 'tool-call' | 'tool-result' | 'section' | 'stderr' | 'error' | 'done'
  text?: string
  tool?: string
  args?: string
  summary?: string
  status?: 'ok' | 'error'
  raw?: string
  exitCode?: number
}

export interface MemoryFile {
  name: string
  path: string
  description: string
  size: number
  modified: number
}

export interface MemoryData {
  systemFiles: MemoryFile[]
  learningFiles: MemoryFile[]
  hasMemory: boolean
}

const api = {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Project
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-folder'),
  getProject: (): Promise<string | null> => ipcRenderer.invoke('project:get'),

  // Pi process
  sendMessage: (prompt: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:send', prompt),
  abort: (): Promise<void> => ipcRenderer.invoke('pi:abort'),
  checkPi: (): Promise<{ found: boolean; path: string | null }> =>
    ipcRenderer.invoke('pi:check'),

  // Memory
  readMemory: (projectPath?: string): Promise<MemoryData | null> =>
    ipcRenderer.invoke('memory:read', projectPath),
  readMemoryFile: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('memory:read-file', filePath),

  // Config
  getConfig: (projectPath?: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('config:get', projectPath),
  setConfig: (key: string, value: unknown, projectPath?: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('config:set', key, value, projectPath),

  // Event listeners — return cleanup functions
  onPiOutput: (cb: (event: ParsedEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: ParsedEvent) => cb(data)
    ipcRenderer.on('pi:output', listener)
    return () => ipcRenderer.removeListener('pi:output', listener)
  },
  onPiStatus: (cb: (status: PiStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: PiStatus) => cb(status)
    ipcRenderer.on('pi:status', listener)
    return () => ipcRenderer.removeListener('pi:status', listener)
  },
  onMemoryUpdate: (cb: (data: MemoryData) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: MemoryData) => cb(data)
    ipcRenderer.on('memory:update', listener)
    return () => ipcRenderer.removeListener('memory:update', listener)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
