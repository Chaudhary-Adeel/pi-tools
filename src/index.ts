// pi-coding-toolkit — entry point.
//
// Registers a complete set of coding tools plus a token-efficient operating
// prompt. Loaded by Pi via the `pi.extensions` field in package.json.
//
// Also sets a custom footer showing "Muhammad Adeel Chaudhary" in yellow.
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
import { SubagentReviewer } from "./tools/subagent-review.ts";
import type { SubagentTask, ReviewAction } from "./tools/subagent-review.ts";

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

  // ── Ctrl+O subagent prompt expansion + git identity injection ────────────

  pi.on("tool_call", async (event, ctx) => {
    // ── Feature 1: Ctrl+O to expand/edit subagent prompts ──────────────────

    if (event.toolName === "spawn_subagents") {
      const rawTasks = event.input.tasks as SubagentTask[] | undefined;
      if (!rawTasks || rawTasks.length === 0) return;

      let tasks: SubagentTask[] = rawTasks.map((t) => ({ ...t }));

      while (true) {
        const action = await ctx.ui.custom(
          (tui, theme, keybindings, done) => {
            const reviewer = new SubagentReviewer(tasks, theme, keybindings, done);
            return {
              render: (w: number) => reviewer.render(w),
              invalidate: () => reviewer.invalidate(),
              handleInput: (data: string) => {
                reviewer.handleInput(data);
                tui.requestRender();
              },
            };
          },
        );

        const typedAction = action as ReviewAction;

        if (typedAction.type === "run") {
          // Apply any edits back to the tool input
          event.input.tasks = tasks;
          break;
        }

        if (typedAction.type === "edit") {
          const task = tasks[typedAction.index];
          const body = task.context
            ? `[Context]\n${task.context}\n\n[Prompt]\n${task.prompt}`
            : task.prompt;
          const edited = await ctx.ui.editor(
            `Edit subagent #${typedAction.index + 1} prompt`,
            body,
          );
          if (edited === undefined) continue; // user cancelled editor

          // Parse edited text — if context was present, split it back out
          if (task.context) {
            const ctxMatch = edited.match(/\[Context\]\n([\s\S]*?)\n\n\[Prompt\]\n([\s\S]*)/);
            if (ctxMatch) {
              tasks[typedAction.index] = {
                ...task,
                context: ctxMatch[1].trim(),
                prompt: ctxMatch[2].trim(),
              };
            } else {
              tasks[typedAction.index] = { ...task, prompt: edited.trim() };
            }
          } else {
            tasks[typedAction.index] = { ...task, prompt: edited.trim() };
          }
          continue;
        }

        if (typedAction.type === "cancel") {
          return { block: true, reason: "Cancelled by user" };
        }

        break;
      }
      return;
    }

    // ── Feature 2: Inject adeel.bot identity into git commits ──────────────

    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      // Match 'git commit' but NOT 'git -c' (already configured)
      if (/\bgit\s+commit\b/.test(cmd) && !/git\s+-c\s+user\.name/.test(cmd)) {
        event.input.command = cmd.replace(
          /\bgit\s+commit\b/,
          "git -c user.name='adeel.bot' -c user.email='adeel.bot@suadeo.net' commit",
        );
      }
    }
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

          // ── build left-side parts ────────────────────────────────────────
          const parts: string[] = [];

          // Git branch (accent color)
          const branch = footerData.getGitBranch();
          if (branch) parts.push(theme.fg("accent", theme.bold(`🌿 ${branch}`)));

          // Token I/O (compact: ↑ / ↓ symbols)
          parts.push(theme.fg("dim", `${theme.fg("success", "↑")}${fmt(input)} ${theme.fg("error", "↓")}${fmt(output)}`));

          // Cache
          if (cacheRead > 0 || cacheWrite > 0) {
            const r = cacheRead > 0 ? `${theme.fg("muted", "R")}${fmt(cacheRead)}` : "";
            const w = cacheWrite > 0 ? `${theme.fg("muted", "W")}${fmt(cacheWrite)}` : "";
            parts.push(theme.fg("dim", [r, w].filter(Boolean).join(" ")));
          }

          // Cost
          parts.push(theme.fg("dim", `$${cost.toFixed(3)}`));

          // Context: bar + percentage
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
