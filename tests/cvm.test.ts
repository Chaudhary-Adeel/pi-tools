// Tests for the CVM core: fingerprints, hot cache, warm store, cold store,
// delta mode, symbol index, and context resolution.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { compoundFp, estimateTokens, fingerprint, shortFp } from "../src/cvm/fingerprint.ts";
import { HotCache } from "../src/cvm/hot-cache.ts";
import { coldGet, coldHas, coldPut, coldStats } from "../src/cvm/cold-store.ts";
import { closeWarmStore, getWarmStore } from "../src/cvm/warm-store.ts";
import { compactDiff, deltaCheck, deltaRecord, resetDeltaLedger } from "../src/cvm/delta.ts";
import { extractSymbols, findSymbols, indexRepo, resetIndexDebounce } from "../src/cvm/symbols.ts";
import { clearContextFileCache, dependencyCandidates, resolveContext } from "../src/cvm/context.ts";
import { resetCvmMetrics, cvmMetrics } from "../src/cvm/metrics.ts";

let tmpDir: string;

function write(rel: string, content: string): void {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cvm-"));
  resetDeltaLedger();
  resetCvmMetrics();
  resetIndexDebounce();
  clearContextFileCache();
});

afterEach(() => {
  closeWarmStore(tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── fingerprint ─────────────────────────────────────────────────────────────

describe("fingerprint", () => {
  test("identical content → identical fingerprint", () => {
    assert.strictEqual(fingerprint("abc"), fingerprint("abc"));
    assert.notStrictEqual(fingerprint("abc"), fingerprint("abd"));
    assert.strictEqual(shortFp(fingerprint("abc")).length, 12);
  });

  test("compoundFp is order- and boundary-sensitive", () => {
    assert.notStrictEqual(compoundFp("ab", "c"), compoundFp("a", "bc"));
    assert.notStrictEqual(compoundFp("a", "b"), compoundFp("b", "a"));
  });

  test("estimateTokens ~4 chars/token", () => {
    assert.strictEqual(estimateTokens("x".repeat(400)), 100);
  });
});

// ── hot cache ───────────────────────────────────────────────────────────────

describe("HotCache", () => {
  test("LRU eviction at capacity", () => {
    const c = new HotCache<string>({ capacity: 2, report: false });
    c.set("a", "1");
    c.set("b", "2");
    c.get("a"); // refresh a's recency
    c.set("c", "3"); // evicts b (least recently used)
    assert.strictEqual(c.get("a"), "1");
    assert.strictEqual(c.get("b"), undefined);
    assert.strictEqual(c.get("c"), "3");
  });

  test("TTL expiry", async () => {
    const c = new HotCache<string>({ ttlMs: 10, report: false });
    c.set("k", "v");
    assert.strictEqual(c.get("k"), "v");
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(c.get("k"), undefined);
  });

  test("byte budget evicts oldest", () => {
    const c = new HotCache<string>({ capacity: 100, maxBytes: 10, report: false });
    c.set("a", "12345678"); // 8 bytes
    c.set("b", "12345678"); // over budget → evict a
    assert.strictEqual(c.get("a"), undefined);
    assert.strictEqual(c.get("b"), "12345678");
  });
});

// ── warm store ──────────────────────────────────────────────────────────────

describe("WarmStore", () => {
  test("kv persists across store instances (sqlite)", () => {
    const store = getWarmStore(tmpDir);
    store.kvSet("greeting", "hello");
    if (store.backend === "sqlite") {
      closeWarmStore(tmpDir);
      const reopened = getWarmStore(tmpDir);
      assert.strictEqual(reopened.kvGet("greeting"), "hello");
    } else {
      assert.strictEqual(store.kvGet("greeting"), "hello");
    }
  });

  test("kv TTL expiry", async () => {
    const store = getWarmStore(tmpDir);
    store.kvSet("t", "v", 10);
    assert.strictEqual(store.kvGet("t"), "v");
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(store.kvGet("t"), undefined);
  });

  test("symbolsReplaceForFile replaces atomically", () => {
    const store = getWarmStore(tmpDir);
    store.symbolsReplaceForFile("a.ts", [
      { id: "1", name: "foo", kind: "function", file: "a.ts", line: 1, endLine: 3, signature: "function foo()" },
    ], []);
    store.symbolsReplaceForFile("a.ts", [
      { id: "2", name: "bar", kind: "function", file: "a.ts", line: 1, endLine: 3, signature: "function bar()" },
    ], []);
    assert.strictEqual(store.symbolsByName("foo").length, 0);
    assert.strictEqual(store.symbolsByName("bar").length, 1);
    assert.strictEqual(store.symbolCount(), 1);
  });
});

// ── cold store ──────────────────────────────────────────────────────────────

describe("cold store", () => {
  test("content-addressed roundtrip with dedup", () => {
    const fp1 = coldPut(tmpDir, "hello cold world");
    const fp2 = coldPut(tmpDir, "hello cold world"); // dedup — same object
    assert.strictEqual(fp1, fp2);
    assert.ok(coldHas(tmpDir, fp1));
    assert.strictEqual(coldGet(tmpDir, fp1), "hello cold world");
    assert.strictEqual(coldStats(tmpDir).objects, 1);
    assert.strictEqual(coldGet(tmpDir, "0".repeat(64)), undefined);
  });
});

// ── delta mode ──────────────────────────────────────────────────────────────

describe("delta mode", () => {
  test("first full, repeat unchanged stub, change → diff", () => {
    const v1 = "line1\nline2\nline3";
    assert.strictEqual(deltaCheck("k", v1).kind, "full");
    const second = deltaCheck("k", v1);
    assert.strictEqual(second.kind, "unchanged");
    assert.match((second as { stub: string }).stub, /force_full/);

    const v2 = "line1\nCHANGED\nline3";
    const third = deltaCheck("k", v2);
    assert.strictEqual(third.kind, "diff");
    const diff = (third as { diff: string }).diff;
    assert.match(diff, /- line2/);
    assert.match(diff, /\+ CHANGED/);
    assert.ok(!diff.includes("- line1"), "unchanged prefix not in diff");
  });

  test("deltaRecord updates the baseline (force_full path)", () => {
    deltaCheck("k2", "aaa");
    deltaRecord("k2", "bbb");
    // Next check against bbb: unchanged.
    assert.strictEqual(deltaCheck("k2", "bbb").kind, "unchanged");
  });

  test("degenerate diff falls back to full", () => {
    deltaCheck("k3", "a\nb\nc");
    const res = deltaCheck("k3", "x\ny\nz\nw\nv\nu");
    assert.strictEqual(res.kind, "full");
  });

  test("compactDiff trims common prefix and suffix", () => {
    const d = compactDiff("a\nb\nc\nd", "a\nB2\nc\nd");
    assert.match(d, /@@ lines 2-2 → 2-2 @@/);
    assert.match(d, /- b/);
    assert.match(d, /\+ B2/);
  });
});

// ── symbol extraction + incremental index ───────────────────────────────────

describe("symbol index", () => {
  test("extracts functions, classes, arrow consts, python defs", () => {
    const ts = extractSymbols(
      "export function alpha(x: number) {\n  return x;\n}\nexport class Beta {}\nconst gamma = async (y) => {\n  return y;\n};\n",
      "a.ts",
    );
    const names = ts.symbols.map((s) => `${s.kind}:${s.name}`);
    assert.ok(names.includes("function:alpha"), names.join(","));
    assert.ok(names.includes("class:Beta"));
    assert.ok(names.includes("function:gamma"));

    const py = extractSymbols("def handler(req):\n    return req\n", "b.py");
    assert.ok(py.symbols.some((s) => s.name === "handler"));
  });

  test("incremental: second index run parses nothing", async () => {
    write("src/a.ts", "export function one() { return 1; }\n");
    write("src/b.ts", "import { one } from './a.ts';\nexport const two = () => one() + 1;\n");

    const first = await indexRepo(tmpDir, { force: true });
    assert.strictEqual(first.parsed, 2);
    assert.ok(first.symbols >= 2);

    resetIndexDebounce(tmpDir);
    const second = await indexRepo(tmpDir, { force: true });
    assert.strictEqual(second.parsed, 0);
    assert.strictEqual(second.reused, 2);
  });

  test("only changed files reparse; deleted files drop out", async () => {
    write("src/a.ts", "export function one() { return 1; }\n");
    write("src/b.ts", "export function two() { return 2; }\n");
    await indexRepo(tmpDir, { force: true });

    write("src/a.ts", "export function oneRenamed() { return 1; }\n");
    fs.rmSync(path.join(tmpDir, "src/b.ts"));
    resetIndexDebounce(tmpDir);
    const stats = await indexRepo(tmpDir, { force: true });
    assert.strictEqual(stats.parsed, 1);
    assert.strictEqual(stats.deleted, 1);
    assert.strictEqual(findSymbols(tmpDir, "oneRenamed").length, 1);
    assert.strictEqual(findSymbols(tmpDir, "one").length, 0);
    assert.strictEqual(findSymbols(tmpDir, "two").length, 0);
  });
});

// ── context resolution ──────────────────────────────────────────────────────

describe("context resolution", () => {
  test("returns symbol source, dependency, and callers — not whole files", async () => {
    write(
      "src/util.ts",
      "export function helper(n: number): number {\n  return n * 2;\n}\n\nexport function unrelatedHuge() {\n" +
        "  // filler\n".repeat(50) +
        "}\n",
    );
    write(
      "src/main.ts",
      "import { helper } from './util.ts';\n\nexport function compute(x: number) {\n  return helper(x) + 1;\n}\n",
    );
    await indexRepo(tmpDir, { force: true });

    const res = await resolveContext(tmpDir, "compute");
    assert.ok(res.found);
    assert.ok(res.confidence > 0.5, `confidence ${res.confidence}`);
    assert.match(res.markdown, /function compute/);
    assert.match(res.markdown, /helper/);
    assert.ok(!res.markdown.includes("unrelatedHuge"), "unrelated code excluded");
    assert.ok(res.tokensSavedVsFiles > 0, "should save vs whole files");
  });

  test("unknown symbol → found=false, confidence 0", async () => {
    write("src/a.ts", "export const x = 1;\n");
    await indexRepo(tmpDir, { force: true });
    const res = await resolveContext(tmpDir, "definitelyMissing");
    assert.strictEqual(res.found, false);
    assert.strictEqual(res.confidence, 0);
    assert.match(res.markdown, /grep_search/);
  });

  test("dependencyCandidates filters keywords and self", () => {
    const deps = dependencyCandidates("function foo() { return bar(baz) + console.log(1); }", "foo");
    assert.ok(deps.includes("bar"));
    assert.ok(deps.includes("baz"));
    assert.ok(!deps.includes("foo"));
    assert.ok(!deps.includes("console"));
    assert.ok(!deps.includes("function"));
  });

  test("metrics accumulate", async () => {
    write("src/a.ts", "export function solo() { return 1; }\n");
    await indexRepo(tmpDir, { force: true });
    await resolveContext(tmpDir, "solo");
    const m = cvmMetrics();
    assert.strictEqual(m.context.resolves, 1);
    assert.ok(m.symbols.lookups >= 1);
  });
});
