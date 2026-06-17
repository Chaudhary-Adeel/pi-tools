---
description: "Sync auto-bootstrap pattern: create starter memory files on first session from package.json/tsconfig.json"
---

# Auto-Bootstrap Memory on First Run

When a user installs this extension, `.pi/memory/` is empty — no conventions, commands,
or persona files exist. The fix: detect missing files at `session_start` and create
starter versions synchronously from project metadata.

## Why sync, not async/subagent

| Approach | Cost |
|----------|------|
| Spawn subagent | ~500ms+ startup, 1 subagent slot, noisy |
| `fs.readFileSync` on 2 files + 4 writes | <5ms, zero overhead |

Reading `package.json` and `tsconfig.json` synchronously at session start is
effectively free — these are tiny files already in the OS page cache.

## What gets created

1. **`conventions.md`** — project name, language detection (TypeScript/JavaScript),
   code style defaults
2. **`commands.md`** — `npm run build`, `npm test`, `npm run lint` extracted from
   `package.json` scripts
3. **`persona.md`** — standard agent behavior preferences
4. **`progress.md`** — empty task tracker template

## Implementation pattern

```ts
// In session_start handler
const conventionsPath = join(memoryRoot, 'system', 'conventions.md');
if (!existsSync(conventionsPath)) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const isTS = existsSync('tsconfig.json');
  // Create all 4 files synchronously
}
```

The check is on a single sentinel file (`conventions.md`). If it exists, skip
everything — no wasted work on subsequent sessions.
