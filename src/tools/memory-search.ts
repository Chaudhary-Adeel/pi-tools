// memory_search tool — agent-callable search across all memory files.
//
// Searches .pi/memory/system/ and .pi/memory/learnings/ for a query string,
// returning file names, match counts, and context snippets. Skips the
// auto-generated memory-map.md. Output is trimmed to 5000 chars to avoid
// context blowout.

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { text } from "../lib/shared.ts";
import { findMemoryRoot, parseMemoryFile } from "../lib/memory.ts";

const MAX_OUTPUT = 5000;
const CONTEXT_LINES = 2;

interface MatchResult {
  file: string;        // relative path e.g. "system/conventions.md"
  matches: number;
  snippets: string[];  // context snippets
}

// ── search ─────────────────────────────────────────────────────────────────

function searchMemoryFiles(root: string, query: string): MatchResult[] {
  const lowerQuery = query.toLowerCase();
  const results: MatchResult[] = [];

  const dirs = ["system", "learnings"];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    if (!fs.existsSync(dirPath)) continue;

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name === "memory-map.md" && dir === "") continue; // root level only

      const filePath = path.join(dirPath, entry.name);
      const raw = fs.readFileSync(filePath, "utf-8");
      const { body } = parseMemoryFile(raw);

      if (!body) continue;

      const lines = body.split("\n");
      const matchLines: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(lowerQuery)) {
          matchLines.push(i);
        }
      }

      if (matchLines.length === 0) continue;

      const relPath = path.join(dir, entry.name);
      const snippets: string[] = [];

      for (const lineIdx of matchLines) {
        const start = Math.max(0, lineIdx - CONTEXT_LINES);
        const end = Math.min(lines.length, lineIdx + CONTEXT_LINES + 1);
        const snippet = lines.slice(start, end).join("\n");
        snippets.push(snippet);
      }

      results.push({
        file: relPath,
        matches: matchLines.length,
        snippets,
      });
    }
  }

  // Sort by match count descending
  results.sort((a, b) => b.matches - a.matches);
  return results;
}

function formatResults(results: MatchResult[], query: string): string {
  if (results.length === 0) {
    return `## 🔍 memory_search: "${query}"\n\nNo matches found in any memory file.`;
  }

  const parts: string[] = [];
  parts.push(`## 🔍 memory_search: "${query}"`);
  parts.push("");
  parts.push(`${results.length} file(s) matched, ${results.reduce((s, r) => s + r.matches, 0)} total matches`);
  parts.push("");

  let totalChars = parts.join("\n").length;

  for (const result of results) {
    // File header
    const fileHeader = `### ${result.file} (${result.matches} match${result.matches > 1 ? "es" : ""})`;
    if (totalChars + fileHeader.length + 2 > MAX_OUTPUT) {
      parts.push(`\n... [trimmed to ${MAX_OUTPUT} chars] ...`);
      break;
    }
    parts.push(fileHeader);
    parts.push("");
    totalChars += fileHeader.length + 2;

    // Snippets — show up to 3 per file to avoid bloat
    const maxSnippets = Math.min(result.snippets.length, 3);
    for (let i = 0; i < maxSnippets; i++) {
      const snippet = result.snippets[i]!;
      const snippetBlock = `\`\`\`\n${snippet}\n\`\`\``;
      if (totalChars + snippetBlock.length + 2 > MAX_OUTPUT) {
        parts.push(`\n... [trimmed to ${MAX_OUTPUT} chars] ...`);
        break;
      }
      parts.push(snippetBlock);
      parts.push("");
      totalChars += snippetBlock.length + 2;
    }

    if (maxSnippets < result.snippets.length) {
      const remaining = `... and ${result.snippets.length - maxSnippets} more snippet(s) in this file`;
      if (totalChars + remaining.length <= MAX_OUTPUT) {
        parts.push(remaining);
        totalChars += remaining.length;
      }
    }
  }

  let output = parts.join("\n");
  if (output.length > MAX_OUTPUT) {
    output = output.slice(0, MAX_OUTPUT - 30) + "\n\n... [trimmed to max output]";
  }
  return output;
}

// ── register ────────────────────────────────────────────────────────────────

export function registerMemorySearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search through all memory files in .pi/memory/system/ and " +
      ".pi/memory/learnings/ for a query. Returns matching file names, " +
      "match counts, and context snippets from the body (not frontmatter). " +
      "Use case-insensitive substring matching. Skips the auto-generated memory-map.md.",
    promptSnippet: "Search agent memory files for a query",
    promptGuidelines: [],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query (case-insensitive substring match)",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const query = (params.query as string).trim();

      if (!query) {
        throw new Error("Query must be a non-empty string.");
      }

      const root = findMemoryRoot(cwd);
      if (!root) {
        return text(
          `## 🔍 memory_search: "${query}"\n\nNo memory directory found. Create \`.pi/memory/\` to start building persistent memory.`,
          { query, root: null, results: [] },
        );
      }

      const results = searchMemoryFiles(root, query);
      const output = formatResults(results, query);

      return text(output, {
        query,
        resultCount: results.length,
        totalMatches: results.reduce((s, r) => s + r.matches, 0),
        files: results.map((r) => ({ file: r.file, matches: r.matches })),
      });
    },
  });
}
