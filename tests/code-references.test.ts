// Tests for lib/code-references.ts — cross-file symbol tracing.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { findReferences, formatReferences } from "../src/lib/code-references.ts";

let tmpDir: string;

function write(rel: string, content: string): void {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-refs-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("findReferences", () => {
  test("classifies definition, import, and call sites across files", async () => {
    write(
      "src/util.ts",
      `export function formatBytes(bytes: number): string {\n  return String(bytes);\n}\n`,
    );
    write(
      "src/main.ts",
      `import { formatBytes } from "./util.ts";\n\nconst label = formatBytes(1024);\n`,
    );

    const { refs } = await findReferences(tmpDir, "formatBytes");
    const kinds = new Map(refs.map((r) => [`${r.file}:${r.line}`, r.kind]));
    assert.strictEqual(kinds.get("src/util.ts:1"), "definition");
    assert.strictEqual(kinds.get("src/main.ts:1"), "import");
    assert.strictEqual(kinds.get("src/main.ts:3"), "call");
  });

  test("call sites include context lines", async () => {
    write("a.ts", `const x = 1;\nconst y = doWork(x);\nconst z = y + 1;\n`);
    const { refs } = await findReferences(tmpDir, "doWork");
    const call = refs.find((r) => r.kind === "call");
    assert.ok(call?.context);
    assert.ok(call!.context!.some((l) => l.includes("const x = 1;")));
    assert.ok(call!.context!.some((l) => l.includes("const z = y + 1;")));
  });

  test("word-boundary matching: no substring hits", async () => {
    write("a.ts", `const foobar = 1;\nconst foo = 2;\n`);
    const { refs } = await findReferences(tmpDir, "foo");
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0]!.line, 2);
  });

  test("respects glob filter", async () => {
    write("a.ts", `target();\n`);
    write("b.py", `target()\n`);
    const { refs } = await findReferences(tmpDir, "target", { glob: "**/*.ts" });
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0]!.file, "a.ts");
  });

  test("caps results and reports truncation", async () => {
    const lines = Array.from({ length: 20 }, () => "hit();").join("\n");
    write("a.ts", lines);
    const { refs, truncated } = await findReferences(tmpDir, "hit", { maxRefs: 5 });
    assert.strictEqual(refs.length, 5);
    assert.strictEqual(truncated, true);
  });

  test("recognizes const arrow-function definitions and python defs", async () => {
    write("fn.ts", `const handler = async (req) => {\n  return req;\n};\n`);
    write("fn.py", `def handler(req):\n    return req\n`);
    const { refs } = await findReferences(tmpDir, "handler");
    assert.ok(refs.filter((r) => r.kind === "definition").length >= 2);
  });
});

describe("formatReferences", () => {
  test("groups by kind with counts", async () => {
    write("u.ts", `export function calc(n: number) { return n; }\n`);
    write("m.ts", `import { calc } from "./u.ts";\ncalc(1);\n`);
    const { refs, filesScanned, truncated } = await findReferences(tmpDir, "calc");
    const out = formatReferences("calc", refs, filesScanned, truncated);
    assert.match(out, /## Definitions \(1\)/);
    assert.match(out, /## Imports \(1\)/);
    assert.match(out, /## Call sites \(1\)/);
  });

  test("empty result message", () => {
    const out = formatReferences("nope", [], 0, false);
    assert.match(out, /No references/);
  });
});
