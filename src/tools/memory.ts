// memory_map tool — agent-callable tool to inspect and manage the agent's memory.
//
// Provides:
//   - view: show memory footprint, file tree, or full map
//   - generate: regenerate the memory-map.md index file
//   - stats: compact memory stats

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { text, formatBytes } from "../lib/shared.ts";
import {
  computeFootprint,
  computeStats,
  readMemoryMap,
  updateMemoryMap,
  estimateTokens,
  formatFootprintLine,
} from "../lib/memory-map.ts";
import type { MemoryFootprint, MemoryStats } from "../lib/memory-map.ts";
import { ensureMemoryDirs } from "../lib/memory.ts";

// ── formatting ────────────────────────────────────────────────────────────

function formatFootprintForAgent(fp: MemoryFootprint, stats?: MemoryStats): string {
  const lines: string[] = [];
  lines.push("## 🧠 Agent Memory Footprint");
  lines.push("");

  if (!fp.hasMemory) {
    lines.push("⚠️ No memory directory found. Create `.pi/memory/` to start building persistent memory.");
    return lines.join("\n");
  }

  // Summary
  lines.push("### Summary");
  lines.push("");
  lines.push(`- **Memory root:** \`${fp.memoryRoot}\``);
  lines.push(`- **System files:** ${fp.systemFiles.length} (always injected — ${formatBytes(fp.injectedBytes)}, ~${fp.injectedTokens.toLocaleString()} tokens)`);
  lines.push(`- **Learning files:** ${fp.learningFiles.length} (on-demand — ${formatBytes(fp.totalBytes - fp.injectedBytes)}, ~${(fp.totalTokens - fp.injectedTokens).toLocaleString()} tokens)`);
  lines.push(`- **Total:** ${fp.systemFiles.length + fp.learningFiles.length} files, ${formatBytes(fp.totalBytes)}, ~${fp.totalTokens.toLocaleString()} tokens`);
  lines.push(`- **Token budget:** ${fp.tokenBudget.toLocaleString()} | **Used:** ${fp.budgetUtilization.toFixed(1)}%`);
  lines.push("");

  // System files
  if (fp.systemFiles.length > 0) {
    lines.push("### 🧠 System Memory (injected every turn)");
    lines.push("");
    lines.push("| File | Priority | Size | Tokens | Description |");
    lines.push("|------|----------|------|--------|-------------|");
    for (const f of fp.systemFiles) {
      const desc = (f.frontmatter.description as string)?.slice(0, 60) ?? "";
      const priority = f.frontmatter.priority ?? "—";
      const size = formatBytes(Buffer.byteLength(f.raw, "utf-8"));
      const tokens = estimateTokens(f.raw);
      lines.push(`| \`${f.relPath}\` | ${priority} | ${size} | ~${tokens} | ${desc} |`);
    }
    lines.push("");

    // Budget gauge
    const barW = 20;
    const filled = Math.round((Math.min(100, fp.budgetUtilization) / 100) * barW);
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barW - filled));
    lines.push(`**Budget:** \`${bar}\` ${fp.budgetUtilization.toFixed(0)}%`);
    if (fp.budgetUtilization > 80) {
      lines.push("> ⚠️ Budget nearly full. Consider consolidating system files.");
    }
    lines.push("");
  }

  // Learnings
  if (fp.learningFiles.length > 0) {
    lines.push("### 📚 Learnings (on-demand)");
    lines.push("");
    lines.push("| File | Size | Tokens | Description |");
    lines.push("|------|------|--------|-------------|");
    for (const f of fp.learningFiles) {
      const desc = (f.frontmatter.description as string)?.slice(0, 60) ?? "";
      const size = formatBytes(Buffer.byteLength(f.raw, "utf-8"));
      const tokens = estimateTokens(f.raw);
      lines.push(`| \`${f.relPath}\` | ${size} | ~${tokens} | ${desc} |`);
    }
    lines.push("");
  }

  // Progress
  if (fp.progress?.task) {
    const p = fp.progress;
    const done = p.checklist.filter((c) => c.done).length;
    const total = p.checklist.length;
    lines.push("### 📋 Current Progress");
    lines.push("");
    lines.push(`- **Task:** ${p.task}`);
    lines.push(`- **Status:** ${p.status.replace(/_/g, " ")}`);
    if (total > 0) lines.push(`- **Checklist:** ${done}/${total} items done`);
    if (p.openDecisions.length > 0) lines.push(`- **Open decisions:** ${p.openDecisions.length}`);
    if (p.nextSteps.length > 0) lines.push(`- **Next steps:** ${p.nextSteps.length}`);
    lines.push("");
  }

  // Footprint line
  const s = stats ?? computeStats(fp.memoryRoot ?? "");
  lines.push(`> \`${formatFootprintLine(s)}\``);

  return lines.join("\n");
}

// ── register tool ─────────────────────────────────────────────────────────

export function registerMemoryMapTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_map",
    label: "Memory Map",
    description:
      "View and manage pi's persistent memory. Use to inspect what the agent " +
      "knows across sessions, check token budget usage, and regenerate the memory " +
      "map index file. Use 'view' to see the full memory dashboard, 'generate' to " +
      "rebuild the memory-map.md index, and 'stats' for compact numbers.",
    promptSnippet: "Inspect or manage agent memory (footprint, map, budget)",
    promptGuidelines: [
      "Use memory_map to check the agent's memory footprint before reading/writing memory files.",
      "Use memory_map with action 'stats' when you only need the numbers (files, sizes, budget).",
    ],
    parameters: Type.Object({
      action: StringEnum(["view", "generate", "stats"] as const, {
        description: "What to do: 'view' shows full memory dashboard, 'generate' rebuilds memory-map.md, 'stats' returns compact numbers",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      ensureMemoryDirs(cwd);
      const action = params.action as string;

      switch (action) {
        case "view": {
          const fp = computeFootprint(cwd);
          const stats = computeStats(cwd);
          return text(formatFootprintForAgent(fp, stats), {
            action: "view",
            stats,
          });
        }
        case "generate": {
          const mapPath = updateMemoryMap(cwd);
          const stats = computeStats(cwd);
          return text(
            `✅ Memory map regenerated: \`${mapPath}\`\n\n` +
            formatFootprintLine(stats),
            { action: "generate", mapPath, stats },
          );
        }
        case "stats": {
          const stats = computeStats(cwd);
          return text(formatFootprintLine(stats), { action: "stats", stats });
        }
        default:
          throw new Error(`Unknown action: ${action}. Use 'view', 'generate', or 'stats'.`);
      }
    },
  });
}
