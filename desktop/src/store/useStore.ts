import { create } from 'zustand'
import type { ParsedEvent, PiStatus, MemoryData } from '../../electron/preload'

// ── Message model ────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant'

export interface ToolCallSegment {
  type: 'tool-call'
  tool: string
  args: string
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
  sidebarTab: 'memory' | 'subagents' | 'cvm' | 'config'
  setSidebarTab: (tab: AppState['sidebarTab']) => void

  // Active assistant message id (being built)
  activeAssistantId: string | null
}

let msgCounter = 0
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

    set({
      messages: messages.map((m) => {
        if (m.id !== activeAssistantId) return m

        const segs = [...m.segments]

        if (event.kind === 'text' && event.text) {
          const last = segs[segs.length - 1]
          if (last?.type === 'text') {
            // Append to last text segment
            return {
              ...m,
              segments: [...segs.slice(0, -1), { type: 'text', text: last.text + '\n' + event.text }],
            }
          }
          return { ...m, segments: [...segs, { type: 'text', text: event.text }] }
        }

        if (event.kind === 'tool-call') {
          return {
            ...m,
            segments: [
              ...segs,
              { type: 'tool-call', tool: event.tool ?? '', args: event.args ?? '' },
            ],
          }
        }

        if (event.kind === 'tool-result') {
          // Update the last pending tool-call with its result
          const lastCallIdx = [...segs].reverse().findIndex((s) => s.type === 'tool-call' && !(s as ToolCallSegment).status)
          if (lastCallIdx !== -1) {
            const realIdx = segs.length - 1 - lastCallIdx
            const updated = [...segs]
            updated[realIdx] = {
              ...updated[realIdx],
              status: event.status,
              summary: event.summary,
            } as ToolCallSegment
            return { ...m, segments: updated }
          }
        }

        if (event.kind === 'done') {
          // Turn complete — clear active id
          return m
        }

        return m
      }),
    })

    if (event.kind === 'done') {
      set({ activeAssistantId: null })
    }
  },

  clearMessages: () => set({ messages: [], activeAssistantId: null }),

  memory: null,
  setMemory: (memory) => set({ memory }),

  sidebarTab: 'memory',
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
}))
