# Coding Agent Memory Patterns: State of the Art

> Research for implementing a memory/context mechanism in a pi coding agent extension (TypeScript).
> Date: 2026-06-11

---

## Table of Contents

1. [Claude Code: CLAUDE.md + Auto Memory](#1-claude-code-claudemd--auto-memory)
2. [Cursor: Project Rules (.cursor/rules/*.mdc)](#2-cursor-project-rules-cursorrulesmdc)
3. [Aider: CONVENTIONS.md](#3-aider-conventionsmd)
4. [MemGPT / Letta: Virtual Context Management](#4-memgpt--letta-virtual-context-management)
5. [Other Notable Approaches](#5-other-notable-approaches)
6. [Key Patterns Summary](#6-key-patterns-summary)
7. [Recommendations for pi](#7-recommendations-for-pi)

---

## 1. Claude Code: CLAUDE.md + Auto Memory

Claude Code has the most mature dual memory system among terminal-based coding agents.

### 1.1 CLAUDE.md Files (Human-Written)

**Hierarchy** (loaded in order from broadest to most specific):

| Scope | Location | Purpose |
|-------|----------|---------|
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS) | Org-wide IT/DevOps standards |
| User instructions | `~/.claude/CLAUDE.md` | Personal preferences across all projects |
| Project instructions | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team-shared project conventions |
| Local instructions | `./CLAUDE.local.md` (gitignored) | Personal project-specific overrides |

**Key design decisions:**
- **Load order**: Broad → specific, so project overrides user, user overrides org
- **Loaded as user message** after system prompt, NOT as system prompt itself (no strict enforcement)
- **Size guidance**: Under 200 lines per file; longer files reduce adherence and consume tokens
- **Structure**: Markdown headers + bullets; Claude scans structure like humans do
- **Specificity rule**: Concrete and verifiable ("Use 2-space indentation" not "Format code properly")
- **Import mechanism**: `@path/to/file` syntax, recursive up to 4 hops deep
- **Consistency**: Conflicting rules → Claude may pick arbitrarily

### 1.2 Path-Scoped Rules (.claude/rules/)

Structured alternative to monolithic CLAUDE.md for large projects:

```markdown
---
description: One-line summary
globs: **/*.ts, **/*.tsx
alwaysApply: false
---
# TypeScript Conventions
- Use strict mode in tsconfig
- Prefer interfaces over type aliases for object shapes
```

- Rules with `paths:` frontmatter load ONLY when Claude reads a matching file
- Rules without `paths:` are loaded at startup (like CLAUDE.md content)
- Rules survive compaction: unscoped rules reload from disk; scoped rules reload when next matching file is read
- Support symlinks for sharing across projects

### 1.3 Auto Memory (AI-Written)

**What it is**: Claude writes its own notes based on corrections and discovered preferences.

- **Storage**: `~/.claude/projects/<project-hash>/auto-memory.md`
- **Loaded**: First 200 lines or 25KB, whichever is smaller
- **Triggers**: Claude decides when to save learnings (build commands, debugging insights, preferences)
- **Git-shared**: Auto memory is per-repository, shared across worktrees
- **Management**: `/memory` command to view, edit, delete entries
- **Subagents**: Can maintain their own separate auto memory

### 1.4 Context Window Management

- **Startup load order**: System prompt → CLAUDE.md files → Auto memory → MCP tool names → Skill descriptions
- **Compaction** (`/compact`): Replaces conversation with structured summary when window fills
  - Project-root CLAUDE.md re-reads from disk
  - Path-scoped rules and nested CLAUDE.md are LOST until matching files are read again
  - Skill bodies re-injected (capped at 5,000 tokens/skill, 25,000 total)
  - Auto memory re-injected
- **Subagent delegation**: Research/file reads happen in separate context windows
- **Checkpoints**: Git-based undo for all changes

### 1.5 Best Practices (from Claude Code docs)

> "Most best practices are based on one constraint: Claude's context window fills up fast, and performance degrades as it fills."

1. **Give Claude a way to verify its work** (tests, build, screenshot comparison)
2. **Explore first, then plan, then code** (separate research from implementation)
3. **Provide specific context in prompts** (files, constraints, examples)
4. **Course-correct early and often** (interrupt at first wrong direction)
5. **Manage context aggressively** (`/compact`, `/clear`, subagents for large reads)
6. **Ruthlessly prune CLAUDE.md** (delete instructions Claude already follows)

---

## 2. Cursor: Project Rules (.cursor/rules/*.mdc)

### 2.1 Architecture

Cursor uses Markdown-based `.mdc` files with YAML frontmatter, living in `.cursor/rules/`.

**File format:**
```yaml
---
description: One-line summary of what this rule helps Cursor do
globs: **/*.ts, **/*.tsx
alwaysApply: false
---
# TypeScript Conventions
- Use strict mode
- Prefer interfaces over type aliases
```

### 2.2 Key Features

- **Path-scoped**: `globs` field auto-attaches rules when matching files are in context
- **Semantic descriptions**: The `description` field lets the agent know what a rule covers before loading it
- **Always-apply mode**: `alwaysApply: true` loads the rule on every request (like CLAUDE.md)
- **Directory-based**: Multiple `.mdc` files in `.cursor/rules/` — modular by concern
- **Git-friendly**: Lives in the repo, shared by the team
- **Legacy format**: Single `.cursorrules` file at project root (now superseded by rules directory)

### 2.3 Community Patterns

A large ecosystem of community-contributed rules exists (awesome-cursorrules repo):
- Framework-specific rules (Next.js, React, Angular, Django, etc.)
- Language-specific rules (TypeScript, Python, Rust, etc.)
- Workflow-specific rules (testing, security, documentation, etc.)
- Domain-specific rules (game dev, mobile, CSS, state management, etc.)

---

## 3. Aider: CONVENTIONS.md

### 3.1 Approach

Aider takes the simplest approach: a plain markdown file.

- **Create**: `CONVENTIONS.md` (or any named markdown file)
- **Load**: `aider --read CONVENTIONS.md` or `/read CONVENTIONS.md` in chat
- **Behavior**: Loaded as read-only chat context, cached with prompt caching if enabled
- **Always load**: Configurable via `.aider.conf.yml`:
  ```yaml
  read: CONVENTIONS.md
  # or multiple files
  read: [CONVENTIONS.md, anotherfile.txt]
  ```

### 3.2 Key Design Decisions

- **Read-only marker**: `/read` marks files as non-editable — Aider won't modify them
- **Prompt caching**: Read-only files are cached, saving tokens on subsequent turns
- **Community repo**: Conventions files shared at [aider conventions repo](https://github.com/paul-gauthier/aider-conventions)
- **No structure**: Pure markdown, no frontmatter, no scoping
- **No auto-memory**: Aider has no AI-written memory mechanism

---

## 4. MemGPT / Letta: Virtual Context Management

Letta (formerly MemGPT) represents the most architecturally sophisticated approach, drawing from OS design patterns.

### 4.1 Core Concept: Virtual Context Management

**Analogy**: Just as OS virtual memory lets applications work with more memory than physically available (by paging between RAM and disk), MemGPT lets LLMs work with more context than their context window allows (by paging between context and external storage).

### 4.2 Memory Hierarchy (Original MemGPT Paper)

```
┌─────────────────────────────────────┐
│         MAIN CONTEXT                │  (prompt tokens — "RAM")
│  ┌───────────────────────────────┐  │
│  │ System Instructions (read-only)│  │  Control flow, memory usage docs
│  ├───────────────────────────────┤  │
│  │ Working Context (read/write)  │  │  Key facts, preferences, persona
│  ├───────────────────────────────┤  │
│  │ FIFO Queue (message history)  │  │  Rolling history + recursive summary
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
          ↕ function calls (self-directed)
┌─────────────────────────────────────┐
│       EXTERNAL CONTEXT              │  ("disk")
│  ┌───────────────────────────────┐  │
│  │ Recall Storage (messages DB)  │  │  All past messages, searchable
│  ├───────────────────────────────┤  │
│  │ Archival Storage (documents)  │  │  Arbitrary text objects, searchable
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Key mechanisms:**
- **Queue Manager**: Handles context overflow via eviction policy
  - At 70% capacity: warns LLM ("memory pressure") to save important info
  - At 100% capacity: flushes queue, generates recursive summary, evicts oldest messages
- **Self-directed memory**: LLM uses function calls to move data between tiers autonomously
- **Function chaining**: `request_heartbeat=true` triggers immediate follow-up inference for multi-step retrieval
- **Event-driven**: User messages, system alerts, timer events all trigger inference

### 4.3 Letta Code: MemFS (Memory Filesystem)

Letta Code evolved the MemGPT concept into a practical, git-backed memory system.

**Architecture:**
```
~/.letta/agents/<agent-id>/memory/
├── system/                    # ALWAYS LOADED into context
│   ├── persona.md             # Agent's identity and values
│   ├── working-style.md       # How the agent approaches work
│   └── project-facts.md       # Key architecture, conventions
├── observations/              # LOADED ON DEMAND (visible by name + description)
│   ├── 2026-06-01-build-fix.md
│   └── 2026-06-05-refactor-notes.md
├── preferences/               # Discovered user preferences
│   └── linting.md
└── skills/                    # Agent-scoped skills
    └── my-skill/SKILL.md
```

**File format:**
```markdown
---
description: "Who I am, what I value, and how I approach working with people."
limit: 50000  # optional legacy char cap
---
My name is Letta Code. I'm a stateful coding assistant...
```

**Key features:**
- **Git-backed**: Every memory edit is a git commit with informative message — full changelog
- **Two-tier loading**: `system/` = always-in-context; everything else = on-demand by name/description
- **Agent self-management**: Agent moves files in/out of `system/` as it learns what's important
- **Memory subagents**: Reflection/defrag subagents use git worktrees for concurrent memory writes
- **Sleep-time reflection**: Background subagents periodically review conversations and write learnings
- **Memory initialization** (`/init`): Bootstraps memory by exploring codebase and importing past session history
- **Memory doctor** (`/doctor`): Audits memory layout for proper placement and token efficiency
- **CLI tooling**: `letta memory status`, `letta memory diff`, `letta memory backup/restore`, `letta memory tokens`

### 4.4 Context Hierarchy (Letta)

```
1. System prompt (static, from server)
2. Memory blocks (from MemFS system/ directory)
3. Tools/Skills descriptions
4. Conversation messages (FIFO, with compaction)
```

### 4.5 Key Innovations

| Innovation | Description |
|-----------|-------------|
| **Self-editing memory** | Agent writes its own memory files via bash tools, then commits |
| **Concurrent memory writers** | Git worktrees allow background subagents to write memory without blocking |
| **Token-aware loading** | `system/` loaded fully; other files only loaded when needed (by name + description) |
| **Versioned memory** | Full git history of everything the agent has learned |
| **Progressive disclosure** | File descriptions visible without loading full content |
| **Dreaming/reflection** | Periodic background consolidation of recent experiences into memory |

---

## 5. Other Notable Approaches

### 5.1 GitHub Copilot Custom Instructions

- Single `.github/copilot-instructions.md` file
- Loaded as context for Copilot Chat and inline suggestions
- Simple markdown, no scoping, no frontmatter
- GitHub-native, versioned alongside code

### 5.2 Continue.dev (now read-only)

- Configuration via `config.json` or `config.ts`
- Custom slash commands with system message injection
- Model-specific context providers
- Rules in `.continue/rules/` directory

### 5.3 Open-Source Patterns

- **`AGENTS.md`**: Emerging convention (supported by Claude Code) for agent-agnostic instructions
- **`.windsurfrules`**: Windsurf's equivalent to `.cursorrules`
- **`CODEX.md`**: OpenAI Codex CLI configuration file

---

## 6. Key Patterns Summary

### 6.1 Working Memory Files (Always-Injected Context)

| System | File(s) | Scope | Structured? |
|--------|---------|-------|-------------|
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md` | Project | Markdown |
| Claude Code | `.claude/rules/*.md` | Path-scoped | YAML frontmatter + Markdown |
| Cursor | `.cursor/rules/*.mdc` | Glob-scoped | YAML frontmatter + Markdown |
| Letta | `system/*.md` | Always-loaded | YAML frontmatter + Markdown |
| Aider | `CONVENTIONS.md` | Read-only chat file | Plain Markdown |
| Copilot | `.github/copilot-instructions.md` | Project | Plain Markdown |

**Converged pattern**: YAML frontmatter with `description` and `globs`/`paths` for scoping, Markdown body for content.

### 6.2 Structured Progress Tracking

No current coding agent has explicit, structured progress tracking. The closest patterns:

- **Claude Code**: Implicit via conversation history; checkpoints provide rollback points
- **Letta**: Memory observations act as a running log; `sleep-time reflection` consolidates recent activity into memory files
- **Gap**: None of the major agents maintain a structured task list, status tracking, or decision log that persists across sessions

### 6.3 Decision Logging

- **Claude Code Auto Memory**: Saves "learnings and patterns" — closest to decision logging, but unstructured
- **Letta observation files**: Agent writes observations about what it learned; timestamped but unstructured
- **Gap**: No system has a formal decision log with rationale, alternatives considered, and outcome

### 6.4 Context Injection at Turn Boundaries

| System | Pre-turn injection | Post-turn processing |
|--------|-------------------|---------------------|
| Claude Code | CLAUDE.md, auto memory, rules, skill descriptions | Compaction when context fills |
| Cursor | Rules matching current files | None |
| Letta | `system/` directory files | Sleep-time reflection subagents |
| Aider | CONVENTIONS.md (if configured) | None |
| MemGPT | System instructions, working context, FIFO queue | Queue eviction + recursive summarization |

**Key insight**: The most effective systems inject context BEFORE each turn, not just at session start.

### 6.5 Critical Design Tensions

1. **Always-loaded vs. On-demand**: Loading everything wastes tokens; loading on-demand risks missing relevant info. Two-tier systems (Letta's `system/` vs non-system) are the best compromise.

2. **Human-written vs. AI-written**: Human instructions are precise but static; AI-written memory captures learnings but can drift. Claude Code's dual system (CLAUDE.md + auto memory) handles both.

3. **Single file vs. Directory**: Single files are simple but bloat; directories are modular but harder to manage. Cursor and Claude Code both moved from single files to directories.

4. **Git-backed vs. Opaque**: Versioned memory (Letta) gives full history and auditability; opaque storage is simpler but loses history.

5. **Scoping vs. Universality**: Path-scoped rules (Cursor, Claude Code) save tokens but can miss cross-cutting concerns; always-applied rules are reliable but wasteful.

---

## 7. Recommendations for pi

Given that pi is a **terminal-based coding agent extension** (TypeScript), here's what maps best:

### 7.1 Core Architecture

Adopt a **two-tier memory filesystem** inspired by Letta's MemFS, simplified for a terminal coding agent:

```
.project/                       # or .pi/
├── memory/
│   ├── system/                 # Always injected into context
│   │   ├── conventions.md      # Coding standards, project architecture
│   │   ├── commands.md         # Build, test, lint commands
│   │   └── persona.md          # Agent behavior preferences
│   ├── learnings/              # On-demand (visible by name + description)
│   │   └── *.md                # Discovered patterns, decisions
│   └── skills/                 # Agent-scoped skills (future)
│       └── */SKILL.md
└── pi.config.json              # Extension configuration
```

### 7.2 File Format

Use YAML frontmatter for metadata, Markdown for content:

```markdown
---
description: "Key architectural decisions and coding conventions for this project"
globs: "**/*.ts"              # optional: only load when working with TS files
priority: 1                    # optional: load order within system/
---
# Project Conventions
- Use 2-space indentation
- Prefer async/await over raw promises
...
```

### 7.3 Context Injection Strategy

**At session start:**
1. Load all `system/*.md` files (sorted by priority)
2. Load `pi.config.json` configuration
3. Load tool/skill descriptions

**At each turn:**
1. Inject `system/` files (read from disk each turn, supporting live edits)
2. Check for context overflow; if near limit, compact conversation

**Before tool execution:**
1. Check if any scoped rules match current files; inject if so

### 7.4 Progress Tracking (New Pattern)

This is a genuine gap in current tools. A lightweight structured tracking system:

```markdown
---
description: "Current task progress and pending decisions"
type: "progress"
---
# Current Task: Add OAuth support

## Status: In Progress
- [x] Research OAuth providers (2026-06-10)
- [x] Design auth flow
- [ ] Implement /auth/callback endpoint
- [ ] Write integration tests

## Open Decisions
1. Session storage: Redis vs JWT? (Leaning JWT for simplicity)
2. Provider scopes: Google-only or multi-provider?
```

The agent could read/write this file just like any other, but the structured format (checkboxes, status) would be recognized by the extension for display formatting.

### 7.5 Decision Log (New Pattern)

```markdown
---
description: "Log of significant decisions with rationale"
type: "decision-log"
---
## 2026-06-10: Chose JWT over Redis for sessions
**Context**: Need session persistence for OAuth flow
**Alternatives considered**: Redis sessions, encrypted cookies, JWT
**Decision**: JWT (stateless, no infra dependency)
**Rationale**: Simplifies deployment; user base < 1000 so token size not an issue
**Trade-offs**: Cannot invalidate sessions server-side
```

### 7.6 Git Integration

- **Option A** (simpler): Store memory files in project repo, versioned alongside code
- **Option B** (Letta-style): Separate git repo for memory with worktree support for concurrent writes

For a terminal coding agent, **Option A** is simpler and sufficient. Let the user decide whether to commit memory files.

### 7.7 Auto Memory (AI-Written Learnings)

Inspired by Claude Code's auto memory:
- Agent writes to `learnings/*.md` when it discovers new patterns
- File descriptions visible without loading content → agent knows what's available
- Agent periodically consolidates learnings into `system/` files
- Optional: user confirmation before auto-memory writes

### 7.8 What NOT to Adopt (for now)

- **Full MemGPT virtual context management**: Too complex for an extension; modern models have large enough context windows
- **Server-side agent state (Letta API model)**: Pi runs locally, keep it simple
- **Sleep-time/background subagents**: Great pattern but requires daemon process; defer to v2
- **Complex scoping rules with globs**: Start with simple `system/` injection; add scoping later if token pressure demands it

### 7.9 Minimal Viable Implementation

The smallest thing that would be genuinely useful:

1. **`system/conventions.md`**: Always-injected coding standards (like CLAUDE.md)
2. **`system/commands.md`**: Build/test/lint commands (like CLAUDE.md commands section)
3. **`memory/` directory**: Agent can create and read additional memory files
4. **YAML frontmatter**: `description` field for discoverability without loading content
5. **Auto-injection**: `system/*.md` files re-read from disk each turn

This captures 80% of the value with 20% of the complexity.

---

## References

- Claude Code Memory docs: https://docs.anthropic.com/en/docs/claude-code/memory
- Claude Code Best Practices: https://docs.anthropic.com/en/docs/claude-code/best-practices
- Claude Code Context Window: https://docs.anthropic.com/en/docs/claude-code/context-window
- Cursor Rules: https://docs.cursor.com/context/rules-for-ai
- Awesome Cursor Rules: https://github.com/PatrickJS/awesome-cursorrules
- Aider Conventions: https://aider.chat/docs/usage/conventions.html
- Letta Memory: https://docs.letta.com/letta-code/memory
- Letta MemFS: https://docs.letta.com/letta-code/memfs
- MemGPT Paper: https://arxiv.org/abs/2310.08560
- Letta Code GitHub: https://github.com/letta-ai/letta-code
