// Tests for lib/subagent-trace.ts — the persistent "complete story" of a
// subagent run (full prompt, full activity history, final result).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendEvent,
  formatRunList,
  formatRunSummary,
  formatSubagentTrace,
  listRuns,
  makeRunId,
  readManifest,
  readRunTraces,
  readSubagentTrace,
  runDir,
  writeManifest,
  writeSubagentTrace,
  type SubagentTrace,
} from "../src/lib/subagent-trace.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-trace-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseTrace(index: number, overrides: Partial<SubagentTrace> = {}): SubagentTrace {
  return {
    id: `sub-${index + 1}-abcd`,
    index,
    prompt: `Do task ${index}`,
    startedAt: Date.now(),
    events: [],
    ...overrides,
  };
}

describe("makeRunId", () => {
  test("produces distinct, filesystem-safe ids", () => {
    const a = makeRunId();
    const b = makeRunId();
    assert.notStrictEqual(a, b);
    assert.doesNotMatch(a, /[/\\:*?"<>|]/);
  });
});

describe("trace read/write roundtrip", () => {
  test("writes and reads back a subagent trace exactly", () => {
    const trace = baseTrace(0, { context: "background info", model: "test-model" });
    writeSubagentTrace(tmpDir, "run1", trace);
    const back = readSubagentTrace(tmpDir, "run1", 0);
    assert.deepStrictEqual(back, trace);
  });

  test("missing trace returns undefined, never throws", () => {
    assert.strictEqual(readSubagentTrace(tmpDir, "no-such-run", 0), undefined);
  });

  test("manifest roundtrip", () => {
    const manifest = { runId: "run1", startedAt: 100, background: false, total: 2, completed: 1, label: "test batch" };
    writeManifest(tmpDir, manifest);
    assert.deepStrictEqual(readManifest(tmpDir, "run1"), manifest);
  });

  test("writeSubagentTrace overwrites cleanly (no stale fields linger)", () => {
    writeSubagentTrace(tmpDir, "run1", baseTrace(0, { result: "old result" }));
    writeSubagentTrace(tmpDir, "run1", baseTrace(0)); // no `result` this time
    const back = readSubagentTrace(tmpDir, "run1", 0);
    assert.strictEqual(back?.result, undefined);
  });

  test("runDir points inside .pi/subagents/<runId>", () => {
    assert.strictEqual(runDir(tmpDir, "abc"), path.join(tmpDir, ".pi", "subagents", "abc"));
  });
});

describe("appendEvent", () => {
  test("appends with a timestamp, doesn't mutate the input trace", () => {
    const trace = baseTrace(0);
    const updated = appendEvent(trace, { toolName: "read", description: "reading foo.ts" });
    assert.strictEqual(trace.events.length, 0, "original must be untouched");
    assert.strictEqual(updated.events.length, 1);
    assert.strictEqual(updated.events[0]!.toolName, "read");
    assert.ok(typeof updated.events[0]!.ts === "number");
  });

  test("preserves full order across many appends (the actual 'complete story')", () => {
    let trace = baseTrace(0);
    for (let i = 0; i < 50; i++) {
      trace = appendEvent(trace, { toolName: "bash", description: `step ${i}` });
    }
    assert.strictEqual(trace.events.length, 50);
    assert.strictEqual(trace.events[0]!.description, "step 0");
    assert.strictEqual(trace.events[49]!.description, "step 49");
  });

  test("caps pathologically long histories with a head+tail trim, not silent loss", () => {
    let trace = baseTrace(0);
    for (let i = 0; i < 500; i++) {
      trace = appendEvent(trace, { toolName: "bash", description: `step ${i}` });
    }
    assert.ok(trace.events.length < 500, "must be trimmed");
    assert.strictEqual(trace.events[0]!.description, "step 0", "head preserved");
    assert.strictEqual(trace.events[trace.events.length - 1]!.description, "step 499", "tail preserved");
    assert.ok(trace.events.some((e) => e.description.includes("omitted")), "omission is visible, not silent");
  });
});

describe("listRuns", () => {
  test("empty when nothing recorded", () => {
    assert.deepStrictEqual(listRuns(tmpDir), []);
  });

  test("returns run ids newest-first, respects limit", () => {
    for (const id of ["20260101-a", "20260103-c", "20260102-b"]) {
      writeManifest(tmpDir, { runId: id, startedAt: 0, background: false, total: 1, completed: 0, label: "x" });
    }
    const runs = listRuns(tmpDir);
    assert.deepStrictEqual(runs, ["20260103-c", "20260102-b", "20260101-a"]);
    assert.strictEqual(listRuns(tmpDir, 2).length, 2);
  });
});

describe("readRunTraces", () => {
  test("reads all subagent traces for a run per the manifest's total", () => {
    writeManifest(tmpDir, { runId: "run1", startedAt: 0, background: false, total: 3, completed: 3, label: "x" });
    writeSubagentTrace(tmpDir, "run1", baseTrace(0));
    writeSubagentTrace(tmpDir, "run1", baseTrace(1));
    writeSubagentTrace(tmpDir, "run1", baseTrace(2));
    const traces = readRunTraces(tmpDir, "run1");
    assert.strictEqual(traces.length, 3);
    assert.deepStrictEqual(traces.map((t) => t.index), [0, 1, 2]);
  });

  test("missing manifest yields no traces, not a crash", () => {
    assert.deepStrictEqual(readRunTraces(tmpDir, "ghost"), []);
  });
});

describe("formatting", () => {
  test("formatRunList reports an empty state clearly", () => {
    assert.match(formatRunList(tmpDir, []), /No subagent runs/);
  });

  test("formatRunList shows status, progress, and label per run", () => {
    writeManifest(tmpDir, { runId: "run1", startedAt: Date.now() - 5000, finishedAt: Date.now(), background: false, total: 2, completed: 2, label: "audit the repo" });
    const out = formatRunList(tmpDir, ["run1"]);
    assert.match(out, /run1/);
    assert.match(out, /2\/2/);
    assert.match(out, /audit the repo/);
    assert.match(out, /done/);
  });

  test("formatRunSummary lists every subagent with status and prompt preview", () => {
    writeManifest(tmpDir, { runId: "run1", startedAt: 0, background: false, total: 2, completed: 1, label: "x" });
    writeSubagentTrace(tmpDir, "run1", baseTrace(0, { exitCode: 0, finishedAt: 100 }));
    writeSubagentTrace(tmpDir, "run1", baseTrace(1)); // still running
    const out = formatRunSummary(tmpDir, "run1");
    assert.match(out, /#1 \[sub-1-abcd\] ✓/);
    assert.match(out, /#2 \[sub-2-abcd\] ⟳ running/);
  });

  test("formatRunSummary reports a missing run without crashing", () => {
    assert.match(formatRunSummary(tmpDir, "ghost"), /No run found/);
  });

  test("formatSubagentTrace includes the FULL prompt, not a truncated preview", () => {
    const longPrompt = "x".repeat(5000);
    const trace = baseTrace(0, { prompt: longPrompt, exitCode: 0, finishedAt: 1000, result: "final answer" });
    const out = formatSubagentTrace(trace);
    assert.ok(out.includes(longPrompt), "full prompt must be present, unlike the 100-char widget preview");
    assert.match(out, /final answer/);
  });

  test("formatSubagentTrace renders the full activity timeline in order", () => {
    let trace = baseTrace(0, { exitCode: 0 });
    trace = appendEvent(trace, { toolName: "read", description: "reading a.ts" });
    trace = appendEvent(trace, { toolName: "grep_search", description: "searching for foo" });
    const out = formatSubagentTrace(trace);
    const readIdx = out.indexOf("reading a.ts");
    const grepIdx = out.indexOf("searching for foo");
    assert.ok(readIdx > 0 && grepIdx > readIdx, "events must appear in chronological order");
  });
});
