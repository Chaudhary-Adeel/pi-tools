// read_file — efficient file reading with line numbers, offset/limit, and
// streaming for large files. Pi's built-in `read` handles images and binary;
// read_file is the plain-text complement with explicit line ranges.
//
// Pi's built-in `write` and `edit` cover writing and editing, so this module
// only registers read_file. The write_file/edit_file implementations are kept
// in comments below for minimal-session usage — uncomment if needed.

import { Type } from "typebox";
import { promises as fsp, createReadStream, type Stats } from "node:fs";
import * as readline from "node:readline";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, errorText, truncate } from "../lib/shared.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function resolve(ctx: ExtensionContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

function shortPath(ctx: ExtensionContext, file: string): string {
  const rel = path.relative(ctx.cwd, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

async function safeStat(p: string): Promise<Stats | undefined> {
  try { return await fsp.stat(p); } catch { return undefined; }
}

// ── efficient line-range reading ───────────────────────────────────────────

const STREAMING_THRESHOLD = 2 * 1024 * 1024; // 2 MB

async function readLines(
  file: string,
  offset: number,
  limit?: number,
): Promise<{ lines: string[]; totalLines: number | null }> {
  const st = await safeStat(file);
  if (!st) throw new Error(`File not found: ${file}`);
  if (st.isDirectory()) throw new Error(`Path is a directory, not a file: ${file}`);

  if (st.size < STREAMING_THRESHOLD) {
    const content = await fsp.readFile(file, "utf8");
    const allLines = content.split("\n");
    const start = Math.max(1, offset);
    const end = limit ? start + limit - 1 : allLines.length;
    return { lines: allLines.slice(start - 1, end), totalLines: allLines.length };
  }

  // Stream for large files — only captures the requested range.
  const start = Math.max(1, offset);
  const end = limit ? start + limit - 1 : Infinity;
  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const captured: string[] = [];
  let lineNum = 0;
  let reached = false;
  for await (const line of rl) {
    lineNum++;
    if (lineNum < start) continue;
    if (lineNum > end) break;
    captured.push(line);
    reached = true;
  }
  if (!reached && lineNum < start) return { lines: [], totalLines: lineNum };
  return { lines: captured, totalLines: null };
}

// ── register ───────────────────────────────────────────────────────────────

export function registerFileTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_file",
    label: "Read File",
    description:
      "Read a UTF-8 text file from disk. Returns content with 1-based line " +
      "numbers. Supports reading a line range for large files. " +
      "For images/binary, use Pi's built-in `read` tool.",
    promptSnippet: "read a file from disk",
    promptGuidelines: [
      "Use read_file to inspect a file before editing it.",
      "For large files pass offset/limit to read only the relevant lines.",
      "Prefer Pi's built-in `read` tool when you need images or binary inspection.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path (absolute or cwd-relative)." }),
      offset: Type.Optional(
        Type.Number({ description: "1-based line to start from." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max lines to read (default all)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const file = resolve(ctx, params.path);
      try {
        const { lines, totalLines } = await readLines(
          file,
          params.offset ?? 1,
          params.limit,
        );
        const start = Math.max(1, params.offset ?? 1);
        const slice = lines
          .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
          .join("\n");
        return text(truncate(slice), {
          path: file,
          totalLines,
          start,
          end: start + lines.length - 1,
          linesRead: lines.length,
        });
      } catch (e) {
        return errorText(`Cannot read ${shortPath(ctx, file)}: ${(e as Error).message}`);
      }
    },
    renderCall(args, theme, _context) {
      const p = (args.path as string) ?? "?";
      let t = theme.fg("toolTitle", theme.bold("read_file "));
      t += theme.fg("muted", p);
      if (args.offset) t += theme.fg("dim", ` @L${args.offset}`);
      if (args.limit) t += theme.fg("dim", ` +${args.limit}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (result.isError) {
        const msg = result.content?.[0]?.text ?? "Error";
        return new Text(theme.fg("error", msg), 0, 0);
      }
      const total = d?.totalLines as number | undefined;
      const start = d?.start as number | undefined;
      const end = d?.end as number | undefined;
      const range = total != null
        ? `lines ${start ?? 1}–${end ?? total} of ${total}`
        : `lines ${start ?? 1}–${end ?? "?"}`;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", d?.path as string ?? "?");
      if (range) summary += "  " + theme.fg("dim", range);
      if (expanded) {
        const preview = result.content?.[0]?.text ?? "";
        const head = preview.split("\n").slice(0, 10).join("\n");
        summary += "\n" + theme.fg("dim", head);
        if (head.length < preview.length) summary += "\n" + theme.fg("dim", "…");
      }
      return new Text(summary, 0, 0);
    },
  });
}

/*
 * ── write_file / edit_file (unregistered — use Pi's built-in write/edit) ───
 *
 * Uncomment the registrations below if you're running a minimal SDK session
 * without Pi's built-in tools and need standalone write/edit capabilities.
 *
 *   pi.registerTool({ name: "write_file", ... });
 *   pi.registerTool({ name: "edit_file", ... });
 */
