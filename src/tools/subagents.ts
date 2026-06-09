// spawn_subagents — fan out independent work to parallel `pi` subprocesses
// and gather their results. Each subagent runs in its own process with an
// isolated context window (`--mode json -p --no-session`), streaming updates
// back via JSON events. This keeps the main context lean and lets work run
// concurrently.
//
// Architecture: we spawn `pi --mode json -p --no-session [--model X] [--tools ...]
// ["Task: <prompt>"]` subprocesses (up to `max_concurrency` at a time), parse
// their ndjson event stream, and collect the final assistant message text.
//
// This follows Pi's own subagent pattern from examples/extensions/subagent.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, errorText, truncate } from "../lib/shared.ts";

// ── types ──────────────────────────────────────────────────────────────────

interface SubTask {
  prompt: string;
  context?: string;
}

interface SubResult {
  index: number;
  prompt: string;
  output: string;
  exitCode: number;
  stderr: string;
  model?: string;
  stopReason?: string;
  turns: number;
  tokens: { input: number; output: number };
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Find the `pi` CLI binary. Falls back to literal "pi" if we can't infer. */
function getPiCommand(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  // Bun virtual scripts point into $bunfs — not useful for spawning.
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGeneric = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGeneric) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

// ── core: run one subagent ─────────────────────────────────────────────────

function runOne(
  cwd: string,
  task: SubTask,
  index: number,
  signal?: AbortSignal,
): Promise<SubResult> {
  return new Promise((resolve) => {
    const result: SubResult = {
      index,
      prompt: task.prompt,
      output: "",
      exitCode: 0,
      stderr: "",
      turns: 0,
      tokens: { input: 0, output: 0 },
    };

    let wasAborted = false;

    const invocation = getPiCommand();
    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
    ];
    // Inject optional context as a first user message.
    // We embed it before the real task via --append-system-prompt.
    // For simplicity we pass the full prompt string directly.
    const fullPrompt = (task.context ? `${task.context}\n\n` : "") + task.prompt;
    args.push(`Task: ${fullPrompt}`);

    const proc = spawn(invocation.command, [...invocation.args, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      // Track the last assistant message_end for the final output.
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        if (msg.role === "assistant") {
          result.turns++;
          if (msg.usage) {
            result.tokens.input += msg.usage.input || 0;
            result.tokens.output += msg.usage.output || 0;
          }
          if (!result.model && msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          // Collect final text
          for (const part of msg.content) {
            if (part.type === "text") {
              result.output = part.text;
            }
          }
        }
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      result.exitCode = code ?? 0;
      if (wasAborted && result.exitCode === 0) result.exitCode = 130;
      resolve(result);
    });

    proc.on("error", () => {
      result.exitCode = 1;
      resolve(result);
    });

    if (signal) {
      const kill = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

// ── concurrency limiter ────────────────────────────────────────────────────

async function runAll(
  tasks: SubTask[],
  concurrency: number,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: (done: number) => void,
): Promise<SubResult[]> {
  if (tasks.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const results: SubResult[] = new Array(tasks.length);
  let nextIndex = 0;
  let done = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      if (signal?.aborted) return;
      const current = nextIndex++;
      if (current >= tasks.length) return;
      results[current] = await runOne(cwd, tasks[current], current, signal);
      done++;
      onProgress?.(done);
    }
  });

  await Promise.all(workers);
  return results.filter(Boolean);
}

// ── register ───────────────────────────────────────────────────────────────

export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "spawn_subagents",
    label: "Spawn Subagents",
    description:
      "Run one or more independent subtasks in parallel `pi` subprocesses " +
      "and return each subagent's final answer. Each subagent has its own " +
      "fresh context window, so use this to fan out work (research several " +
      "files/topics at once, draft independent pieces) and keep the main " +
      "context lean. Only the conclusions come back — not the intermediate steps.",
    promptSnippet: "delegate independent subtasks to parallel subagents",
    promptGuidelines: [
      "Use spawn_subagents when work splits into independent chunks that don't depend on each other's output — fan them out in one call.",
      "Give each subagent a self-contained prompt: it cannot see this conversation, so include every fact, path, and constraint it needs.",
      "Do NOT use it for a single linear task, or when subtasks must run in sequence.",
      "Prefer it over doing many large reads/searches inline when you only need the conclusions, to save the main context window.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          prompt: Type.String({
            description:
              "Self-contained instruction for this subagent. It has no memory " +
              "of the parent conversation — include all needed context.",
          }),
          context: Type.Optional(
            Type.String({
              description:
                "Optional background to seed as a prior message before the prompt.",
            }),
          ),
        }),
        { description: "The subtasks to run (each in its own session)." },
      ),
      max_concurrency: Type.Optional(
        Type.Number({
          description: "Max subagents to run at once (default 4).",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const tasks: SubTask[] = (params.tasks as SubTask[]) ?? [];
      if (tasks.length === 0) return text("No tasks provided.");

      const concurrency = Math.max(1, params.max_concurrency ?? 4);
      const total = tasks.length;
      const label = total === 1 ? "subagent" : "subagents";

      ctx.ui.setStatus(`${total} ${label} running…`);
      try {
        const results = await runAll(
          tasks,
          concurrency,
          ctx.cwd,
          signal,
          (done) => {
            const icon = done < total ? "⟳" : "✓";
            ctx.ui.setStatus(`${icon} ${done}/${total} ${label} finished`);
            onUpdate?.({
              content: [{ type: "text", text: `Subagents finished: ${done}/${total}` }],
            });
          },
        );

        // Sort by original index
        results.sort((a, b) => a.index - b.index);

        const body = results
          .map((r) => {
            const status = r.exitCode === 0 ? "✓" : `✗ (exit ${r.exitCode})`;
            const header = `### Subagent ${r.index + 1}  ${status}\nTask: ${r.prompt}`;
            const out = r.output || r.stderr || "(no output)";
            return `${header}\n\nResult:\n${out}`;
          })
          .join("\n\n---\n\n");

        ctx.ui.setStatus(undefined);
        return text(truncate(body, 40_000), {
          count: results.length,
          successCount: results.filter((r) => r.exitCode === 0).length,
          prompts: results.map((r) => r.prompt),
          models: results.map((r) => r.model).filter(Boolean),
          totalTurns: results.reduce((s, r) => s + r.turns, 0),
        });
      } catch (_err) {
        ctx.ui.setStatus(undefined);
        throw _err;
      }
    },
    renderCall(args, theme, _context) {
      const tasks = args.tasks as SubTask[] | undefined;
      const n = tasks?.length ?? 0;
      let t = theme.fg("toolTitle", theme.bold("subagents "));
      t += theme.fg("muted", `(${n})`);
      if (tasks && tasks.length > 0) {
        t += "\n";
        t += tasks
          .map((task) => {
            const firstLine = task.prompt.split("\n")[0] ?? task.prompt;
            const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
            return "  " + theme.fg("dim", preview);
          })
          .join("\n");
      }
      return new Text(t, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      if (result.isError) {
        const msg = result.content?.[0]?.text ?? "Error";
        return new Text(theme.fg("error", msg), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      const count = (d?.count as number) ?? 0;
      const ok = (d?.successCount as number) ?? count;
      const icon = ok === count ? theme.fg("success", "✓") : theme.fg("warning", "◐");
      let summary = icon + " " + theme.fg("muted", `${ok}/${count} subagent(s) finished`);
      return new Text(summary, 0, 0);
    },
  });
}
