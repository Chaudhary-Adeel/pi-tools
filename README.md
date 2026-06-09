# pi-tools

A batteries-included [Pi](https://pi.dev) package: coding tools, browser
automation, a token-efficient operating prompt, and parallel subagents.
Built for lean models where keeping the context window small matters.

Zero runtime dependencies — just Node built-ins and Pi's own packages.

## What's inside

### File & Web Tools

| Tool | What it does |
| --- | --- |
| `web_fetch` | Fetch a URL and return readable text (HTML→text), or raw for JSON/XML |
| `web_search` | Search the web; keyless (DuckDuckGo) or via `TAVILY_API_KEY` |
| `read_file` | Read a text file with line numbers + offset/limit. Streams large files (>2MB) |
| `grep_search` | Regex search over file contents, with glob filter |
| `glob_files` | Find files by `**/*.ext`-style pattern |
| `ask_user` | Ask the human a blocking question (free-text or choices) |
| `spawn_subagents` | Run independent subtasks in parallel `pi` subprocesses (isolated context) |

For editing, writing, and shell commands, use Pi's built-in tools: `edit`, `write`, `bash`.

### Browser Tools (CDP)

Control a real Chromium-based browser via Chrome DevTools Protocol. Zero deps — hand-rolled WebSocket over `node:net`.

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Get accessibility tree of the page (token-efficient page view) |
| `browser_click` | Click an element by CSS selector or visible text |
| `browser_type` | Type text into an input field |
| `browser_evaluate` | Run JavaScript in the page context |
| `browser_console` | Read console messages (log, warn, error, exceptions) |
| `browser_screenshot` | Capture a PNG screenshot (renders inline in chat) |

**Skill included:** `/skill:browser` auto-loads browser instructions into context.
Run `./skills/browser/start.sh` to launch a browser with the right flags — it auto-detects Chrome/Brave/Edge/Chromium.

### Operating Prompt

Injected at agent start — pushes the model to batch independent tool calls,
delegate to subagents, read only what it needs, and answer concisely.

### Footer

A polished two-line footer with:
- **Context window progress bar** — colored block characters (🟢 < 50% → 🟡 50-80% → 🔴 > 80%)
- **Token stats** — `↑` / `↓` input/output with color coding
- **Git branch, cost, model** — compact layout with `│` separators
- **Credit** — "Muhammad Adeel Chaudhary" in yellow on the bottom line

## Install

From the package directory (this folder):

```bash
pi install /absolute/path/to/pi-tools
```

Or via git/npm:

```bash
pi install git:github.com/chaudhary-adeel/pi-tools
pi install npm:pi-tools
```

To try it without installing:

```bash
pi -e ./src/index.ts
```

No `npm install` needed — zero runtime dependencies. For editor type-checking:

```bash
npm install   # optional, only for tsconfig/type-checking
```

## Configuration

- `TAVILY_API_KEY` — if set, `web_search` uses Tavily for higher-quality results; otherwise falls back to keyless DuckDuckGo.

## Browser Setup

The browser tools connect to a running Chromium-based browser via CDP.

**One-time launch (the skill handles this automatically):**

```bash
./skills/browser/start.sh
```

Or manually:

```bash
google-chrome --remote-debugging-port=9222
# or: brave-browser --remote-debugging-port=9222
# or: chromium --remote-debugging-port=9222
```

The `start.sh` script auto-detects your installed browser and creates an isolated profile at `~/.pi/browser-profile`.

## Subagents

`spawn_subagents` spawns separate `pi --mode json -p --no-session` subprocesses —
each with its own isolated context window — runs them concurrently (default 4 at
a time), and returns only their final answers. Give each subtask a
**self-contained** prompt; a subagent cannot see the parent conversation.

## Layout

```
pi-tools/
├── package.json
├── tsconfig.json
├── README.md
├── skills/
│   └── browser/
│       ├── SKILL.md              # skill definition
│       ├── start.sh              # launch browser with CDP
│       └── references/
│           └── tools.md          # detailed tool reference
└── src/
    ├── index.ts                  # entry: tools + prompt + footer
    ├── prompt.ts                 # token-efficient operating prompt
    ├── lib/
    │   ├── shared.ts             # helpers (truncate, html→text, etc.)
    │   └── browser-cdp.ts        # zero-dep CDP client (hand-rolled WebSocket)
    └── tools/
        ├── web.ts                # web_fetch, web_search
        ├── files.ts              # read_file
        ├── search.ts             # grep_search, glob_files
        ├── ask.ts                # ask_user
        ├── subagents.ts          # spawn_subagents
        ├── subagent-review.ts    # Ctrl+O subagent prompt editor
        ├── builtins.ts           # compact edit/write output
        └── browser.ts            # browser_navigate, snapshot, click, type, evaluate, console, screenshot
```

## Security

Pi packages run with full system access. Only install packages you trust, and review the source before enabling in untrusted projects.
