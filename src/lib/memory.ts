// Memory manager — two-tier MD file system for persistent agent context.
//
// Tier 1: system/   — Always injected into context at turn start
// Tier 2: learnings/ — On-demand; visible by description, loaded when needed
//
// File format: YAML frontmatter + Markdown body
//   ---
//   description: "What this file covers"
//   priority: 1          (load order, lower = first)
//   ---
//   # Content here
//
// The agent can read/write memory files via normal bash/edit tools.
// This module handles discovery, injection, and progress tracking.

import * as fs from "node:fs";
import * as path from "node:path";

// ── types ──────────────────────────────────────────────────────────────────

export interface MemoryFile {
  /** Full path on disk */
  path: string;
  /** Relative path from memory root (e.g. "system/conventions.md") */
  relPath: string;
  /** Parsed frontmatter + body */
  frontmatter: Record<string, unknown>;
  /** Markdown body (after frontmatter) */
  body: string;
  /** Raw file content */
  raw: string;
}

export interface Progress {
  task: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  checklist: { label: string; done: boolean }[];
  openDecisions: string[];
  nextSteps: string[];
  lastUpdated: string;
}

// ── config ──────────────────────────────────────────────────────────────────

const MEMORY_ROOT = ".pi/memory";
const SYSTEM_DIR = "system";
const LEARNINGS_DIR = "learnings";
const PROGRESS_FILE = "progress.md";

const MEMORY_EDIT_TOOLS = new Set(["edit", "write"]);

/** True if a tool_result event's edit/write targeted a file under
 *  .pi/memory/ — shared by the memory-git auto-commit hook and the Memory
 *  Health Engine's incremental sweep trigger, which both need to detect the
 *  same thing but react to it independently. */
export function isMemoryFileEdit(toolName: string, input: unknown): boolean {
  if (!MEMORY_EDIT_TOOLS.has(toolName)) return false;
  const i = input as { path?: string; file_path?: string } | undefined;
  const filePath = i?.path ?? i?.file_path ?? "";
  return filePath.includes(`${MEMORY_ROOT}/`);
}

// ── discovery ───────────────────────────────────────────────────────────────

/** Module-level cache: findMemoryRoot result by resolved cwd. The memory root
 *  doesn't change during a session, so caching eliminates 3+ directory walks
 *  per `before_agent_start` (called from loadSystemMemory, listLearnings,
 *  loadProgress, etc.). Invalidated only when memory dirs are first created. */
let _memoryRootCache: { cwd: string; root: string | null } | null = null;

/** Find the memory root for the current project (walks up from cwd). */
export function findMemoryRoot(cwd: string): string | null {
  const resolved = path.resolve(cwd);
  // PI_MEMORY_SCOPE bounds the upward walk to this directory (for tests).
  const scope = process.env.PI_MEMORY_SCOPE
    ? path.resolve(process.env.PI_MEMORY_SCOPE)
    : null;
  // Only cache positive hits — null results are cheap to re-walk and
  // become stale as soon as ensureMemoryDirs creates the directory.
  if (_memoryRootCache && _memoryRootCache.cwd === resolved && _memoryRootCache.root !== null) {
    // Verify cached entry is still valid — the memory dir may have been
    // removed (e.g. in tests). One existsSync beats a full walk.
    if (scope) {
      // With a scope set, cached root must still be within scope.
      if (!_memoryRootCache.root.startsWith(scope + path.sep) && _memoryRootCache.root !== scope) {
        _memoryRootCache = null; // invalidate
      }
    }
    if (_memoryRootCache && fs.existsSync(_memoryRootCache.root)) {
      return _memoryRootCache.root;
    }
  }
  let dir = resolved;
  const root = path.parse(dir).root;
  let result: string | null = null;
  while (dir !== root) {
    const memPath = path.join(dir, MEMORY_ROOT);
    if (fs.existsSync(memPath) && fs.statSync(memPath).isDirectory()) {
      result = memPath;
      break;
    }
    // Stop at scope boundary
    if (scope && dir === scope) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Only cache positive finds — null results become stale quickly
  if (result !== null) {
    _memoryRootCache = { cwd: resolved, root: result };
  }
  return result;
}

/** Ensure the memory directory structure exists. */
export function ensureMemoryDirs(cwd: string): string {
  const root = path.join(path.resolve(cwd), MEMORY_ROOT);
  const existed = fs.existsSync(root);
  fs.mkdirSync(path.join(root, SYSTEM_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, LEARNINGS_DIR), { recursive: true });
  if (!existed) _memoryRootCache = null; // invalidate — root may now be findable
  return root;
}

// ── parsing ─────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse "key: value" lines from a frontmatter block into a typed record —
 *  shared by parseMemoryFile (full parse) and parseFrontmatterOnly
 *  (metadata-only fast path), which otherwise duplicated this line-by-line
 *  quote-stripping/number-parsing loop verbatim. */
function parseFrontmatterLines(fmText: string): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  for (const line of fmText.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value: string = line.slice(idx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Parse numbers
    if (/^\d+(\.\d+)?$/.test(value)) {
      fm[key] = Number(value);
    } else if (value === "true" || value === "false") {
      fm[key] = value === "true";
    } else {
      fm[key] = value;
    }
  }
  return fm;
}

/** Parse a memory file into frontmatter + body. */
export function parseMemoryFile(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: raw };
  return { frontmatter: parseFrontmatterLines(m[1]!), body: m[2] ?? "" };
}

/** Lightweight metadata from a memory file (frontmatter only, no body). */
export interface MemoryFileMeta {
  relPath: string;
  frontmatter: Record<string, unknown>;
}

/** Load all .md files from a directory, sorted by priority. */
export function loadMemoryDir(dir: string): MemoryFile[] {
  if (!fs.existsSync(dir)) return [];
  const files: MemoryFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const fp = path.join(dir, entry.name);
    const raw = fs.readFileSync(fp, "utf-8");
    const { frontmatter, body } = parseMemoryFile(raw);
    files.push({
      path: fp,
      relPath: path.relative(path.dirname(dir), fp).replace(/\\/g, "/"),
      frontmatter,
      body,
      raw,
    });
  }
  files.sort((a, b) => {
    const pa = (a.frontmatter.priority as number) ?? 99;
    const pb = (b.frontmatter.priority as number) ?? 99;
    return pa - pb;
  });
  return files;
}

/** Load .md files from a directory, reading only frontmatter (not body).
 *  Much cheaper than loadMemoryDir for metadata-only consumers like
 *  formatLearningSummaries which just need description + relPath. */
export function loadMemoryDirMetadata(dir: string): MemoryFileMeta[] {
  if (!fs.existsSync(dir)) return [];
  const files: MemoryFileMeta[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const fp = path.join(dir, entry.name);
    const raw = fs.readFileSync(fp, "utf-8");
    // Only extract frontmatter — skip full body parse to avoid
    // allocating the body string and running the expensive end-anchored
    // regex on the entire file.
    const frontmatter = parseFrontmatterOnly(raw);
    files.push({
      relPath: path.relative(path.dirname(dir), fp).replace(/\\/g, "/"),
      frontmatter,
    });
  }
  files.sort((a, b) => {
    const pa = (a.frontmatter.priority as number) ?? 99;
    const pb = (b.frontmatter.priority as number) ?? 99;
    return pa - pb;
  });
  return files;
}

/** Parse only YAML frontmatter — avoids the body capture group of the full
 *  FRONTMATTER_RE which forces a full-file scan for large bodies. */
function parseFrontmatterOnly(raw: string): Record<string, unknown> {
  // Frontmatter is delimited by --- at start and the next line with ---
  if (!raw.startsWith("---")) return {};
  const closeIdx = raw.indexOf("\n---", 3);
  if (closeIdx === -1) return {};
  const fmText = raw.slice(raw[3] === "\n" ? 4 : 3, closeIdx);
  return parseFrontmatterLines(fmText);
}

/** Load all always-injected system memory files. */
export function loadSystemMemory(cwd: string): MemoryFile[] {
  const root = findMemoryRoot(cwd);
  if (!root) return [];
  return loadMemoryDir(path.join(root, SYSTEM_DIR));
}

/** Load all on-demand learning files, including full content — needed by
 *  callers like computeFootprint that total up real byte/token sizes.
 *  Metadata-only consumers (descriptions, priority) should use the cheaper
 *  loadMemoryDirMetadata instead, as formatLearningSummaries does. */
export function listLearnings(cwd: string): MemoryFile[] {
  const root = findMemoryRoot(cwd);
  if (!root) return [];
  return loadMemoryDir(path.join(root, LEARNINGS_DIR));
}

/** Load a specific learning file by relative path. */
export function loadLearning(cwd: string, filename: string): MemoryFile | null {
  const root = findMemoryRoot(cwd);
  if (!root) return null;
  const fp = path.join(root, LEARNINGS_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, "utf-8");
  const { frontmatter, body } = parseMemoryFile(raw);
  return { path: fp, relPath: filename, frontmatter, body, raw };
}

// ── progress tracking ───────────────────────────────────────────────────────

/** Parse the progress.md file if it exists. */
export function loadProgress(cwd: string): Progress | null {
  const root = findMemoryRoot(cwd);
  if (!root) return null;
  const fp = path.join(root, SYSTEM_DIR, PROGRESS_FILE);
  if (!fs.existsSync(fp)) return null;
  const raw = fs.readFileSync(fp, "utf-8");
  const { body } = parseMemoryFile(raw);

  // Parse checklist items
  const checklist: { label: string; done: boolean }[] = [];
  const openDecisions: string[] = [];
  const nextSteps: string[] = [];
  let task = "";
  let status: Progress["status"] = "pending";

  // Known section headings (exact match, case-insensitive)
  const SECTION_MAP: Record<string, "checklist" | "decisions" | "next"> = {
    "checklist": "checklist",
    "open decisions": "decisions",
    "next steps": "next",
  };

  let section: "checklist" | "decisions" | "next" | "none" = "none";
  for (const line of body.split("\n")) {
    const h2m = line.match(/^##\s+(.*)/i);
    if (h2m) {
      const rawHeading = h2m[1]!.trim();
      const heading = rawHeading.toLowerCase();
      // Parse status from H2 (template uses "## Status: Pending")
      if (heading.startsWith("status:")) {
        const s = heading.slice(7).trim();
        status = parseStatus(s);
      } else {
        // Exact match first, then substring fallback for backward compat
        const matched = SECTION_MAP[heading];
        section = (matched ?? "none") as typeof section;
        if (section === "none") {
          if (heading.includes("checklist") || heading === "progress") {
            section = "checklist";
          } else if (heading.includes("decision")) {
            section = "decisions";
          } else if (heading.includes("next step")) {
            section = "next";
          }
        }
      }
      continue;
    }
    if (line.startsWith("# ")) {
      const rest = line.slice(2).trim();
      const lower = rest.toLowerCase();
      if (lower.startsWith("status:")) {
        status = parseStatus(lower.slice(7).trim());
      } else if (lower.startsWith("task:")) {
        task = rest.slice(5).trim();
      } else {
        // First H1 that isn't a status/task prefix line is the task title
        task = rest;
      }
      continue;
    }
    const cm = line.match(/^[-*]\s*\[(\s|x)\]\s*(.*)/);
    if (cm && section === "checklist") {
      checklist.push({ label: cm[2]!.trim(), done: cm[1] === "x" });
      continue;
    }
    const dm = line.match(/^\d+\.\s+(.*)/);
    if (dm && section === "decisions") {
      openDecisions.push(dm[1]!.trim());
      continue;
    }
    const nm = line.match(/^[-*]\s+(.*)/);
    if (nm && section === "next") {
      nextSteps.push(nm[1]!.trim());
      continue;
    }
  }

  const lastUpdated = fs.statSync(fp).mtime.toISOString();
  return { task, status, checklist, openDecisions, nextSteps, lastUpdated };
}

/** Parse a status string like "Pending" or "In Progress" into Progress["status"]. */
function parseStatus(raw: string): Progress["status"] {
  const s = raw.toLowerCase();
  if (s.includes("progress") || s === "in_progress") return "in_progress";
  if (s.includes("done") || s.includes("complete")) return "done";
  if (s.includes("block")) return "blocked";
  return "pending";
}

/** Format system memory for context injection. */
export function formatSystemMemory(cwd: string, maxTokens: number): string {
  // Exclude progress.md — it is injected separately via formatProgressInjection
  // (in a richer, parsed form). Including it here would duplicate it every turn.
  const files = loadSystemMemory(cwd).filter(
    (f) => path.basename(f.path) !== PROGRESS_FILE,
  );
  if (files.length === 0) return "";

  const parts: string[] = [];
  parts.push("## Project Memory (always loaded)");
  parts.push("");

  let total = 0;
  for (const f of files) {
    const desc = f.frontmatter.description as string | undefined;
    const header = desc ? `### ${desc}` : `### ${f.relPath}`;
    const block = `${header}\n${f.body}`;
    const estTokens = Math.ceil(block.length / 4);
    if (total + estTokens > maxTokens) {
      parts.push(`[... more memory files omitted — token budget]`);
      break;
    }
    parts.push(block);
    parts.push("");
    total += estTokens;
  }

  return parts.join("\n");
}

/** Format learning file summary for context (descriptions only, not bodies).
 *  Uses the metadata-only loader to avoid reading full learning bodies every turn. */
export function formatLearningSummaries(cwd: string): string {
  const root = findMemoryRoot(cwd);
  if (!root) return "";
  const files = loadMemoryDirMetadata(path.join(root, LEARNINGS_DIR));
  if (files.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Available Learnings (on-demand; read with `read` tool)");
  for (const f of files) {
    const desc = f.frontmatter.description || f.relPath;
    lines.push(`- **${f.relPath}**: ${desc}`);
  }
  return lines.join("\n");
}

/** Format progress for injection. Returns empty string if no progress. */
export function formatProgressInjection(cwd: string): string {
  const p = loadProgress(cwd);
  if (!p || !p.task) return "";

  const lines: string[] = [];
  lines.push("## Current Task Progress");
  lines.push("");
  lines.push(`**Task:** ${p.task}`);
  lines.push(`**Status:** ${p.status.replace(/_/g, " ")}`);

  if (p.checklist.length > 0) {
    lines.push("");
    lines.push("### Checklist");
    for (const item of p.checklist) {
      lines.push(`- [${item.done ? "x" : " "}] ${item.label}`);
    }
  }

  if (p.openDecisions.length > 0) {
    lines.push("");
    lines.push("### Open Decisions");
    for (let i = 0; i < p.openDecisions.length; i++) {
      lines.push(`${i + 1}. ${p.openDecisions[i]}`);
    }
  }

  if (p.nextSteps.length > 0) {
    lines.push("");
    lines.push("### Next Steps");
    for (const step of p.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

/** Create a template progress.md if it doesn't exist. */
export function ensureProgressFile(cwd: string): string {
  const root = ensureMemoryDirs(cwd);
  const fp = path.join(root, SYSTEM_DIR, PROGRESS_FILE);
  if (!fs.existsSync(fp)) {
    const template = `---
description: "Current task progress, checklist, decisions, and next steps"
priority: 0
type: "progress"
---
# Current Task

## Status: Pending

## Checklist
- [ ] Task item 1
- [ ] Task item 2

## Open Decisions
1. Decision to make (context, alternatives, leaning)

## Next Steps
- First concrete next action
- Second concrete next action
`;
    fs.writeFileSync(fp, template, "utf-8");
  }
  return fp;
}
