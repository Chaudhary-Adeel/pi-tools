// Tests for lib/harness.ts — delegation heuristics and nudge state machine.

import { test, describe } from "node:test";
import assert from "node:assert";

import {
  DelegationTracker,
  DEFAULT_THRESHOLDS,
  estimateSubtasks,
  isResearchTool,
  parallelizationHint,
} from "../src/lib/harness.ts";

describe("isResearchTool", () => {
  test("classifies research vs mutating tools", () => {
    assert.ok(isResearchTool("read"));
    assert.ok(isResearchTool("grep_search"));
    assert.ok(isResearchTool("code_references"));
    assert.ok(isResearchTool("web_search"));
    assert.ok(!isResearchTool("edit"));
    assert.ok(!isResearchTool("write"));
    assert.ok(!isResearchTool("bash"));
    assert.ok(!isResearchTool("spawn_subagents"));
  });
});

describe("estimateSubtasks", () => {
  test("empty prompt → 0", () => {
    assert.strictEqual(estimateSubtasks("  "), 0);
  });

  test("simple single ask → 1", () => {
    assert.strictEqual(estimateSubtasks("Fix the typo in README"), 1);
  });

  test("bullet lists count items", () => {
    const prompt = "Please do:\n- add tests\n- update docs\n- fix the linter";
    assert.strictEqual(estimateSubtasks(prompt), 3);
  });

  test("numbered lists count items", () => {
    const prompt = "1. audit auth\n2. audit billing\n3. audit exports\n4. summarize";
    assert.strictEqual(estimateSubtasks(prompt), 4);
  });

  test("repo-wide sweep → at least 3", () => {
    assert.ok(estimateSubtasks("Review the entire codebase for dead code") >= 3);
    assert.ok(estimateSubtasks("scan repo and improve efficiency") >= 3);
  });

  test("conjunction-joined multi-part asks", () => {
    const n = estimateSubtasks("Add logging to the server; also update the client, and then write docs");
    assert.ok(n >= 3, `got ${n}`);
  });
});

describe("DelegationTracker — streak nudge", () => {
  const research = (t: DelegationTracker, n: number) => {
    for (let i = 0; i < n; i++) t.recordToolStart("read_file");
  };

  test("fires exactly once at the streak threshold", () => {
    const t = new DelegationTracker();
    t.beginLoop();
    research(t, DEFAULT_THRESHOLDS.streak - 1);
    assert.strictEqual(t.maybeStreakNudge(), undefined);
    research(t, 1);
    const nudge = t.maybeStreakNudge();
    assert.ok(nudge?.includes("spawn_subagents"));
    // Not again within the same loop, however long the streak grows.
    research(t, 10);
    assert.strictEqual(t.maybeStreakNudge(), undefined);
  });

  test("suppressed when the loop already spawned subagents", () => {
    const t = new DelegationTracker();
    t.beginLoop();
    t.recordToolStart("spawn_subagents", 4);
    research(t, 10);
    assert.strictEqual(t.maybeStreakNudge(), undefined);
  });

  test("resets per loop, capped per session", () => {
    const t = new DelegationTracker();
    for (let loop = 0; loop < DEFAULT_THRESHOLDS.maxStreakNudges; loop++) {
      t.beginLoop();
      research(t, DEFAULT_THRESHOLDS.streak);
      assert.ok(t.maybeStreakNudge(), `loop ${loop} should nudge`);
    }
    t.beginLoop();
    research(t, DEFAULT_THRESHOLDS.streak);
    assert.strictEqual(t.maybeStreakNudge(), undefined, "session cap reached");
  });
});

describe("DelegationTracker — context nudge", () => {
  test("fires once above the threshold with enough research", () => {
    const t = new DelegationTracker();
    t.beginLoop();
    for (let i = 0; i < DEFAULT_THRESHOLDS.contextMinResearch; i++) t.recordToolStart("grep_search");
    assert.strictEqual(t.maybeContextNudge(30), undefined, "below threshold");
    const nudge = t.maybeContextNudge(72);
    assert.ok(nudge?.includes("72%"));
    assert.strictEqual(t.maybeContextNudge(90), undefined, "once per session");
  });

  test("ignores unknown usage and idle loops", () => {
    const t = new DelegationTracker();
    t.beginLoop();
    assert.strictEqual(t.maybeContextNudge(null), undefined);
    assert.strictEqual(t.maybeContextNudge(95), undefined, "no research yet");
  });
});

describe("stats", () => {
  test("accumulates and formats", () => {
    const t = new DelegationTracker();
    t.beginLoop();
    t.recordPromptAnalysis(4, true);
    t.recordToolStart("read_file");
    t.recordToolStart("spawn_subagents", 3);
    const out = t.formatStats();
    assert.match(out, /agent loops:\s+1/);
    assert.match(out, /research calls:\s+1/);
    assert.match(out, /1 \(3 tasks\)/);
    assert.match(out, /hints injected:\s+1/);
  });

  test("parallelizationHint mentions the estimate and the tool", () => {
    const hint = parallelizationHint(5);
    assert.match(hint, /~5 independent subtasks/);
    assert.match(hint, /spawn_subagents/);
  });
});
