---
description: "Subagent token usage is tracked separately and reconciled in the custom footer"
---

# Subagent Token Tracking & Reconciliation

- Subagents spawned via `spawn_subagents` run in **separate processes** that the main
  `ctx.sessionManager` cannot observe.
- Their token usage is tracked in `src/lib/subagent-tokens.ts`, outside the normal
  session manager instrumentation.
- The custom footer calls `getSubagentUsage()` to pull subagent totals back into the
  main cost report, so overall usage reporting stays accurate.
