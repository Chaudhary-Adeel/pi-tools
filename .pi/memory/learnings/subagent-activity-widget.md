---
description: "Callback-based subagent activity tracking renders a compact 1-line TUI widget showing live tool calls"
---

# Subagent Activity Widget Pattern

Subagents run in separate processes — the parent has no visibility into what they're
doing unless explicitly reported. The solution: a `setSubagentActivity` callback
passed from the spawn handler down to each `runOne`, with a compact TUI widget.

## Architecture

```
spawn_subagents tool handler
  → runAll(tasks, maxConcurrency, onActivity)
    → runOne(task, onActivity)       // per subagent
      → setSubagentActivity(agent, toolName, args)  // called on tool events
        → onActivity(idx, task, text)
          → ctx.ui.custom() widget    // 1-line TUI display
```

## Widget design (token-conscious)

- **1 line max** — token budget is critical; every line in the prompt costs
- Format: `⟳ 2/4 | #1 reading src/index.ts | #2 searching for "foo"`
- Shows up to 3 subagents' current activity, separated by `|`
- Self-clears 2 seconds after all subagents finish
- On narrow terminals, truncates to just the counter: `⟳ 2/4`

## What subagents report

- **Prompt**: shown first (what the subagent was asked to do)
- **Tool calls**: `reading file.ts`, `bash: npm test`, `searching for pattern`
- Replaced live as the subagent progresses

## Key decisions

| Decision | Why |
|----------|-----|
| No review screen | Subagents launch instantly — user sees prompts in the widget instead |
| Callback, not polling | Subagent processes can't be polled; they must push activity |
| Compact format | Single line, no borders — saves ~50-100 tokens per turn vs multi-line widget |
| Self-clearing | Doesn't leave stale widget content in the prompt after completion |
