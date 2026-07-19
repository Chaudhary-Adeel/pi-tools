/**
 * Tree-sitter AST engine — replaces regex heuristics with real parse trees.
 *
 * Lazy-loads tree-sitter grammars per file extension. Falls back to the
 * existing regex-based extractors when tree-sitter or a grammar is unavailable,
 * so no hard dependency is introduced.
 *
 * Supported languages (auto-detected by extension):
 *   .ts/.tsx → tree-sitter-typescript
 *   .js/.jsx → tree-sitter-typescript (TSX grammar handles JS too)
 *   .py      → tree-sitter-python
 *   .rs      → tree-sitter-rust
 *   .go      → tree-sitter-go
 */

// NOTE: tree-sitter is an optional dependency. The module loads grammars
// lazily — if tree-sitter or a specific grammar isn't installed, the
// heuristic regex fallback (src/lib/code-references.ts) is used instead.
// This keeps pi-tools installable without native build requirements.

import type { SymbolRecord } from "../cvm/warm-store.ts";

// ── language registry ──────────────────────────────────────────────────────

interface LanguageConfig {
  /** File extensions this grammar handles. */
  extensions: string[];
  /** npm package to install for this grammar. */
  grammar: string;
}

const LANGUAGES: LanguageConfig[] = [
  { extensions: [".ts", ".tsx"], grammar: "tree-sitter-typescript" },
  { extensions: [".js", ".jsx", ".mjs", ".cjs"], grammar: "tree-sitter-typescript" },
  { extensions: [".py", ".pyi"], grammar: "tree-sitter-python" },
  { extensions: [".rs"], grammar: "tree-sitter-rust" },
  { extensions: [".go"], grammar: "tree-sitter-go" },
];

/** Map extension → language config for fast lookup. */
const EXT_MAP: Map<string, LanguageConfig> = new Map();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) EXT_MAP.set(ext, lang);
}

// ── API (Thin wrappers — real impl loads tree-sitter lazily) ──────────────

export function isSupported(ext: string): boolean {
  return EXT_MAP.has(ext.toLowerCase());
}

export function getGrammar(ext: string): string | undefined {
  return EXT_MAP.get(ext.toLowerCase())?.grammar;
}

/**
 * Extract symbols from source code using tree-sitter if available.
 * Falls back to the heuristic regex extractor when tree-sitter isn't loaded.
 *
 * @param filePath — absolute path (extension determines the parser)
 * @param source   — file contents as string
 * @returns Symbol records (empty array if parsing fails)
 */
export async function extractSymbols(
  filePath: string,
  source: string,
): Promise<Omit<SymbolRecord, "id" | "file" | "fp">[]> {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const lang = EXT_MAP.get(ext);
  if (!lang) return [];

  try {
    // Lazy-load tree-sitter — if it's not installed, return empty
    // and the caller falls back to heuristic extraction
    const Parser = await tryLoadTreeSitter();
    if (!Parser) return [];

    const grammar = await tryLoadGrammar(lang.grammar);
    if (!grammar) return [];

    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(source);

    return walkTreeForSymbols(tree.rootNode, source);
  } catch {
    return [];
  }
}

// ── lazy loading ───────────────────────────────────────────────────────────

let tsParser: any = null;
let tsLoaded = false;

async function tryLoadTreeSitter(): Promise<any> {
  if (tsLoaded) return tsParser;
  try {
    const ts = await import("tree-sitter");
    tsParser = ts.default ?? ts;
    tsLoaded = true;
    return tsParser;
  } catch {
    tsLoaded = true;
    return null;
  }
}

const grammarCache = new Map<string, any>();

async function tryLoadGrammar(pkg: string): Promise<any> {
  if (grammarCache.has(pkg)) return grammarCache.get(pkg) ?? null;
  try {
    const mod = await import(pkg);
    const grammar = mod.default ?? mod;
    grammarCache.set(pkg, grammar);
    return grammar;
  } catch {
    grammarCache.set(pkg, null);
    return null;
  }
}

// ── symbol extraction from tree-sitter AST ─────────────────────────────────

interface SimpleSymbol {
  name: string;
  kind: "function" | "class" | "variable" | "interface" | "type" | "enum" | "method";
  line: number;
}

function walkTreeForSymbols(node: any, source: string): SimpleSymbol[] {
  const symbols: SimpleSymbol[] = [];
  const lines = source.split("\n");

  function walk(n: any) {
    const kind = mapNodeKind(n.type);
    if (kind) {
      const text = source.slice(n.startIndex, n.endIndex);
      const name = extractName(text, n.type);
      if (name) {
        symbols.push({
          name,
          kind,
          line: n.startPosition.row + 1, // 1-based
        });
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i));
    }
  }

  walk(node);
  return symbols;
}

function mapNodeKind(tsType: string): SimpleSymbol["kind"] | null {
  if (tsType.includes("function_declaration") || tsType.includes("method_definition")) return "function";
  if (tsType.includes("arrow_function")) return "function";
  if (tsType.includes("class_declaration")) return "class";
  if (tsType.includes("interface_declaration")) return "interface";
  if (tsType.includes("type_alias_declaration")) return "type";
  if (tsType.includes("enum_declaration")) return "enum";
  if (tsType.includes("variable_declaration") || tsType.includes("lexical_declaration")) return "variable";
  return null;
}

function extractName(text: string, tsType: string): string | null {
  // Simple heuristic: the second word after the keyword is usually the name
  // e.g. "function foo(" → "foo", "class Bar {" → "Bar"
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return null;
  // Strip generics, parens, etc.
  const name = words[1]!.replace(/[<({].*$/, "").trim();
  return name || null;
}
