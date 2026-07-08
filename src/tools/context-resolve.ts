// context_resolve — CVM symbol-level retrieval.
//
// The "never retrieve whole files" primitive: returns a symbol's exact
// source, its dependency signatures, relevant imports, and callers — with a
// confidence score, auto-expanding when coverage is too low.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText } from "../lib/shared.ts";
import { resolveContext } from "../cvm/context.ts";

export function registerContextResolveTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context_resolve",
    label: "Resolve Context",
    description:
      "Retrieve the smallest COMPLETE context for a symbol from the CVM " +
      "index: its exact source, dependency signatures, relevant imports, " +
      "and callers — instead of whole files. Includes a confidence score; " +
      "low-confidence retrievals auto-expand to dependency bodies. " +
      "Prefer this over reading entire files when you need to understand " +
      "or modify one function/class/type.",
    promptSnippet: "retrieve a symbol's minimal complete context (CVM)",
    promptGuidelines: [
      "Prefer context_resolve over read_file when a specific function/class/type is the target — it returns the symbol plus exactly its dependencies and callers, not the whole file.",
    ],
    parameters: Type.Object({
      symbol: Type.String({
        description: "The identifier to resolve, e.g. 'resolveContext' or 'WarmStore'.",
      }),
      confidence_threshold: Type.Optional(
        Type.Number({
          description:
            "Auto-expand retrieval when confidence falls below this (0-1, default 0.7).",
        }),
      ),
      max_callers: Type.Optional(
        Type.Number({ description: "Max caller sites to include (default 15)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await resolveContext(ctx.cwd, params.symbol.trim(), {
        confidenceThreshold: params.confidence_threshold,
        maxCallers: params.max_callers,
        signal,
      });
      const header = result.found
        ? `Context for \`${result.symbol}\` — confidence ${(result.confidence * 100).toFixed(0)}%` +
          `${result.expanded ? " (auto-expanded)" : ""}, ~${result.tokens} tokens ` +
          `(~${result.tokensSavedVsFiles} saved vs whole files)\n\n`
        : "";
      return text(header + result.markdown, {
        symbol: result.symbol,
        found: result.found,
        confidence: result.confidence,
        expanded: result.expanded,
        tokens: result.tokens,
        tokensSaved: result.tokensSavedVsFiles,
      });
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("context_resolve "));
      t += theme.fg("muted", (args.symbol as string) ?? "?");
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      if (!d?.found) {
        return new Text(theme.fg("warning", `◌ ${d?.symbol ?? "?"} not in index`), 0, 0);
      }
      const conf = ((d.confidence as number) * 100).toFixed(0);
      let summary =
        theme.fg("success", "✓ ") +
        theme.fg("muted", `${d.symbol as string}`) +
        theme.fg("dim", `  confidence ${conf}%${d.expanded ? " (expanded)" : ""}, ~${d.tokens} tok, ~${d.tokensSaved} saved`);
      if (expanded) {
        summary += "\n" + theme.fg("dim", firstText(result).split("\n").slice(0, 12).join("\n"));
      }
      return new Text(summary, 0, 0);
    },
  });
}
