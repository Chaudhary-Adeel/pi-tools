import { create } from 'zustand'
import type { ParsedEvent, PiStatus, MemoryData, SubagentRunInfo, CvmStats, ConnectorInfo } from '../../electron/preload'

// ── Message model ────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant'

export interface ToolCallSegment {
  type: 'tool-call'
  tool: string
  args: string
  callId?: number
  status?: 'ok' | 'error'
  summary?: string
}

export interface TextSegment {
  type: 'text'
  text: string
}

export type Segment = TextSegment | ToolCallSegment

export interface Message {
  id: string
  role: MessageRole
  segments: Segment[]
  timestamp: number
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface AppState {
  // Project
  projectPath: string | null
  setProject: (path: string | null) => void

  // Pi status
  piStatus: PiStatus
  setPiStatus: (s: PiStatus) => void
  piFound: boolean
  setPiFound: (found: boolean) => void

  // Chat messages
  messages: Message[]
  addUserMessage: (text: string) => string
  appendEvent: (event: ParsedEvent) => void
  clearMessages: () => void

  // Memory panel
  memory: MemoryData | null
  setMemory: (m: MemoryData) => void

  // Sidebar tab
  sidebarTab: 'memory' | 'subagents' | 'cvm' | 'config' | 'connectors' | 'tasks' | 'files' | 'git'
  setSidebarTab: (tab: AppState['sidebarTab']) => void

  // Active assistant message id (being built)
  activeAssistantId: string | null

  // Subagent runs
  subagentRuns: SubagentRunInfo[]
  setSubagentRuns: (runs: SubagentRunInfo[]) => void

  // CVM stats
  cvmStats: CvmStats | null
  setCvmStats: (stats: CvmStats | null) => void

  // Connectors
  connectors: ConnectorInfo[]
  setConnectors: (connectors: ConnectorInfo[]) => void
}

let msgCounter = 0
let toolCallCounter = 0
const nextId = () => `msg-${++msgCounter}`

export const useStore = create<AppState>((set, get) => ({
  projectPath: null,
  setProject: (path) => set({ projectPath: path }),

  piStatus: 'idle',
  setPiStatus: (piStatus) => set({ piStatus }),
  piFound: true,
  setPiFound: (piFound) => set({ piFound }),

  messages: [],
  activeAssistantId: null,

  addUserMessage: (text) => {
    const id = nextId()
    set((s) => ({
      messages: [
        ...s.messages,
        { id, role: 'user', segments: [{ type: 'text', text }], timestamp: Date.now() },
      ],
    }))
    // Pre-create an empty assistant message
    const assistantId = nextId()
    set((s) => ({
      activeAssistantId: assistantId,
      messages: [
        ...s.messages,
        { id: assistantId, role: 'assistant', segments: [], timestamp: Date.now() },
      ],
    }))
    return assistantId
  },

  appendEvent: (event: ParsedEvent) => {
    const { activeAssistantId, messages } = get()
    if (!activeAssistantId) return

    // Only mutate the last message (active assistant) during streaming.
    // Avoids O(n) map over all messages on every text/tool event.
    const lastIdx = messages.length - 1
    const m = messages[lastIdx]
    if (!m || m.id !== activeAssistantId) return

    const segs = [...m.segments]

    if (event.kind === 'text' && event.text) {
      const lastSeg = segs[segs.length - 1]
      if (lastSeg?.type === 'text') {
        segs[segs.length - 1] = { type: 'text', text: lastSeg.text + '\n' + event.text }
      } else {
        segs.push({ type: 'text', text: event.text })
      }
    } else if (event.kind === 'tool-call') {
      const callId = ++toolCallCounter
      segs.push({ type: 'tool-call', tool: event.tool ?? '', args: event.args ?? '', callId })
    } else if (event.kind === 'tool-result') {
      // Match the most recent pending tool-call (reverse scan).
      // Sequential results match correctly; callId enables future out-of-order support.
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i]
        if (s.type === 'tool-call' && !(s as ToolCallSegment).status) {
          segs[i] = { ...s, status: event.status, summary: event.summary } as ToolCallSegment
          break
        }
      }
    }
    // 'done' and 'error' events don't modify segments — just clear active below.

    set({
      messages: [...messages.slice(0, -1), { ...m, segments: segs }],
    })

    if (event.kind === 'done') {
      set({ activeAssistantId: null })
      // Send native notification on turn completion
      window.electronAPI?.notify('Pi Tools', 'Turn complete')
    }
  },

  clearMessages: () => set({ messages: [], activeAssistantId: null }),

  memory: null,
  setMemory: (memory) => set({ memory }),

  sidebarTab: 'memory',
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),

  subagentRuns: [],
  setSubagentRuns: (subagentRuns) => set({ subagentRuns }),

  cvmStats: null,
  setCvmStats: (cvmStats) => set({ cvmStats }),

  connectors: [],
  setConnectors: (connectors) => set({ connectors }),
}))
