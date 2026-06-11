// /learn — manually distill the current session into durable memory.
//
// Reads the current conversation, spawns a distiller subprocess that writes
// reusable learnings to .pi/memory/learnings/, and reports what it saved.
// This is the deliberate, visible counterpart to the automatic capture that
// runs on session shutdown.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildSessionSummary, distillLearnings } from "../lib/learn.ts";

export function registerLearnCommand(pi: ExtensionAPI): void {
  pi.registerCommand("learn", {
    description: "Distill this session into reusable memory (.pi/memory/learnings/)",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const summary = buildSessionSummary(entries as unknown[]);

      if (summary.assistantTurns === 0) {
        ctx.ui.notify("Nothing to learn from yet — have a conversation first.", "info");
        return;
      }

      ctx.ui.setStatus("learn", "💡 Distilling learnings…");
      ctx.ui.notify("💡 Capturing learnings from this session…", "info");

      try {
        const result = await distillLearnings({
          cwd: ctx.cwd,
          summary,
          model: ctx.model?.id,
          background: false,
          signal: ctx.signal,
        });

        if (result.newOrChanged.length > 0) {
          ctx.ui.notify(
            `💡 Saved ${result.newOrChanged.length} learning(s): ${result.newOrChanged.join(", ")}`,
            "info",
          );
        } else {
          ctx.ui.notify(
            result.output ? `💡 ${result.output}` : "💡 No new learnings worth saving.",
            "info",
          );
        }
      } catch (err) {
        ctx.ui.notify(
          `Learn failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("learn", undefined);
      }
    },
  });
}
