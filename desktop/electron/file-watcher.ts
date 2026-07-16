/**
 * File watcher — watches .pi/memory/ and .pi/subagents/ for changes and
 * pushes structured updates to the renderer. Uses Node.js built-in fs.watch
 * with a periodic polling fallback (30 s) for platform reliability.
 */

import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { MemoryFile, MemoryData } from './types'

const watchers = new Map<string, fs.FSWatcher>()
const pollers = new Map<string, ReturnType<typeof setInterval>>()

async function readFrontmatterDescription(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8')
    const match = /^---[\s\S]*?description:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/m.exec(content)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

async function readMemoryDir(dir: string, relative: string): Promise<MemoryFile[]> {
  try {
    await fs.promises.access(dir)
    const entries = await fs.promises.readdir(dir)
    const files: MemoryFile[] = []
    for (const f of entries) {
      if (!f.endsWith('.md') || f === 'memory-map.md') continue
      const fp = path.join(dir, f)
      try {
        const st = await fs.promises.stat(fp)
        files.push({
          name: f.replace(/\.md$/, ''),
          path: path.join(relative, f),
          description: await readFrontmatterDescription(fp),
          size: st.size,
          modified: st.mtimeMs,
        })
      } catch {
        // file may have been deleted between readdir and stat — skip
      }
    }
    return files.sort((a, b) => b.modified - a.modified)
  } catch {
    return []
  }
}

async function readMemory(projectPath: string): Promise<MemoryData> {
  const memRoot = path.join(projectPath, '.pi', 'memory')
  let hasMemory = false
  try {
    await fs.promises.access(memRoot)
    hasMemory = true
  } catch {
    hasMemory = false
  }
  return {
    hasMemory,
    systemFiles: hasMemory
      ? await readMemoryDir(path.join(memRoot, 'system'), '.pi/memory/system')
      : [],
    learningFiles: hasMemory
      ? await readMemoryDir(path.join(memRoot, 'learnings'), '.pi/memory/learnings')
      : [],
  }
}

/** Start watching a project's .pi/ directory and push updates to the renderer. */
export function startFileWatcher(projectPath: string, win: BrowserWindow): void {
  stopFileWatcher(projectPath)

  const piDir = path.join(projectPath, '.pi')
  fs.mkdirSync(piDir, { recursive: true })

  let debounce: ReturnType<typeof setTimeout> | null = null

  const pushUpdate = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => {
      if (!win.isDestroyed()) {
        win.webContents.send('memory:update', await readMemory(projectPath))
      }
    }, 300)
  }

  // Watch recursively — Node 20+ supports recursive on all platforms.
  const watcher = fs.watch(
    piDir,
    { recursive: true, persistent: true },
    (event, filename) => {
      // Match changes inside memory/ or subagents/ trees, plus new directory creation.
      if (
        filename?.includes('memory') ||
        filename?.includes('subagents') ||
        event === 'rename'
      ) {
        pushUpdate()
      }
    },
  )

  watcher.on('error', (err) => {
    console.error('[file-watcher] fs.watch error:', err.message)
    // Re-establish the watch after a brief delay
    setTimeout(() => {
      if (!win.isDestroyed()) {
        startFileWatcher(projectPath, win)
      }
    }, 1000)
  })

  watchers.set(projectPath, watcher)

  // Periodic polling fallback (30s) — fs.watch is unreliable on some platforms.
  const poller = setInterval(async () => {
    if (win.isDestroyed()) {
      clearInterval(poller)
      pollers.delete(projectPath)
      return
    }
    win.webContents.send('memory:update', await readMemory(projectPath))
  }, 30_000)
  pollers.set(projectPath, poller)

  // Send initial state immediately
  readMemory(projectPath).then((data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('memory:update', data)
    }
  })
}

export function stopFileWatcher(projectPath: string): void {
  const w = watchers.get(projectPath)
  if (w) {
    w.close()
    watchers.delete(projectPath)
  }
  const p = pollers.get(projectPath)
  if (p) {
    clearInterval(p)
    pollers.delete(projectPath)
  }
}

export { readMemory }
