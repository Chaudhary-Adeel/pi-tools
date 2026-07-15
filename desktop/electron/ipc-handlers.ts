import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { runPiTurn, killCurrentProcess, findPiBinary } from './pi-process'
import { startFileWatcher, stopFileWatcher, readMemory } from './file-watcher'

let activeProject: string | null = null

export function registerIpcHandlers(win: BrowserWindow): void {
  // ── Window controls ────────────────────────────────────────────────────
  // (minimize/maximize/close are registered in main.ts via ipcMain.on)

  // ── Project ────────────────────────────────────────────────────────────
  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Open Project Folder',
    })
    if (result.canceled || !result.filePaths[0]) return null
    const folder = result.filePaths[0]
    activeProject = folder
    startFileWatcher(folder, win)
    return folder
  })

  ipcMain.handle('project:get', () => activeProject)

  // ── Pi process ─────────────────────────────────────────────────────────
  ipcMain.handle('pi:send', async (_event, prompt: string) => {
    if (!activeProject) return { error: 'No project open. Open a folder first.' }
    try {
      await runPiTurn(prompt, { projectPath: activeProject, win })
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('pi:abort', () => {
    killCurrentProcess()
    return { ok: true }
  })

  ipcMain.handle('pi:check', () => ({
    found: !!findPiBinary(),
    path: findPiBinary(),
  }))

  // ── Memory ─────────────────────────────────────────────────────────────
  ipcMain.handle('memory:read', (_event, projectPath?: string) => {
    const cwd = projectPath ?? activeProject
    if (!cwd) return null
    return readMemory(cwd)
  })

  ipcMain.handle('memory:read-file', (_event, filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch {
      return null
    }
  })

  // ── Config ─────────────────────────────────────────────────────────────
  ipcMain.handle('config:get', (_event, projectPath?: string) => {
    const cwd = projectPath ?? activeProject
    if (!cwd) return {}
    const configPath = path.join(cwd, '.pi', 'pi-tools.json')
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      return {}
    }
  })

  ipcMain.handle('config:set', (_event, key: string, value: unknown, projectPath?: string) => {
    const cwd = projectPath ?? activeProject
    if (!cwd) return { error: 'No project open' }
    const configPath = path.join(cwd, '.pi', 'pi-tools.json')
    let current: Record<string, unknown> = {}
    try {
      current = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch { /* new file */ }
    current[key] = value
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2))
    return { ok: true }
  })

  // ── Cleanup on window close ─────────────────────────────────────────────
  win.on('closed', () => {
    if (activeProject) stopFileWatcher(activeProject)
    killCurrentProcess()
  })
}
