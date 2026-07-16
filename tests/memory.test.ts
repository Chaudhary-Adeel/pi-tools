import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseMemoryFile,
  loadProgress,
  formatSystemMemory,
  formatLearningSummaries,
  findMemoryRoot,
  ensureMemoryDirs,
  ensureProgressFile,
  formatProgressInjection,
  loadSystemMemory,
  listLearnings,
} from "../src/lib/memory.ts";

// ── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function mkdirs(...segments: string[]): string {
  const p = path.join(tmpDir, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(relPath: string, content: string): string {
  const fp = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf-8");
  return fp;
}

before(() => {
  tmpDir = path.join(os.tmpdir(), "pi-memory-test-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  // Scope memory lookups to the temp dir to avoid finding global ~/.pi/memory
  process.env.PI_MEMORY_SCOPE = tmpDir;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PI_MEMORY_SCOPE;
});

// Clean per-test: remove .pi dir
function cleanMemory() {
  const mem = path.join(tmpDir, ".pi");
  if (fs.existsSync(mem)) fs.rmSync(mem, { recursive: true, force: true });
}

// ─── parseMemoryFile ────────────────────────────────────────────────────────

describe("parseMemoryFile", () => {
  it("parses YAML frontmatter with description and priority", () => {
    const raw = [
      "---",
      'description: "Coding standards"',
      "priority: 1",
      "---",
      "# Conventions",
      "Use 2-space indentation.",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "Coding standards");
    assert.equal(result.frontmatter.priority, 1);
    assert.ok(result.body.includes("# Conventions"));
    assert.ok(result.body.includes("Use 2-space indentation"));
  });

  it("parses frontmatter with single-quoted values", () => {
    const raw = [
      "---",
      "description: 'Build commands'",
      "status: 'active'",
      "---",
      "# Build",
      "npm run build",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "Build commands");
    assert.equal(result.frontmatter.status, "active");
  });

  it("parses frontmatter with unquoted values", () => {
    const raw = [
      "---",
      "description: Test guidelines",
      "coverage: 80",
      "stable: true",
      "---",
      "content",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "Test guidelines");
    assert.equal(result.frontmatter.coverage, 80);
    assert.equal(result.frontmatter.stable, true);
  });

  it("parses frontmatter with boolean false", () => {
    const raw = [
      "---",
      "enabled: false",
      "---",
      "body",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.enabled, false);
  });

  it("parses frontmatter with float values", () => {
    const raw = [
      "---",
      "score: 3.14",
      "version: 2.0",
      "---",
      "body",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.score, 3.14);
    assert.equal(result.frontmatter.version, 2);
  });

  it("returns empty frontmatter and full body when no frontmatter present", () => {
    const raw = [
      "# Just a heading",
      "Some content here.",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.deepEqual(result.frontmatter, {});
    assert.equal(result.body, raw);
  });

  it("returns empty frontmatter and body for empty string", () => {
    const result = parseMemoryFile("");
    assert.deepEqual(result.frontmatter, {});
    assert.equal(result.body, "");
  });

  it("handles frontmatter with extra whitespace around values", () => {
    const raw = [
      "---",
      "description:   \"  spaced value  \"  ",
      "priority:   99   ",
      "---",
      "body",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "  spaced value  ");
    assert.equal(result.frontmatter.priority, 99);
  });

  it("skips blank lines and lines without colons in frontmatter", () => {
    const raw = [
      "---",
      "",
      "description: Hello",
      "",
      "priority: 5",
      "  indented line  ",
      "---",
      "body",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "Hello");
    assert.equal(result.frontmatter.priority, 5);
  });

  it("handles CRLF line endings in frontmatter", () => {
    const raw = "---\r\ndescription: \"CRLF test\"\r\npriority: 7\r\n---\r\nBody here";
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "CRLF test");
    assert.equal(result.frontmatter.priority, 7);
    assert.equal(result.body, "Body here");
  });

  it("handles only opening --- without closing", () => {
    const raw = [
      "---",
      "description: incomplete",
      "# body",
    ].join("\n");
    const result = parseMemoryFile(raw);
    // No closing --- so frontmatter regex doesn't match
    assert.deepEqual(result.frontmatter, {});
    assert.equal(result.body, raw);
  });

  it("handles multiple --- blocks (only first is frontmatter)", () => {
    const raw = [
      "---",
      "description: First",
      "---",
      "# Section",
      "---",
      "more content",
    ].join("\n");
    const result = parseMemoryFile(raw);
    assert.equal(result.frontmatter.description, "First");
    assert.ok(result.body.includes("# Section"));
    assert.ok(result.body.includes("---"));
    assert.ok(result.body.includes("more content"));
  });
});

// ─── loadProgress ───────────────────────────────────────────────────────────

describe("loadProgress", () => {
  it("returns null when no .pi/memory exists", () => {
    cleanMemory();
    assert.equal(loadProgress(tmpDir), null);
  });

  it("returns null when no progress.md exists", () => {
    cleanMemory();
    mkdirs(".pi", "memory", "system");
    // No progress.md file
    assert.equal(loadProgress(tmpDir), null);
  });

  it("parses full progress.md with all sections", () => {
    cleanMemory();
    writeFile(
      ".pi/memory/system/progress.md",
      [
        "---",
        'description: "Current task progress"',
        "priority: 0",
        "type: progress",
        "---",
        "# Implement login feature",
        "",
        "## Status: In Progress",
        "",
        "## Checklist",
        "- [x] Design API",
        "- [ ] Implement endpoint",
        "- [ ] Write tests",
        "",
        "## Open Decisions",
        "1. Use JWT or sessions? (leaning JWT)",
        "2. Rate limiting strategy?",
        "",
        "## Next Steps",
        "- Wire up auth middleware",
        "- Add integration tests",
      ].join("\n"),
    );
    const result = loadProgress(tmpDir);
    assert.ok(result);
    assert.equal(result.task, "Implement login feature");
    assert.equal(result.status, "in_progress");
    assert.equal(result.checklist.length, 3);
    assert.equal(result.checklist[0].label, "Design API");
    assert.equal(result.checklist[0].done, true);
    assert.equal(result.checklist[1].label, "Implement endpoint");
    assert.equal(result.checklist[1].done, false);
    assert.equal(result.checklist[2].label, "Write tests");
    assert.equal(result.checklist[2].done, false);
    assert.equal(result.openDecisions.length, 2);
    assert.equal(result.openDecisions[0], "Use JWT or sessions? (leaning JWT)");
    assert.equal(result.openDecisions[1], "Rate limiting strategy?");
    assert.equal(result.nextSteps.length, 2);
    assert.equal(result.nextSteps[0], "Wire up auth middleware");
    assert.equal(result.nextSteps[1], "Add integration tests");
  });

  it("parses partial progress with only task and status", () => {
    cleanMemory();
    writeFile(
      ".pi/memory/system/progress.md",
      [
        "---",
        "description: test",
        "---",
        "# Some task",
        "## Status: Done",
      ].join("\n"),
    );
    const result = loadProgress(tmpDir);
    assert.ok(result);
    assert.equal(result.task, "Some task");
    assert.equal(result.status, "done");
    assert.equal(result.checklist.length, 0);
    assert.equal(result.openDecisions.length, 0);
    assert.equal(result.nextSteps.length, 0);
  });

  it("status: pending", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Task X", "## Status: Pending",
    ].join("\n"));
    const result = loadProgress(tmpDir);
    assert.equal(result!.status, "pending");
  });

  it("status: done / complete", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Task X", "## Status: Complete",
    ].join("\n"));
    assert.equal(loadProgress(tmpDir)!.status, "done");
  });

  it("status: blocked", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Task X", "## Status: Blocked",
    ].join("\n"));
    assert.equal(loadProgress(tmpDir)!.status, "blocked");
  });

  it("empty sections produce empty arrays", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Task",
      "## Status: Pending",
      "## Checklist",
      "## Open Decisions",
      "## Next Steps",
    ].join("\n"));
    const result = loadProgress(tmpDir);
    assert.ok(result);
    assert.equal(result.checklist.length, 0);
    assert.equal(result.openDecisions.length, 0);
    assert.equal(result.nextSteps.length, 0);
  });

  it("handles checklist items with spaces around checkbox", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Verify email",
      "## Status: In Progress",
      "## Checklist",
      "- [x]  extra spaces  ",
      "* [ ] bullet star",
    ].join("\n"));
    const result = loadProgress(tmpDir);
    assert.equal(result!.checklist.length, 2);
    assert.equal(result!.checklist[0].label, "extra spaces");
    assert.equal(result!.checklist[0].done, true);
    assert.equal(result!.checklist[1].label, "bullet star");
    assert.equal(result!.checklist[1].done, false);
  });

  it("handles status declared as H1 heading", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Status: In Progress",
      "# Background Task",
    ].join("\n"));
    const result = loadProgress(tmpDir);
    assert.equal(result!.task, "Background Task");
    assert.equal(result!.status, "in_progress");
  });

  it("handles 'in progress' as H1 status text", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Status: In Progress",
      "# My Task",
    ].join("\n"));
    const result = loadProgress(tmpDir);
    assert.equal(result!.status, "in_progress");
    assert.equal(result!.task, "My Task");
  });
});

// ─── formatSystemMemory ─────────────────────────────────────────────────────

describe("formatSystemMemory", () => {
  it("returns empty string when no memory dir exists", () => {
    cleanMemory();
    assert.equal(formatSystemMemory(tmpDir, 4000), "");
  });

  it("returns empty string when no system files exist", () => {
    cleanMemory();
    mkdirs(".pi", "memory", "system");
    assert.equal(formatSystemMemory(tmpDir, 4000), "");
  });

  it("excludes progress.md from output", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", 'description: "Progress"', "priority: 0", "---",
      "# Task", "stuff",
    ].join("\n"));
    // progress.md is excluded, so output should be empty
    assert.equal(formatSystemMemory(tmpDir, 4000), "");
  });

  it("formats system memory files", () => {
    cleanMemory();
    writeFile(".pi/memory/system/conventions.md", [
      "---",
      'description: "Coding conventions"',
      "priority: 1",
      "---",
      "Use 2-space indent.",
    ].join("\n"));
    writeFile(".pi/memory/system/commands.md", [
      "---",
      'description: "Build commands"',
      "priority: 2",
      "---",
      "npm run build",
    ].join("\n"));

    const output = formatSystemMemory(tmpDir, 4000);
    assert.ok(output.includes("## Project Memory (always loaded)"));
    assert.ok(output.includes("### Coding conventions"));
    assert.ok(output.includes("Use 2-space indent"));
    assert.ok(output.includes("### Build commands"));
    assert.ok(output.includes("npm run build"));
  });

  it("respects maxTokens budget", () => {
    cleanMemory();
    // Create a file with ~200 chars -> ~50 tokens
    const longBody = "x".repeat(800); // ~200 tokens
    writeFile(".pi/memory/system/big.md", [
      "---", 'description: "Big file"', "priority: 1", "---", longBody,
    ].join("\n"));

    // Budget of 50 tokens: the header + description consume tokens, so body
    // alone at 200 tokens exceeds 50. Expect truncation.
    const output = formatSystemMemory(tmpDir, 50);
    assert.ok(output.includes("token budget"));
    assert.ok(!output.includes("xxxx")); // body should not be included
  });

  it("includes file when within budget", () => {
    cleanMemory();
    writeFile(".pi/memory/system/small.md", [
      "---", 'description: "Small"', "priority: 1", "---", "hello",
    ].join("\n"));

    const output = formatSystemMemory(tmpDir, 4000);
    assert.ok(output.includes("### Small"));
    assert.ok(output.includes("hello"));
    assert.ok(!output.includes("token budget"));
  });
});

// ─── formatLearningSummaries ────────────────────────────────────────────────

describe("formatLearningSummaries", () => {
  it("returns empty string when no memory dir exists", () => {
    cleanMemory();
    assert.equal(formatLearningSummaries(tmpDir), "");
  });

  it("returns empty string when no learning files exist", () => {
    cleanMemory();
    mkdirs(".pi", "memory", "learnings");
    assert.equal(formatLearningSummaries(tmpDir), "");
  });

  it("shows description for each learning file", () => {
    cleanMemory();
    writeFile(".pi/memory/learnings/react-patterns.md", [
      "---",
      'description: "React patterns and best practices"',
      "---",
      "# React Patterns",
      "Full content here...",
    ].join("\n"));
    writeFile(".pi/memory/learnings/testing.md", [
      "---",
      'description: "Testing strategies"',
      "---",
      "# Testing",
      "Full content here...",
    ].join("\n"));

    const output = formatLearningSummaries(tmpDir);
    assert.ok(output.includes("## Available Learnings"));
    assert.ok(output.includes("**learnings/react-patterns.md**: React patterns and best practices"));
    assert.ok(output.includes("**learnings/testing.md**: Testing strategies"));
  });

  it("uses filename as fallback when no description", () => {
    cleanMemory();
    writeFile(".pi/memory/learnings/nodesc.md", [
      "---", "priority: 5", "---", "content",
    ].join("\n"));

    const output = formatLearningSummaries(tmpDir);
    assert.ok(output.includes("**learnings/nodesc.md**: learnings/nodesc.md"));
  });
});

// ─── formatProgressInjection ────────────────────────────────────────────────

describe("formatProgressInjection", () => {
  it("returns empty when no progress", () => {
    cleanMemory();
    assert.equal(formatProgressInjection(tmpDir), "");
  });

  it("returns empty when task is empty", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "## Status: Pending",
    ].join("\n"));
    assert.equal(formatProgressInjection(tmpDir), "");
  });

  it("formats progress with all sections", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Memory System Audit",
      "## Status: In Progress",
      "## Checklist",
      "- [x] Audit",
      "- [ ] Fix #1",
      "## Open Decisions",
      "1. Git backing?",
      "## Next Steps",
      "- Run tests",
    ].join("\n"));
    const output = formatProgressInjection(tmpDir);
    assert.ok(output.includes("## Current Task Progress"));
    assert.ok(output.includes("**Task:** Memory System Audit"));
    assert.ok(output.includes("**Status:** in progress"));
    assert.ok(output.includes("- [x] Audit"));
    assert.ok(output.includes("- [ ] Fix #1"));
    assert.ok(output.includes("1. Git backing?"));
    assert.ok(output.includes("- Run tests"));
  });

  it("handles minimal progress with only task", () => {
    cleanMemory();
    writeFile(".pi/memory/system/progress.md", [
      "---", "description: t", "---",
      "# Simple task",
      "## Status: Done",
    ].join("\n"));
    const output = formatProgressInjection(tmpDir);
    assert.ok(output.includes("**Task:** Simple task"));
    assert.ok(!output.includes("Checklist"));
    assert.ok(!output.includes("Open Decisions"));
  });
});

// ─── findMemoryRoot ─────────────────────────────────────────────────────────

describe("findMemoryRoot", () => {
  it("finds memory root in current dir", () => {
    cleanMemory();
    const projDir = path.join(tmpDir, "projects", "a");
    mkdirs(".pi", "memory", "system");
    // .pi is in tmpDir, not in projDir, so searching from projDir finds it
    // (findMemoryRoot walks up)
    const found = findMemoryRoot(projDir);
    const expected = path.join(tmpDir, ".pi", "memory");
    assert.equal(found, expected);

    // Now remove tmpDir's .pi and create one inside projDir instead
    fs.rmSync(path.join(tmpDir, ".pi"), { recursive: true, force: true });
    fs.mkdirSync(path.join(projDir, ".pi", "memory", "system"), { recursive: true });
    assert.equal(findMemoryRoot(projDir), path.join(projDir, ".pi", "memory"));
  });

  it("walks up from subdirectory", () => {
    cleanMemory();
    const projDir = path.join(tmpDir, "walk-test");
    fs.mkdirSync(path.join(projDir, ".pi", "memory", "system"), { recursive: true });
    const subDir = path.join(projDir, "src", "lib");
    fs.mkdirSync(subDir, { recursive: true });

    assert.equal(findMemoryRoot(subDir), path.join(projDir, ".pi", "memory"));
  });

  it("returns null if no .pi/memory found in hierarchy", () => {
    cleanMemory();
    assert.equal(findMemoryRoot(tmpDir), null);
  });
});

// ─── ensureMemoryDirs ───────────────────────────────────────────────────────

describe("ensureMemoryDirs", () => {
  it("creates .pi/memory/system and .pi/memory/learnings", () => {
    cleanMemory();
    const root = ensureMemoryDirs(tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, ".pi", "memory", "system")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".pi", "memory", "learnings")));
    assert.equal(root, path.join(tmpDir, ".pi", "memory"));
  });
});

// ─── ensureProgressFile ─────────────────────────────────────────────────────

describe("ensureProgressFile", () => {
  it("creates a template progress.md", () => {
    cleanMemory();
    const fp = ensureProgressFile(tmpDir);
    assert.ok(fs.existsSync(fp));
    const content = fs.readFileSync(fp, "utf-8");
    assert.ok(content.includes("Current Task"));
    assert.ok(content.includes("## Status: Pending"));
    assert.ok(content.includes("## Checklist"));
    assert.ok(content.includes("## Open Decisions"));
    assert.ok(content.includes("## Next Steps"));
    // Verify YAML frontmatter present
    assert.ok(content.startsWith("---"));
    assert.ok(content.includes("priority: 0"));
  });

  it("does not overwrite existing progress.md", () => {
    cleanMemory();
    const customContent = "---\ndescription: custom\n---\n# Custom task";
    writeFile(".pi/memory/system/progress.md", customContent);
    const fp = ensureProgressFile(tmpDir);
    assert.equal(fs.readFileSync(fp, "utf-8"), customContent);
  });
});

// ─── loadSystemMemory / listLearnings ───────────────────────────────────────

describe("loadSystemMemory", () => {
  it("returns empty array when no memory dir", () => {
    cleanMemory();
    assert.deepEqual(loadSystemMemory(tmpDir), []);
  });

  it("loads system files sorted by priority", () => {
    cleanMemory();
    writeFile(".pi/memory/system/b.md", [
      "---", "priority: 2", "---", "B content",
    ].join("\n"));
    writeFile(".pi/memory/system/a.md", [
      "---", "priority: 1", "---", "A content",
    ].join("\n"));
    writeFile(".pi/memory/system/c.md", [
      "---", "priority: 3", "---", "C content",
    ].join("\n"));

    const files = loadSystemMemory(tmpDir);
    assert.equal(files.length, 3);
    assert.equal(files[0].frontmatter.priority, 1);
    assert.equal(files[1].frontmatter.priority, 2);
    assert.equal(files[2].frontmatter.priority, 3);
    assert.ok(files[0].relPath.includes("a.md"));
    assert.ok(files[1].relPath.includes("b.md"));
    assert.ok(files[2].relPath.includes("c.md"));
  });

  it("defaults priority to 99 when not set", () => {
    cleanMemory();
    writeFile(".pi/memory/system/low.md", [
      "---", "priority: 1", "---", "low",
    ].join("\n"));
    writeFile(".pi/memory/system/noprio.md", [
      "---", "description: test", "---", "no prio",
    ].join("\n"));

    const files = loadSystemMemory(tmpDir);
    assert.equal(files[0].frontmatter.priority, 1);
    assert.equal(files[1].relPath.includes("noprio.md"), true);
  });
});

describe("listLearnings", () => {
  it("returns empty array when no memory dir", () => {
    cleanMemory();
    assert.deepEqual(listLearnings(tmpDir), []);
  });

  it("lists learning files", () => {
    cleanMemory();
    writeFile(".pi/memory/learnings/foo.md", [
      "---", 'description: "Foo"', "---", "content",
    ].join("\n"));
    const files = listLearnings(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0].frontmatter.description, "Foo");
  });
});
