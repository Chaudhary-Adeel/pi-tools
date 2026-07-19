// Agent-to-Agent Handoff Protocol
//
// When context limits are reached during long-running tasks (>50% used),
// the agent writes a structured handoff document so the next session can
// pick up seamlessly. This extends the existing .pi/memory/progress.md
// with structured task state, decisions made, and files in progress.
//
// The agent triggers handoff automatically when warned about context
// pressure, or manually via /handoff.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface Handoff {
  /** When this handoff was created */
  timestamp: string;
  /** What the user originally asked for */
  originalRequest: string;
  /** What has been completed so far */
  completedSteps: string[];
  /** What remains to be done */
  remainingSteps: string[];
  /** Key decisions made and why */
  decisions: { decision: string; rationale: string }[];
  /** Files currently being modified */
  filesInProgress: string[];
  /** Files that were changed (for the next agent to review) */
  filesChanged: string[];
  /** Specific notes for the next agent */
  notes: string;
  /** Context usage at handoff time */
  contextUsagePct: number;
}

const HANDOFF_PATH = ".pi/handoff.json";

export function loadHandoff(cwd: string): Handoff | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, HANDOFF_PATH), "utf8"));
  } catch {
    return null;
  }
}

export function writeHandoff(cwd: string, handoff: Handoff): void {
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, HANDOFF_PATH), JSON.stringify(handoff, null, 2));
}

export function clearHandoff(cwd: string): void {
  try { fs.unlinkSync(path.join(cwd, HANDOFF_PATH)); } catch {}
}

export function registerHandoffCommand(pi: ExtensionAPI): void {
  pi.registerCommand("handoff", {
    description:
      "Create or load a structured task handoff for seamless session continuation. " +
      "Use when context is running low on long tasks.",
    handler: async (args, ctx) => {
      const sub = args[0] ?? "status";
      const cwd = ctx.cwd;

      switch (sub) {
        case "status":
        case "load": {
          const handoff = loadHandoff(cwd);
          if (!handoff) {
            ctx.ui.notify("No active handoff. Run /handoff create to start one.", "info");
            return;
          }
          const lines = [
            "## Active Handoff",
            "",
            `Created: ${handoff.timestamp}`,
            `Context usage at handoff: ${handoff.contextUsagePct}%`,
            "",
            "**Original Request:**",
            handoff.originalRequest,
            "",
            "**Completed:**",
            ...handoff.completedSteps.map((s) => `  ✅ ${s}`),
            "",
            "**Remaining:**",
            ...handoff.remainingSteps.map((s) => `  ⬜ ${s}`),
            "",
            "**Decisions:**",
            ...handoff.decisions.map((d) => `  • ${d.decision}: ${d.rationale}`),
            "",
            "**Files in progress:**",
            ...handoff.filesInProgress.map((f) => `  📝 ${f}`),
            "",
            "**Files changed:**",
            ...handoff.filesChanged.map((f) => `  ✏️ ${f}`),
            "",
            `**Notes:** ${handoff.notes || "(none)"}`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "create": {
          const usage = (ctx as any).getContextUsage?.();
          const handoff: Handoff = {
            timestamp: new Date().toISOString(),
            originalRequest: args.slice(1).join(" ") || "(describe your task)",
            completedSteps: [],
            remainingSteps: [],
            decisions: [],
            filesInProgress: [],
            filesChanged: [],
            notes: "",
            contextUsagePct: usage?.percent ?? 0,
          };
          writeHandoff(cwd, handoff);
          ctx.ui.notify(
            "Handoff created. The agent will update it as work progresses.\n" +
            "Use /handoff status to view, /handoff clear to reset.",
            "info",
          );
          break;
        }

        case "clear": {
          clearHandoff(cwd);
          ctx.ui.notify("Handoff cleared.", "info");
          break;
        }

        default:
          ctx.ui.notify(
            "Usage: /handoff [create|status|load|clear]\n" +
            "  create \"<description>\" — Start a new handoff\n" +
            "  status/load            — View current handoff\n" +
            "  clear                  — Remove handoff",
            "info",
          );
      }
    },
  });
}
