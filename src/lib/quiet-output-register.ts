// Event wiring for Quiet Output (logic in cvm/quiet-output.ts).
//
// Two hooks:
//   tool_call — caps Pi's built-in `read` at a default line limit when the
//               model didn't specify one (prevents accidental full-file
//               dumps into context)
//   context   — fires before every LLM request with the full message
//               history (a deep clone — Pi's runner clones before invoking
//               handlers, so mutating/replacing here can never touch the
//               stored session or the TUI's rendering of past tool calls).
//               Oversized toolResult messages are swapped for a head+tail
//               preview in THIS outbound request only; the transcript stays
//               intact for scrollback and read_artifact recovery.
//
// This deliberately does NOT use the `tool_result` event: that hook's
// return value becomes the CANONICAL stored/rendered ToolResultMessage
// (verified against pi-coding-agent's agent-session.js), so compacting
// there would permanently replace what's shown in the terminal too. The
// `context` event only reshapes what's sent to the model.
//
// Runs in subagent processes too (safe — cold-store writes are
// content-addressed and idempotent, no shared-state race like the memory
// sweep has), so subagents get the same context-budget protection.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  applyReadDefaultLimit,
  compactIfLarge,
  DEFAULT_READ_LIMIT,
  QUIET_EXCLUDED_TOOLS,
} from "../cvm/quiet-output.ts";
import { cvmMetrics } from "../cvm/metrics.ts";
import { isQuietOutputEnabled } from "./config.ts";

export function registerQuietOutput(pi: ExtensionAPI): void {
  // ── cap unlimited read() calls ──
  pi.on("tool_call", (event, ctx) => {
    if (!isQuietOutputEnabled(ctx.cwd)) return;
    if (!isToolCallEventType("read", event)) return;
    if (applyReadDefaultLimit(event.input, DEFAULT_READ_LIMIT)) {
      cvmMetrics().quietOutput.readLimitApplied++;
    }
  });

  // ── compact oversized toolResult messages for the outbound request only ──
  pi.on("context", (event, ctx) => {
    if (!isQuietOutputEnabled(ctx.cwd)) return;

    let changed = false;
    const messages = event.messages.map((m) => {
      if (m.role !== "toolResult") return m;
      if (QUIET_EXCLUDED_TOOLS.has(m.toolName)) return m;

      const textParts = m.content.filter((p) => p.type === "text");
      const otherParts = m.content.filter((p) => p.type !== "text");
      if (textParts.length === 0) return m;

      const combined = textParts.map((p) => p.text).join("\n");
      const compacted = compactIfLarge(ctx.cwd, combined, m.isError);
      if (!compacted) return m;

      changed = true;
      return { ...m, content: [...otherParts, { type: "text" as const, text: compacted.preview }] };
    });

    if (changed) return { messages };
  });
}
