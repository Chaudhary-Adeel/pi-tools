// Tests for cvm/quiet-output.ts — oversized-output compaction + read() cap.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyReadDefaultLimit,
  clearCompactionCache,
  compactIfLarge,
  DEFAULT_QUIET_THRESHOLDS,
  DEFAULT_READ_LIMIT,
  shouldApplyReadDefaultLimit,
} from "../src/cvm/quiet-output.ts";
import { coldGet } from "../src/cvm/cold-store.ts";
import { resetCvmMetrics, cvmMetrics } from "../src/cvm/metrics.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quiet-"));
  clearCompactionCache();
  resetCvmMetrics();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bigText(lines: number, prefix = "line"): string {
  return Array.from({ length: lines }, (_, i) => `${prefix} ${i}`).join("\n");
}

describe("compactIfLarge", () => {
  test("small text passes through untouched", () => {
    assert.strictEqual(compactIfLarge(tmpDir, "short output\nline2", false), undefined);
  });

  test("compacts output over the line threshold", () => {
    const text = bigText(500);
    const result = compactIfLarge(tmpDir, text, false);
    assert.ok(result);
    assert.match(result!.preview, /^line 0\n/);
    assert.match(result!.preview, /line 499$/);
    assert.match(result!.preview, /lines omitted/);
    assert.match(result!.preview, /read_artifact/);
    assert.strictEqual(result!.originalLines, 500);
  });

  test("full original text is retrievable from cold storage via the fingerprint", () => {
    const text = bigText(500, "distinctive-marker-content");
    const result = compactIfLarge(tmpDir, text, false)!;
    const stored = coldGet(tmpDir, result.fp);
    assert.strictEqual(stored, text);
  });

  test("error output gets a larger head+tail allocation than normal output", () => {
    const text = bigText(500);
    const normal = compactIfLarge(tmpDir, text, false)!;
    const error = compactIfLarge(tmpDir, text, true)!;
    // Error preview keeps more lines (160+120=280) than normal (100+60=160).
    assert.ok(error.preview.length > normal.preview.length);
  });

  test("a handful of very long lines over the char threshold: nothing to trim (too few lines)", () => {
    const text = Array.from({ length: 5 }, (_, i) => "x".repeat(3000) + i).join("\n");
    assert.ok(text.length > DEFAULT_QUIET_THRESHOLDS.maxChars);
    // Only 5 lines total — far fewer than head+tail, so there's no middle
    // section to omit even though the char threshold was exceeded.
    assert.strictEqual(compactIfLarge(tmpDir, text, false), undefined);
  });

  test("over the char threshold but within head+tail line budget: nothing to trim", () => {
    // 150 lines * 100 chars ≈ 15,000 chars (over the 12,000 char threshold),
    // but 150 lines is under head(100)+tail(60)=160 AND under maxLines(240) —
    // so it needs compaction by size, yet there's no middle section to omit.
    const { headLines, tailLines, maxChars, maxLines } = DEFAULT_QUIET_THRESHOLDS;
    const lineCount = headLines + tailLines - 10;
    assert.ok(lineCount < maxLines, "test line count must stay under maxLines");
    const text = bigText(lineCount, "z".repeat(90));
    assert.ok(text.length > maxChars, "test text must exceed the char threshold");
    assert.strictEqual(compactIfLarge(tmpDir, text, false), undefined);
  });

  test("memoization: identical content is not recomputed but metrics still accrue per call", () => {
    const text = bigText(500);
    const first = compactIfLarge(tmpDir, text, false)!;
    const before = cvmMetrics().tokensSaved;
    const second = compactIfLarge(tmpDir, text, false)!;
    assert.strictEqual(first.fp, second.fp);
    assert.strictEqual(first.preview, second.preview);
    assert.ok(cvmMetrics().tokensSaved > before, "second call must still record its own savings");
    assert.strictEqual(cvmMetrics().quietOutput.compactions, 2);
  });

  test("different content produces a different fingerprint (no cache collision)", () => {
    const a = compactIfLarge(tmpDir, bigText(500, "aaa"), false)!;
    const b = compactIfLarge(tmpDir, bigText(500, "bbb"), false)!;
    assert.notStrictEqual(a.fp, b.fp);
  });
});

describe("read() default limit", () => {
  test("applies default when limit is unset", () => {
    const input: { path?: string; limit?: number } = { path: "src/foo.ts" };
    const applied = applyReadDefaultLimit(input, DEFAULT_READ_LIMIT);
    assert.strictEqual(applied, true);
    assert.strictEqual(input.limit, DEFAULT_READ_LIMIT);
  });

  test("does not override an explicit limit", () => {
    const input = { path: "src/foo.ts", limit: 5000 };
    const applied = applyReadDefaultLimit(input, DEFAULT_READ_LIMIT);
    assert.strictEqual(applied, false);
    assert.strictEqual(input.limit, 5000);
  });

  test("skips image/binary extensions", () => {
    assert.strictEqual(shouldApplyReadDefaultLimit("assets/logo.png"), false);
    assert.strictEqual(shouldApplyReadDefaultLimit("dist/bundle.wasm"), false);
    assert.strictEqual(shouldApplyReadDefaultLimit("src/index.ts"), true);
    const input: { path?: string; limit?: number } = { path: "assets/logo.png" };
    assert.strictEqual(applyReadDefaultLimit(input, DEFAULT_READ_LIMIT), false);
    assert.strictEqual(input.limit, undefined);
  });

  test("no-op when path is missing", () => {
    const input: { path?: string; limit?: number } = {};
    assert.strictEqual(applyReadDefaultLimit(input, DEFAULT_READ_LIMIT), false);
  });
});
