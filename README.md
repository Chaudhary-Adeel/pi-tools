# pi-coding-toolkit

A batteries-included [Pi](https://pi.dev) package: the basic coding tools an
agent needs, plus a token-efficient operating prompt and the ability to fan
work out to parallel subagents. Built for lean models (e.g. DeepSeek v4 Pro)
where keeping the context window small matters.

## What's inside

| Tool | What it does |
| --- | --- |
| `web_fetch` | Fetch a URL and return readable text (HTML→text), or raw for JSON/XML |
| `web_search` | Search the web; keyless (DuckDuckGo) or via `TAVILY_API_KEY` |
| `read_file` | Read a text file with line numbers + offset/limit. Streams large files (>2MB), EISDIR-safe |
| `grep_search` | Regex search over file contents, with glob filter |
| `glob_files` | Find files by `**/*.ext`-style pattern |
| `ask_user` | Ask the human a blocking question (free-text or choices) |
| `spawn_subagents` | Run independent subtasks in parallel `pi` subprocesses (isolated context) |

For editing, writing, and shell commands, use Pi's built-in tools: `edit`, `write`, `bash`. They're deeply integrated and don't cost extra tokens from duplicate tool schemas in the context window.

Plus an **operating prompt** injected at agent start that pushes the model to:
batch independent tool calls, delegate to subagents to keep context small,
read only what it needs, and answer concisely.

### Footer

The Pi bottom bar shows **"Muhammad Adeel Chaudhary"** in yellow, alongside
token stats, the current model, and git branch.

> **Note on overlap with built-ins.** Pi's coding agent already ships
> `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`. To stay additive and avoid name
> collisions, this package's file/shell/search tools use distinct names
> (`read_file`, `run_shell`, `grep_search`, …). They also make the package a
> complete toolkit on its own for minimal SDK sessions that start with no
> built-in tools. If you only want the *additive* tools (web, ask, subagents),
> comment out the relevant `register*` lines in [`src/index.ts`](src/index.ts).

## Install

From the package directory (this folder):

```bash
pi install /absolute/path/to/pi-coding-toolkit
```

Or, if you push it to a repo / npm:

```bash
pi install git:github.com/you/pi-coding-toolkit
pi install npm:pi-coding-toolkit
```

To try it without installing:

```bash
pi -e ./src/index.ts
```

There are no runtime dependencies (Node builtins + Pi's own packages only), so
no `npm install` step is required. For editor type-checking, install dev types:

```bash
npm install   # optional, only for tsconfig/type-checking
```

## Configuration

- `TAVILY_API_KEY` — if set, `web_search` uses Tavily for higher-quality
  results; otherwise it falls back to a keyless DuckDuckGo HTML query.

## Subagents

`spawn_subagents` spawns separate `pi --mode json -p --no-session` subprocesses —
each with its own isolated context window — runs them concurrently (default 4 at
a time), and returns only their final answers. Give each subtask a
**self-contained** prompt; a subagent cannot see the parent conversation.

The implementation follows Pi's own official subagent pattern from
`examples/extensions/subagent`. It parses the ndjson event stream from each
subprocess, collecting the final assistant message text.

## Layout

```
pi-coding-toolkit/
├── package.json          # declares pi.extensions -> ./src/index.ts
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts          # entry: wires up tools + prompt + footer
    ├── prompt.ts         # token-efficient operating prompt
    ├── session-manager.ts # /sessions command and session browser
    ├── lib/              # shared helpers (no deps)
    └── tools/            # one file per tool group
```

## Security

Pi packages run with full system access — `run_shell` executes arbitrary
commands and the file tools write to disk. Only install packages you trust, and
review the source before enabling in untrusted projects.
