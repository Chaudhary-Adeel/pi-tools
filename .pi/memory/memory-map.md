# Memory Map

> Auto-generated index of the agent's persistent memory in `.pi/memory/`.
> Regenerate with `/update_memory_map` or by asking the agent to update it.


## Summary

| Category | Files | Size | Tokens (est.) |
|----------|------:|-----:|-------------:|
| 🧠 **System Memory** (injected each turn) | 4 | 2.6 KB | ~658 |
| 📚 **Learnings** (on-demand) | 4 | 3.2 KB | ~803 |
| **Total** | 8 | 5.7 KB | ~1,461 |

**Token budget:** 4,000 tokens | **Budget used:** 16.4%

## 🧠 System Memory (always injected)

### `system/progress.md`

- **Description:** Current task progress, checklist, decisions, and next steps
- **Priority:** 0  |  **Size:** 922 B  |  **Tokens:** ~230
- **Path:** `/Users/adeel/Downloads/pi-tools/.pi/memory/system/progress.md`

### `system/conventions.md`

- **Description:** Coding standards, conventions, and architectural patterns for this project
- **Priority:** 1  |  **Size:** 831 B  |  **Tokens:** ~208
- **Path:** `/Users/adeel/Downloads/pi-tools/.pi/memory/system/conventions.md`

### `system/commands.md`

- **Description:** Build, test, lint, and other common commands for this project
- **Priority:** 2  |  **Size:** 409 B  |  **Tokens:** ~103
- **Path:** `/Users/adeel/Downloads/pi-tools/.pi/memory/system/commands.md`

### `system/persona.md`

- **Description:** Agent behavior preferences and interaction style
- **Priority:** 3  |  **Size:** 467 B  |  **Tokens:** ~117
- **Path:** `/Users/adeel/Downloads/pi-tools/.pi/memory/system/persona.md`

## 📚 Learnings (loaded on-demand)

- **`learnings/child-process-survival.md`** — How to spawn child processes that survive parent exit in Node.js  (1002 B, ~249 tokens)
- **`learnings/pi-tui-terminal-dimensions.md`** — pi TUI terminal size: use tui.terminal.columns/rows, not tui.width()/tui.height()  (676 B, ~167 tokens)
- **`learnings/pi-tui-theme-colors.md`** — theme.fg() valid colors differ from ctx.ui.notify() severity levels  (1.0 KB, ~252 tokens)
- **`learnings/subagent-token-reconciliation.md`** — Subagent token usage is tracked separately and reconciled in the custom footer  (538 B, ~135 tokens)

## 📋 Current Progress

- **Task:** Add /memory command and memory maps package
- **Status:** done
- **Checklist:** 7/7 done
- **Open decisions:** 2
- **Next steps:** 4

## 🗺️ Memory Topology

```
.pi/memory/
├── memory-map.md          ← this file
├── system/                ← injected into context every turn
│   ├── system/progress.md
│   ├── system/conventions.md
│   ├── system/commands.md
│   ├── system/persona.md
│   └── progress.md         ← task tracking
└── learnings/             ← loaded on-demand by agent
    ├── learnings/child-process-survival.md
    ├── learnings/pi-tui-terminal-dimensions.md
    ├── learnings/pi-tui-theme-colors.md
    ├── learnings/subagent-token-reconciliation.md
```

## 💡 Management Tips

- Use **`/memory`** to see the full interactive memory dashboard at any time.
- The agent can read/write memory files with normal `read`/`edit`/`write` tools.

---
*Map generated 2026-06-11T20:08:11.644Z*