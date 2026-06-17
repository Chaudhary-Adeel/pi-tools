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
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, errorText, truncate, getPiCommand } from "../lib/shared.ts";
import { addSubagentUsage, type SubagentUsage } from "../lib/subagent-tokens.ts";

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
  usage: SubagentUsage;
}

interface SubActivity {
  index: number;
  toolName: string;
  description: string;
}

/** Build a human-readable label from a tool name + args. */
function describeTool(toolName: string, args: Record<string, unknown>): string {
  const path = (args.path ?? args.file_path ?? args.filePath ?? args.url ?? "") as string;
  const query = args.query ?? args.pattern ?? "";
  const cmd = (args.command ?? "") as string;
  switch (toolName) {
    case "read":
    case "read_file": return `reading ${shortPath(path)}`;
    case "write": return `writing ${shortPath(path)}`;
    case "edit": return `editing ${shortPath(path)}`;
    case "bash": return `bash: ${shortCmd(cmd)}`;
    case "grep_search": return `searching for "${query}"`;
    case "glob_files": return `finding ${query}`;
    case "web_fetch": return `fetching ${shortPath(path)}`;
    case "web_search": return `web search: "${query}"`;
    case "spawn_subagents": return `spawning sub-subagents`;
    case "browser_navigate": return `navigating to ${shortPath(path)}`;
    case "browser_snapshot": return `taking page snapshot`;
    case "memory_search": return `searching memory for "${query}"`;
    default: return toolName;
  }
}

function shortPath(p: string): string {
  if (!p) return "?";
  const parts = p.split("/");
  return parts.slice(-2).join("/") || p;
}

function shortCmd(cmd: string): string {
  if (!cmd) return "?";
  const firstLine = cmd.split("\n")[0]!.trim();
  return firstLine.length > 50 ? firstLine.slice(0, 47) + "…" : firstLine;
}

// ── core: run one subagent ─────────────────────────────────────────────────

function runOne(
  cwd: string,
  task: SubTask,
  index: number,
  signal?: AbortSignal,
  onActivity?: (activity: SubActivity) => void,
): Promise<SubResult> {
  return new Promise((resolve) => {
    const result: SubResult = {
      index,
      prompt: task.prompt,
      output: "",
      exitCode: 0,
      stderr: "",
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
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

      // Report tool execution activity (live visibility)
      if (event.type === "tool_execution_start" && event.toolName) {
        const desc = describeTool(event.toolName, event.args ?? {});
        onActivity?.({ index, toolName: event.toolName, description: desc });
      }
      if (event.type === "tool_execution_update" && event.toolName && event.partialResult) {
        // Show tool progress (e.g., file read offset, download progress)
        const detail = typeof event.partialResult === "string"
          ? event.partialResult.slice(0, 40)
          : "";
        if (detail) {
          onActivity?.({ index, toolName: event.toolName, description: `${event.toolName}: ${detail}` });
        }
      }

      // Track the last assistant message_end for the final output.
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        if (msg.role === "assistant") {
          result.turns++;
          result.usage.turns = result.turns;
          if (msg.usage) {
            result.usage.input += msg.usage.input || 0;
            result.usage.output += msg.usage.output || 0;
            result.usage.cacheRead += (msg.usage as any).cacheRead ?? 0;
            result.usage.cacheWrite += (msg.usage as any).cacheWrite ?? 0;
            result.usage.cost += (msg.usage as any).cost?.total ?? 0;
          }
          if (!result.model && msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          // Collect assistant text (append for multi-turn subagents)
          for (const part of msg.content) {
            if (part.type === "text") {
              result.output = result.output ? `${result.output}\n\n${part.text}` : part.text;
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
  onActivity?: (activity: SubActivity) => void,
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
      results[current] = await runOne(cwd, tasks[current], current, signal, onActivity);
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
      "Give each subagent a self-contained prompt: it cannot see this conversation, so include every fact, path, and constraint it needs.",
      "When subagent results would be large (extensive code, long reports), set output_to_files: true to write results to temp files instead of bloating the main context window. Read files with Pi's built-in read tool when you need the full output.",
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
      output_to_files: Type.Optional(
        Type.Boolean({
          description:
            "If true, write subagent results to temp files instead of returning " +
            "them inline. Returns file paths with brief summaries. This keeps " +
            "subagent result text OUT of the main context window entirely, so " +
            "the context bar won't bloat. Read the files with Pi's built-in read " +
            "tool when you need the full results. Default: false (inline results).",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const tasks: SubTask[] = (params.tasks as SubTask[]) ?? [];
      if (tasks.length === 0) return text("No tasks provided.");

      const concurrency = Math.min(16, Math.max(1, params.max_concurrency ?? 4));
      const total = tasks.length;
      const label = total === 1 ? "subagent" : "subagents";

      // Show visible notification in the chat + status bar
      ctx.ui.notify(`🚀 Spawning ${total} ${label}…`, "info");
      ctx.ui.setStatus(`${total} ${label} running…`);

      // Live activity widget — compact single-line indicator of subagent progress.
      // Detailed results are in the chat output; this is just an at-a-glance widget.
      const activityLog = new Map<number, string>();
      // Seed with prompt summaries so the user can inspect them at a glance
      for (let i = 0; i < tasks.length; i++) {
        const preview = tasks[i].prompt.length > 100
          ? tasks[i].prompt.slice(0, 97) + "…"
          : tasks[i].prompt;
        activityLog.set(i, `prompt: ${preview}`);
      }
      let doneCount = 0;
      const renderWidget = () => {
        if (activityLog.size === 0) return;
        const sorted = [...activityLog.entries()].sort(([a], [b]) => a - b);
        const termWidth = process.stdout.columns ?? 80;
        const prefix = `⟳ ${doneCount}/${total} | `;
        // Very narrow terminal — just the count
        if (termWidth < prefix.length + 10) {
          ctx.ui.setWidget("subagents", [`⟳ ${doneCount}/${total}`]);
          return;
        }
        // Compact single line: ⟳ done/total | #1 desc | #2 desc …
        let line = prefix;
        let remaining = termWidth - prefix.length;
        let first = true;
        for (const [idx, desc] of sorted) {
          const entry = `#${idx + 1} ${desc}`;
          const sep = first ? "" : " | ";
          if (remaining >= sep.length + 4) {
            const max = remaining - sep.length;
            const shown = entry.length <= max ? entry : entry.slice(0, max - 1) + "…";
            line += sep + shown;
            remaining -= sep.length + shown.length;
            first = false;
          } else {
            break;
          }
        }
        ctx.ui.setWidget("subagents", [line]);
      };
      renderWidget(); // show prompts immediately

      try {
        const results = await runAll(
          tasks,
          concurrency,
          ctx.cwd,
          signal,
          (done) => {
            doneCount = done;
            const icon = done < total ? "⟳" : "✓";
            ctx.ui.setStatus(`${icon} ${done}/${total} ${label} finished`);
            renderWidget();
            onUpdate?.({
              content: [{ type: "text", text: `Subagents finished: ${done}/${total}` }],
            });
          },
          (activity) => {
            activityLog.set(activity.index, activity.description);
            renderWidget();
          },
        );

        // Sort by original index
        results.sort((a, b) => a.index - b.index);

        // Keep the final widget state visible for 2s, then clear
        setTimeout(() => ctx.ui.setWidget("subagents", undefined), 2000);

        const body = results
          .map((r) => {
            const status = r.exitCode === 0 ? "✓" : `✗ (exit ${r.exitCode})`;
            const header = `### Subagent ${r.index + 1}  ${status}\nTask: ${r.prompt}`;
            const out = r.output || r.stderr || "(no output)";
            return `${header}\n\nResult:\n${out}`;
          })
          .join("\n\n---\n\n");

        const resultBody = truncate(body, 40_000);

        // Clear status bar, show completion notification
        ctx.ui.setStatus(undefined);
        const icon = results.every((r) => r.exitCode === 0) ? "✓" : "⚠";
        ctx.ui.notify(`${icon} ${results.length}/${total} ${label} completed`, "info");

        // ── Accumulate subagent LLM usage into the tracker so the ──
        // ── main footer can show the combined total.               ──
        const agg: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        for (const r of results) {
          agg.input += r.usage.input;
          agg.output += r.usage.output;
          agg.cacheRead += r.usage.cacheRead;
          agg.cacheWrite += r.usage.cacheWrite;
          agg.cost += r.usage.cost;
          agg.turns += r.usage.turns;
        }
        addSubagentUsage(agg);

        // ── File-output mode: persist results to disk, return references ──
        if (params.output_to_files) {
          const tmpDir = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), "pi-subagent-"),
          );
          const filePaths: string[] = [];
          for (const r of results) {
            const fname = `subagent-${r.index + 1}-result.md`;
            const fp = path.join(tmpDir, fname);
            const status = r.exitCode === 0 ? "✓" : `✗ (exit ${r.exitCode})`;
            const content = `# Subagent ${r.index + 1}  ${status}\n\n**Task:** ${r.prompt}\n\n**Result:**\n${r.output || r.stderr || "(no output)"}`;
            await fs.promises.writeFile(fp, content, "utf-8");
            filePaths.push(fp);
          }

          // Return compact references — NOT the full text. This keeps the
          // context window lean.
          const refSummary = results
            .map((r, i) => {
              const status = r.exitCode === 0 ? "✓" : `✗`;
              const preview = (r.output || r.stderr || "").slice(0, 120);
              return `${status} **Subagent ${r.index + 1}:** ${r.prompt.slice(0, 80)}… → \`${filePaths[i]}\`\n> ${preview}…`;
            })
            .join("\n\n");

          return text(
            `Subagent results written to ${tmpDir}/\n\n${refSummary}\n\nUse Pi's \`read\` tool to load full results.`,
            {
              count: results.length,
              successCount: results.filter((r) => r.exitCode === 0).length,
              prompts: results.map((r) => r.prompt),
              models: results.map((r) => r.model).filter(Boolean),
              totalTurns: results.reduce((s, r) => s + r.turns, 0),
              subagentUsage: agg,
              outputDir: tmpDir,
              outputFiles: filePaths,
            },
          );
        }

        // ── Inline mode (default) ──
        return text(resultBody, {
          count: results.length,
          successCount: results.filter((r) => r.exitCode === 0).length,
          prompts: results.map((r) => r.prompt),
          models: results.map((r) => r.model).filter(Boolean),
          totalTurns: results.reduce((s, r) => s + r.turns, 0),
          subagentUsage: agg,
        });
      } catch (_err) {
        ctx.ui.setStatus(undefined);
        ctx.ui.setWidget("subagents", undefined);
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
