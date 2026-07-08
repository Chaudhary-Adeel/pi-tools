// /cvm — Context Virtual Memory observability.
//
//   /cvm          metrics + index + storage stats
//   /cvm index    force a full incremental reindex now

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coldStats } from "../cvm/cold-store.ts";
import { formatCvmMetrics } from "../cvm/metrics.ts";
import { indexRepo, resetIndexDebounce } from "../cvm/symbols.ts";
import { cvmDir, getWarmStore } from "../cvm/warm-store.ts";
import { formatBytes } from "../lib/shared.ts";

export function registerCvmCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cvm", {
    description: "Context Virtual Memory stats — caches, symbol index, tokens saved",
    getArgumentCompletions: (prefix) =>
      ["index"].filter((k) => k.startsWith(prefix)).map((k) => ({ value: k, label: k })),
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
        "Run '/cvm index' to force a reindex.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
