// todo_finder — scan codebase for TODO, FIXME, HACK, XXX, and other task markers.
// Returns an organized list grouped by marker type with file:line locations.

import { Type } from "typebox";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate } from "../lib/shared.ts";
import { walk } from "../lib/walk.ts";

// ── patterns ────────────────────────────────────────────────────────────────

const MARKERS: { re: RegExp; label: string }[] = [
  { re: /\bTODO\b[:\s]*/i, label: "TODO" },
  { re: /\bFIXME\b[:\s]*/i, label: "FIXME" },
  { re: /\bHACK\b[:\s]*/i, label: "HACK" },
  { re: /\bXXX\b/i, label: "XXX" },
  { re: /\bOPTIMIZE\b[:\s]*/i, label: "OPTIMIZE" },
  { re: /\bBUG\b[:\s]*/i, label: "BUG" },
  { re: /\bREVIEW\b[:\s]*/i, label: "REVIEW" },
  { re: /\bNOTE\b[:\s]*/i, label: "NOTE" },
];

const CODE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".kt",
  ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".scala",
  ".vue", ".svelte", ".sql", ".sh", ".bash", ".yaml", ".yml", ".toml",
  ".json", ".md",
]);

function base(ctx: ExtensionContext, p?: string): string {
  if (!p) return ctx.cwd;
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

// ── register ────────────────────────────────────────────────────────────────

export function registerTodoFinder(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo_finder",
    label: "TODO Finder",
    description:
      "Scan the codebase for TODO, FIXME, HACK, XXX, and other task markers. " +
      "Returns items grouped by marker type with file:line locations and the " +
      "surrounding comment context. Useful for tech debt visibility and sprint planning.",
    promptSnippet: "find TODO/FIXME/HACK markers across the codebase",
    promptGuidelines: [
      "Use before large refactors to understand deferred work in the affected area.",
      "Filter by path to focus on a specific module.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory to scan (default cwd)." }),
      ),
      markers: Type.Optional(
        Type.String({
          description: "Comma-separated markers to find (default: TODO,FIXME,HACK,XXX,OPTIMIZE,BUG).",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Cap total results (default 200)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = base(ctx, params.path);
      const markerNames = (params.markers as string ?? "TODO,FIXME,HACK,XXX,OPTIMIZE,BUG")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);

      const active = MARKERS.filter((m) => markerNames.includes(m.label));
      if (active.length === 0) throw new Error("No valid markers specified.");

      const max = (params.max_results as number) ?? 200;
      const hits: Record<string, string[]> = {};
      for (const m of active) hits[m.label] = [];

      let filesScanned = 0;
      let totalHits = 0;

      for await (const file of walk(root)) {
        if (signal?.aborted) break;
        if (totalHits >= max) break;

        const ext = path.extname(file).toLowerCase();
        if (!CODE_FILE_EXTENSIONS.has(ext)) continue;

        let content: string;
        try {
          content = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        filesScanned++;

        const lines = content.split("\n");
        const rel = path.relative(ctx.cwd, file).replace(/\\/g, "/");

        for (let i = 0; i < lines.length; i++) {
          if (totalHits >= max) break;
          const line = lines[i]!;
          for (const marker of active) {
            if (totalHits >= max) break;
            if (!marker.re.test(line)) continue;

            const text = line.trim();
            if (hits[marker.label]!.length >= Math.ceil(max / active.length)) continue;

            hits[marker.label]!.push(`${rel}:${i + 1}: ${text}`);
            totalHits++;
          }
        }
      }

      // Build output grouped by marker
      const parts: string[] = [];
      let grandTotal = 0;
      for (const marker of active) {
        const items = hits[marker.label]!;
        if (items.length === 0) continue;
        grandTotal += items.length;
        parts.push(`## ${marker.label} (${items.length})`);
        for (const item of items.slice(0, 30)) parts.push(item);
        if (items.length > 30) parts.push(`... and ${items.length - 30} more`);
        parts.push("");
      }

      if (grandTotal === 0) {
        return text(`No markers found in ${filesScanned} files.`);
      }

      return text(truncate(parts.join("\n")), {
        total: grandTotal,
        filesScanned,
        markerBreakdown: Object.fromEntries(
          active.map((m) => [m.label, hits[m.label]!.length]),
        ),
      });
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("todo_finder "));
      t += theme.fg("muted", (args.path as string) ?? ".");
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      const total = (d?.total as number) ?? 0;
      const breakdown = d?.markerBreakdown as Record<string, number> | undefined;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `${total} marker(s)`);
      if (breakdown) {
        const parts = Object.entries(breakdown)
          .filter(([, c]) => c > 0)
          .map(([k, v]) => `${k}:${v}`);
        if (parts.length) summary += theme.fg("dim", `  (${parts.join(", ")})`);
      }
      return new Text(summary, 0, 0);
    },
  });
}
