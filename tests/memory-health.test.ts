// Tests for lib/memory-health.ts — the Memory Health Engine.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureMemoryDirs } from "../src/lib/memory.ts";
import { closeWarmStore } from "../src/cvm/warm-store.ts";
import { indexRepo, resetIndexDebounce } from "../src/cvm/symbols.ts";
import {
  analyzeMemoryHealth,
  applyHealActions,
  compressDeterministic,
  extractCodeRefs,
  formatHealthReport,
  memorySimilarity,
  validateRefs,
  DEFAULT_HEALTH_THRESHOLDS,
} from "../src/lib/memory-health.ts";

let tmpDir: string;

function writeMemory(rel: string, content: string): void {
  const p = path.join(tmpDir, ".pi", "memory", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

function writeSource(rel: string, content: string): void {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memhealth-"));
  ensureMemoryDirs(tmpDir);
  resetIndexDebounce(tmpDir);
});

afterEach(() => {
  closeWarmStore(tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── extraction ───────────────────────────────────────────────────────────────

describe("extractCodeRefs", () => {
  test("finds path-like references but not URLs", () => {
    const refs = extractCodeRefs(
      "See `src/lib/foo.ts` and https://example.com/bar.ts for details, also check pkg/mod.go.",
    );
    assert.ok(refs.paths.includes("src/lib/foo.ts"));
    assert.ok(refs.paths.includes("pkg/mod.go"));
    assert.ok(!refs.paths.some((p) => p.includes("example.com")));
  });

  test("finds backticked symbols", () => {
    const refs = extractCodeRefs("Call `resolveContext` before `formatBytes()`.");
    assert.ok(refs.symbols.includes("resolveContext"));
    assert.ok(refs.symbols.includes("formatBytes"));
  });
});

// ── ref validation ───────────────────────────────────────────────────────────

describe("validateRefs", () => {
  test("existing path is not dead", () => {
    writeSource("src/real.ts", "export const x = 1;\n");
    const v = validateRefs(tmpDir, { paths: ["src/real.ts"], symbols: [] });
    assert.strictEqual(v.deadPaths.length, 0);
  });

  test("moved file with unique basename is fixable", async () => {
    writeSource("src/new-location/moved.ts", "export const y = 1;\n");
    await indexRepo(tmpDir, { force: true });
    const v = validateRefs(tmpDir, { paths: ["src/old-location/moved.ts"], symbols: [] });
    assert.strictEqual(v.fixablePaths.length, 1);
    assert.strictEqual(v.fixablePaths[0]!.to, "src/new-location/moved.ts");
  });

  test("genuinely missing path is dead, not fixable", async () => {
    await indexRepo(tmpDir, { force: true });
    const v = validateRefs(tmpDir, { paths: ["src/never/existed.ts"], symbols: [] });
    assert.deepStrictEqual(v.fixablePaths, []);
    assert.ok(v.deadPaths.includes("src/never/existed.ts"));
  });

  test("ambiguous basename (2+ matches) stays dead, not guessed", async () => {
    writeSource("src/a/dup.ts", "export const a = 1;\n");
    writeSource("src/b/dup.ts", "export const b = 1;\n");
    await indexRepo(tmpDir, { force: true });
    const v = validateRefs(tmpDir, { paths: ["src/gone/dup.ts"], symbols: [] });
    assert.deepStrictEqual(v.fixablePaths, []);
    assert.ok(v.deadPaths.includes("src/gone/dup.ts"));
  });
});

// ── similarity ───────────────────────────────────────────────────────────────

describe("memorySimilarity", () => {
  test("identical text scores 1", () => {
    const a = { desc: "auth flow notes", body: "the auth flow uses JWT tokens for session handling" };
    assert.strictEqual(memorySimilarity(a, a), 1);
  });

  test("unrelated text scores low", () => {
    const a = { desc: "auth flow", body: "JWT tokens and session handling for login" };
    const b = { desc: "css grid layout", body: "flexbox and grid template columns for responsive design" };
    assert.ok(memorySimilarity(a, b) < 0.2);
  });
});

// ── deterministic compression ────────────────────────────────────────────────

describe("compressDeterministic", () => {
  test("strips trailing whitespace and collapses blank runs", () => {
    const raw = "line1   \nline2\t\n\n\n\nline3\n";
    const out = compressDeterministic(raw);
    assert.ok(!out.includes("line1   "));
    assert.ok(!/\n{3,}/.test(out));
  });

  test("never touches content inside fenced code blocks", () => {
    const raw = "text\n```\ncode   \n\n\n\nmore code\n```\nafter\n";
    const out = compressDeterministic(raw);
    assert.ok(out.includes("code   \n\n\n\nmore code"), "fence content must be byte-identical");
  });
});

// ── analysis + scoring ───────────────────────────────────────────────────────

describe("analyzeMemoryHealth", () => {
  test("no memory root → clean report, no actions", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nomemhealth-"));
    try {
      const report = analyzeMemoryHealth(other);
      assert.strictEqual(report.memoryRoot, null);
      assert.deepStrictEqual(report.actions, []);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test("well-formed learning scores high with no actions", () => {
    writeMemory(
      "learnings/good.md",
      '---\ndescription: "A well-formed learning"\n---\n# Good\n\nThis is a solid, complete learning entry with real content.\n',
    );
    const report = analyzeMemoryHealth(tmpDir);
    const f = report.files.find((x) => x.relPath === "learnings/good.md")!;
    assert.strictEqual(f.score, 100);
    assert.deepStrictEqual(f.issues, []);
  });

  test("missing description → repair-frontmatter action, penalized score", () => {
    writeMemory("learnings/nodesc.md", "# No Description\n\nSome real content that is long enough to not be trivial.\n");
    const report = analyzeMemoryHealth(tmpDir);
    const f = report.files.find((x) => x.relPath === "learnings/nodesc.md")!;
    assert.ok(f.score < 100);
    assert.ok(f.issues.some((i) => i.includes("missing frontmatter")));
    assert.ok(report.actions.some((a) => a.type === "repair-frontmatter" && a.file === "learnings/nodesc.md"));
  });

  test("dead file reference is penalized and reported", async () => {
    writeMemory(
      "learnings/deadref.md",
      '---\ndescription: "references a dead file"\n---\nSee `src/totally/gone.ts` for the implementation.\n',
    );
    await indexRepo(tmpDir, { force: true });
    const report = analyzeMemoryHealth(tmpDir);
    const f = report.files.find((x) => x.relPath === "learnings/deadref.md")!;
    assert.ok(f.deadRefs.includes("src/totally/gone.ts"));
    assert.ok(f.score < 100);
  });

  test("moved file reference produces a fix-ref action", async () => {
    writeSource("src/moved-target.ts", "export const z = 1;\n");
    writeMemory(
      "learnings/movedref.md",
      '---\ndescription: "references a moved file"\n---\nSee `src/old/moved-target.ts` for details.\n',
    );
    await indexRepo(tmpDir, { force: true });
    const report = analyzeMemoryHealth(tmpDir);
    const action = report.actions.find((a) => a.type === "fix-ref");
    assert.ok(action);
    if (action?.type === "fix-ref") {
      assert.strictEqual(action.from, "src/old/moved-target.ts");
      assert.strictEqual(action.to, "src/moved-target.ts");
    }
  });

  test("near-duplicate learnings: older one flagged for archival", () => {
    const shared = "This describes the retry-with-backoff pattern used for flaky network calls in the client.";
    writeMemory("learnings/retry-old.md", `---\ndescription: "retry backoff pattern"\n---\n${shared}\n`);
    writeMemory("learnings/retry-new.md", `---\ndescription: "retry backoff pattern"\n---\n${shared} Updated with jitter.\n`);
    // Make "old" older on disk.
    const oldPath = path.join(tmpDir, ".pi/memory/learnings/retry-old.md");
    const past = new Date(Date.now() - 100_000);
    fs.utimesSync(oldPath, past, past);

    const report = analyzeMemoryHealth(tmpDir, { ...DEFAULT_HEALTH_THRESHOLDS, duplicateSimilarity: 0.5 });
    const old = report.files.find((x) => x.relPath === "learnings/retry-old.md")!;
    assert.strictEqual(old.duplicateOf, "learnings/retry-new.md");
    assert.ok(report.actions.some((a) => a.type === "archive-duplicate" && a.file === "learnings/retry-old.md"));
  });

  test("dedup pass is capped — doesn't hang on a pathologically large learnings dir", () => {
    // Just past the cap; each file distinct enough that only the cap (not
    // similarity) is under test. This must return promptly.
    for (let i = 0; i < 305; i++) {
      writeMemory(`learnings/many-${i}.md`, `---\ndescription: "topic ${i}"\n---\nUnique content block ${i} xyz${i}.\n`);
    }
    const start = Date.now();
    const report = analyzeMemoryHealth(tmpDir);
    assert.ok(Date.now() - start < 5000, "must not attempt full O(n^2) pairwise scan past the cap");
    assert.ok(!report.actions.some((a) => a.type === "archive-duplicate"));
  });

  test("system files are never flagged for archival even when stale/low-score", () => {
    writeMemory("system/thin.md", "x\n"); // no frontmatter, trivial body
    const report = analyzeMemoryHealth(tmpDir);
    assert.ok(!report.actions.some((a) => a.file === "system/thin.md" && (a.type === "archive-duplicate" || a.type === "archive-expired")));
  });

  test("progress.md and memory-map.md are never scanned", () => {
    writeMemory("system/progress.md", "stale progress notes\n");
    const report = analyzeMemoryHealth(tmpDir);
    assert.ok(!report.files.some((f) => f.relPath === "system/progress.md"));
  });
});

// ── applying actions ─────────────────────────────────────────────────────────

describe("applyHealActions", () => {
  test("repair-frontmatter adds a description, preserves body and other keys", () => {
    writeMemory("learnings/repair.md", "priority: 2\n---\n# Heading Here\n\nBody content that is long enough.\n");
    // NOTE: malformed leading frontmatter (missing opening ---) is treated as plain body
    // by parseMemoryFile, so write a realistic no-description case instead:
    writeMemory("learnings/repair2.md", "# Some Heading\n\nBody content that is long enough to be real.\n");
    const report = analyzeMemoryHealth(tmpDir);
    const applied = applyHealActions(tmpDir, report);
    assert.ok(applied.applied.some((a) => a.type === "repair-frontmatter" && a.file === "learnings/repair2.md"));
    const fixed = fs.readFileSync(path.join(tmpDir, ".pi/memory/learnings/repair2.md"), "utf-8");
    assert.match(fixed, /^---\ndescription:/);
    assert.match(fixed, /Body content that is long enough to be real\./);
  });

  test("fix-ref rewrites the dead path to the resolved location", async () => {
    writeSource("src/actual/file.ts", "export const w = 1;\n");
    writeMemory(
      "learnings/ref.md",
      '---\ndescription: "ref test"\n---\nSee `src/wrong/file.ts` here.\n',
    );
    await indexRepo(tmpDir, { force: true });
    const report = analyzeMemoryHealth(tmpDir);
    const applied = applyHealActions(tmpDir, report);
    assert.ok(applied.applied.some((a) => a.type === "fix-ref"));
    const fixed = fs.readFileSync(path.join(tmpDir, ".pi/memory/learnings/ref.md"), "utf-8");
    assert.match(fixed, /src\/actual\/file\.ts/);
    assert.ok(!fixed.includes("src/wrong/file.ts"));
  });

  test("archive moves the file, never deletes", () => {
    const shared = "Detailed notes about the caching layer invalidation strategy used across the app.";
    writeMemory("learnings/cache-a.md", `---\ndescription: "caching notes"\n---\n${shared}\n`);
    writeMemory("learnings/cache-b.md", `---\ndescription: "caching notes"\n---\n${shared} Refined.\n`);
    const aPath = path.join(tmpDir, ".pi/memory/learnings/cache-a.md");
    const past = new Date(Date.now() - 100_000);
    fs.utimesSync(aPath, past, past);

    const report = analyzeMemoryHealth(tmpDir, { ...DEFAULT_HEALTH_THRESHOLDS, duplicateSimilarity: 0.5 });
    applyHealActions(tmpDir, report);
    assert.ok(!fs.existsSync(aPath), "original must be moved out");
    const archiveDir = path.join(tmpDir, ".pi/memory/archive");
    assert.ok(fs.existsSync(archiveDir));
    const archived = fs.readdirSync(archiveDir);
    assert.ok(archived.some((f) => f.endsWith("cache-a.md")));
  });

  test("compress rewrites only when savings clear the threshold", () => {
    const padded = "content\n" + "   \n".repeat(20); // trailing-space-only lines, well over threshold
    writeMemory("learnings/pad.md", `---\ndescription: "padded"\n---\n${padded}`);
    const report = analyzeMemoryHealth(tmpDir);
    const before = fs.readFileSync(path.join(tmpDir, ".pi/memory/learnings/pad.md"), "utf-8");
    applyHealActions(tmpDir, report);
    const after = fs.readFileSync(path.join(tmpDir, ".pi/memory/learnings/pad.md"), "utf-8");
    assert.ok(after.length < before.length);
  });

  test("second apply on an already-healed report is idempotent (no crash, skips)", () => {
    writeMemory("learnings/once.md", "# Heading\n\nReal content for this entry, long enough.\n");
    const report = analyzeMemoryHealth(tmpDir);
    applyHealActions(tmpDir, report); // first apply — repairs frontmatter
    const second = applyHealActions(tmpDir, report); // same stale action list, reapplied
    assert.ok(second.skipped.some((s) => s.reason.includes("already has a description")));
  });
});

// ── report formatting ───────────────────────────────────────────────────────

describe("formatHealthReport", () => {
  test("reports cleanly with no memory root", () => {
    const report = analyzeMemoryHealth(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fmt-")));
    assert.match(formatHealthReport(report), /nothing to heal/);
  });

  test("includes applied and skipped actions when provided", () => {
    writeMemory("learnings/x.md", "# X\n\nSome real content here that is long enough.\n");
    const report = analyzeMemoryHealth(tmpDir);
    const applied = applyHealActions(tmpDir, report);
    const out = formatHealthReport(report, applied);
    assert.match(out, /Memory health:/);
    assert.match(out, /repaired frontmatter/);
  });
});
