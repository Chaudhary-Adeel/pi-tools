// /subagents — inspect subagent runs: the "complete story" the live widget
// can't show (it's transient and only ever displays the latest activity
// line per subagent). Every run's full prompt, full tool-by-tool activity
// timeline, and final result are persisted by lib/subagent-trace.ts and
// readable here at any time, during or after the run.
//
//   /subagents                list recent runs
//   /subagents <runId>        a run's summary (all subagents, one line each)
//   /subagents <runId> <n>    one subagent's full prompt + activity + result

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatRunList,
  formatRunSummary,
  formatSubagentTrace,
  listRuns,
  readSubagentTrace,
} from "../lib/subagent-trace.ts";

export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Inspect subagent runs: full prompts + activity traces, not just the final answer",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);

      if (parts.length === 0) {
        ctx.ui.notify(formatRunList(ctx.cwd, listRuns(ctx.cwd)), "info");
        return;
      }

      const [runId, indexArg] = parts;
      if (!runId) return;

      if (indexArg !== undefined) {
        const n = Number(indexArg);
        if (!Number.isInteger(n) || n < 1) {
          ctx.ui.notify(`Invalid subagent number: ${indexArg}`, "error");
          return;
        }
        const trace = readSubagentTrace(ctx.cwd, runId, n - 1);
        if (!trace) {
          ctx.ui.notify(`No subagent #${n} found in run ${runId}.`, "error");
          return;
        }
        ctx.ui.notify(formatSubagentTrace(trace), "info");
        return;
      }

      ctx.ui.notify(formatRunSummary(ctx.cwd, runId), "info");
    },
  });
}
