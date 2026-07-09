// read_artifact — retrieve full text previously stashed by Quiet Output.
//
// When a tool's output is too large, the CVM compacts it to a head+tail
// preview and stores the complete text as a content-addressed cold-store
// object. This tool is the readback half of that contract.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate } from "../lib/shared.ts";
import { coldGet } from "../cvm/cold-store.ts";

export function registerReadArtifactTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_artifact",
    label: "Read Artifact",
    description:
      "Retrieve the full text of a large tool output that was compacted to " +
      "a preview (Quiet Output). Pass the fingerprint shown in the " +
      "compacted preview's omission marker.",
    promptSnippet: "retrieve the full text behind a compacted output",
    promptGuidelines: [
      "Only call this when the compacted preview truly isn't enough — most of the time the head+tail preview already answers the question.",
    ],
    parameters: Type.Object({
      fp: Type.String({
        description: "The FULL fingerprint from the 'Use read_artifact(...)' line in a compacted preview (not the short display id in the omission marker).",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const content = coldGet(ctx.cwd, params.fp);
      if (content === undefined) {
        throw new Error(
          `No artifact found for fingerprint "${params.fp}". Make sure you used the full ` +
            "fingerprint from the 'Use read_artifact(...)' instruction line, not the short id shown in the omission marker.",
        );
      }
      return text(truncate(content, 60_000), {
        fp: params.fp,
        chars: content.length,
        lines: content.split("\n").length,
      });
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("read_artifact "));
      t += theme.fg("muted", (args.fp as string) ?? "?");
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      let summary =
        theme.fg("success", "✓ ") + theme.fg("muted", `${d?.lines ?? "?"} lines retrieved`);
      if (expanded) summary += "\n" + theme.fg("dim", firstText(result).split("\n").slice(0, 10).join("\n"));
      return new Text(summary, 0, 0);
    },
  });
}
