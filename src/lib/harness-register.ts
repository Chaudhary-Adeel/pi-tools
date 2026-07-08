// Event wiring for the delegation harness (see harness.ts for the logic).
//
// Registers:
//   - per-turn parallelization hints for decomposable prompts
//   - mid-loop steering nudges when serial research streaks run long
//   - context-pressure nudges at turn end
//   - a renderer so nudges show dimmed instead of as raw custom messages
//   - the /harness command for utilization stats

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DelegationTracker,
  estimateSubtasks,
  parallelizationHint,
} from "./harness.ts";
import { isAutoDelegateEnabled } from "./config.ts";
import { isSubagentProcess } from "../tools/subagents.ts";

const NUDGE_TYPE = "pi-tools:harness-nudge";
const HINT_MIN_SUBTASKS = 3;

export function registerDelegationHarness(pi: ExtensionAPI): void {
  // Subagent processes can't spawn subagents, so steering them toward
  // delegation would only mislead. The tracker stays out entirely.
  if (isSubagentProcess()) return;

  const tracker = new DelegationTracker();

  pi.on("agent_start", () => tracker.beginLoop());

  // 1. Prompt-shape analysis: decomposable request → hint into THIS turn's
  //    system prompt, while the model is still forming a plan.
  pi.on("before_agent_start", (event, ctx) => {
    if (!isAutoDelegateEnabled(ctx.cwd)) return;
    const subtasks = estimateSubtasks(event.prompt);
    const hint = subtasks >= HINT_MIN_SUBTASKS;
    tracker.recordPromptAnalysis(subtasks, hint);
    if (hint) {
      return { systemPrompt: event.systemPrompt + "\n\n" + parallelizationHint(subtasks) };
    }
  });

  // 2. Live tool stream: count research calls, notice fan-outs.
  pi.on("tool_execution_start", (event) => {
    const taskCount =
      event.toolName === "spawn_subagents"
        ? ((event.args?.tasks as unknown[] | undefined)?.length ?? 0)
        : 0;
    tracker.recordToolStart(event.toolName, taskCount);
  });

  // Streak nudge — steered into the active stream so the model can change
  // course before the next serial lookup.
  pi.on("tool_execution_end", (_event, ctx) => {
    if (!isAutoDelegateEnabled(ctx.cwd)) return;
    const nudge = tracker.maybeStreakNudge();
    if (nudge) {
      pi.sendMessage(
        { customType: NUDGE_TYPE, content: nudge, display: true },
        { deliverAs: "steer" },
      );
    }
  });

  // 3. Context pressure at turn end.
  pi.on("turn_end", (_event, ctx) => {
    if (!isAutoDelegateEnabled(ctx.cwd)) return;
    const nudge = tracker.maybeContextNudge(ctx.getContextUsage()?.percent);
    if (nudge) {
      pi.sendMessage(
        { customType: NUDGE_TYPE, content: nudge, display: true },
        { deliverAs: "steer" },
      );
    }
  });

  // Render nudges dimmed — informational, not conversation.
  pi.registerMessageRenderer(NUDGE_TYPE, (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(theme.fg("dim", content), 0, 0);
  });

  // /harness — show utilization stats and thresholds.
  pi.registerCommand("harness", {
    description: "Show delegation-harness stats: research calls, fan-outs, nudges",
    handler: async (_args, ctx) => {
      const enabled = isAutoDelegateEnabled(ctx.cwd);
      const header = enabled ? "" : "⚠ delegation harness is OFF (/config autoDelegate on)\n\n";
      ctx.ui.notify(header + tracker.formatStats(), "info");
    },
  });
}
