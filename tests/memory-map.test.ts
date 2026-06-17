import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  computeFootprint,
  computeStats,
  estimateTokens,
} from "../src/lib/memory-map.ts";

// ── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function writeFile(relPath: string, content: string): string {
  const fp = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf-8");
  return fp;
}

before(() => {
  tmpDir = path.join(os.tmpdir(), "pi-memmap-test-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cleanMemory() {
  const mem = path.join(tmpDir, ".pi");
  if (fs.existsSync(mem)) fs.rmSync(mem, { recursive: true, force: true });
}

// ─── estimateTokens ─────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("estimates ASCII text (chars / 4)", () => {
    // 100 chars -> ceil(100/4) = 25
    assert.equal(estimateTokens("x".repeat(100)), 25);
  });

  it("estimates Unicode text", () => {
    // "你好世界" = 4 chars -> ceil(4/4) = 1
    assert.equal(estimateTokens("你好世界"), 1);
  });

  it("rounds up for partial token boundary", () => {
    // 5 chars -> ceil(5/4) = 2
    assert.equal(estimateTokens("12345"), 2);
    // 4 chars -> ceil(4/4) = 1
    assert.equal(estimateTokens("1234"), 1);
  });

  it("handles multi-byte and emoji characters", () => {
    const text = "Hello 🌍 world — Unicode!";
    const result = estimateTokens(text);
    assert.ok(result > 0);
    assert.equal(typeof result, "number");
  });

  it("handles long text", () => {
    const text = "x".repeat(4000);
    assert.equal(estimateTokens(text), 1000);
  });
});

// ─── computeFootprint ──────────────────────────────────────────────────────

describe("computeFootprint", () => {
  it("returns hasMemory:false when no memory dir exists", () => {
    cleanMemory();
    const fp = computeFootprint(tmpDir);
    assert.equal(fp.hasMemory, false);
    assert.equal(fp.memoryRoot, null);
    assert.equal(fp.totalBytes, 0);
    assert.equal(fp.totalTokens, 0);
    assert.equal(fp.injectedBytes, 0);
    assert.equal(fp.injectedTokens, 0);
    assert.equal(fp.budgetUtilization, 0);
    assert.equal(fp.progress, null);
    assert.deepEqual(fp.systemFiles, []);
    assert.deepEqual(fp.learningFiles, []);
  });

  it("returns hasMemory:true with empty dirs when only .pi/memory exists", () => {
    cleanMemory();
    const root = path.join(tmpDir, ".pi", "memory");
    fs.mkdirSync(path.join(root, "system"), { recursive: true });
    fs.mkdirSync(path.join(root, "learnings"), { recursive: true });

    const fp = computeFootprint(tmpDir);
    assert.equal(fp.hasMemory, true);
    assert.equal(fp.memoryRoot, root);
    assert.equal(fp.systemFiles.length, 0);
    assert.equal(fp.learningFiles.length, 0);
    assert.equal(fp.totalBytes, 0);
    assert.equal(fp.totalTokens, 0);
  });

  it("counts system and learning files correctly", () => {
    cleanMemory();
    writeFile(".pi/memory/system/conventions.md", [
      "---", 'description: "Conventions"', "priority: 1", "---",
      "Use 2-space indent.",
    ].join("\n"));
    writeFile(".pi/memory/system/commands.md", [
      "---", 'description: "Commands"', "priority: 2", "---",
      "npm run build",
    ].join("\n"));
    writeFile(".pi/memory/learnings/testing.md", [
      "---", 'description: "Testing"', "---",
      "# Testing strategies",
    ].join("\n"));

    const fp = computeFootprint(tmpDir);
    assert.equal(fp.hasMemory, true);
    assert.equal(fp.systemFiles.length, 2);
    assert.equal(fp.learningFiles.length, 1);
    assert.ok(fp.totalBytes > 0);
    assert.ok(fp.totalTokens > 0);
  });

  it("computes injected tokens from system files only", () => {
    cleanMemory();
    writeFile(".pi/memory/system/a.md", [
      "---", "description: A", "---", "ABCD".repeat(10), // 40 chars = 10 tokens
    ].join("\n"));
    writeFile(".pi/memory/learnings/b.md", [
      "---", "description: B", "---", "x".repeat(400), // 100 tokens in body (plus meta)
    ].join("\n"));

    const fp = computeFootprint(tmpDir);
    // injectedTokens = tokens of system file raw content
    assert.ok(fp.injectedTokens > 0);
    // totalTokens should be larger than injectedTokens (includes learnings)
    assert.ok(fp.totalTokens > fp.injectedTokens);
    assert.ok(fp.totalBytes > fp.injectedBytes);
  });

  it("computes budget utilization", () => {
    cleanMemory();
    writeFile(".pi/memory/system/big.md", [
      "---", "description: Big", "---", "x".repeat(800), // ~200 tokens
    ].join("\n"));

    const budget = 400;
    const fp = computeFootprint(tmpDir, budget);
    assert.ok(fp.budgetUtilization > 0);
    assert.ok(fp.budgetUtilization <= 100);
    assert.equal(fp.tokenBudget, budget);
  });

  it("budget utilization is 0 when no system files", () => {
    cleanMemory();
    fs.mkdirSync(path.join(tmpDir, ".pi", "memory", "system"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".pi", "memory", "learnings"), { recursive: true });
    const fp = computeFootprint(tmpDir);
    assert.equal(fp.budgetUtilization, 0);
  });

  it("includes progress if progress.md exists", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: Progress", "---",
      "# My Task", "## Status: Done",
    ].join("\n"));

    const fp = computeFootprint(tmpDir);
    assert.ok(fp.progress);
    assert.equal(fp.progress!.task, "My Task");
    assert.equal(fp.progress!.status, "done");
  });

  it("uses default token budget of 4000", () => {
    cleanMemory();
    fs.mkdirSync(path.join(tmpDir, ".pi", "memory", "system"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".pi", "memory", "learnings"), { recursive: true });
    const fp = computeFootprint(tmpDir);
    assert.equal(fp.tokenBudget, 4000);
  });

  it("handles subdirectory traversal (findMemoryRoot walks up)", () => {
    cleanMemory();
    writeFile(".pi/memory/system/a.md", [
      "---", "description: A", "---", "content",
    ].join("\n"));
    const subDir = path.join(tmpDir, "deeply", "nested", "subdir");
    fs.mkdirSync(subDir, { recursive: true });

    const fp = computeFootprint(subDir);
    assert.equal(fp.hasMemory, true);
    assert.equal(fp.systemFiles.length, 1);
  });
});

// ─── computeStats ──────────────────────────────────────────────────────────

describe("computeStats", () => {
  it("returns zeroes when no memory dir", () => {
    cleanMemory();
    const stats = computeStats(tmpDir);
    assert.equal(stats.systemCount, 0);
    assert.equal(stats.learningCount, 0);
    assert.equal(stats.totalCount, 0);
    assert.equal(stats.totalBytes, 0);
    assert.equal(stats.totalTokens, 0);
    assert.equal(stats.injectedBytes, 0);
    assert.equal(stats.injectedTokens, 0);
    assert.equal(stats.tokenBudget, 4000);
    assert.equal(stats.budgetUtilization, 0);
  });

  it("matches computeFootprint numbers", () => {
    cleanMemory();
    writeFile(".pi/memory/system/a.md", [
      "---", "description: A", "---", "ABCDEFGH", // 8 chars
    ].join("\n"));
    writeFile(".pi/memory/system/b.md", [
      "---", "description: B", "---", "1234", // 4 chars
    ].join("\n"));
    writeFile(".pi/memory/learnings/x.md", [
      "---", "description: X", "---", "learn",
    ].join("\n"));

    const fp = computeFootprint(tmpDir);
    const stats = computeStats(tmpDir);

    assert.equal(stats.systemCount, fp.systemFiles.length);
    assert.equal(stats.learningCount, fp.learningFiles.length);
    assert.equal(stats.totalCount, fp.systemFiles.length + fp.learningFiles.length);
    assert.equal(stats.totalBytes, fp.totalBytes);
    assert.equal(stats.totalTokens, fp.totalTokens);
    assert.equal(stats.injectedBytes, fp.injectedBytes);
    assert.equal(stats.injectedTokens, fp.injectedTokens);
    assert.equal(stats.tokenBudget, fp.tokenBudget);
    assert.equal(stats.budgetUtilization, fp.budgetUtilization);
  });

  it("respects custom token budget", () => {
    cleanMemory();
    fs.mkdirSync(path.join(tmpDir, ".pi", "memory", "system"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".pi", "memory", "learnings"), { recursive: true });
    const stats = computeStats(tmpDir, 8000);
    assert.equal(stats.tokenBudget, 8000);
  });
});
