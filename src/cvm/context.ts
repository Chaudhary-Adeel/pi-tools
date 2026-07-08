// Context resolution — assemble the smallest COMPLETE context for a symbol.
//
// Never returns whole files. A resolve returns:
//   - the requested symbol's exact source (verbatim, never summarized)
//   - signatures of the symbols it depends on (bodies only after expansion)
//   - its callers (file:line + the calling line)
//   - the defining file's relevant imports
//
// Every resolve computes a confidence score from dependency and caller
// coverage. Below the threshold, retrieval automatically expands one
// radius step (dependency signatures → dependency bodies) and rescores —
// reasoning quality is never sacrificed for token savings.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { estimateTokens } from "./fingerprint.ts";
import { HotCache } from "./hot-cache.ts";
import { cvmMetrics, recordConfidence, recordTokensSaved } from "./metrics.ts";
import { findSymbols, indexRepo, resetIndexDebounce } from "./symbols.ts";
import { getWarmStore, type SymbolRecord } from "./warm-store.ts";

// Keyed by path+mtime so an edit invalidates instantly — a TTL alone would
// serve pre-edit source as authoritative for its whole window.
const fileCache = new HotCache<string>({ capacity: 128, ttlMs: 5 * 60_000 });

const IDENT_RE = /[A-Za-z_$][\w$]{2,}/g;
const COMMON_IDENTS = new Set([
  "const", "return", "string", "number", "boolean", "void", "this", "true", "false",
  "null", "undefined", "console", "process", "Promise", "Array", "Object", "String",
  "Number", "Boolean", "Math", "JSON", "Error", "Map", "Set", "Buffer", "Date",
  "export", "import", "from", "async", "await", "function", "class", "interface",
  "type", "extends", "implements", "public", "private", "static", "readonly", "new",
]);

export interface ResolvedContext {
  symbol: string;
  found: boolean;
  confidence: number;
  expanded: boolean;
  markdown: string;
  tokens: number;
  tokensSavedVsFiles: number;
}

export interface ResolveOptions {
  /** Confidence below this triggers one automatic expansion (default 0.7). */
  confidenceThreshold?: number;
  /** Max definitions to include when a name is defined in several places. */
  maxDefinitions?: number;
  maxCallers?: number;
  signal?: AbortSignal;
}

async function readLines(cwd: string, rel: string): Promise<string[] | undefined> {
  const abs = path.join(cwd, rel);
  try {
    const stat = await fsp.stat(abs);
    const key = `${abs}:${stat.mtimeMs}:${stat.size}`;
    const cached = fileCache.get(key);
    if (cached !== undefined) return cached.split("\n");
    const content = await fsp.readFile(abs, "utf-8");
    fileCache.set(key, content);
    return content.split("\n");
  } catch {
    return undefined;
  }
}

function sliceSource(lines: string[], sym: SymbolRecord): string {
  return lines.slice(sym.line - 1, sym.endLine).join("\n");
}

/** Identifiers a source slice depends on, filtered to plausible symbols. */
export function dependencyCandidates(source: string, self: string): string[] {
  const counts = new Map<string, number>();
  for (const m of source.matchAll(IDENT_RE)) {
    const name = m[0]!;
    if (name === self || COMMON_IDENTS.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.keys()].slice(0, 40);
}

export async function resolveContext(
  cwd: string,
  symbolName: string,
  options: ResolveOptions = {},
): Promise<ResolvedContext> {
  const threshold = options.confidenceThreshold ?? 0.7;
  const maxDefs = options.maxDefinitions ?? 3;
  const maxCallers = options.maxCallers ?? 15;

  await indexRepo(cwd, { signal: options.signal });
  const warm = getWarmStore(cwd);

  let defs = findSymbols(cwd, symbolName).slice(0, maxDefs);

  // Staleness guard: if any defining file changed since it was indexed
  // (edits inside the index debounce window), force a reindex and re-look-up
  // so line ranges never slice outdated source.
  let stale = false;
  for (const def of defs) {
    const rec = warm.fileGet(def.file);
    try {
      const stat = await fsp.stat(path.join(cwd, def.file));
      if (!rec || rec.mtimeMs !== stat.mtimeMs || rec.size !== stat.size) stale = true;
    } catch {
      stale = true; // file gone
    }
    if (stale) break;
  }
  if (stale) {
    resetIndexDebounce(cwd);
    await indexRepo(cwd, { force: true, signal: options.signal });
    defs = findSymbols(cwd, symbolName).slice(0, maxDefs);
  }
  if (defs.length === 0) {
    recordConfidence(0);
    return {
      symbol: symbolName,
      found: false,
      confidence: 0,
      expanded: false,
      markdown:
        `No indexed definition for "${symbolName}". ` +
        "It may be external (package), dynamically defined, or misspelled — " +
        "fall back to grep_search / code_references.",
      tokens: 0,
      tokensSavedVsFiles: 0,
    };
  }

  const assemble = async (expandDeps: boolean) => {
    const parts: string[] = [];
    let depCandidates = 0;
    let depResolved = 0;
    const involvedFiles = new Set<string>();
    const includedDepNames = new Set<string>();

    for (const def of defs) {
      const lines = await readLines(cwd, def.file);
      if (!lines) continue;
      involvedFiles.add(def.file);
      const source = sliceSource(lines, def);

      parts.push(
        `## ${def.kind} \`${def.name}\` — ${def.file}:${def.line}-${def.endLine}`,
        "```",
        source,
        "```",
      );

      // Relevant imports from the defining file.
      const importLines = lines
        .filter((l) => /^\s*(import|from|use|require|include|using)\b/.test(l))
        .slice(0, 20);
      if (importLines.length > 0) {
        parts.push(`Imports in ${def.file}:`, "```", importLines.join("\n"), "```");
      }

      // Dependencies: known symbols referenced by this definition.
      const deps = dependencyCandidates(source, def.name);
      depCandidates += deps.length;
      const depLines: string[] = [];
      for (const dep of deps) {
        if (includedDepNames.has(dep)) {
          depResolved++;
          continue;
        }
        const depDefs = warm.symbolsByName(dep);
        if (depDefs.length === 0) continue;
        depResolved++;
        includedDepNames.add(dep);
        const d = depDefs[0]!;
        // The dep's file counts toward the "whole files" baseline either way:
        // without the CVM the model would have read it to understand the dep.
        involvedFiles.add(d.file);
        if (expandDeps) {
          const depFileLines = await readLines(cwd, d.file);
          if (depFileLines) {
            depLines.push(`### ${d.kind} \`${d.name}\` — ${d.file}:${d.line}`, "```", sliceSource(depFileLines, d), "```");
            continue;
          }
        }
        depLines.push(`- \`${d.signature}\`  (${d.file}:${d.line})`);
      }
      if (depLines.length > 0) {
        parts.push(expandDeps ? "Dependencies (expanded):" : "Dependency signatures:", ...depLines);
      }
    }

    // Callers — how this symbol is actually used.
    const callers = warm
      .refsToSymbol(symbolName, maxCallers * 2)
      .filter((r) => r.kind === "call" && !defs.some((d) => d.file === r.file && r.line >= d.line && r.line <= d.endLine))
      .slice(0, maxCallers);
    if (callers.length > 0) {
      const callerLines: string[] = [];
      for (const c of callers) {
        const lines = await readLines(cwd, c.file);
        const text = lines?.[c.line - 1]?.trim() ?? "";
        callerLines.push(`- ${c.file}:${c.line}: \`${text.slice(0, 140)}\``);
      }
      parts.push(`Callers (${callers.length}):`, ...callerLines);
    }

    // Confidence: definition found (0.5) + dependency coverage (0.3)
    // + caller knowledge (0.2 — full marks when callers found or none exist).
    const depCoverage = depCandidates === 0 ? 1 : depResolved / depCandidates;
    const callerScore = callers.length > 0 || warm.refsToSymbol(symbolName, 1).length === 0 ? 1 : 0.5;
    const confidence = 0.5 + 0.3 * depCoverage + 0.2 * callerScore;

    return { markdown: parts.join("\n"), confidence, involvedFiles };
  };

  let result = await assemble(false);
  let expanded = false;
  if (result.confidence < threshold) {
    cvmMetrics().context.expansions++;
    expanded = true;
    result = await assemble(true);
  }

  // Savings estimate: tokens of whole involved files vs what we returned.
  let wholeFileTokens = 0;
  for (const f of result.involvedFiles) {
    const lines = await readLines(cwd, f);
    if (lines) wholeFileTokens += estimateTokens(lines.join("\n"));
  }
  const tokens = estimateTokens(result.markdown);
  const saved = Math.max(0, wholeFileTokens - tokens);
  recordTokensSaved(saved);
  recordConfidence(result.confidence);

  return {
    symbol: symbolName,
    found: true,
    confidence: result.confidence,
    expanded,
    markdown: result.markdown,
    tokens,
    tokensSavedVsFiles: saved,
  };
}

/** Test hook. */
export function clearContextFileCache(): void {
  fileCache.clear();
}
