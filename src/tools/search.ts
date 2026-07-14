// grep_search + glob_files
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, globToRegExp } from "../lib/shared.ts";
import { walk } from "../lib/walk.ts";

const NUL = String.fromCharCode(0); // binary-file sentinel

function base(ctx: ExtensionContext, p?: string): string {
  if (!p) return ctx.cwd;
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

export function registerSearchTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grep_search",
    label: "Grep",
    description:
      "Search file contents for a regular expression across a directory tree " +
      "(skips node_modules, .git, etc). Returns matching file:line: text.",
    promptSnippet: "search file contents by regex",
    promptGuidelines: [
      "Narrow with the glob filter (e.g. **/*.ts) to keep results focused.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Regular expression to search for." }),
      path: Type.Optional(
        Type.String({ description: "Directory to search (default cwd)." }),
      ),
      glob: Type.Optional(
        Type.String({ description: "Only search files matching this glob, e.g. **/*.py" }),
      ),
      ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive (default false)." })),
      max_matches: Type.Optional(
        Type.Number({ description: "Stop after N matches (default 200)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      let re: RegExp;
      try {
        re = new RegExp(params.pattern, params.ignore_case ? "i" : "");
      } catch (e) {
        throw new Error(`Invalid regex: ${(e as Error).message}`);
      }
      const root = base(ctx, params.path);
      const fileFilter = params.glob ? globToRegExp(params.glob) : null;
      const max = params.max_matches ?? 200;
      const hits: string[] = [];
      let scanned = 0;
      for await (const file of walk(root)) {
        if (signal?.aborted) break;
        if (hits.length >= max) break;
        if (fileFilter) {
          const rel = path.relative(root, file);
          if (!fileFilter.test(rel) && !fileFilter.test(file)) continue;
        }
        scanned++;
        let content: string;
        try {
          content = await fs.readFile(file, "utf8");
        } catch {
          continue; // unreadable
        }
        if (content.indexOf(NUL) !== -1) continue; // skip binary files
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          if (re.test(lines[i])) {
            const rel = path.relative(ctx.cwd, file) || file;
            hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      if (hits.length === 0) {
        return text(`No matches for /${params.pattern}/ (scanned ${scanned} files).`);
      }
      return text(truncate(hits.join("\n")), {
        matches: hits.length,
        scanned,
        pattern: params.pattern,
      });
    },
    renderCall(args, theme, _context) {
      const pat = (args.pattern as string) ?? "?";
      let t = theme.fg("toolTitle", theme.bold("grep "));
      t += theme.fg("muted", `/${pat}/`);
      if (args.glob) t += theme.fg("dim", ` in ${args.glob as string}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const matches = d?.matches as number ?? 0;
      const scanned = d?.scanned as number ?? 0;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `${matches} match(es)`);
      if (scanned) summary += theme.fg("dim", `  (${scanned} files scanned)`);
      return new Text(summary, 0, 0);
    },
  });

  pi.registerTool({
    name: "glob_files",
    label: "Find Files",
    description:
      "Find files by glob pattern (supports **, *, ?) under a directory, " +
      "skipping noise dirs. Returns matching paths.",
    promptSnippet: "find files by name/glob pattern",
    promptGuidelines: [
      "Use glob_files to locate files by name pattern, e.g. **/*.test.ts or src/**/index.*",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts" }),
      path: Type.Optional(
        Type.String({ description: "Directory to search from (default cwd)." }),
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Cap the number of results (default 500)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = base(ctx, params.path);
      const re = globToRegExp(params.pattern);
      const max = params.max_results ?? 500;
      const found: string[] = [];
      for await (const file of walk(root)) {
        if (signal?.aborted) break;
        if (found.length >= max) break;
        const rel = path.relative(root, file);
        if (re.test(rel) || re.test(file)) {
          found.push(path.relative(ctx.cwd, file) || file);
        }
      }
      if (found.length === 0) return text(`No files match: ${params.pattern}`);
      return text(found.join("\n"), { count: found.length, pattern: params.pattern });
    },
    renderCall(args, theme, _context) {
      const pat = (args.pattern as string) ?? "?";
      let t = theme.fg("toolTitle", theme.bold("glob "));
      t += theme.fg("muted", pat);
      return new Text(t, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as Record<string, unknown> | undefined;
      const count = d?.count as number ?? 0;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `${count} file(s)`);
      return new Text(summary, 0, 0);
    },
  });
}
