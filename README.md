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
| `code_references` | Trace a symbol across files: definitions, imports, call sites with context — progressive code understanding before editing |
| `context_resolve` | CVM symbol-level retrieval: exact source + dependency signatures + callers with confidence scoring — instead of whole files |
| `github_explore` | Search code/repos and read files on GitHub (REST API; `GITHUB_TOKEN` optional) |
| `tasks` | Persistent structured task list (`.pi/tasks.json`) — add/update/list; open tasks re-injected each session |
| `ask_user` | Ask the human a blocking question (free-text or choices) |
| `spawn_subagents` | Run independent subtasks in parallel `pi` subprocesses (isolated context); each result carries a stable id (`sub-2-4fd1`); optional lighter model; nesting blocked |
| `memory_map` | Inspect agent memory footprint, check token budget, regenerate memory-map.md |
| `memory_search` | Search across all memory files (system + learnings) for a query |

**Browser (CDP):** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_evaluate`, `browser_console`, `browser_screenshot` — control a real Chromium-based browser via Chrome DevTools Protocol, zero deps. SSRF-protected (blocks `file://`, private/reserved IPs). Verified end-to-end against headless Chromium.

For editing, writing, and shell: use Pi's built-in `edit`, `write`, `bash`.

### Slash Commands

| Command | What it does |
|---------|--------------|
| `/memory` | Interactive TUI dashboard — memory footprint, token budget gauge, progress tracker. Tabs: tree, system, learnings, progress |
| `/learn` | Distill the current session into reusable memory — writes durable learnings to `.pi/memory/learnings/` |
| `/doctor` | Memory health audit — scored checklist of issues, duplicates, and optimization suggestions |
| `/consolidate` | Reorganize memory learnings — merge duplicates, archive stale entries, clean up |
| `/init` | Initialize project memory from codebase analysis (framework, scripts, conventions) |
| `/serve` | Start HTTP API server + bore tunnel for mobile/remote access |
| `/config` | Configure git identity, greetings name, subagent model — interactive or `/config <key> <value>` |
| `/connectors` | List the connectors this package provides (tools, commands, requirements, active state) |
| `/agents` | Show subagent setup: main/subagent model, nesting policy, presets (explorer, coder, reviewer, tester) |
| `/newTask` | Run a task in a fresh subagent: `/newTask <prompt>` (standard) or `/newTask background <prompt>` (detached, logged to `.pi/newtask/`, tracked in tasks.json). Preset prefix: `/newTask reviewer: …` |
| `/harness` | Delegation-harness stats: research calls, subagent fan-outs, delegation ratio, nudges sent |
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

### Context Virtual Memory (CVM)

A layered context engine ([docs/CVM.md](docs/CVM.md)) that delivers the **smallest complete context** — never re-downloading, re-parsing, or re-sending identical content:

- **Hot / warm / cold tiers** — in-process LRU+TTL, persistent `node:sqlite` store (`.pi/cvm/cvm.db`), brotli content-addressed cold objects. Zero new dependencies.
- **Incremental symbol memory** — the repo is indexed once; unchanged files cost one `stat()` afterwards. Lookups are instant.
- **`context_resolve` tool** — a symbol's exact source + dependency signatures + callers instead of whole files, with a confidence score that auto-expands retrieval when coverage is low. Source code is never summarized in place of itself.
- **Delta mode** — repeat `read_file`/`web_fetch` of unchanged content returns a short `[CVM] unchanged` stub; changed content returns a compact diff. `force_full: true` recovers after compaction.
- **HTTP cache** — ETag/Last-Modified revalidation for `web_fetch` and `github_explore`; 304s cost no download (and don't burn GitHub rate limits).
- **`/cvm`** — tokens saved, hit ratios, index and storage stats; `/cvm index` forces a reindex.

### Delegation Harness

Prompt rules alone don't make a model fan out — so pi-tools extends Pi's harness with **active subagent-utilization steering**:

- **Prompt-shape hints** — decomposable requests (lists, multi-part asks, repo-wide sweeps) get a `<parallelization_hint>` injected into that turn's system prompt, while the plan is still forming.
- **Research-streak nudges** — 5+ sequential research calls (read/grep/glob/web/…) in one loop without a fan-out triggers a mid-stream steering nudge to break the remaining lookups into subagents. Rate-limited (once per loop, 3 per session).
- **Context-pressure nudges** — past 60% context usage with research still running, the harness suggests delegating the rest with `output_to_files: true` (once per session).
- **`/harness`** — live stats: research calls, fan-outs, delegation ratio, hints/nudges sent.
- Disable with `/config autoDelegate off`. Subagent processes are excluded automatically (they can't spawn).

### Smart Prompting

- **Token-efficient operating prompt** — pushes the model to batch tool calls, delegate to subagents, read only what it needs.
- **Progressive task resolution** — multi-step work is decomposed into the `tasks` list, resolved step by step, and only marked done after verification; shared symbols are traced with `code_references` before editing.
- **Git discipline** — the agent never commits or pushes unless explicitly asked.
- **Model-aware coding instructions** — extra guardrails for DeepSeek models (XML-structured self-verification, context management).
- **Live memory injection** — system memory + learning summaries + progress + open tasks are injected fresh each session from disk.

### Footer

Two-line footer with repo+branch (`🌿 pi-tools:main`), context window progress bar (colored block chars), token I/O stats (↑/↓), cache hits, cost, subagent contribution, and model name. The bottom line shows the configured greetings name.

Git commits through Pi are signed with the configured git identity (default `adeel.bot`) — change it with `/config`.

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

**`/config` settings** (persisted to `.pi/pi-tools.json` per-project or `~/.pi/pi-tools.json` globally):
- `gitName` / `gitEmail` — identity injected into `git commit` (default: `adeel.bot`)
- `greetingName` — name shown in the footer (default: Muhammad Adeel Chaudhary)
- `subagentModel` — lighter model for subagents and `/newTask` (default: inherit session model)
- `autoDelegate` — delegation-harness hints/nudges, `on`/`off` (default: on)

**Environment variables:**
- `TAVILY_API_KEY` — enables Tavily-backed `web_search` (falls back to DuckDuckGo otherwise)
- `GITHUB_TOKEN` (or `GH_TOKEN`) — higher rate limits + private repos for `github_explore`
- `PI_MEMORY_TOKEN_BUDGET` — memory injection token cap (default: 4000)
- `PI_SUBAGENT_MODEL` — overrides the configured `subagentModel`

**Flags** (pass on `pi` invocation):
- `--no-auto-learn` — disable automatic learning capture on session end
- `--memory-git` — auto-commit `.pi/memory/` changes to git after each turn

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
├── tests/                       # test suite
│   ├── memory.test.ts
│   ├── memory-map.test.ts
│   ├── config.test.ts
│   ├── tasks.test.ts
│   └── code-references.test.ts
├── .pi/memory/                  # agent's persistent memory
│   ├── memory-map.md            #   auto-generated index
│   ├── system/                  #   injected every turn
│   └── learnings/               #   on-demand
└── src/
    ├── index.ts                 # entry point: registers tools, commands, hooks
    ├── prompt.ts                # token-efficient operating prompt
    ├── commands/
    │   ├── memory-command.ts    # /memory TUI dashboard
    │   ├── learn-command.ts     # /learn — distill session
    │   ├── doctor-command.ts    # /doctor — memory health audit
    │   ├── consolidate-command.ts # /consolidate — reorganize learnings
    │   ├── init-command.ts      # /init — bootstrap memory
    │   ├── serve-command.ts     # /serve — HTTP API + bore tunnel
    │   ├── config-command.ts    # /config — settings editor
    │   ├── connectors-command.ts # /connectors — connector inventory
    │   ├── agents-command.ts    # /agents — subagent presets + model info
    │   └── new-task-command.ts  # /newTask — standard/background subagent runs
    ├── lib/
    │   ├── harness.ts           # delegation heuristics + nudge state machine
    │   ├── harness-register.ts  # harness event wiring + /harness command
    │   ├── memory.ts            # two-tier memory system + auto-bootstrap
    │   ├── memory-map.ts        # footprint computation + map generation
    │   ├── deepseek-prompt.ts   # model-aware coding prompt + memory/tasks injection
    │   ├── browser-cdp.ts       # zero-dep CDP client
    │   ├── code-references.ts   # cross-file symbol tracing engine
    │   ├── config.ts            # layered pi-tools config (/config)
    │   ├── tasks.ts             # persistent structured task list
    │   ├── agents.ts            # subagent presets
    │   ├── learn.ts             # session distillation + auto-capture
    │   ├── subagent-tokens.ts   # cross-process subagent token tracking
    │   ├── walk.ts              # directory tree walker
    │   └── shared.ts            # shared helpers (text, firstText, getRepoName, …)
    └── tools/
        ├── web.ts               # web_fetch, web_search
        ├── files.ts             # read_file
        ├── search.ts            # grep_search, glob_files
        ├── code-references.ts   # code_references
        ├── github-explore.ts    # github_explore
        ├── tasks.ts             # tasks
        ├── ask.ts               # ask_user
        ├── subagents.ts         # spawn_subagents (+ runSubagent for /newTask)
        ├── memory.ts            # memory_map
        ├── memory-search.ts     # memory_search
        ├── browser.ts           # 7 CDP browser tools
        ├── builtins.ts          # compact edit/write output
        └── subagent-review.ts   # Ctrl+O prompt editor
```

## Security

Pi packages run with full system access. Review the source before installing.
