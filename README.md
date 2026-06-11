# pi-tools

A batteries-included [Pi](https://pi.dev) package: coding tools, browser
automation, persistent memory, parallel subagents, and a token-efficient
operating prompt. Built for lean models where context window budget matters.

Zero runtime dependencies — Node built-ins + Pi's bundled packages only.

## What's inside

### Agent Tools

| Tool | What it does |
|------|--------------|
| `web_fetch` | Fetch a URL and return readable text (HTML→text), or raw for JSON/XML |
| `web_search` | Search the web; keyless (DuckDuckGo) or via `TAVILY_API_KEY` |
| `read_file` | Read a text file with line numbers + offset/limit |
| `grep_search` | Regex search over file contents, with glob filter |
| `glob_files` | Find files by `**/*.ext`-style pattern |
| `ask_user` | Ask the human a blocking question (free-text or choices) |
| `spawn_subagents` | Run independent subtasks in parallel `pi` subprocesses (isolated context) |
| `memory_map` | Inspect agent memory footprint, check token budget, regenerate memory-map.md |

**Browser (CDP):** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_console`, `browser_screenshot` — control a real Chromium-based browser via Chrome DevTools Protocol, zero deps.

For editing, writing, and shell: use Pi's built-in `edit`, `write`, `bash`.

### Slash Commands

| Command | What it does |
|---------|--------------|
| `/memory` | Interactive TUI dashboard — like looking inside Pi's brain. See what's stored, token budget gauge, progress tracker. Tabs: tree, system, learnings, progress |
| `/learn` | Distill the current session into reusable memory — writes durable learnings to `.pi/memory/learnings/` |
| `/skill:browser` | Loads browser automation instructions into context |

**Ctrl+O** — interactive subagent prompt editor (expand, edit, or cancel subagent tasks before execution).

### Memory System

Pi's brain, persisted across sessions in `.pi/memory/`:

- **System memory** (`.pi/memory/system/*.md`) — injected into context every turn. Project conventions, commands, persona, progress.
- **Learnings** (`.pi/memory/learnings/*.md`) — on-demand. The agent sees descriptions and loads files with `read` when needed.
- **Progress tracker** (`.pi/memory/system/progress.md`) — task status, checklists, decisions, next steps. Agent maintains it automatically.
- **Memory map** (`.pi/memory/memory-map.md`) — auto-generated index of everything in memory: sizes, token estimates, budget utilization, topology tree.

The agent is instructed to write to these files as its long-term memory. Use `/memory` to see the full dashboard or `memory_map` tool to query from a prompt.

#### Auto-capture learnings

When an interactive session ends after real work, a background distiller reads the
conversation and saves any durable, reusable insights (bug root causes, API gotchas,
conventions, working commands) to `.pi/memory/learnings/` — so the agent gets smarter
across sessions without you doing anything.

- Runs in a detached `pi -p` subprocess on exit, so it never blocks shutdown.
- Skips trivial sessions and avoids duplicating existing learnings.
- Run `/learn` any time to capture the current session on demand.
- Pass `--no-auto-learn` to disable automatic capture for a run.

### Smart Prompting

- **Token-efficient operating prompt** — pushes the model to batch tool calls, delegate to subagents, read only what it needs.
- **Model-aware coding instructions** — extra guardrails for DeepSeek models (XML-structured self-verification, context management).
- **Live memory injection** — system memory + learning summaries + progress are injected fresh each turn from disk.

### Footer

Two-line footer with context window progress bar (colored block chars), token I/O stats (↑/↓), cache hits, cost, subagent contribution, git branch, and model name.

Git commits through Pi are automatically signed as `adeel.bot`.

## Install

```bash
# Local (from this directory)
pi install /absolute/path/to/pi-tools

# Or via git
pi install git:github.com/chaudhary-adeel/pi-tools

# Quick test without installing
pi -e ./src/index.ts
```

No `npm install` needed. For editor type-checking only:
```bash
npm install
```

## Config

- `TAVILY_API_KEY` — enables Tavily-backed `web_search` (falls back to DuckDuckGo otherwise)

## Browser Setup

```bash
./skills/browser/start.sh   # auto-detects Chrome/Brave/Edge/Chromium, creates isolated profile
```

Or manually: `google-chrome --remote-debugging-port=9222`

## Layout

```
pi-tools/
├── package.json
├── README.md
├── skills/browser/              # browser automation skill
├── .pi/memory/                  # agent's persistent memory
│   ├── memory-map.md            #   auto-generated index
│   ├── system/                  #   injected every turn
│   └── learnings/               #   on-demand
└── src/
    ├── index.ts                 # entry point
    ├── prompt.ts                # operating prompt
    ├── commands/
    │   └── memory-command.ts    # /memory TUI dashboard
    ├── lib/
    │   ├── memory.ts            # two-tier memory system
    │   ├── memory-map.ts        # footprint computation + map generation
    │   ├── deepseek-prompt.ts   # model-aware coding prompt + memory injection
    │   ├── browser-cdp.ts       # zero-dep CDP client
    │   └── shared.ts            # helpers
    └── tools/
        ├── web.ts               # web_fetch, web_search
        ├── files.ts             # read_file
        ├── search.ts            # grep_search, glob_files
        ├── ask.ts               # ask_user
        ├── subagents.ts         # spawn_subagents
        ├── memory.ts            # memory_map
        ├── browser.ts           # 7 CDP browser tools
        ├── builtins.ts          # compact edit/write output
        └── subagent-review.ts   # Ctrl+O prompt editor
```

## Security

Pi packages run with full system access. Review the source before installing.
