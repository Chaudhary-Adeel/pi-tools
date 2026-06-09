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

  // ── custom footer: "Muhammad Adeel Chaudhary" in yellow ──────────────────

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

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

          const fmt = (n: number) =>
            n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

          // Context usage + budget
          const usage = ctx.getContextUsage();
          let ctxStr = "";
          if (usage?.contextWindow) {
            const used = usage.tokens != null ? fmt(usage.tokens) : "?";
            const total = fmt(usage.contextWindow);
            const pct = usage.percent != null ? `${usage.percent}% ` : "";
            ctxStr = `${pct}${used}/${total}`;
          }

          // Top line: git branch + token stats / context on left, model on right
          const branch = footerData.getGitBranch();
          const leftParts: string[] = [];
          if (branch) leftParts.push(theme.fg("accent", branch));
          leftParts.push(`↑${fmt(input)} ↓${fmt(output)}`);
          if (cacheRead > 0 || cacheWrite > 0) {
            leftParts.push(`R${fmt(cacheRead)} W${fmt(cacheWrite)}`);
          }
          leftParts.push(`$${cost.toFixed(3)}`);
          if (ctxStr) leftParts.push(ctxStr);
          const left = theme.fg("dim", leftParts.join("  "));

          const modelStr = ctx.model?.id ?? "no-model";
          const modelLine = theme.fg("dim", modelStr);
          const padTop = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(modelLine)));
          const topLine = truncateToWidth(left + padTop + modelLine, width);

          // Bottom line: name on the right, in yellow
          const name = theme.fg("warning", theme.bold("Muhammad Adeel Chaudhary"));
          const padBottom = " ".repeat(Math.max(0, width - visibleWidth(name)));
          const bottomLine = truncateToWidth(padBottom + name, width);

          return [topLine, bottomLine];
        },
      };
    });
  });
}
