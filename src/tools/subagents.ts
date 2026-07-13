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
//
// Subagents run on a lighter model when one is configured (/config →
// subagentModel, or PI_SUBAGENT_MODEL), and they can never spawn subagents
// themselves: the child process is marked with PI_TOOLS_SUBAGENT=1 and this
// module skips registering spawn_subagents inside marked processes.
//
// Observability & non-blocking mode:
//   Every run writes a full, untruncated trace per subagent (prompt, every
//   tool-call activity event, final result) to .pi/subagents/<runId>/ via
//   lib/subagent-trace.ts — the live widget only ever showed the LATEST
//   activity line and vanished after the run, so that was previously the
//   ONLY visibility into what a subagent actually did. Inspect any run with
//   the /subagents command.
//
//   background: true starts the batch and returns immediately (mirroring
//   /newTask's background mode) instead of blocking the calling turn until
//   every subagent finishes — tracked via the `tasks` tool, with a
//   completion notification when the whole batch is done. Unlike /newTask's
//   detached spawn (meant to survive session exit), this stays attached to
//   the current process: the point is to let the main agent keep working
//   *within this session* while subagents run, not to outlive it.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, getPiCommand } from "../lib/shared.ts";
import { getSubagentModel } from "../lib/config.ts";
import { addSubagentUsage, type SubagentUsage } from "../lib/subagent-tokens.ts";
import { addTasks, updateTask } from "../lib/tasks.ts";
import {
  appendEvent,
  makeRunId,
  runDir,
  writeManifest,
  writeSubagentTrace,
  type SubagentTrace,
} from "../lib/subagent-trace.ts";

/** Set in subagent subprocess environments; blocks nested spawning. */
export const SUBAGENT_ENV_FLAG = "PI_TOOLS_SUBAGENT";

export function isSubagentProcess(): boolean {
  return process.env[SUBAGENT_ENV_FLAG] === "1";
}

// ── types ──────────────────────────────────────────────────────────────────

interface SubTask {
  prompt: string;
  context?: string;
}

interface SubResult {
  /** Stable id for this subagent run, e.g. "sub-2-4fd1". Reported back so
   *  completed work can be referenced unambiguously. */
  id: string;
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

export function makeSubagentId(index: number): string {
  return `sub-${index + 1}-${crypto.randomBytes(2).toString("hex")}`;
}

// ── core: run one subagent ─────────────────────────────────────────────────

interface RunOneOptions {
  cwd: string;
  task: SubTask;
  index: number;
  id: string;
  model?: string;
  signal?: AbortSignal;
  onActivity?: (activity: SubActivity) => void;
}

function runOne(options: RunOneOptions): Promise<SubResult> {
  const { cwd, task, index, id, model, signal, onActivity } = options;
  return new Promise((resolve) => {
    const result: SubResult = {
      id,
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
    // Lighter model for subagents when configured — they do focused,
    // disposable work and don't need the main session's model.
    if (model) args.push("--model", model);
    // Inject optional context as a first user message.
    // For simplicity we pass the full prompt string directly.
    const fullPrompt = (task.context ? `${task.context}\n\n` : "") + task.prompt;
    args.push(`Task: ${fullPrompt}`);

    const proc = spawn(invocation.command, [...invocation.args, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Mark the child so it can never register/spawn nested subagents.
      env: { ...process.env, [SUBAGENT_ENV_FLAG]: "1" },
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

/** Run a single subagent task and await its result. Used by /newTask. */
export function runSubagent(
  cwd: string,
  prompt: string,
  model?: string,
  signal?: AbortSignal,
  onActivity?: (activity: SubActivity) => void,
): Promise<SubagentRunResult> {
  return runOne({ cwd, task: { prompt }, index: 0, id: makeSubagentId(0), model, signal, onActivity });
}

export type SubagentRunResult = SubResult;

// ── concurrency limiter ────────────────────────────────────────────────────

interface RunAllOptions {
  concurrency: number;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
  onActivity?: (activity: SubActivity) => void;
  /** Fired the instant each subagent resolves, before onProgress — used to
   *  finalize that subagent's trace file immediately rather than waiting
   *  for the whole batch. */
  onSubagentDone?: (result: SubResult) => void;
}

async function runAll(tasks: SubTask[], ids: string[], options: RunAllOptions): Promise<SubResult[]> {
  const { concurrency, cwd, model, signal, onProgress, onActivity, onSubagentDone } = options;
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
      const result = await runOne({
        cwd, task: tasks[current]!, index: current, id: ids[current]!, model, signal, onActivity,
      });
      results[current] = result;
      onSubagentDone?.(result);
      done++;
      onProgress?.(done);
    }
  });

  await Promise.all(workers);
  return results.filter(Boolean);
}

// ── tracing helpers ──────────────────────────────────────────────────────────

/** Seed one trace file per task before any subagent starts, so /subagents
 *  shows a "queued" state immediately rather than only after first activity. */
function initTraces(
  cwd: string,
  runId: string,
  tasks: SubTask[],
  ids: string[],
  model: string | undefined,
): Map<number, SubagentTrace> {
  const traces = new Map<number, SubagentTrace>();
  const now = Date.now();
  for (let i = 0; i < tasks.length; i++) {
    const trace: SubagentTrace = {
      id: ids[i]!,
      index: i,
      prompt: tasks[i]!.prompt,
      context: tasks[i]!.context,
      model,
      startedAt: now,
      events: [],
    };
    traces.set(i, trace);
    writeSubagentTrace(cwd, runId, trace);
  }
  return traces;
}

function aggregateUsage(results: SubResult[]): SubagentUsage {
  const agg: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const r of results) {
    agg.input += r.usage.input;
    agg.output += r.usage.output;
    agg.cacheRead += r.usage.cacheRead;
    agg.cacheWrite += r.usage.cacheWrite;
    agg.cost += r.usage.cost;
    agg.turns += r.usage.turns;
  }
  return agg;
}

function formatResultsBody(results: SubResult[]): string {
  return results
    .map((r) => {
      const status = r.exitCode === 0 ? "✓" : `✗ (exit ${r.exitCode})`;
      const header = `### Subagent ${r.index + 1} [${r.id}]  ${status}\nTask: ${r.prompt}`;
      const out = r.output || r.stderr || "(no output)";
      return `${header}\n\nResult:\n${out}`;
    })
    .join("\n\n---\n\n");
}

// ── register ───────────────────────────────────────────────────────────────

export function registerSubagentTool(pi: ExtensionAPI): void {
  // Never register inside a subagent process — subagents must not spawn
  // subagents. The tool simply doesn't exist for them.
  if (isSubagentProcess()) return;

  pi.registerTool({
    name: "spawn_subagents",
    label: "Spawn Subagents",
    description:
      "Run one or more independent subtasks in parallel `pi` subprocesses " +
      "and return each subagent's final answer. Each subagent has its own " +
      "fresh context window, so use this to fan out work (research several " +
      "files/topics at once, draft independent pieces) and keep the main " +
      "context lean. Only the conclusions come back inline — not the " +
      "intermediate steps — but every tool call each subagent makes is " +
      "recorded to a full trace you can inspect with /subagents or by " +
      "reading its file directly. Each completed subagent is reported with " +
      "a stable id (e.g. sub-2-4fd1). Subagents may run on a lighter model " +
      "(configured via /config) and cannot spawn subagents themselves. Set " +
      "background: true to start the batch and keep working yourself " +
      "instead of blocking this turn until every subagent finishes.",
    promptSnippet: "delegate independent subtasks to parallel subagents",
    promptGuidelines: [
      "Give each subagent a self-contained prompt: it cannot see this conversation, so include every fact, path, and constraint it needs.",
      "When subagent results would be large (extensive code, long reports), set output_to_files: true to write results to temp files instead of bloating the main context window. Read files with Pi's built-in read tool when you need the full output.",
      "For a substantial fan-out (3+ subagents, or work likely to take a while), set background: true and keep making progress yourself — implement the parts that don't depend on the subagents' findings, or continue other work — instead of sitting idle on a blocking call. You'll be notified when the batch completes.",
      "If you need to see exactly what a subagent did (not just its final answer), use /subagents <runId> or read the trace file mentioned in the result.",
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
      background: Type.Optional(
        Type.Boolean({
          description:
            "If true, start the batch and return immediately instead of " +
            "blocking until every subagent finishes — you can keep working " +
            "in the meantime. Tracked via the tasks tool; you'll get a " +
            "notification (and a message in this conversation) when the " +
            "whole batch completes. Default: false (wait for all results).",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const tasks: SubTask[] = (params.tasks as SubTask[]) ?? [];
      if (tasks.length === 0) return text("No tasks provided.");

      const concurrency = Math.min(16, Math.max(1, params.max_concurrency ?? 4));
      const total = tasks.length;
      const label = total === 1 ? "subagent" : "subagents";
      const model = getSubagentModel(ctx.cwd);
      const ids = tasks.map((_, i) => makeSubagentId(i));
      const runId = makeRunId();
      const startedAt = Date.now();
      const traceDir = runDir(ctx.cwd, runId);
      const batchLabel = tasks[0]!.prompt.split("\n")[0]!.slice(0, 60) + (total > 1 ? ` (+${total - 1} more)` : "");

      writeManifest(ctx.cwd, {
        runId, startedAt, background: !!params.background,
        total, completed: 0, label: batchLabel,
      });
      const traces = initTraces(ctx.cwd, runId, tasks, ids, model);

      const onActivity = (activity: SubActivity) => {
        const trace = traces.get(activity.index);
        if (!trace) return;
        const updated = appendEvent(trace, { toolName: activity.toolName, description: activity.description });
        traces.set(activity.index, updated);
        writeSubagentTrace(ctx.cwd, runId, updated);
      };

      const onSubagentDone = (result: SubResult) => {
        const trace = traces.get(result.index);
        if (!trace) return;
        const finished: SubagentTrace = {
          ...trace,
          finishedAt: Date.now(),
          exitCode: result.exitCode,
          result: result.output || result.stderr || "(no output)",
        };
        traces.set(result.index, finished);
        writeSubagentTrace(ctx.cwd, runId, finished);
      };

      // ── background: acknowledge now, run + report later ──
      if (params.background) {
        return runInBackground(pi, ctx, {
          tasks, ids, runId, startedAt, traceDir, batchLabel, concurrency, model, total, label,
          onActivity, onSubagentDone,
        });
      }

      // ── blocking (default): show live status, wait for everything ──
      const modelNote = model ? ` (model: ${model})` : "";
      ctx.ui.notify(`🚀 Spawning ${total} ${label}${modelNote}…`, "info");
      ctx.ui.setStatus("subagents", `${total} ${label} running…`);

      // Live activity widget — compact single-line indicator of subagent
      // progress. The FULL history lives in the trace files above; this is
      // just an at-a-glance widget showing each subagent's latest activity.
      const latestActivity = new Map<number, string>();
      for (let i = 0; i < tasks.length; i++) {
        const preview = tasks[i]!.prompt.length > 100 ? tasks[i]!.prompt.slice(0, 97) + "…" : tasks[i]!.prompt;
        latestActivity.set(i, `prompt: ${preview}`);
      }
      let doneCount = 0;
      const renderWidget = () => {
        if (latestActivity.size === 0) return;
        const sorted = [...latestActivity.entries()].sort(([a], [b]) => a - b);
        const termWidth = process.stdout.columns ?? 80;
        const prefix = `⟳ ${doneCount}/${total} | `;
        if (termWidth < prefix.length + 10) {
          ctx.ui.setWidget("subagents", [`⟳ ${doneCount}/${total}`]);
          return;
        }
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
      renderWidget();

      try {
        const results = await runAll(tasks, ids, {
          concurrency, cwd: ctx.cwd, model, signal,
          onProgress: (done) => {
            doneCount = done;
            const icon = done < total ? "⟳" : "✓";
            ctx.ui.setStatus("subagents", `${icon} ${done}/${total} ${label} finished`);
            renderWidget();
            onUpdate?.({ content: [{ type: "text", text: `Subagents finished: ${done}/${total}` }], details: undefined });
          },
          onActivity: (activity) => {
            latestActivity.set(activity.index, activity.description);
            onActivity(activity);
            renderWidget();
          },
          onSubagentDone: (result) => {
            onSubagentDone(result);
            writeManifest(ctx.cwd, {
              runId, startedAt, background: false,
              total, completed: [...traces.values()].filter((t) => t.exitCode !== undefined).length,
              label: batchLabel,
            });
          },
        });

        results.sort((a, b) => a.index - b.index);
        setTimeout(() => ctx.ui.setWidget("subagents", undefined), 2000);

        writeManifest(ctx.cwd, {
          runId, startedAt, finishedAt: Date.now(), background: false,
          total, completed: results.length, label: batchLabel,
        });

        const resultBody = truncate(formatResultsBody(results), 40_000);
        const traceNote = `\n\nFull activity trace for each subagent: ${traceDir}/ (or /subagents ${runId})`;

        ctx.ui.setStatus("subagents", undefined);
        const icon = results.every((r) => r.exitCode === 0) ? "✓" : "⚠";
        const idList = results.map((r) => r.id).join(", ");
        ctx.ui.notify(`${icon} ${results.length}/${total} ${label} completed (${idList})`, "info");

        const agg = aggregateUsage(results);
        addSubagentUsage(agg);

        if (params.output_to_files) {
          const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
          const filePaths: string[] = [];
          for (const r of results) {
            const fname = `subagent-${r.index + 1}-result.md`;
            const fp = path.join(tmpDir, fname);
            const status = r.exitCode === 0 ? "✓" : `✗ (exit ${r.exitCode})`;
            const content = `# Subagent ${r.index + 1} [${r.id}]  ${status}\n\n**Task:** ${r.prompt}\n\n**Result:**\n${r.output || r.stderr || "(no output)"}`;
            await fs.promises.writeFile(fp, content, "utf-8");
            filePaths.push(fp);
          }
          const refSummary = results
            .map((r, i) => {
              const status = r.exitCode === 0 ? "✓" : `✗`;
              const preview = (r.output || r.stderr || "").slice(0, 120);
              return `${status} **Subagent ${r.index + 1} [${r.id}]:** ${r.prompt.slice(0, 80)}… → \`${filePaths[i]}\`\n> ${preview}…`;
            })
            .join("\n\n");

          return text(
            `Subagent results written to ${tmpDir}/\n\n${refSummary}${traceNote}\n\nUse Pi's \`read\` tool to load full results.`,
            {
              count: results.length,
              successCount: results.filter((r) => r.exitCode === 0).length,
              ids: results.map((r) => r.id),
              prompts: results.map((r) => r.prompt),
              models: results.map((r) => r.model).filter(Boolean),
              totalTurns: results.reduce((s, r) => s + r.turns, 0),
              subagentUsage: agg,
              outputDir: tmpDir,
              outputFiles: filePaths,
              runId,
            },
          );
        }

        return text(resultBody + traceNote, {
          count: results.length,
          successCount: results.filter((r) => r.exitCode === 0).length,
          ids: results.map((r) => r.id),
          prompts: results.map((r) => r.prompt),
          models: results.map((r) => r.model).filter(Boolean),
          totalTurns: results.reduce((s, r) => s + r.turns, 0),
          subagentUsage: agg,
          runId,
        });
      } catch (_err) {
        ctx.ui.setStatus("subagents", undefined);
        ctx.ui.setWidget("subagents", undefined);
        throw _err;
      }
    },
    renderCall(args, theme, _context) {
      const tasks = args.tasks as SubTask[] | undefined;
      const n = tasks?.length ?? 0;
      let t = theme.fg("toolTitle", theme.bold("subagents "));
      t += theme.fg("muted", `(${n})`);
      if (args.background) t += theme.fg("accent", " [background]");
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
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      if (d?.background) {
        return new Text(theme.fg("accent", `🚀 ${d.count ?? "?"} subagent(s) started in background`), 0, 0);
      }
      const count = (d?.count as number) ?? 0;
      const ok = (d?.successCount as number) ?? count;
      const ids = (d?.ids as string[] | undefined) ?? [];
      const icon = ok === count ? theme.fg("success", "✓") : theme.fg("warning", "◐");
      let summary = icon + " " + theme.fg("muted", `${ok}/${count} subagent(s) finished`);
      if (ids.length > 0) summary += "  " + theme.fg("dim", ids.join(" "));
      return new Text(summary, 0, 0);
    },
  });
}

// ── background mode ──────────────────────────────────────────────────────────

interface BackgroundOptions {
  tasks: SubTask[];
  ids: string[];
  runId: string;
  startedAt: number;
  traceDir: string;
  batchLabel: string;
  concurrency: number;
  model?: string;
  total: number;
  label: string;
  onActivity: (activity: SubActivity) => void;
  onSubagentDone: (result: SubResult) => void;
}

/** Starts the batch without awaiting it, returning an immediate ack result.
 *  Deliberately NOT tied to the calling turn's abort signal or detached from
 *  this process (see module header) — it runs for the life of this session. */
function runInBackground(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: BackgroundOptions,
): ReturnType<typeof text> {
  const { tasks, ids, runId, startedAt, traceDir, batchLabel, concurrency, model, total, label, onActivity, onSubagentDone } = opts;

  const taskEntries = addTasks(
    ctx.cwd,
    tasks.map((t, i) => `subagent[${runId}#${i + 1}]: ${t.prompt.split("\n")[0]!.slice(0, 60)}`),
  );
  taskEntries.forEach((te, i) =>
    updateTask(ctx.cwd, te.id, { status: "in_progress", notes: `trace: ${traceDir}/subagent-${i + 1}.json` }),
  );

  void (async () => {
    let results: SubResult[] = [];
    try {
      results = await runAll(tasks, ids, {
        concurrency, cwd: ctx.cwd, model,
        onActivity,
        onSubagentDone: (result) => {
          onSubagentDone(result);
          const task = taskEntries[result.index];
          if (task) {
            updateTask(ctx.cwd, task.id, {
              status: result.exitCode === 0 ? "completed" : "pending",
              notes: result.exitCode === 0 ? `[${result.id}] done` : `[${result.id}] failed (exit ${result.exitCode})`,
            });
          }
        },
      });
      results.sort((a, b) => a.index - b.index);

      writeManifest(ctx.cwd, {
        runId, startedAt, finishedAt: Date.now(), background: true,
        total, completed: results.length, label: batchLabel,
      });

      const agg = aggregateUsage(results);
      addSubagentUsage(agg);

      const icon = results.every((r) => r.exitCode === 0) ? "✓" : "⚠";
      const idList = results.map((r) => r.id).join(", ");
      pi.sendMessage(
        {
          customType: "pi-tools:subagents-background-result",
          content: `## Background subagents ${icon} [${runId}]\n\n${truncate(formatResultsBody(results), 40_000)}\n\nFull traces: ${traceDir}/`,
          display: true,
          details: { runId, ids: results.map((r) => r.id), usage: agg },
        },
      );
      ctx.ui.notify(`${icon} background subagents completed (${idList})`, results.every((r) => r.exitCode === 0) ? "info" : "error");
    } catch (err) {
      for (const te of taskEntries) updateTask(ctx.cwd, te.id, { status: "pending", notes: `batch failed: ${(err as Error).message}` });
      ctx.ui.notify(`✗ background subagents [${runId}] failed: ${(err as Error).message}`, "error");
    }
  })();

  return text(
    `🚀 Started ${total} ${label} in background (run ${runId}). Continue your own work — ` +
      `you'll get a message here when the batch completes. Track progress with the tasks tool, ` +
      `/subagents ${runId}, or by reading ${traceDir}/.`,
    { background: true, runId, count: total, taskIds: taskEntries.map((t) => t.id), traceDir },
  );
}
