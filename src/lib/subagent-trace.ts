// Subagent trace — the persistent "complete story" of a subagent run.
//
// spawn_subagents' live widget is transient UI: it shows the LATEST activity
// per subagent and disappears a couple seconds after the batch finishes.
// Before this module, that was the only visibility into what a subagent
// actually did — its full tool-by-tool history was never recorded anywhere,
// only the final answer. This module makes every run inspectable, during
// and after: full untruncated prompt, full activity timeline, full result.
//
// Layout: .pi/subagents/<runId>/manifest.json + subagent-<n>.json
// One JSON file per subagent, overwritten (not appended) on each update —
// small files, simplest correct approach, no append-consistency concerns.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface TraceEvent {
  ts: number;
  toolName: string;
  description: string;
}

export interface SubagentTrace {
  id: string;
  index: number;
  prompt: string;
  context?: string;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  events: TraceEvent[];
  result?: string;
}

export interface RunManifest {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  background: boolean;
  total: number;
  completed: number;
  label: string;
}

// Bounded like Quiet Output's compaction: a pathological subagent loop
// shouldn't grow a trace file without limit. Head+tail keeps the story
// coherent (what it started with, what it ended with) even when trimmed.
const MAX_EVENTS = 400;
const EVENT_HEAD = 200;
const EVENT_TAIL = 200;

export function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function subagentsRoot(cwd: string): string {
  return path.join(cwd, ".pi", "subagents");
}

export function runDir(cwd: string, runId: string): string {
  return path.join(subagentsRoot(cwd), runId);
}

function traceFile(cwd: string, runId: string, index: number): string {
  return path.join(runDir(cwd, runId), `subagent-${index + 1}.json`);
}

function manifestFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), "manifest.json");
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function writeManifest(cwd: string, manifest: RunManifest): void {
  writeJson(manifestFile(cwd, manifest.runId), manifest);
}

export function readManifest(cwd: string, runId: string): RunManifest | undefined {
  return readJson<RunManifest>(manifestFile(cwd, runId));
}

export function writeSubagentTrace(cwd: string, runId: string, trace: SubagentTrace): void {
  writeJson(traceFile(cwd, runId, trace.index), trace);
}

export function readSubagentTrace(cwd: string, runId: string, index: number): SubagentTrace | undefined {
  return readJson<SubagentTrace>(traceFile(cwd, runId, index));
}

/** Append an event to a trace's in-memory event list, applying the
 *  head+tail cap. Pure — callers persist the returned trace themselves. */
export function appendEvent(trace: SubagentTrace, event: Omit<TraceEvent, "ts">): SubagentTrace {
  const events = [...trace.events, { ...event, ts: Date.now() }];
  if (events.length <= MAX_EVENTS) return { ...trace, events };
  const omitted = events.length - EVENT_HEAD - EVENT_TAIL;
  const trimmed = [
    ...events.slice(0, EVENT_HEAD),
    { ts: Date.now(), toolName: "…", description: `[${omitted} earlier events omitted]` },
    ...events.slice(events.length - EVENT_TAIL),
  ];
  return { ...trace, events: trimmed };
}

/** Most recent run ids, newest first. */
export function listRuns(cwd: string, limit = 20): string[] {
  try {
    return fs
      .readdirSync(subagentsRoot(cwd), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function readRunTraces(cwd: string, runId: string): SubagentTrace[] {
  const manifest = readManifest(cwd, runId);
  const total = manifest?.total ?? 0;
  const traces: SubagentTrace[] = [];
  for (let i = 0; i < total; i++) {
    const t = readSubagentTrace(cwd, runId, i);
    if (t) traces.push(t);
  }
  return traces;
}

// ── formatting for /subagents ───────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRunList(cwd: string, runIds: string[]): string {
  if (runIds.length === 0) return "No subagent runs recorded yet.";
  const lines = ["Recent subagent runs:"];
  for (const runId of runIds) {
    const m = readManifest(cwd, runId);
    if (!m) continue;
    const status = m.finishedAt ? "✓ done" : m.background ? "⟳ running (background)" : "⟳ running";
    const dur = m.finishedAt ? ` in ${fmtDuration(m.finishedAt - m.startedAt)}` : "";
    lines.push(`  ${runId}  ${status}  ${m.completed}/${m.total} — ${m.label}${dur}`);
  }
  lines.push("\nUse '/subagents <runId>' for a run's summary, '/subagents <runId> <n>' for one subagent's full trace.");
  return lines.join("\n");
}

export function formatRunSummary(cwd: string, runId: string): string {
  const manifest = readManifest(cwd, runId);
  if (!manifest) return `No run found: ${runId}`;
  const traces = readRunTraces(cwd, runId);
  const lines = [
    `Run ${runId} — ${manifest.completed}/${manifest.total} complete${manifest.background ? " (background)" : ""}`,
    `Task: ${manifest.label}`,
    "",
  ];
  for (const t of traces) {
    const status = t.exitCode === undefined ? "⟳ running" : t.exitCode === 0 ? "✓" : `✗ (exit ${t.exitCode})`;
    const dur = t.finishedAt ? ` — ${fmtDuration(t.finishedAt - t.startedAt)}` : "";
    lines.push(`#${t.index + 1} [${t.id}] ${status}${dur} — ${t.events.length} event(s)`);
    lines.push(`   ${t.prompt.split("\n")[0]!.slice(0, 100)}`);
  }
  lines.push("\nUse '/subagents " + runId + " <n>' for one subagent's full prompt + activity trace.");
  return lines.join("\n");
}

export function formatSubagentTrace(trace: SubagentTrace): string {
  const status = trace.exitCode === undefined ? "⟳ running" : trace.exitCode === 0 ? "✓" : `✗ (exit ${trace.exitCode})`;
  const lines = [`Subagent #${trace.index + 1} [${trace.id}] ${status}`];
  if (trace.model) lines.push(`Model: ${trace.model}`);
  lines.push("", "Full prompt:", trace.prompt);
  if (trace.context) lines.push("", "Context:", trace.context);
  lines.push(
    "",
    `Activity (${trace.events.length} event(s)):`,
    ...trace.events.map((e) => `  [+${fmtDuration(e.ts - trace.startedAt)}] ${e.description}`),
  );
  if (trace.result) lines.push("", "Result:", trace.result);
  return lines.join("\n");
}
