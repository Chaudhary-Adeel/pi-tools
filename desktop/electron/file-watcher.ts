/**
 * File watcher — watches .pi/memory/ and .pi/subagents/ for changes and
 * pushes structured updates to the renderer. Uses Node.js built-in fs.watch.
 */

import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'

interface MemoryFile {
  name: string
  path: string
  description: string
  size: number
  modified: number
}

interface MemoryData {
  systemFiles: MemoryFile[]
  learningFiles: MemoryFile[]
  hasMemory: boolean
}

const watchers = new Map<string, fs.FSWatcher>()

function readFrontmatterDescription(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const match = /^---[\s\S]*?description:\s*["']?(.+?)["']?\s*\n[\s\S]*?---/m.exec(content)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

function readMemoryDir(dir: string, relative: string): MemoryFile[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'memory-map.md')
    .map((f) => {
      const fp = path.join(dir, f)
      const st = fs.statSync(fp)
      return {
        name: f.replace(/\.md$/, ''),
        path: path.join(relative, f),
        description: readFrontmatterDescription(fp),
        size: st.size,
        modified: st.mtimeMs,
      }
    })
    .sort((a, b) => b.modified - a.modified)
}

function readMemory(projectPath: string): MemoryData {
  const memRoot = path.join(projectPath, '.pi', 'memory')
  const hasMemory = fs.existsSync(memRoot)
  return {
    hasMemory,
    systemFiles: readMemoryDir(path.join(memRoot, 'system'), '.pi/memory/system'),
    learningFiles: readMemoryDir(path.join(memRoot, 'learnings'), '.pi/memory/learnings'),
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
    debounce = setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send('memory:update', readMemory(projectPath))
      }
    }, 300)
  }

  // Watch recursively — Node 20+ supports recursive on all platforms
  const watcher = fs.watch(
    piDir,
    { recursive: true, persistent: false },
    (event, filename) => {
      if (filename?.includes('memory') || filename?.includes('subagents')) {
        pushUpdate()
      }
    },
  )

  watchers.set(projectPath, watcher)

  // Send initial state immediately
  win.webContents.send('memory:update', readMemory(projectPath))
}

export function stopFileWatcher(projectPath: string): void {
  const w = watchers.get(projectPath)
  if (w) {
    w.close()
    watchers.delete(projectPath)
  }
}

export { readMemory }
