import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { runPiTurn, killCurrentProcess, findPiBinary } from './pi-process'
import { startFileWatcher, stopFileWatcher, readMemory } from './file-watcher'

const projects = new Map<number, string>()

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
    projects.set(win.id, folder)
    startFileWatcher(folder, win)
    return folder
  })

  ipcMain.handle('project:get', () => projects.get(win.id) ?? null)

  // ── Pi process ─────────────────────────────────────────────────────────
  ipcMain.handle('pi:send', async (_event, prompt: string) => {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return { error: 'Prompt must be a non-empty string.' }
    }
    const project = projects.get(win.id)
    if (!project) return { error: 'No project open. Open a folder first.' }
    try {
      await runPiTurn(prompt, { projectPath: project, win })
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('pi:abort', () => {
    const wasRunning = killCurrentProcess()
    return { ok: true, wasRunning }
  })

  ipcMain.handle('pi:check', () => {
    const piBinary = findPiBinary()
    return { found: !!piBinary, path: piBinary }
  })

  // ── Memory ─────────────────────────────────────────────────────────────
  ipcMain.handle('memory:read', (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
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
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return {}
    const configPath = path.join(cwd, '.pi', 'pi-tools.json')
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {}
      console.warn('[config:get] Failed to parse config:', err)
      return {}
    }
  })

  ipcMain.handle('config:set', (_event, key: string, value: unknown, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
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

  ipcMain.handle('config:setAll', (_event, config: Record<string, unknown>, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return { error: 'No project open' }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { error: 'config must be a plain object' }
    }
    const configPath = path.join(cwd, '.pi', 'pi-tools.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    return { ok: true }
  })

  // ── Subagents ──────────────────────────────────────────────────────────
  ipcMain.handle('subagents:list', (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return []
    const subDir = path.join(cwd, '.pi', 'subagents')
    try {
      if (!fs.existsSync(subDir)) return []
      const runs = fs.readdirSync(subDir)
      return runs.map((runId) => {
        const runDir = path.join(subDir, runId)
        const st = fs.statSync(runDir)
        // Check for trace file to determine status
        const traceFile = path.join(runDir, 'trace.md')
        const hasTrace = fs.existsSync(traceFile)
        return {
          runId,
          status: hasTrace ? 'completed' as const : 'running' as const,
          prompt: '',
          createdAt: st.birthtimeMs,
        }
      })
    } catch {
      return []
    }
  })

  ipcMain.handle('subagents:trace', (_event, runId: string, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return null
    const traceFile = path.join(cwd, '.pi', 'subagents', runId, 'trace.md')
    try {
      return fs.readFileSync(traceFile, 'utf8')
    } catch {
      return null
    }
  })

  // ── CVM ────────────────────────────────────────────────────────────────
  ipcMain.handle('cvm:stats', (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return null
    const cvmDir = path.join(cwd, '.pi', 'cvm')
    try {
      if (!fs.existsSync(cvmDir)) return null
      const warmDb = path.join(cvmDir, 'cvm.db')
      const objectsDir = path.join(cvmDir, 'objects')
      const warmSize = fs.existsSync(warmDb) ? fs.statSync(warmDb).size : 0
      let coldCount = 0
      let coldBytes = 0
      if (fs.existsSync(objectsDir)) {
        for (const f of fs.readdirSync(objectsDir)) {
          try {
            const fp = path.join(objectsDir, f)
            const st = fs.statSync(fp)
            coldCount++
            coldBytes += st.size
          } catch { /* skip */ }
        }
      }
      return {
        tokensSaved: 0,
        httpHitRatio: 0,
        hotCacheSize: 0,
        warmStoreSize: warmSize,
        coldObjectCount: coldCount,
        coldBytesTotal: coldBytes,
        symbolIndexSize: 0,
        indexFileCount: 0,
        deltaStubs: 0,
        deltaDiffs: 0,
        lastReindex: null,
      }
    } catch {
      return null
    }
  })

  // ── Connectors ─────────────────────────────────────────────────────────
  ipcMain.handle('connectors:list', () => {
    const which = (bin: string) => {
      try {
        const cmd = process.platform === 'win32' ? `where ${bin}` : `which ${bin}`
        require('child_process').execSync(cmd, { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    }
    return [
      {
        name: 'Web',
        what: 'Fetch pages and search the web',
        available: true,
      },
      {
        name: 'Browser (CDP)',
        what: 'Drive a Chromium browser over DevTools Protocol',
        available: which('chrome') || which('chromium') || which('google-chrome'),
        needs: 'Chrome with --remote-debugging-port=9222',
      },
      {
        name: 'GitHub',
        what: 'Search and read public GitHub repos',
        available: true,
      },
      {
        name: 'Subagents',
        what: 'Parallel pi subprocesses with isolated context',
        available: true,
      },
      {
        name: 'Serve',
        what: 'HTTP API server + bore tunnel',
        available: which('bore'),
        needs: 'bore for public tunneling',
      },
    ]
  })

  // ── Learn ──────────────────────────────────────────────────────────────
  ipcMain.handle('learn:trigger', async (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return { error: 'No project open' }
    // Trigger /learn by sending the command to pi
    try {
      await runPiTurn('/learn', { projectPath: cwd, win })
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // ── Tasks ──────────────────────────────────────────────────────────────
  ipcMain.handle('tasks:read', (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return []
    const tasksPath = path.join(cwd, '.pi', 'tasks.json')
    try {
      if (!fs.existsSync(tasksPath)) return []
      const raw = JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  })

  ipcMain.handle('tasks:write', (_event, tasks: unknown[], projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return { error: 'No project open' }
    const tasksPath = path.join(cwd, '.pi', 'tasks.json')
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true })
    const tmpPath = tasksPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(tasks, null, 2))
    fs.renameSync(tmpPath, tasksPath)
    return { ok: true }
  })

  // ── Git Diff ───────────────────────────────────────────────────────────
  ipcMain.handle('git:diff', (_event, filePath: string, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return null
    try {
      const { execSync } = require('child_process') as typeof import('child_process')
      return execSync(`git diff -- "${filePath}"`, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 })
    } catch {
      return null
    }
  })

  ipcMain.handle('git:diffStaged', (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return null
    try {
      const { execSync } = require('child_process') as typeof import('child_process')
      return execSync('git diff --staged', { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    } catch {
      return null
    }
  })

  // ── Browser ────────────────────────────────────────────────────────────
  ipcMain.handle('browser:getUrl', () => {
    return process.env.BROWSER_URL ?? 'about:blank'
  })

  // ── API Keys ──────────────────────────────────────────────────────────
  ipcMain.handle('env:get', (_event, key: string) => {
    const val = process.env[key]
    return val ? `${val.slice(0, 4)}****` : null
  })

  ipcMain.handle('env:getAll', (_event, keys: string[]) => {
    const result: Record<string, string | null> = {}
    for (const key of keys) {
      const val = process.env[key]
      result[key] = val ? `${val.slice(0, 4)}****` : null
    }
    return result
  })

  // ── Cleanup on window close ─────────────────────────────────────────────
  win.on('closed', () => {
    const project = projects.get(win.id)
    if (project) stopFileWatcher(project)
    projects.delete(win.id)
    killCurrentProcess()
  })

  // ── Serve ─────────────────────────────────────────────────────────────
  ipcMain.handle('serve:start', async (_event, projectPath?: string) => {
    const cwd = projectPath ?? projects.get(win.id)
    if (!cwd) return { error: 'No project open' }
    try {
      // Start serve as a background command via pi
      win.webContents.send('pi:status', 'thinking')
      const result = await runPiTurn('/serve start', { projectPath: cwd, win })
      return { ok: true, url: `http://localhost:8420` }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('serve:stop', async (_event) => {
    // Killing the current process also stops serve
    killCurrentProcess()
    return { ok: true }
  })
}
