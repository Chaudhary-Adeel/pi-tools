// pi-coding-toolkit — entry point.
//
// Registers a complete set of coding tools plus a token-efficient operating
// prompt. Loaded by Pi via the `pi.extensions` field in package.json.
//
// Also sets a custom footer showing the configured greeting name (see /config).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { registerWebTools } from "./tools/web.ts";
import { registerFileTools } from "./tools/files.ts";
import { registerSearchTools } from "./tools/search.ts";
import { registerAskTool } from "./tools/ask.ts";
import { registerSubagentTool } from "./tools/subagents.ts";
import { registerCompactBuiltins } from "./tools/builtins.ts";
import { registerBrowserTools } from "./tools/browser.ts";
import { registerPrompt } from "./prompt.ts";
import { getSubagentUsage, resetSubagentTokens } from "./lib/subagent-tokens.ts";
import { registerCodingPrompt } from "./lib/deepseek-prompt.ts";
import { ensureMemoryDirs, isMemoryFileEdit } from "./lib/memory.ts";
import { registerMemoryCommand } from "./commands/memory-command.ts";
import { registerMemoryMapTool } from "./tools/memory.ts";
import { registerMemorySearchTool } from "./tools/memory-search.ts";
import { registerLearnCommand } from "./commands/learn-command.ts";
import { registerDoctorCommand } from "./commands/doctor-command.ts";
import { registerConsolidateCommand } from "./commands/consolidate-command.ts";
import { registerInitCommand } from "./commands/init-command.ts";
import { registerServeCommand } from "./commands/serve-command.ts";
import { registerConfigCommand } from "./commands/config-command.ts";
import { registerConnectorsCommand } from "./commands/connectors-command.ts";
import { registerMcpCommand } from "./mcp/registry.ts";
import { connectAllFromConfig } from "./mcp/client.ts";
import { registerNewTaskCommand } from "./commands/new-task-command.ts";
import { registerSubagentsCommand } from "./commands/subagents-command.ts";
import { registerGitHubExploreTool } from "./tools/github-explore.ts";
import { registerCodeReferencesTool } from "./tools/code-references.ts";
import { registerTaskTool } from "./tools/tasks.ts";
import { registerContextResolveTool } from "./tools/context-resolve.ts";
import { registerReadArtifactTool } from "./tools/read-artifact.ts";
import { registerQuietOutput } from "./lib/quiet-output-register.ts";
import { registerCvmCommand, runCvmGc } from "./commands/cvm-command.ts";
import { resetDeltaLedger } from "./cvm/delta.ts";
import { resetCvmMetrics } from "./cvm/metrics.ts";
import { indexRepo } from "./cvm/symbols.ts";
import { getWarmStore } from "./cvm/warm-store.ts";
import { getGreetingName, getGitIdentity } from "./lib/config.ts";
import { registerDelegationHarness } from "./lib/harness-register.ts";
import { registerMemoryHealth } from "./lib/memory-health-register.ts";
import { getRepoName } from "./lib/shared.ts";
import { buildSessionSummary, hasMeaningfulActivity, distillLearnings } from "./lib/learn.ts";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const CVM_GC_INTERVAL_MS = 24 * 60 * 60_000;

export default function (pi: ExtensionAPI): void {
  // Unique tools.  Pi's built-ins (write, edit, bash) cover the rest —
  // no need to duplicate them and waste tokens every turn.
  registerWebTools(pi); //      web_fetch, web_search
  registerFileTools(pi); //     read_file
  registerSearchTools(pi); //   grep_search, glob_files
  registerAskTool(pi); //        ask_user
  registerSubagentTool(pi); //   spawn_subagents
  registerCompactBuiltins(pi); // compact edit/write output
  registerBrowserTools(pi); //  browser_navigate, snapshot, click, type, evaluate, console, screenshot
  registerGitHubExploreTool(pi); // github_explore — search/read public GitHub repos
  registerCodeReferencesTool(pi); // code_references — progressive code understanding
  registerTaskTool(pi); //       tasks — structured session task list
  registerContextResolveTool(pi); // context_resolve — CVM symbol-level retrieval
  registerReadArtifactTool(pi); // read_artifact — retrieve full text behind a compacted output

  // Operating prompt (token efficiency + parallelism/subagent strategy).
  registerPrompt(pi);

  // Model-aware coding prompt + live memory injection.
  // Injects project memory from .pi/memory/, DeepSeek guardrails, and
  // progress tracking at each session start / after compaction.
  registerCodingPrompt(pi);

  // /memory command — interactive TUI dashboard for memory footprint.
  registerMemoryCommand(pi);

  // memory_map tool — agent-callable memory inspection and index generation.
  registerMemoryMapTool(pi);

  // memory_search tool — agent-callable search across all memory files.
  registerMemorySearchTool(pi);

  // /learn command — manually distill the current session into learnings.
  registerLearnCommand(pi);

  // /doctor command — memory health audit with scored checklist.
  registerDoctorCommand(pi);

  // /consolidate command — audit and reorganize memory learnings.
  registerConsolidateCommand(pi);

  // /init command — initialize project memory from codebase analysis.
  registerInitCommand(pi);

  // /serve command — HTTP API + bore tunnel for mobile/remote access.
  registerServeCommand(pi);

  // /config — configure git identity, greeting name, subagent model.
  registerConfigCommand(pi);

  // /mcp — manage MCP server connections (Postgres, Slack, Filesystem, etc.)
  registerMcpCommand(pi);

  // /connectors — list this package's connectors (tools, commands, integrations).
  registerConnectorsCommand(pi);

  // /agents — show subagent setup: model, presets, nesting policy.
  registerAgentsCommand(pi);

  // /newTask — kick off a task in a fresh subagent (standard or background).
  registerNewTaskCommand(pi);

  // /subagents — inspect subagent runs: full prompts + activity traces.
  registerSubagentsCommand(pi);

  // Delegation harness — active subagent-utilization steering: prompt-shape
  // hints, research-streak nudges, context-pressure nudges, /harness stats.
  registerDelegationHarness(pi);

  // /cvm — Context Virtual Memory stats + manual reindex.
  registerCvmCommand(pi);

  // Memory Health Engine — autonomous scoring/validation/healing of
  // .pi/memory against the live codebase, plus the /heal command.
  registerMemoryHealth(pi);

  // Quiet Output — compacts any oversized tool output (built-ins included)
  // to a head+tail preview before it reaches the model; caps unlimited
  // read() calls at a sane default. Stats surface in /cvm.
  registerQuietOutput(pi);

  // Flag to opt out of automatic learning capture on exit.
  pi.registerFlag("no-auto-learn", {
    description: "Disable automatic learning capture when the session ends",
    type: "boolean",
    default: false,
  });

  // ── Auto-capture learnings on session end ────────────────────────────────
  // When an interactive session ends after real work, distill durable,
  // reusable learnings into .pi/memory/learnings/ in the background.
  //
  // Recursion is impossible here: the distiller runs as `pi -p` (mode
  // "print"), and this hook only fires for mode "tui". The PI_TOOLS_DISTILL
  // env guard is a second safety net.
  pi.on("session_shutdown", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (process.env.PI_TOOLS_DISTILL === "1") return;
    if (pi.getFlag("no-auto-learn") === true) return;
    // Only capture on real exits / session swaps, not transient reloads.
    if (event.reason === "reload") return;

    try {
      const summary = buildSessionSummary(ctx.sessionManager.getBranch() as unknown[]);
      if (!hasMeaningfulActivity(summary)) return;
      // Fire-and-forget: detached subprocess survives this process exiting.
      distillLearnings({
        cwd: ctx.cwd,
        summary,
        model: ctx.model?.id,
        background: true,
      });
    } catch {
      /* never block shutdown on capture errors */
    }
  });

  // ── Git identity injection ──────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    // ── Inject configured bot identity into git commits (see /config) ────

    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      // Match 'git commit' but NOT 'git -c' (already configured)
      if (GIT_COMMIT_RE.test(cmd) && !/git\s+-c\s+user\.name/.test(cmd)) {
        const git = getGitIdentity(ctx.cwd);
        // Single-quote syntax is safe here on every OS: Pi's bash tool
        // always resolves to a bash/sh-compatible shell (Git Bash on
        // Windows, /bin/bash or sh elsewhere) — it never falls back to
        // cmd.exe or PowerShell, so this never needs OS branching.
        event.input.command = cmd.replace(
          GIT_COMMIT_RE,
          `git -c user.name='${git.name}' -c user.email='${git.email}' commit`,
        );
      }
    }
  });

  // ── Memory git backing: auto-commit memory changes on turn end ────────
  // OFF by default — users opt in with --memory-git.

  pi.registerFlag("memory-git", {
    description: "Automatically git-commit .pi/memory/ changes on each turn",
    type: "boolean",
    default: false,
  });

  let memoryModified = false;

  pi.on("tool_result", (event) => {
    if (pi.getFlag("memory-git") !== true) return;
    if (isMemoryFileEdit(event.toolName, event.input)) memoryModified = true;
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!memoryModified) return;
    memoryModified = false;
    try {
      // git diff --quiet exits 0 if no changes, 1 if there ARE changes.
      // execFileSync passes argv directly (no shell), so this runs the same
      // way on every OS instead of relying on a POSIX-flavored command string.
      execFileSync("git", ["diff", "--quiet", ".pi/memory/"], { cwd: ctx.cwd });
      return; // no changes
    } catch {
      // changes exist — stage and commit
      try {
        const git = getGitIdentity(ctx.cwd);
        execFileSync("git", ["add", ".pi/memory/"], { cwd: ctx.cwd });
        execFileSync(
          "git",
          [
            "-c", `user.name=${git.name}`,
            "-c", `user.email=${git.email}`,
            "commit", "-m", "chore(memory): update project memory files",
          ],
          { cwd: ctx.cwd },
        );
      } catch {
        /* no git repo or commit failed — silent */
      }
    }
  });

  // Reset subagent token tracking + ensure memory dirs on session start.
  pi.on("session_start", (_event, ctx) => {
    resetSubagentTokens();
    ensureMemoryDirs(ctx.cwd);
    memoryModified = false;

    // CVM: a fresh context has seen nothing — reset the delta ledger and
    // session metrics, then warm the symbol index in the background so the
    // first context_resolve is near-instant.
    resetDeltaLedger();
    resetCvmMetrics();
    void indexRepo(ctx.cwd).catch(() => {});

    // Auto-bootstrap memory on first run — create starter files from codebase
    autoBootstrapMemory(ctx.cwd);

    // Auto-connect MCP servers defined in .pi/mcp.json
    void connectAllFromConfig(ctx.cwd).catch(() => {});

    // Cold-store objects and expired HTTP cache rows otherwise accumulate
    // forever — reclaim them at most once a day (timestamp persisted so
    // restarts don't re-run it every session). Deferred + silent unless
    // something was actually freed, mirroring the memory-health sweep.
    try {
      const warm = getWarmStore(ctx.cwd);
      const last = Number(warm.kvGet("cvm:lastGc") ?? 0);
      if (Date.now() - last >= CVM_GC_INTERVAL_MS) {
        warm.kvSet("cvm:lastGc", String(Date.now()));
        setTimeout(() => {
          try {
            const { objectsDeleted, bytesFreed } = runCvmGc(ctx.cwd);
            if (objectsDeleted > 0) {
              ctx.ui.notify(`🗑 CVM gc: reclaimed ${objectsDeleted} stale object(s) (${(bytesFreed / 1024).toFixed(0)}KB)`, "info");
            }
          } catch {
            /* gc must never break a session */
          }
        }, 5000);
      }
    } catch {
      /* fall through — a failed timestamp read shouldn't block startup */
    }
  });

  // CVM correctness: compaction and tree navigation destroy prior tool
  // results from the model's context — a delta stub claiming content is
  // "already in your context" would then be false. Reset the ledger so the
  // next retrieval returns full content again.
  pi.on("session_compact", () => {
    resetDeltaLedger();
  });
  pi.on("session_tree", () => {
    resetDeltaLedger();
  });

  // ── custom footer with progress bar and polished layout ────────────────────

  pi.on("session_start", (_event, ctx) => {
    // Resolved once per session — shelling out to git per render would be wasteful.
    const repoName = getRepoName(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      // ── progress bar builder ────────────────────────────────────────────
      const barChars = ["█", "▓", "▒", "░"];
      const renderBar = (pct: number, barW: number): string => {
        const clamped = Math.max(0, Math.min(100, pct));
        const filled = (clamped / 100) * barW;
        const fullBlocks = Math.floor(filled);
        const remainder = filled - fullBlocks;
        let bar = "";
        if (clamped > 0) {
          bar = barChars[0]!.repeat(fullBlocks);
          if (fullBlocks < barW) {
            const idx = Math.min(barChars.length - 1, Math.floor(remainder * barChars.length));
            bar += barChars[idx]!;
            bar += " ".repeat(Math.max(0, barW - fullBlocks - 1));
          }
        } else {
          bar = " ".repeat(barW);
        }
        // Color: green < 50% → yellow < 80% → red
        const color = clamped < 50 ? "success" : clamped < 80 ? "warning" : "error";
        return theme.fg(color, bar);
      };

      // ── number formatter ─────────────────────────────────────────────────
      const fmt = (n: number): string =>
        n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Token stats from the session branch.
          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              input += m.usage.input;
              output += m.usage.output;
              cacheRead += m.usage.cacheRead ?? 0;
              cacheWrite += m.usage.cacheWrite ?? 0;
              cost += m.usage.cost.total;
            }
          }

          const usage = ctx.getContextUsage();

          // ── Add subagent LLM usage to totals (they run in separate ──
          // ── processes so ctx.sessionManager doesn't see them).       ──
          const sub = getSubagentUsage();
          input += sub.input;
          output += sub.output;
          cacheRead += sub.cacheRead;
          cacheWrite += sub.cacheWrite;
          cost += sub.cost;

          // ── build left-side parts ────────────────────────────────────────
          const parts: string[] = [];

          // Repo + git branch (accent color), e.g. "🌿 pi-tools:main"
          const branch = footerData.getGitBranch();
          const repoLabel = branch ? `${repoName}:${branch}` : repoName;
          if (repoLabel) parts.push(theme.fg("accent", theme.bold(`🌿 ${repoLabel}`)));

          // Token I/O (compact: ↑ / ↓ symbols) — includes subagent tokens
          parts.push(theme.fg("dim", `${theme.fg("success", "↑")}${fmt(input)} ${theme.fg("error", "↓")}${fmt(output)}`));

          // Cache
          if (cacheRead > 0 || cacheWrite > 0) {
            const r = cacheRead > 0 ? `${theme.fg("muted", "R")}${fmt(cacheRead)}` : "";
            const w = cacheWrite > 0 ? `${theme.fg("muted", "W")}${fmt(cacheWrite)}` : "";
            parts.push(theme.fg("dim", [r, w].filter(Boolean).join(" ")));
          }

          // Cost — includes subagent cost
          parts.push(theme.fg("dim", `$${cost.toFixed(3)}`));

          // Context: bar + percentage.
          if (usage?.contextWindow) {
            const pct = usage.percent ?? 0;
            const usedStr = usage.tokens != null ? fmt(usage.tokens) : "?";
            const totalStr = fmt(usage.contextWindow);
            const barW = Math.min(16, Math.max(6, Math.floor(width * 0.15)));
            const bar = renderBar(pct, barW);
            const pctStr = theme.fg(pct >= 80 ? "error" : pct >= 50 ? "warning" : "success", theme.bold(`${String(Math.round(pct)).padStart(3)}%`));
            const ctxLabel = theme.fg("muted", "ctx");
            parts.push(`${ctxLabel} ${bar} ${pctStr} ${theme.fg("dim", `${usedStr}/${totalStr}`)}`);
          }

          // Show subagent contribution if non-zero
          if (sub.input > 0 || sub.output > 0) {
            const subTokens = sub.input + sub.output;
            parts.push(theme.fg("accent", `↳sub ${fmt(subTokens)}`));
          }

          const left = parts.join(` ${theme.fg("borderMuted", "│")} `);

          // Model name on the right
          const modelStr = ctx.model?.id ?? "no-model";
          const modelLabel = theme.fg("dim", `◆ ${modelStr}`);

          const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(modelLabel)));
          const topLine = truncateToWidth(left + pad + modelLabel, width);

          // ── bottom line: greeting name on the right (see /config) ────────
          const name = theme.fg("warning", theme.bold(getGreetingName(ctx.cwd)));
          const padBottom = " ".repeat(Math.max(0, width - visibleWidth(name)));
          const bottomLine = truncateToWidth(padBottom + name, width);

          return [topLine, bottomLine];
        },
      };
    });
  });
}

// ── auto-bootstrap memory on first run ───────────────────────────────────

function autoBootstrapMemory(cwd: string): void {
  const root = path.join(cwd, ".pi/memory");
  const conventionsPath = path.join(root, "system", "conventions.md");
  if (fs.existsSync(conventionsPath)) return; // already bootstrapped

  try {
    const pkgPath = path.join(cwd, "package.json");
    const tsconfigPath = path.join(cwd, "tsconfig.json");

    const pkg = fs.existsSync(pkgPath)
      ? JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
      : null;
    const hasTs = fs.existsSync(tsconfigPath);
    const lang = hasTs ? "TypeScript" : "JavaScript";

    // Detect test framework from package.json scripts
    const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
    const testCmd = scripts.test || "npm test";
    const buildCmd = scripts.build || "npm run build";
    const lintCmd = scripts.lint || "npm run lint";

    // Detect framework hints
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies } as Record<string, string>;
    const framework = deps.react ? "React" : deps.next ? "Next.js" : deps.vue ? "Vue" : "";
    const frameworkNote = framework ? ` ${framework}` : "";

    // ── conventions.md ──
    const conventions = [
      "---",
      'description: "Coding standards, conventions, and architectural patterns for this project"',
      "priority: 1",
      "---",
      `# ${pkg?.name ?? "Project"} Conventions`,
      "",
      `- ${lang}${frameworkNote} project`,
      "- Write clear, self-documenting code",
      "- Follow existing patterns in the codebase",
      "- Keep functions small and focused",
      "- Add tests for new functionality",
      "",
    ].join("\n");

    // ── commands.md ──
    const commands = [
      "---",
      'description: "Build, test, lint, and other common commands for this project"',
      "priority: 2",
      "---",
      "# Project Commands",
      "",
      "## Build",
      "```bash",
      `${buildCmd}`,
      "```",
      "",
      "## Test",
      "```bash",
      `${testCmd}`,
      "```",
      "",
      "## Lint",
      "```bash",
      `${lintCmd}`,
      "```",
      "",
    ].join("\n");

    // ── persona.md ──
    const persona = [
      "---",
      'description: "Agent behavior preferences and interaction style"',
      "priority: 3",
      "---",
      "# Agent Persona",
      "",
      "## Interaction Style",
      "- Be concise — lead with results, not narration",
      "- Report failures honestly with output",
      "- Skip preambles and filler",
      "",
      "## Editing Preferences",
      "- Prefer surgical edits over full rewrites",
      "- Show only changed lines in diffs",
      "- Confirm before destructive operations",
      "",
      "## Verification",
      "- Always run build/tests after changes",
      "- Verify before claiming done",
      "",
    ].join("\n");

    fs.mkdirSync(path.dirname(conventionsPath), { recursive: true });
    fs.writeFileSync(conventionsPath, conventions, "utf-8");
    fs.writeFileSync(path.join(root, "system", "commands.md"), commands, "utf-8");
    fs.writeFileSync(path.join(root, "system", "persona.md"), persona, "utf-8");

    // progress.md handled by ensureProgressFile
  } catch {
    // never block startup on bootstrap failure
  }
}
