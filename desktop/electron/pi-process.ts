/**
 * Pi CLI subprocess manager.
 *
 * Each user message spawns a fresh `pi -p` (print-mode) process with stdin
 * piped. The process streams its stdout to the renderer via the provided
 * callback. pi-tools' memory system (.pi/memory/) provides cross-session
 * context so the agent remembers previous work.
 */

import { spawn, ChildProcess, execSync } from 'child_process'
import { BrowserWindow } from 'electron'
import { PiOutputParser, ParsedEvent } from './output-parser'
import { PiStatus } from './types'

export interface PiProcessOptions {
  projectPath: string
  win: BrowserWindow
}

let currentProcess: ChildProcess | null = null
let currentPid: number | null = null
let currentStatus: PiStatus = 'idle'
let killedByUser = false
let currentGeneration = 0

/** Find the `pi` binary — checks PATH. Returns null if not found. */
export function findPiBinary(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where pi' : 'which pi'
    const result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0]?.trim()
    return result || null
  } catch {
    return null
  }
}

function setStatus(win: BrowserWindow, status: PiStatus): void {
  currentStatus = status
  if (!win.isDestroyed()) win.webContents.send('pi:status', status)
}

function sendEvent(win: BrowserWindow, event: ParsedEvent): void {
  if (!win.isDestroyed()) win.webContents.send('pi:output', event)
}

/** Run a single Pi turn in print mode. Returns a promise that resolves when done. */
export function runPiTurn(
  prompt: string,
  opts: PiProcessOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (currentProcess) {
      currentProcess.kill()
      currentProcess = null
    }

    const piBin = findPiBinary()
    if (!piBin) {
      const msg = 'Pi binary not found on PATH. Install Pi first: https://pi.dev'
      setStatus(opts.win, 'error')
      sendEvent(opts.win, { kind: 'error', text: msg })
      reject(new Error(msg))
      return
    }

    setStatus(opts.win, 'thinking')

    // Run pi in print mode so it completes one turn and exits.
    // Pass PI_TOOLS_DESKTOP=1 so extensions can detect the desktop context.
    const env = { ...process.env, PI_TOOLS_DESKTOP: '1' }

    killedByUser = false
    const gen = ++currentGeneration

    const proc = spawn(
      piBin,
      ['-p', '--no-session', prompt],
      {
        cwd: opts.projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    )

    currentProcess = proc
    currentPid = proc.pid ?? null

    let buffer = ''

    const parser = new PiOutputParser()
    const flushBuffer = (data: string) => {
      buffer += data
      // Process complete lines to avoid splitting ANSI codes mid-sequence
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const events = parser.parseOutput(line)
        for (const ev of events) {
          if (ev.kind === 'tool-call') setStatus(opts.win, 'calling-tool')
          else if (ev.kind === 'text') setStatus(opts.win, 'thinking')
          sendEvent(opts.win, ev)
        }
      }
    }

    proc.stdout?.on('data', (chunk: Buffer) => flushBuffer(chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Stderr: surface as a dim note, not an error, since Pi uses it for debug info
      const text = chunk.toString('utf8').trim()
      if (text) sendEvent(opts.win, { kind: 'stderr', text })
    })

    proc.on('close', (code) => {
      // Ignore stale handlers from a previous (already replaced) process
      if (gen !== currentGeneration) return
      // Flush any remaining buffered data
      if (buffer.trim()) {
        const events = parser.parseOutput(buffer)
        for (const ev of events) sendEvent(opts.win, ev)
        buffer = ''
      }
      currentProcess = null
      currentPid = null
      setStatus(opts.win, 'idle')
      sendEvent(opts.win, { kind: 'done', exitCode: code ?? 0 })
      // Don't reject if user aborted (SIGTERM=143 on Unix, 1 on Windows, or killedByUser flag)
      const isAbort = killedByUser || code === 130 || code === 143
      if (code !== null && code !== 0 && !isAbort) {
        reject(new Error(`Pi exited with code ${code}`))
      } else {
        resolve()
      }
    })

    proc.on('error', (err) => {
      // Ignore stale handlers from a previous (already replaced) process
      if (gen !== currentGeneration) return
      currentProcess = null
      currentPid = null
      setStatus(opts.win, 'error')
      sendEvent(opts.win, { kind: 'error', text: `Failed to start Pi: ${err.message}` })
      reject(err)
    })
  })
}

/** Kill the current Pi process (user-initiated abort). */
export function killCurrentProcess(): boolean {
  if (!currentProcess) return false
  killedByUser = true

  if (process.platform === 'win32' && currentPid) {
    // On Windows with shell:true, killing the shell orphans the child.
    // Use taskkill /T to kill the whole process tree.
    try {
      execSync(`taskkill /F /T /PID ${currentPid}`, { stdio: 'ignore' })
    } catch {
      // taskkill may fail if process already exited — that's fine
    }
  } else {
    // Unix: kill the process group so children die too
    const pid = currentPid ?? currentProcess.pid
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        currentProcess.kill('SIGTERM')
      }
    }
  }

  currentProcess = null
  currentPid = null
  currentStatus = 'idle'
  return true
}

export function getCurrentStatus(): PiStatus {
  return currentStatus
}
