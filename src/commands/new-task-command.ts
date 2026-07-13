// /newTask — kick off a task in a fresh subagent process.
//
//   /newTask <prompt>               standard: run now, result lands in chat
//   /newTask background <prompt>    detached: runs while you keep working,
//                                   logs to .pi/newtask/, tracked in tasks.json
//   /newTask <preset>: <prompt>     apply an /agents preset (explorer, coder, …)
//
// Subagents run with the configured lighter model (/config subagentModel)
// and cannot spawn subagents of their own.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyPreset } from "../lib/agents.ts";
import { getSubagentModel } from "../lib/config.ts";
import { getPiCommand } from "../lib/shared.ts";
import { addTasks, updateTask } from "../lib/tasks.ts";
import { runSubagent, SUBAGENT_ENV_FLAG } from "../tools/subagents.ts";

export function registerNewTaskCommand(pi: ExtensionAPI): void {
  pi.registerCommand("newTask", {
    description: "Run a task in a fresh subagent: /newTask [background] <prompt>",
    handler: async (args, ctx) => {
      let input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /newTask [background|standard] <prompt>", "error");
        return;
      }

      let background = false;
      const modeMatch = /^(background|standard)\s+(.+)$/s.exec(input);
      if (modeMatch) {
        background = modeMatch[1] === "background";
        input = modeMatch[2]!.trim();
      }

      const { preset, prompt } = applyPreset(input);
      const model = getSubagentModel(ctx.cwd);
      const label = preset ? `${preset.name}: ${input.slice(preset.name.length + 1).trim()}` : input;
      const shortLabel = label.length > 60 ? label.slice(0, 57) + "…" : label;

      if (background) {
        runInBackground(ctx.cwd, prompt, shortLabel, model, (msg, type) =>
          ctx.ui.notify(msg, type),
        );
        return;
      }

      // ── standard: run now, stream status, deliver the result ──
      ctx.ui.setStatus("newtask", `⟳ subagent: ${shortLabel}`);
      ctx.ui.notify(`🚀 newTask started${model ? ` (model: ${model})` : ""}: ${shortLabel}`, "info");
      try {
        const result = await runSubagent(ctx.cwd, prompt, model, ctx.signal, (a) =>
          ctx.ui.setStatus("newtask", `⟳ [${a.toolName}] ${a.description}`),
        );
        const ok = result.exitCode === 0;
        const body = result.output || result.stderr || "(no output)";
        pi.sendMessage(
          {
            customType: "pi-tools:newtask-result",
            content: `## newTask ${ok ? "✓" : `✗ (exit ${result.exitCode})`} [${result.id}]\nTask: ${label}\n\n${body}`,
            display: true,
            details: { id: result.id, exitCode: result.exitCode, usage: result.usage },
          },
        );
        ctx.ui.notify(
          ok ? `✓ newTask completed [${result.id}]` : `✗ newTask failed (exit ${result.exitCode}) [${result.id}]`,
          ok ? "info" : "error",
        );
      } finally {
        ctx.ui.setStatus("newtask", undefined);
      }
    },
  });

  // Without a registered renderer, Pi's default custom-message component
  // dumps the full markdown body unconditionally — no collapsed state at
  // all. Match spawn_subagents' collapsed-by-default / expand convention.
  pi.registerMessageRenderer("pi-tools:newtask-result", (message, { expanded }, theme) => {
    const details = message.details as { id?: string; exitCode?: number } | undefined;
    const contentText =
      typeof message.content === "string"
        ? message.content
        : message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

    const ok = details?.exitCode === 0;
    const icon = ok ? theme.fg("success", "✓") : theme.fg("warning", `✗ (exit ${details?.exitCode})`);
    let summary = theme.fg("accent", "newTask ") + icon;
    if (details?.id) summary += theme.fg("dim", `  [${details.id}]`);
    if (expanded) summary += "\n" + contentText;
    return new Text(summary, 0, 0);
  });
}

function runInBackground(
  cwd: string,
  prompt: string,
  shortLabel: string,
  model: string | undefined,
  notify: (msg: string, type: "info" | "error") => void,
): void {
  const id = `bg-${crypto.randomBytes(3).toString("hex")}`;
  const logDir = path.join(cwd, ".pi", "newtask");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${id}.log`);
  const out = fs.openSync(logFile, "w");

  const [task] = addTasks(cwd, [`newTask(${id}): ${shortLabel}`]);
  if (task) updateTask(cwd, task.id, { status: "in_progress", notes: `log: ${logFile}` });

  const invocation = getPiCommand();
  const cliArgs = ["-p", "--no-session"];
  if (model) cliArgs.push("--model", model);
  cliArgs.push(`Task: ${prompt}`);

  const proc = spawn(invocation.command, [...invocation.args, ...cliArgs], {
    cwd,
    shell: false,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, [SUBAGENT_ENV_FLAG]: "1" },
  });

  proc.on("error", () => {
    if (task) updateTask(cwd, task.id, { status: "pending", notes: "failed to start" });
    notify(`✗ newTask ${id} failed to start`, "error");
  });
  // If this session is still alive when the child exits, mark it done.
  proc.on("close", (code) => {
    if (task) {
      updateTask(cwd, task.id, {
        status: "completed",
        notes: `exit ${code ?? 0} — output: ${logFile}`,
      });
    }
    notify(
      code === 0
        ? `✓ background task ${id} completed — ${logFile}`
        : `✗ background task ${id} exited ${code} — ${logFile}`,
      code === 0 ? "info" : "error",
    );
  });
  proc.unref();
  fs.close(out, () => {});

  notify(`🚀 background task ${id} started${model ? ` (model: ${model})` : ""} — log: ${logFile}`, "info");
}
