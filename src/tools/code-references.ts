// code_references — progressive code understanding across files.
//
// Finds where a symbol is defined, imported, and called across the tree,
// with context around definitions and call sites so the model can infer
// expected inputs/outputs before editing — without reading whole files.

import { Type } from "typebox";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate } from "../lib/shared.ts";
import { findReferences, formatReferences } from "../lib/code-references.ts";

export function registerCodeReferencesTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_references",
    label: "Code References",
    description:
      "Find every reference to a symbol (function, class, variable) across " +
      "the codebase, classified as definition / import / call site / other, " +
      "with context lines around definitions and call sites. Use this to " +
      "understand how a function is called between files and what inputs/" +
      "outputs are expected BEFORE changing it.",
    promptSnippet: "trace a symbol's definition and call sites across files",
    promptGuidelines: [
      "Before modifying a function's signature or behavior, run code_references on it to see every caller and the shapes they pass/expect.",
      "Follow up with read_file on specific files only when a call site needs more context than the snippet shows.",
    ],
    parameters: Type.Object({
      symbol: Type.String({
        description: "The identifier to trace, e.g. 'formatBytes' or 'UserService'.",
      }),
      path: Type.Optional(
        Type.String({ description: "Directory to search (default cwd)." }),
      ),
      glob: Type.Optional(
        Type.String({ description: "Only scan files matching this glob, e.g. **/*.ts" }),
      ),
      max_refs: Type.Optional(
        Type.Number({ description: "Cap total references returned (default 60)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const symbol = params.symbol.trim();
      if (!symbol) throw new Error("'symbol' must be a non-empty identifier.");
      const root = params.path
        ? path.isAbsolute(params.path)
          ? params.path
          : path.resolve(ctx.cwd, params.path)
        : ctx.cwd;
      const { refs, filesScanned, truncated } = await findReferences(
        root,
        symbol,
        { glob: params.glob, maxRefs: params.max_refs },
        signal,
      );
      const defs = refs.filter((r) => r.kind === "definition").length;
      const calls = refs.filter((r) => r.kind === "call").length;
      return text(truncate(formatReferences(symbol, refs, filesScanned, truncated)), {
        symbol,
        total: refs.length,
        definitions: defs,
        calls,
        files: new Set(refs.map((r) => r.file)).size,
        truncated,
      });
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("code_references "));
      t += theme.fg("muted", (args.symbol as string) ?? "?");
      if (args.glob) t += theme.fg("dim", ` in ${args.glob as string}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      const total = (d?.total as number) ?? 0;
      const defs = (d?.definitions as number) ?? 0;
      const calls = (d?.calls as number) ?? 0;
      const files = (d?.files as number) ?? 0;
      let summary =
        theme.fg("success", "✓ ") +
        theme.fg("muted", `${total} ref(s) in ${files} file(s)`) +
        theme.fg("dim", `  (${defs} def, ${calls} call)`);
      if (expanded) {
        const head = firstText(result).split("\n").slice(0, 15).join("\n");
        summary += "\n" + theme.fg("dim", head);
      }
      return new Text(summary, 0, 0);
    },
  });
}
