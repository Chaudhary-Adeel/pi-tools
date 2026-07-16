/**
 * Canonical types shared across the Electron main-process modules.
 * Import from here instead of redefining in each file.
 */

// ── Pi process status ────────────────────────────────────────────────────────

export type PiStatus = 'idle' | 'thinking' | 'calling-tool' | 'error'

// ── Parsed output events (discriminated union) ───────────────────────────────

export type ParsedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; tool: string; args: string; raw: string }
  | { kind: 'tool-result'; tool: string; status: 'ok' | 'error'; summary: string; raw: string }
  | { kind: 'section'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; exitCode: number }

// ── Memory file metadata ─────────────────────────────────────────────────────

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

// ── Subagent runs ────────────────────────────────────────────────────────────

export interface SubagentRunInfo {
  runId: string
  status: 'running' | 'completed' | 'error'
  prompt: string
  createdAt: number
  model?: string
  tokensUsed?: number
}

// ── CVM stats ────────────────────────────────────────────────────────────────

export interface CvmStats {
  tokensSaved: number
  httpHitRatio: number
  hotCacheSize: number
  warmStoreSize: number
  coldObjectCount: number
  coldBytesTotal: number
  symbolIndexSize: number
  indexFileCount: number
  deltaStubs: number
  deltaDiffs: number
  lastReindex: number | null
}

// ── Connector info ───────────────────────────────────────────────────────────

export interface ConnectorInfo {
  name: string
  what: string
  available: boolean
  needs?: string
}
