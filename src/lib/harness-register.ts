// Event wiring for the behavioral harness (see harness.ts for the logic).
//
// Registers:
//   - per-turn parallelization hints for decomposable prompts
//   - mid-loop steering nudges when serial research streaks run long
//   - context-pressure nudges at turn end
//   - a turn-end nudge when files were changed without a verification run
//   - a renderer so nudges show dimmed instead of as raw custom messages
//   - the /harness command for utilization + verification stats

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DelegationTracker,
  VerificationTracker,
  estimateSubtasks,
  parallelizationHint,
} from "./harness.ts";
import { isAutoDelegateEnabled } from "./config.ts";
import { isSubagentProcess } from "../tools/subagents.ts";

const NUDGE_TYPE = "pi-tools:harness-nudge";
const HINT_MIN_SUBTASKS = 3;

export function registerDelegationHarness(pi: ExtensionAPI): void {
  // Subagents still edit files and should still be nudged to verify their
  // own work, so only the delegation tracker (which steers toward
  // spawn_subagents — a tool subagents don't have) is skipped for them.
  const isSubagent = isSubagentProcess();

  const tracker = new DelegationTracker();
  const verifyTracker = new VerificationTracker();

  pi.on("agent_start", () => {
    if (!isSubagent) tracker.beginLoop();
    verifyTracker.beginLoop();
  });

  // 1. Prompt-shape analysis: decomposable request → hint into THIS turn's
  //    system prompt, while the model is still forming a plan. Subagents
  //    can't spawn subagents, so this stays main-session-only.
  pi.on("before_agent_start", (event, ctx) => {
    if (isSubagent || !isAutoDelegateEnabled(ctx.cwd)) return;
    const subtasks = estimateSubtasks(event.prompt);
    const hint = subtasks >= HINT_MIN_SUBTASKS;
    tracker.recordPromptAnalysis(subtasks, hint);
    if (hint) {
      return { systemPrompt: event.systemPrompt + "\n\n" + parallelizationHint(subtasks) };
    }
  });

  // 2. Live tool stream: count research calls / fan-outs (main session
  //    only), and track file mutations vs. verification runs (everywhere —
  //    subagents make real edits too and should be held to the same bar).
  pi.on("tool_execution_start", (event) => {
    if (!isSubagent) {
      const taskCount =
        event.toolName === "spawn_subagents"
          ? ((event.args?.tasks as unknown[] | undefined)?.length ?? 0)
          : 0;
      tracker.recordToolStart(event.toolName, taskCount);
    }
    verifyTracker.recordToolStart(event.toolName, event.args?.command as string | undefined);
  });

  // Streak nudge — steered into the active stream so the model can change
  // course before the next serial lookup.
  pi.on("tool_execution_end", (_event, ctx) => {
    if (isSubagent || !isAutoDelegateEnabled(ctx.cwd)) return;
    const nudge = tracker.maybeStreakNudge();
    if (nudge) {
      pi.sendMessage(
        { customType: NUDGE_TYPE, content: nudge, display: true },
        { deliverAs: "steer" },
      );
    }
  });

  // 3. Context pressure at turn end (main session only — subagents don't
  //    have anywhere further to delegate to).
  pi.on("turn_end", (_event, ctx) => {
    if (isSubagent || !isAutoDelegateEnabled(ctx.cwd)) return;
    const nudge = tracker.maybeContextNudge(ctx.getContextUsage()?.percent);
    if (nudge) {
      pi.sendMessage(
        { customType: NUDGE_TYPE, content: nudge, display: true },
        { deliverAs: "steer" },
      );
    }
  });

  // 4. Unverified-change nudge at turn end — everywhere, main session and
  //    subagents alike, since both make real edits.
  pi.on("turn_end", (_event, ctx) => {
    if (!isAutoDelegateEnabled(ctx.cwd)) return;
    const nudge = verifyTracker.maybeVerifyNudge();
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

  // /harness — show utilization + verification stats and thresholds.
  pi.registerCommand("harness", {
    description: "Show behavioral-harness stats: delegation + verification nudges",
    handler: async (_args, ctx) => {
      const enabled = isAutoDelegateEnabled(ctx.cwd);
      const header = enabled ? "" : "⚠ behavioral harness is OFF (/config autoDelegate on)\n\n";
      ctx.ui.notify(header + tracker.formatStats() + "\n\n" + verifyTracker.formatStats(), "info");
    },
  });
}
