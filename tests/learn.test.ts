// Tests for lib/learn.ts — session summary building and meaningful-activity
// heuristic. These functions are pure (no I/O, no Pi APIs) so they are
// directly unit-testable without any filesystem setup.

import { test, describe } from "node:test";
import assert from "node:assert";

import {
  buildSessionSummary,
  hasMeaningfulActivity,
  type SessionSummary,
} from "../src/lib/learn.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal session entry shaped like what ctx.sessionManager.getBranch() returns. */
function userMsg(text: string) {
  return { type: "message", message: { role: "user", content: text } };
}

function assistantMsg(text: string, toolCalls: unknown[] = []) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }, ...toolCalls],
    },
  };
}

function editToolCall(filePath: string) {
  return { type: "toolCall", name: "edit", arguments: { path: filePath } };
}

function writeToolCall(filePath: string) {
  return { type: "toolCall", name: "write", arguments: { path: filePath } };
}

// ── buildSessionSummary ──────────────────────────────────────────────────────

describe("buildSessionSummary", () => {
  test("empty entries → empty summary with zero counts", () => {
    const s = buildSessionSummary([]);
    assert.strictEqual(s.userTurns, 0);
    assert.strictEqual(s.assistantTurns, 0);
    assert.strictEqual(s.filesChanged.length, 0);
    assert.strictEqual(s.transcript, "");
  });

  test("counts user and assistant turns correctly", () => {
    const s = buildSessionSummary([
      userMsg("Hello"),
      assistantMsg("Hi there"),
      userMsg("Do something"),
      assistantMsg("Done"),
    ]);
    assert.strictEqual(s.userTurns, 2);
    assert.strictEqual(s.assistantTurns, 2);
  });

  test("builds transcript with USER: and ASSISTANT: prefixes", () => {
    const s = buildSessionSummary([
      userMsg("Fix the bug"),
      assistantMsg("Fixed it"),
    ]);
    assert.match(s.transcript, /USER: Fix the bug/);
    assert.match(s.transcript, /ASSISTANT: Fixed it/);
  });

  test("captures file paths from edit tool calls", () => {
    const s = buildSessionSummary([
      userMsg("Edit a file"),
      assistantMsg("Done", [editToolCall("src/lib/foo.ts")]),
    ]);
    assert.ok(s.filesChanged.includes("src/lib/foo.ts"));
  });

  test("captures file paths from write tool calls", () => {
    const s = buildSessionSummary([
      userMsg("Write a file"),
      assistantMsg("Done", [writeToolCall("src/new.ts")]),
    ]);
    assert.ok(s.filesChanged.includes("src/new.ts"));
  });

  test("deduplicates files edited multiple times", () => {
    const s = buildSessionSummary([
      userMsg("Edit twice"),
      assistantMsg("First edit", [editToolCall("src/shared.ts")]),
      assistantMsg("Second edit", [editToolCall("src/shared.ts")]),
    ]);
    assert.strictEqual(
      s.filesChanged.filter((f) => f === "src/shared.ts").length,
      1,
      "same path should appear only once",
    );
  });

  test("multiple different files are all captured", () => {
    const s = buildSessionSummary([
      userMsg("Edit many"),
      assistantMsg("Done", [
        editToolCall("a.ts"),
        writeToolCall("b.ts"),
        editToolCall("c.ts"),
      ]),
    ]);
    assert.ok(s.filesChanged.includes("a.ts"));
    assert.ok(s.filesChanged.includes("b.ts"));
    assert.ok(s.filesChanged.includes("c.ts"));
  });

  test("ignores non-message entry types", () => {
    const s = buildSessionSummary([
      { type: "tool_result", output: "something" },
      { type: "system", content: "init" },
      userMsg("Hi"),
    ]);
    assert.strictEqual(s.userTurns, 1);
    assert.strictEqual(s.assistantTurns, 0);
  });

  test("content as plain string (non-array) is still extracted", () => {
    const s = buildSessionSummary([
      {
        type: "message",
        message: { role: "user", content: "plain string user message" },
      },
    ]);
    assert.match(s.transcript, /plain string user message/);
    assert.strictEqual(s.userTurns, 1);
  });

  test("assistant messages with no text part still count as a turn", () => {
    const s = buildSessionSummary([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
        },
      },
    ]);
    assert.strictEqual(s.assistantTurns, 1);
  });
});

// ── hasMeaningfulActivity ─────────────────────────────────────────────────────

describe("hasMeaningfulActivity", () => {
  function make(overrides: Partial<SessionSummary>): SessionSummary {
    return {
      transcript: "",
      filesChanged: [],
      userTurns: 0,
      assistantTurns: 0,
      ...overrides,
    };
  }

  test("any file edited → meaningful", () => {
    assert.ok(hasMeaningfulActivity(make({ filesChanged: ["x.ts"], userTurns: 1, assistantTurns: 1 })));
  });

  test("no turns at all → not meaningful", () => {
    assert.ok(!hasMeaningfulActivity(make({})));
  });

  test("user turn but no assistant turn → not meaningful", () => {
    assert.ok(!hasMeaningfulActivity(make({ userTurns: 2 })));
  });

  test("only one exchange and no keywords, short transcript → not meaningful", () => {
    assert.ok(!hasMeaningfulActivity(make({ userTurns: 1, assistantTurns: 1, transcript: "hi there" })));
  });

  test("3+ back-and-forth exchanges → meaningful", () => {
    assert.ok(
      hasMeaningfulActivity(make({ userTurns: 3, assistantTurns: 3, transcript: "some content" })),
    );
  });

  test("'remember' keyword in transcript → meaningful even with 1 exchange", () => {
    assert.ok(
      hasMeaningfulActivity(
        make({ userTurns: 1, assistantTurns: 1, transcript: "please remember this gotcha" }),
      ),
    );
  });

  test("'note this' keyword → meaningful", () => {
    assert.ok(
      hasMeaningfulActivity(
        make({ userTurns: 1, assistantTurns: 1, transcript: "note this pattern for later" }),
      ),
    );
  });

  test("'don't forget' keyword → meaningful", () => {
    assert.ok(
      hasMeaningfulActivity(
        make({ userTurns: 1, assistantTurns: 1, transcript: "don't forget to update the docs" }),
      ),
    );
  });

  test("long transcript ≥ 600 chars → meaningful (enough content to distill)", () => {
    assert.ok(
      hasMeaningfulActivity(
        make({ userTurns: 1, assistantTurns: 1, transcript: "x".repeat(600) }),
      ),
    );
  });

  test("transcript just under 600 chars with 1 exchange → not meaningful", () => {
    assert.ok(
      !hasMeaningfulActivity(
        make({ userTurns: 1, assistantTurns: 1, transcript: "x".repeat(599) }),
      ),
    );
  });

  test("keyword check is case-insensitive", () => {
    assert.ok(
      hasMeaningfulActivity(
        make({ userTurns: 1, assistantTurns: 1, transcript: "Please REMEMBER this" }),
      ),
    );
  });
});
