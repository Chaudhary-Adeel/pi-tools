// /cvm — Context Virtual Memory observability.
//
//   /cvm          metrics + index + storage stats
//   /cvm index    force a full incremental reindex now
//   /cvm gc       reclaim stale cold-store objects + expired HTTP cache rows

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coldStats, coldPrune } from "../cvm/cold-store.ts";
import { formatCvmMetrics } from "../cvm/metrics.ts";
import { indexRepo, resetIndexDebounce } from "../cvm/symbols.ts";
import { cvmDir, getWarmStore } from "../cvm/warm-store.ts";
import { formatBytes } from "../lib/shared.ts";

/** Delete http rows past their TTL by more than this grace period, then
 *  reclaim any cold objects no longer referenced (or just old/oversized). */
const HTTP_STALE_GRACE_MS = 24 * 60 * 60_000;

export function runCvmGc(cwd: string): { httpRowsDeleted: number; objectsDeleted: number; bytesFreed: number } {
  const warm = getWarmStore(cwd);
  const httpRowsDeleted = warm.httpDeleteStale(Date.now() - HTTP_STALE_GRACE_MS);
  const liveFps = new Set(warm.httpAllFps());
  const { deleted: objectsDeleted, bytesFreed } = coldPrune(cwd, { liveFps });
  return { httpRowsDeleted, objectsDeleted, bytesFreed };
}

export function registerCvmCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cvm", {
    description: "Context Virtual Memory stats — caches, symbol index, tokens saved",
    getArgumentCompletions: (prefix) =>
      ["index", "gc"].filter((k) => k.startsWith(prefix)).map((k) => ({ value: k, label: k })),
    handler: async (args, ctx) => {
      const warm = getWarmStore(ctx.cwd);

      if (args.trim() === "index") {
        ctx.ui.setStatus("cvm", "⟳ indexing symbols…");
        try {
          resetIndexDebounce(ctx.cwd);
          const stats = await indexRepo(ctx.cwd, { force: true, signal: ctx.signal });
          ctx.ui.notify(
            `✓ CVM index: ${stats.symbols} symbols in ${stats.files} files ` +
              `(${stats.parsed} parsed, ${stats.reused} reused, ${stats.deleted} dropped, ${stats.ms}ms)`,
            "info",
          );
        } finally {
          ctx.ui.setStatus("cvm", undefined);
        }
        return;
      }

      if (args.trim() === "gc") {
        ctx.ui.setStatus("cvm", "⟳ reclaiming stale cache entries…");
        try {
          const { httpRowsDeleted, objectsDeleted, bytesFreed } = runCvmGc(ctx.cwd);
          ctx.ui.notify(
            `✓ CVM gc: ${httpRowsDeleted} stale http row(s), ${objectsDeleted} cold object(s) freed (${formatBytes(bytesFreed)})`,
            "info",
          );
        } finally {
          ctx.ui.setStatus("cvm", undefined);
        }
        return;
      }

      const cold = coldStats(ctx.cwd);
      let dbSize = 0;
      try {
        dbSize = fs.statSync(path.join(cvmDir(ctx.cwd), "cvm.db")).size;
      } catch {
        /* memory backend or not created yet */
      }

      const lines = [
        formatCvmMetrics(),
        "",
        "Storage:",
        `  warm backend:  ${warm.backend}${dbSize ? ` (${formatBytes(dbSize)})` : ""}`,
        `  symbol index:  ${warm.symbolCount()} symbols across ${warm.fileList().length} files`,
        `  cold objects:  ${cold.objects} (${formatBytes(cold.bytes)} compressed)`,
        "",
        "Run '/cvm index' to force a reindex, '/cvm gc' to reclaim stale cache entries.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
