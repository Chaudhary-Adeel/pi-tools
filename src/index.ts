// pi-coding-toolkit — entry point.
//
// Registers a complete set of coding tools plus a token-efficient operating
// prompt. Loaded by Pi via the `pi.extensions` field in package.json.
//
// Also sets a custom footer showing "Muhammad Adeel Chaudhary" in yellow.
import { execSync } from "node:child_process";
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
import { ensureMemoryDirs } from "./lib/memory.ts";
import { registerMemoryCommand } from "./commands/memory-command.ts";
import { registerMemoryMapTool } from "./tools/memory.ts";
import { registerMemorySearchTool } from "./tools/memory-search.ts";
import { registerLearnCommand } from "./commands/learn-command.ts";
import { registerDoctorCommand } from "./commands/doctor-command.ts";
import { registerConsolidateCommand } from "./commands/consolidate-command.ts";
import { registerInitCommand } from "./commands/init-command.ts";
import { buildSessionSummary, hasMeaningfulActivity, distillLearnings } from "./lib/learn.ts";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;

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
    // ── Inject adeel.bot identity into git commits ──────────────────────

    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      // Match 'git commit' but NOT 'git -c' (already configured)
      if (GIT_COMMIT_RE.test(cmd) && !/git\s+-c\s+user\.name/.test(cmd)) {
        event.input.command = cmd.replace(
          GIT_COMMIT_RE,
          "git -c user.name='adeel.bot' -c user.email='adeel.bot@suadeo.net' commit",
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
    const memTools = new Set(["edit", "write"]);
    if (!memTools.has(event.toolName)) return;
    const input = event.input as { path?: string; file_path?: string };
    const filePath = input?.path ?? input?.file_path ?? "";
    if (filePath.includes(".pi/memory/")) memoryModified = true;
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!memoryModified) return;
    memoryModified = false;
    try {
      // git diff --quiet exits 0 if no changes, 1 if there ARE changes
      execSync("git diff --quiet .pi/memory/", { cwd: ctx.cwd });
      return; // no changes
    } catch {
      // changes exist — stage and commit
      try {
        execSync("git add .pi/memory/", { cwd: ctx.cwd });
        execSync(
          "git -c user.name='adeel.bot' -c user.email='adeel.bot@suadeo.net' commit -m 'chore(memory): update project memory files'",
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

    // Auto-bootstrap memory on first run — create starter files from codebase
    autoBootstrapMemory(ctx.cwd);
  });

  // ── custom footer with progress bar and polished layout ────────────────────

  pi.on("session_start", (_event, ctx) => {
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

          // Git branch (accent color)
          const branch = footerData.getGitBranch();
          if (branch) parts.push(theme.fg("accent", theme.bold(`🌿 ${branch}`)));

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

          // ── bottom line: credit on the right, in warning color ───────────
          const name = theme.fg("warning", theme.bold("Muhammad Adeel Chaudhary"));
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
    const srcDir = path.join(cwd, "src");

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
