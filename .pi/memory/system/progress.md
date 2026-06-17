---
description: "Current task progress, checklist, decisions, and next steps"
priority: 0
type: "progress"
---
# Task: Memory System Audit + Security/Quality/Performance Fixes

## Status: Done

## Checklist — Full Audit (3 dimensions, 26 files)

### Security Fixes
- [x] **S1 (Critical)**: SSRF in web_fetch — added `validateUrl()` blocking private/reserved IPs
- [x] **S2 (Critical)**: SSRF in browser_navigate — added `validateBrowserUrl()` blocking `file://` + private IPs
- [x] **S4 (High)**: Subagent concurrency cap — `Math.min(16, ...)` hard upper bound
- [x] **Browser SSRF**: blocked `file://`, `ftp://`, `data:`, `javascript:` protocols
- [x] Review: C1-C3 (shell exec, path traversal) — deferred (pi built-ins, needs framework-level fixes)

### Code Quality Fixes
- [x] **Q1 (Critical)**: ESM `require()` crash — replaced with top-level `import { execSync }`
- [x] **Q3 (Critical)**: Duplicate `getPiCommand()` — deleted from subagents.ts, import from shared.ts
- [x] **Q6 (High)**: `lastUpdated` field always empty — populated from `fs.statSync(fp).mtime.toISOString()`
- [x] **C6 (Critical)**: Subagent output overwrite — appended multi-turn assistant text instead of overwriting
- [x] **GIT_COMMIT_RE**: Extracted duplicate regex to module-level constant
- [x] **typebox** import: Verified correct — pi runtime re-export, not a bug

### Performance Fixes
- [x] **P3 (Critical)**: `findMemoryRoot` caching — eliminates 3+ directory walks per turn
- [x] **P9 (High)**: `loadMemoryDirMetadata` — avoids full file reads for learning summaries
- [x] **P4 (High)**: Doctor command — eliminated 3× redundant file reads
- [x] **M1 (Medium)**: Unified `fmtSize` → `formatBytes` from shared.ts

### Prompt Token Efficiency
- [x] Browser tools: extracted `NAV_HINT` constant, referenced once instead of 7 copies
- [x] Subagent tool: trimmed guidelines from 5→2 (kept only non-obvious tips)
- [x] Web tools: trimmed guidelines from 4→2 (removed description restatements)

### New Feature: Subagent Visibility
- [x] Spawn notification: `"🚀 Spawning N subagents…"` on start
- [x] Completion notification: `"✓ N/N subagents completed"` on finish
- [x] Live status bar: `"⟳ 2/4 subagents finished"` during execution
- [x] Status cleared on completion

## Files Changed (15 files, +429/-129 lines)
src/index.ts, src/tools/subagents.ts, src/tools/web.ts, src/tools/browser.ts,
src/tools/memory.ts, src/lib/memory.ts, src/lib/memory-map.ts, src/lib/learn.ts,
src/lib/shared.ts, src/lib/deepseek-prompt.ts, src/commands/memory-command.ts,
src/commands/doctor-command.ts, src/prompt.ts, package.json,
.pi/memory/system/progress.md, .pi/memory/memory-map.md

## Tests
66 tests, 0 failures, all green.

## Open Decisions
1. Shell exec/path traversal (C1-C3): These are pi built-in tool behaviors. Would need framework-level path sandbox or confirmation prompts — deferred.
2. Token budget default (4000): Still hardcoded but configurable via `PI_MEMORY_TOKEN_BUDGET` env var.
3. Subagent recursion depth limit: Could add `PI_SUBAGENT_DEPTH` env var with cap of 3 — deferred.
