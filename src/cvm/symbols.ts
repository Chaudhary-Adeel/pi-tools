// Symbol memory — incremental, fingerprint-invalidated symbol index.
//
// Heuristic (regex + indentation) rather than Tree-sitter: this repo is
// zero-dependency, and for retrieval-guidance purposes line-accurate
// definitions with approximate extents are sufficient. The invalidation
// contract is the important part:
//
//   unchanged mtime+size        → reuse (no read, no parse)
//   changed stat, same content  → reuse (read + hash, no parse)
//   changed content             → reparse just that file
//
// so after the first index, repeated interactions never rescan the repo.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { walk } from "../lib/walk.ts";
import { compoundFp, fingerprint } from "./fingerprint.ts";
import { cvmMetrics } from "./metrics.ts";
import { getWarmStore, type RefRecord, type SymbolRecord } from "./warm-store.ts";

// ── language detection ──────────────────────────────────────────────────────

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".swift": "swift", ".rb": "ruby", ".php": "php", ".lua": "lua", ".cs": "csharp",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
};

export function detectLang(file: string): string | undefined {
  return LANG_BY_EXT[path.extname(file).toLowerCase()];
}

// ── extraction ──────────────────────────────────────────────────────────────

interface DefPattern {
  re: RegExp;
  kind: string;
}

// Definition heads across the supported languages. Group 1 = symbol name.
const DEF_PATTERNS: DefPattern[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?(?:type)\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
  { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/, kind: "function" },
  // py/rust/go/kotlin/swift: `def name(`, `async def name(`, `pub fn name(`, `func name(`
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+|async\s+|unsafe\s+|export\s+|static\s+|override\s+)*(?:def|fn|func|fun)\s+([A-Za-z_$][\w$]*)\s*[(<]/, kind: "function" },
  // go method receivers: `func (r *T) Name(`
  { re: /^\s*func\s+\([^)]*\)\s*([A-Za-z_$][\w$]*)\s*[(<]/, kind: "function" },
  { re: /^\s*struct\s+([A-Za-z_$][\w$]*)/, kind: "struct" },
  { re: /^\s*trait\s+([A-Za-z_$][\w$]*)/, kind: "trait" },
  { re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_$][\w$]*)/, kind: "impl" },
  { re: /^\s*module\s+([A-Za-z_$][\w$]*)/, kind: "module" },
];

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "function", "typeof",
  "await", "async", "throw", "delete", "void", "in", "of", "do", "else", "case",
  "super", "constructor", "require", "import", "export", "match", "print", "assert",
  "yield", "def", "fn", "func", "elif", "with", "not", "and", "or", "sizeof",
]);

export interface ExtractedFile {
  symbols: SymbolRecord[];
  refs: RefRecord[];
}

/** Heuristic end-line: scan forward until indentation returns to the
 *  definition's level with content (or a closing brace at that level),
 *  then extend while braces are unbalanced so dedented content inside the
 *  body (template literals, K&R variants) never truncates a definition. */
function findEndLine(lines: string[], start: number): number {
  const defIndent = lines[start]!.match(/^\s*/)![0].length;
  const cap = Math.min(lines.length, start + 400);
  let end = start;
  for (let i = start + 1; i < cap; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)![0].length;
    if (indent <= defIndent) {
      // Closing brace at def level belongs to the definition.
      if (/^[\s})\]]*;?$/.test(line)) end = i;
      break;
    }
    end = i;
  }

  // Brace-balance safety net (no-op for brace-less languages like Python).
  let balance = 0;
  for (let i = start; i <= end; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") balance++;
      else if (ch === "}") balance--;
    }
  }
  let extended = end;
  while (balance > 0 && extended + 1 < cap) {
    extended++;
    for (const ch of lines[extended]!) {
      if (ch === "{") balance++;
      else if (ch === "}") balance--;
    }
  }
  // Balanced (possibly after extending) → use the extended end; still
  // unbalanced at the cap → keep the conservative indentation-based end.
  return balance <= 0 ? Math.max(end, extended) : end;
}

export function extractSymbols(content: string, file: string): ExtractedFile {
  const lines = content.split("\n");
  const symbols: SymbolRecord[] = [];
  const refs: RefRecord[] = [];
  const seenAtLine = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Definitions
    for (const { re, kind } of DEF_PATTERNS) {
      const m = re.exec(line);
      if (m && m[1] && !seenAtLine.has(i)) {
        seenAtLine.add(i);
        const endLine = findEndLine(lines, i);
        symbols.push({
          id: compoundFp(file, m[1], i + 1),
          name: m[1],
          kind,
          file,
          line: i + 1,
          endLine: endLine + 1,
          signature: line.trim().slice(0, 200),
        });
        break;
      }
    }

    // Imports
    if (/^\s*(import|from|use|require|include|using)\b/.test(line)) {
      for (const m of line.matchAll(/([A-Za-z_$][\w$]{2,})/g)) {
        if (!CALL_KEYWORDS.has(m[1]!)) {
          refs.push({ symbolName: m[1]!, file, line: i + 1, kind: "import" });
        }
      }
      continue;
    }

    // Call sites: identifier immediately followed by "(".
    for (const m of line.matchAll(/([A-Za-z_$][\w$]{2,})\s*\(/g)) {
      const name = m[1]!;
      if (CALL_KEYWORDS.has(name)) continue;
      if (seenAtLine.has(i)) continue; // the definition line itself
      refs.push({ symbolName: name, file, line: i + 1, kind: "call" });
    }
  }

  // Bound refs so pathological files can't bloat the index.
  return { symbols, refs: refs.slice(0, 2000) };
}

// ── incremental indexing ────────────────────────────────────────────────────

export interface IndexStats {
  parsed: number;
  reused: number;
  deleted: number;
  files: number;
  symbols: number;
  ms: number;
}

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const lastIndexAt = new Map<string, number>();
const INDEX_DEBOUNCE_MS = 15_000;

/** Incrementally (re)index the repository's symbols. Cheap after the first
 *  run: unchanged files cost one stat() each. Debounced unless forced. */
export async function indexRepo(
  cwd: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<IndexStats> {
  const warm = getWarmStore(cwd);
  const started = Date.now();
  const stats: IndexStats = { parsed: 0, reused: 0, deleted: 0, files: 0, symbols: 0, ms: 0 };

  const debouncedAt = lastIndexAt.get(cwd) ?? 0;
  if (!options.force && started - debouncedAt < INDEX_DEBOUNCE_MS) {
    stats.symbols = warm.symbolCount();
    stats.files = warm.fileList().length;
    stats.ms = Date.now() - started;
    return stats;
  }
  lastIndexAt.set(cwd, started);

  const seen = new Set<string>();
  for await (const abs of walk(cwd)) {
    if (options.signal?.aborted) break;
    const lang = detectLang(abs);
    if (!lang) continue;
    const rel = path.relative(cwd, abs);
    seen.add(rel);
    stats.files++;

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    const prev = warm.fileGet(rel);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      stats.reused++;
      cvmMetrics().symbols.filesReused++;
      continue;
    }

    let content: string;
    try {
      content = await fsp.readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const fp = fingerprint(content);
    if (prev && prev.fp === fp) {
      // Touched but identical (e.g. checkout) — refresh stat, skip parsing.
      warm.fileUpsert({ ...prev, mtimeMs: stat.mtimeMs, size: stat.size });
      stats.reused++;
      cvmMetrics().symbols.filesReused++;
      continue;
    }

    const { symbols, refs } = extractSymbols(content, rel);
    warm.symbolsReplaceForFile(rel, symbols, refs);
    warm.fileUpsert({
      path: rel, fp, mtimeMs: stat.mtimeMs, size: stat.size, lang,
      indexedAt: Date.now(),
    });
    stats.parsed++;
    cvmMetrics().symbols.filesParsed++;
  }

  // Drop records for files that no longer exist.
  if (!options.signal?.aborted) {
    for (const rec of warm.fileList()) {
      if (!seen.has(rec.path)) {
        warm.fileDelete(rec.path);
        stats.deleted++;
      }
    }
  }

  stats.symbols = warm.symbolCount();
  stats.ms = Date.now() - started;
  return stats;
}

/** Near-instant lookup after initial indexing. */
export function findSymbols(cwd: string, name: string): SymbolRecord[] {
  cvmMetrics().symbols.lookups++;
  return getWarmStore(cwd).symbolsByName(name);
}

/** Test hook — clear the per-cwd index debounce. */
export function resetIndexDebounce(cwd?: string): void {
  if (cwd) lastIndexAt.delete(cwd);
  else lastIndexAt.clear();
}
