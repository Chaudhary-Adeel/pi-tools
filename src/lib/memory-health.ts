// Memory Health Engine — keeps .pi/memory/ accurate, minimal, self-healing.
//
// Continuously (session sweeps + after memory edits) the engine:
//   scores       every memory file 0–100 (structure, freshness, code-ref
//                validity, uniqueness, size)
//   validates    code references (paths + symbols) against the LIVE codebase
//                via the filesystem and the CVM symbol index
//   reconciles   dead file paths — a reference whose basename still exists in
//                exactly one place is rewritten to the new location
//   deduplicates near-identical learnings (the weaker one is archived)
//   compresses   deterministically (trailing whitespace, blank-line runs —
//                never inside code fences, never semantic/LLM rewriting)
//   expires      low-score, long-stale learnings into the archive
//
// Safety contract:
//   - NOTHING is ever deleted — archived files move to .pi/memory/archive/
//   - system/*.md is conservative: repair/compress/fix-ref only, never archived
//   - progress.md and memory-map.md are never touched (agent/generated files)
//   - every action is deterministic and reversible; no LLM rewrites content

import * as fs from "node:fs";
import * as path from "node:path";
import { fingerprint } from "../cvm/fingerprint.ts";
import { getWarmStore } from "../cvm/warm-store.ts";
import { jaccardWordSimilarity } from "./shared.ts";
import { findMemoryRoot, parseMemoryFile } from "./memory.ts";

// ── types ───────────────────────────────────────────────────────────────────

export interface MemoryHealth {
  /** Path relative to the memory root, e.g. "learnings/foo.md". */
  relPath: string;
  kind: "system" | "learning";
  fp: string;
  score: number; // 0–100
  issues: string[];
  deadRefs: string[];
  fixableRefs: Array<{ from: string; to: string }>;
  duplicateOf?: string;
  ageDays: number;
  bytes: number;
}

export type HealAction =
  | { type: "repair-frontmatter"; file: string; description: string }
  | { type: "fix-ref"; file: string; from: string; to: string }
  | { type: "compress"; file: string; savedBytes: number }
  | { type: "archive-duplicate"; file: string; duplicateOf: string }
  | { type: "archive-expired"; file: string; score: number };

export interface HealthReport {
  memoryRoot: string | null;
  files: MemoryHealth[];
  actions: HealAction[];
  avgScore: number;
  scannedAt: number;
}

export interface HealthThresholds {
  /** Similarity at/above which two learnings are duplicates. */
  duplicateSimilarity: number;
  /** Learnings below this score AND older than expireAfterDays get archived. */
  expireScore: number;
  expireAfterDays: number;
  /** Deduction cap for dead references. */
  maxRefPenalty: number;
  /** Bytes above which a memory is flagged oversized. */
  oversizeBytes: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  duplicateSimilarity: 0.75,
  expireScore: 40,
  expireAfterDays: 30,
  maxRefPenalty: 30,
  oversizeBytes: 16 * 1024,
};

/** Files the engine must never act on. */
const UNTOUCHABLE = new Set(["system/progress.md", "memory-map.md"]);

// ── code-reference extraction & validation ──────────────────────────────────

// Trailing "." allowed in the boundary set for sentence-ending references
// ("...see pkg/mod.go.") — a real prose pattern, not just a test artifact.
const PATH_REF_RE = /(?:^|[\s"'`(])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5})(?=$|[\s"'`),:;.])/gm;
const SYMBOL_REF_RE = /`([A-Za-z_$][\w$]{3,})(?:\(\))?`/g;

/** Path-like and backticked-symbol references found in a memory body. */
export function extractCodeRefs(body: string): { paths: string[]; symbols: string[] } {
  const paths = new Set<string>();
  for (const m of body.matchAll(PATH_REF_RE)) {
    const p = m[1]!;
    if (!p.startsWith("http") && !p.includes("://")) paths.add(p);
  }
  const symbols = new Set<string>();
  for (const m of body.matchAll(SYMBOL_REF_RE)) symbols.add(m[1]!);
  return { paths: [...paths], symbols: [...symbols] };
}

export interface RefValidation {
  deadPaths: string[];
  fixablePaths: Array<{ from: string; to: string }>;
  deadSymbols: string[];
}

/** Check references against the live codebase. A dead path whose basename
 *  exists in exactly one indexed location is fixable (the file moved).
 *  Symbols are checked against the CVM index only when the index is
 *  populated, and count as "dead" only if absent from both the index and a
 *  fast content check of the memory's own claims — heuristic extraction
 *  means we stay lenient to avoid false penalties. */
export function validateRefs(
  cwd: string,
  refs: { paths: string[]; symbols: string[] },
): RefValidation {
  const warm = getWarmStore(cwd);
  const result: RefValidation = { deadPaths: [], fixablePaths: [], deadSymbols: [] };

  let indexedFiles: string[] | undefined;
  for (const ref of refs.paths) {
    if (fs.existsSync(path.join(cwd, ref))) continue;
    indexedFiles ??= warm.fileList().map((f) => f.path);
    const base = path.basename(ref);
    const matches = indexedFiles.filter((f) => path.basename(f) === base);
    if (matches.length === 1) {
      result.fixablePaths.push({ from: ref, to: matches[0]!.replace(/\\/g, "/") });
    } else {
      result.deadPaths.push(ref);
    }
  }

  // Symbol validation is advisory-strength only when the index is real.
  if (warm.symbolCount() >= 50) {
    for (const sym of refs.symbols) {
      if (warm.symbolsByName(sym).length === 0) result.deadSymbols.push(sym);
    }
  }
  return result;
}

// ── similarity (duplicate detection) ────────────────────────────────────────

/** Word-set Jaccard over description + leading body. 0–1. */
export function memorySimilarity(a: { desc: string; body: string }, b: { desc: string; body: string }): number {
  return jaccardWordSimilarity(`${a.desc} ${a.body.slice(0, 600)}`, `${b.desc} ${b.body.slice(0, 600)}`);
}

// ── deterministic compression ───────────────────────────────────────────────

/** Strip trailing whitespace and collapse runs of 3+ blank lines to one,
 *  leaving fenced code blocks byte-identical. Purely mechanical — content
 *  meaning is never altered. */
export function compressDeterministic(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      blankRun = 0;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const trimmed = line.replace(/[ \t]+$/, "");
    if (trimmed === "") {
      blankRun++;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(trimmed);
  }
  return out.join("\n");
}

// ── scoring ─────────────────────────────────────────────────────────────────

interface ScanEntry {
  relPath: string;
  kind: "system" | "learning";
  raw: string;
  desc: string;
  body: string;
  mtimeMs: number;
  bytes: number;
}

function scanMemoryFiles(memoryRoot: string): ScanEntry[] {
  const entries: ScanEntry[] = [];
  for (const sub of ["system", "learnings"] as const) {
    const dir = path.join(memoryRoot, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const relPath = `${sub}/${name}`;
      if (UNTOUCHABLE.has(relPath)) continue;
      const full = path.join(dir, name);
      let raw: string;
      let stat: fs.Stats;
      try {
        raw = fs.readFileSync(full, "utf-8");
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const { frontmatter, body } = parseMemoryFile(raw);
      entries.push({
        relPath,
        kind: sub === "system" ? "system" : "learning",
        raw,
        desc: typeof frontmatter.description === "string" ? frontmatter.description : "",
        body,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
      });
    }
  }
  return entries;
}

/** Analyze all memories: score, validate against the codebase, and decide
 *  the safe healing actions. Pure analysis — nothing is written. */
export function analyzeMemoryHealth(
  cwd: string,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): HealthReport {
  const memoryRoot = findMemoryRoot(cwd);
  if (!memoryRoot) {
    return { memoryRoot: null, files: [], actions: [], avgScore: 100, scannedAt: Date.now() };
  }

  const entries = scanMemoryFiles(memoryRoot);
  const now = Date.now();
  const files: MemoryHealth[] = [];
  const actions: HealAction[] = [];

  // Pairwise duplicate detection among learnings. O(n²) — fine for budgeted
  // memory dirs (/doctor already flags bloat well before this matters), but
  // capped so a pathologically large learnings/ can't stall a background
  // sweep: beyond the cap, skip dedup for this pass rather than block.
  const MAX_DEDUP_PAIRWISE = 300;
  const duplicateOf = new Map<string, string>();
  const learnings = entries.filter((e) => e.kind === "learning");
  if (learnings.length <= MAX_DEDUP_PAIRWISE) {
    for (let i = 0; i < learnings.length; i++) {
      for (let j = i + 1; j < learnings.length; j++) {
        const a = learnings[i]!;
        const b = learnings[j]!;
        if (memorySimilarity(a, b) >= thresholds.duplicateSimilarity) {
          // Weaker = older mtime (less recently maintained) loses.
          const loser = a.mtimeMs <= b.mtimeMs ? a : b;
          const keeper = loser === a ? b : a;
          if (!duplicateOf.has(loser.relPath)) duplicateOf.set(loser.relPath, keeper.relPath);
        }
      }
    }
  }

  for (const e of entries) {
    const issues: string[] = [];
    let score = 100;

    if (!e.desc) {
      score -= 25;
      issues.push("missing frontmatter description");
    }
    if (e.body.trim().length < 20) {
      score -= 30;
      issues.push("empty or trivial body");
    }

    const ageDays = (now - e.mtimeMs) / 86_400_000;
    // Flag staleness at the same age the expiry action later archives at
    // (thresholds.expireAfterDays) — a file shouldn't reach expiry without
    // ever having been surfaced as stale in the report first.
    if (e.kind === "learning" && ageDays > thresholds.expireAfterDays) {
      score -= 15;
      issues.push(`stale (${Math.round(ageDays)}d untouched)`);
    }

    const refs = extractCodeRefs(e.body);
    const validation = validateRefs(cwd, refs);
    const refPenalty = Math.min(
      thresholds.maxRefPenalty,
      validation.deadPaths.length * 10 + validation.deadSymbols.length * 5,
    );
    if (refPenalty > 0) {
      score -= refPenalty;
      if (validation.deadPaths.length > 0)
        issues.push(`dead file references: ${validation.deadPaths.join(", ")}`);
      if (validation.deadSymbols.length > 0)
        issues.push(`unknown symbols: ${validation.deadSymbols.join(", ")}`);
    }

    const dup = duplicateOf.get(e.relPath);
    if (dup) {
      score -= 20;
      issues.push(`duplicates ${dup}`);
    }

    if (e.bytes > thresholds.oversizeBytes) {
      score -= 10;
      issues.push(`oversized (${(e.bytes / 1024).toFixed(1)} KB)`);
    }

    score = Math.max(0, score);
    files.push({
      relPath: e.relPath,
      kind: e.kind,
      fp: fingerprint(e.raw),
      score,
      issues,
      deadRefs: [...validation.deadPaths, ...validation.deadSymbols],
      fixableRefs: validation.fixablePaths,
      duplicateOf: dup,
      ageDays,
      bytes: e.bytes,
    });

    // ── decide safe actions ──
    if (!e.desc) {
      const heading = e.body.match(/^#+\s+(.+)$/m)?.[1] ?? e.body.trim().split("\n")[0] ?? e.relPath;
      actions.push({
        type: "repair-frontmatter",
        file: e.relPath,
        description: heading.slice(0, 120),
      });
    }
    for (const fix of validation.fixablePaths) {
      actions.push({ type: "fix-ref", file: e.relPath, from: fix.from, to: fix.to });
    }
    const compressed = compressDeterministic(e.raw);
    const saved = e.raw.length - compressed.length;
    if (saved > Math.max(64, e.raw.length * 0.05)) {
      actions.push({ type: "compress", file: e.relPath, savedBytes: saved });
    }
    if (e.kind === "learning") {
      if (dup) {
        actions.push({ type: "archive-duplicate", file: e.relPath, duplicateOf: dup });
      } else if (score < thresholds.expireScore && ageDays > thresholds.expireAfterDays) {
        actions.push({ type: "archive-expired", file: e.relPath, score });
      }
    }
  }

  const avgScore =
    files.length === 0 ? 100 : files.reduce((s, f) => s + f.score, 0) / files.length;
  return { memoryRoot, files, actions, avgScore, scannedAt: now };
}

// ── applying actions ────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: HealAction[];
  skipped: Array<{ action: HealAction; reason: string }>;
}

/** Apply healing actions. Archives move files (never delete); text changes
 *  are deterministic. A file archived by one action is skipped by later ones. */
export function applyHealActions(cwd: string, report: HealthReport): ApplyResult {
  const result: ApplyResult = { applied: [], skipped: [] };
  if (!report.memoryRoot) return result;
  const root = report.memoryRoot;
  const gone = new Set<string>();

  const archive = (relPath: string): boolean => {
    const from = path.join(root, relPath);
    if (!fs.existsSync(from)) return false;
    const archiveDir = path.join(root, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    let dest = path.join(archiveDir, `${stamp}-${path.basename(relPath)}`);
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(archiveDir, `${stamp}-${n++}-${path.basename(relPath)}`);
    }
    fs.renameSync(from, dest);
    gone.add(relPath);
    return true;
  };

  for (const action of report.actions) {
    if (gone.has(action.file)) {
      result.skipped.push({ action, reason: "file already archived this sweep" });
      continue;
    }
    const full = path.join(root, action.file);
    try {
      switch (action.type) {
        case "repair-frontmatter": {
          const raw = fs.readFileSync(full, "utf-8");
          const { frontmatter, body } = parseMemoryFile(raw);
          if (frontmatter.description) {
            result.skipped.push({ action, reason: "already has a description" });
            continue;
          }
          // Preserve any existing frontmatter keys; only add the description.
          const otherKeys = Object.entries(frontmatter).map(([k, v]) =>
            typeof v === "string" ? `${k}: "${v}"` : `${k}: ${String(v)}`,
          );
          const fmBlock = [
            "---",
            `description: "${action.description.replace(/"/g, "'")}"`,
            ...otherKeys,
            "---",
          ].join("\n");
          fs.writeFileSync(full, `${fmBlock}\n${body}`, "utf-8");
          break;
        }
        case "fix-ref": {
          const raw = fs.readFileSync(full, "utf-8");
          if (!raw.includes(action.from)) {
            result.skipped.push({ action, reason: "reference no longer present" });
            continue;
          }
          fs.writeFileSync(full, raw.split(action.from).join(action.to), "utf-8");
          break;
        }
        case "compress": {
          const raw = fs.readFileSync(full, "utf-8");
          fs.writeFileSync(full, compressDeterministic(raw), "utf-8");
          break;
        }
        case "archive-duplicate":
        case "archive-expired": {
          if (!archive(action.file)) {
            result.skipped.push({ action, reason: "file missing" });
            continue;
          }
          break;
        }
      }
      result.applied.push(action);
    } catch (e) {
      result.skipped.push({ action, reason: (e as Error).message });
    }
  }

  // Persist a bounded action log for observability.
  try {
    const warm = getWarmStore(cwd);
    const prev = JSON.parse(warm.kvGet("memhealth:log") ?? "[]") as unknown[];
    const entry = { at: Date.now(), applied: result.applied };
    warm.kvSet("memhealth:log", JSON.stringify([...prev.slice(-99), entry]));
  } catch {
    /* observability must never break healing */
  }

  return result;
}

// ── report formatting ───────────────────────────────────────────────────────

export function formatHealthReport(report: HealthReport, applied?: ApplyResult): string {
  if (!report.memoryRoot) return "No .pi/memory/ directory — nothing to heal.";
  const lines: string[] = [
    `Memory health: ${report.avgScore.toFixed(0)}/100 across ${report.files.length} file(s)`,
  ];
  const sorted = [...report.files].sort((a, b) => a.score - b.score);
  for (const f of sorted) {
    const flag = f.score >= 80 ? "✓" : f.score >= 50 ? "◐" : "✗";
    lines.push(`  ${flag} ${String(f.score).padStart(3)}  ${f.relPath}${f.issues.length ? ` — ${f.issues.join("; ")}` : ""}`);
  }
  if (applied) {
    lines.push("");
    lines.push(
      applied.applied.length === 0
        ? "No healing actions needed."
        : `Healed (${applied.applied.length}):`,
    );
    for (const a of applied.applied) {
      switch (a.type) {
        case "repair-frontmatter": lines.push(`  + repaired frontmatter: ${a.file}`); break;
        case "fix-ref": lines.push(`  + fixed reference in ${a.file}: ${a.from} → ${a.to}`); break;
        case "compress": lines.push(`  + compressed ${a.file} (−${a.savedBytes} bytes)`); break;
        case "archive-duplicate": lines.push(`  + archived duplicate ${a.file} (kept ${a.duplicateOf})`); break;
        case "archive-expired": lines.push(`  + archived expired ${a.file} (score ${a.score})`); break;
      }
    }
    for (const s of applied.skipped) {
      lines.push(`  ~ skipped ${s.action.type} ${s.action.file}: ${s.reason}`);
    }
  }
  return lines.join("\n");
}
