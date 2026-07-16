// Cross-file symbol reference analysis — the engine behind code_references.
//
// Given a symbol name, walks the tree and classifies every occurrence as a
// definition, an import, or a call/reference. Call sites include surrounding
// context lines so the caller can see how the function is invoked between
// files and infer its expected inputs and outputs without reading whole files.
//
// Heuristic and language-agnostic by design (regex, not AST): tuned for
// JS/TS/Python/Go/Rust/Java-style code, good enough to direct deeper reads.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { walk } from "./walk.ts";
import { globToRegExp } from "./shared.ts";

export type RefKind = "definition" | "import" | "call" | "reference";

export interface SymbolRef {
  file: string; // relative to root
  line: number; // 1-based
  kind: RefKind;
  text: string; // the matching line, trimmed
  context?: string[]; // surrounding lines (call sites + definitions)
}

export interface FindReferencesOptions {
  glob?: string;
  maxRefs?: number;
  contextLines?: number;
}

const NUL = String.fromCharCode(0);

/** Escape a symbol for embedding in a regex. */
function escapeRe(s: string): string {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

const DEF_KEYWORDS =
  "function|class|interface|type|enum|struct|trait|impl|def|fn|func|sub|macro";

function classifyLine(line: string, symbol: string): RefKind {
  const sym = escapeRe(symbol);
  // Imports / requires / includes
  if (
    new RegExp(`^\\s*(import|from|use|require|include|using)\\b.*\\b${sym}\\b`).test(line) ||
    new RegExp(`\\brequire\\s*\\(.*${sym}`).test(line)
  ) {
    return "import";
  }
  // Definitions: keyword before the symbol, or assignment of a function/lambda,
  // or a method/function signature form `symbol(...)  {` / `symbol(...):`
  if (
    new RegExp(`\\b(${DEF_KEYWORDS})\\s+${sym}\\b`).test(line) ||
    new RegExp(`\\b(const|let|var|val)\\s+${sym}\\s*=`).test(line) ||
    new RegExp(`^\\s*(export\\s+)?(async\\s+)?${sym}\\s*(=\\s*(async\\s*)?\\(|\\([^)]*\\)\\s*(\\{|=>|:))`).test(line)
  ) {
    return "definition";
  }
  // Call: symbol immediately followed by (
  if (new RegExp(`\\b${sym}\\s*\\(`).test(line)) return "call";
  return "reference";
}

export async function findReferences(
  root: string,
  symbol: string,
  options: FindReferencesOptions = {},
  signal?: AbortSignal,
): Promise<{ refs: SymbolRef[]; filesScanned: number; truncated: boolean }> {
  const wordRe = new RegExp(`\\b${escapeRe(symbol)}\\b`);
  const fileFilter = options.glob ? globToRegExp(options.glob) : null;
  const maxRefs = options.maxRefs ?? 60;
  const ctxN = options.contextLines ?? 2;

  const refs: SymbolRef[] = [];
  let filesScanned = 0;
  let truncated = false;

  for await (const file of walk(root)) {
    if (signal?.aborted) break;
    if (refs.length >= maxRefs) {
      truncated = true;
      break;
    }
    if (fileFilter && !fileFilter.test(file)) continue;
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.indexOf(NUL) !== -1) continue; // binary
    if (!wordRe.test(content)) continue; // fast reject before line split
    filesScanned++;

    const lines = content.split("\n");
    const rel = (path.relative(root, file) || file).replace(/\\/g, "/");
    for (let i = 0; i < lines.length; i++) {
      if (!wordRe.test(lines[i]!)) continue;
      if (refs.length >= maxRefs) {
        truncated = true; // a further match exists beyond the cap
        break;
      }
      const kind = classifyLine(lines[i]!, symbol);
      const ref: SymbolRef = { file: rel, line: i + 1, kind, text: lines[i]!.trim() };
      // Context for definitions and call sites — that's where the
      // inputs/outputs picture comes from.
      if (kind === "definition" || kind === "call") {
        const from = Math.max(0, i - ctxN);
        const to = Math.min(lines.length, i + ctxN + 1);
        ref.context = lines.slice(from, to).map((l, j) => `${from + j + 1}: ${l}`);
      }
      refs.push(ref);
    }
  }

  return { refs, filesScanned, truncated };
}

const KIND_ORDER: RefKind[] = ["definition", "import", "call", "reference"];
const KIND_LABEL: Record<RefKind, string> = {
  definition: "Definitions",
  import: "Imports",
  call: "Call sites",
  reference: "Other references",
};

export function formatReferences(
  symbol: string,
  refs: SymbolRef[],
  filesScanned: number,
  truncated: boolean,
): string {
  if (refs.length === 0) return `No references to "${symbol}" found (${filesScanned} matching files scanned).`;
  const parts: string[] = [
    `References to "${symbol}" — ${refs.length} hit(s) across ${new Set(refs.map((r) => r.file)).size} file(s):`,
  ];
  for (const kind of KIND_ORDER) {
    const group = refs.filter((r) => r.kind === kind);
    if (group.length === 0) continue;
    parts.push(`\n## ${KIND_LABEL[kind]} (${group.length})`);
    for (const r of group) {
      if (r.context) {
        parts.push(`${r.file}:${r.line}\n${r.context.map((c) => `  ${c}`).join("\n")}`);
      } else {
        parts.push(`${r.file}:${r.line}: ${r.text}`);
      }
    }
  }
  if (truncated) parts.push("\n… result cap reached — narrow with glob to see more.");
  return parts.join("\n");
}
