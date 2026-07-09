// Autonomy wiring for the Memory Health Engine (logic in memory-health.ts).
//
// Sweeps run:
//   - in the background at session start, at most once per 6 hours
//     (timestamp persisted in the CVM warm store, so restarts don't re-sweep)
//   - after any turn that edited .pi/memory/ files (incremental, immediate)
//   - on demand via /heal (apply) or /heal dry (report only)
//
// Disabled with /config memoryHealth off. Notifies only when something was
// actually healed — a healthy memory stays silent.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  analyzeMemoryHealth,
  applyHealActions,
  formatHealthReport,
} from "./memory-health.ts";
import { isMemoryHealthEnabled } from "./config.ts";
import { getWarmStore } from "../cvm/warm-store.ts";
import { isSubagentProcess } from "../tools/subagents.ts";

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const LAST_SWEEP_KEY = "memhealth:lastSweep";

function describeApplied(applied: ReturnType<typeof applyHealActions>): string {
  const counts = new Map<string, number>();
  for (const a of applied.applied) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${n} ${t}`).join(", ");
}

export function registerMemoryHealth(pi: ExtensionAPI): void {
  // Subagents share the same .pi/memory — only the main session heals it,
  // otherwise parallel subagents could race each other's sweeps.
  if (isSubagentProcess()) return;

  let sweeping = false;

  const sweep = (cwd: string, notify?: (msg: string) => void): void => {
    if (sweeping) return;
    sweeping = true;
    try {
      const report = analyzeMemoryHealth(cwd);
      if (report.actions.length === 0) return;
      const applied = applyHealActions(cwd, report);
      if (applied.applied.length > 0 && notify) {
        notify(`🩺 Memory healed: ${describeApplied(applied)} (avg score ${report.avgScore.toFixed(0)})`);
      }
    } catch {
      /* healing must never break a session */
    } finally {
      sweeping = false;
    }
  };

  // ── background sweep at session start (debounced across sessions) ──
  pi.on("session_start", (_event, ctx) => {
    if (!isMemoryHealthEnabled(ctx.cwd)) return;
    try {
      const warm = getWarmStore(ctx.cwd);
      const last = Number(warm.kvGet(LAST_SWEEP_KEY) ?? 0);
      if (Date.now() - last < SWEEP_INTERVAL_MS) return;
      warm.kvSet(LAST_SWEEP_KEY, String(Date.now()));
    } catch {
      /* fall through — a failed timestamp read shouldn't block healing */
    }
    // Defer so session startup (prompt assembly, index warm-up) wins the loop.
    setTimeout(() => sweep(ctx.cwd, (m) => ctx.ui.notify(m, "info")), 3000);
  });

  // ── incremental: heal right after a turn that edited memory files ──
  let memoryTouched = false;
  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as { path?: string; file_path?: string };
    const p = input?.path ?? input?.file_path ?? "";
    if (p.includes(".pi/memory/")) memoryTouched = true;
  });
  pi.on("turn_end", (_event, ctx) => {
    if (!memoryTouched) return;
    memoryTouched = false;
    if (!isMemoryHealthEnabled(ctx.cwd)) return;
    sweep(ctx.cwd, (m) => ctx.ui.notify(m, "info"));
  });

  // ── /heal — on-demand sweep ──
  pi.registerCommand("heal", {
    description: "Memory Health Engine: score, validate, and heal .pi/memory (use 'dry' to preview)",
    getArgumentCompletions: (prefix) =>
      ["dry"].filter((k) => k.startsWith(prefix)).map((k) => ({ value: k, label: k })),
    handler: async (args, ctx) => {
      const dry = args.trim() === "dry";
      ctx.ui.setStatus("heal", "🩺 analyzing memory health…");
      try {
        const report = analyzeMemoryHealth(ctx.cwd);
        const applied = dry ? undefined : applyHealActions(ctx.cwd, report);
        let out = formatHealthReport(report, applied);
        if (dry && report.actions.length > 0) {
          out += `\n\n${report.actions.length} action(s) would run — '/heal' to apply.`;
        }
        ctx.ui.notify(out, "info");
      } finally {
        ctx.ui.setStatus("heal", undefined);
      }
    },
  });
}
