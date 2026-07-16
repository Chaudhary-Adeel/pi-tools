import { contextBridge, ipcRenderer } from 'electron'

import type { PiStatus, ParsedEvent, MemoryFile, MemoryData, SubagentRunInfo, CvmStats, ConnectorInfo } from './types'
export type { PiStatus, ParsedEvent, MemoryFile, MemoryData, SubagentRunInfo, CvmStats, ConnectorInfo }

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
  setConfigAll: (config: Record<string, unknown>, projectPath?: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('config:setAll', config, projectPath),

  // Subagents
  getSubagentRuns: (projectPath?: string): Promise<SubagentRunInfo[]> =>
    ipcRenderer.invoke('subagents:list', projectPath),
  getSubagentTrace: (runId: string, projectPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('subagents:trace', runId, projectPath),

  // CVM
  getCvmStats: (projectPath?: string): Promise<CvmStats | null> =>
    ipcRenderer.invoke('cvm:stats', projectPath),

  // Connectors
  getConnectors: (): Promise<ConnectorInfo[]> =>
    ipcRenderer.invoke('connectors:list'),

  // Learn
  triggerLearn: (projectPath?: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('learn:trigger', projectPath),

  // Tasks
  readTasks: (projectPath?: string): Promise<unknown[]> =>
    ipcRenderer.invoke('tasks:read', projectPath),
  writeTasks: (tasks: unknown[], projectPath?: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('tasks:write', tasks, projectPath),

  // Git
  gitDiff: (filePath: string, projectPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('git:diff', filePath, projectPath),
  gitDiffStaged: (projectPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('git:diffStaged', projectPath),

  // Browser
  getBrowserUrl: (): Promise<string> =>
    ipcRenderer.invoke('browser:getUrl'),

  // Env
  getEnvAll: (keys: string[]): Promise<Record<string, string | null>> =>
    ipcRenderer.invoke('env:getAll', keys),

  // Notifications
  notify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke('notify', title, body),

  // Serve
  serveStart: (projectPath?: string): Promise<{ ok?: boolean; error?: string; url?: string }> =>
    ipcRenderer.invoke('serve:start', projectPath),
  serveStop: (): Promise<{ ok?: boolean }> =>
    ipcRenderer.invoke('serve:stop'),

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
