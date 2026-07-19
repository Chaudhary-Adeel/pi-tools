// /report — generate session summary reports.
// Exports task completion, code changes, test/lint results, subagent stats.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerReportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("report", {
    description:
      "Generate a session summary report: tasks completed, files changed, " +
      "test/lint/type-check results, subagent runs, and learnings captured. " +
      "Exports as Markdown for PR descriptions or team updates.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const format = args[0] ?? "markdown";
      const memoryRoot = path.join(cwd, ".pi/memory");

      // Read progress
      let progress = "";
      try {
        progress = fs.readFileSync(path.join(memoryRoot, "system", "progress.md"), "utf8");
      } catch {
        progress = "(No progress tracked yet)";
      }

      // Count learnings
      let learningCount = 0;
      let learningNames: string[] = [];
      try {
        const learnDir = path.join(memoryRoot, "learnings");
        if (fs.existsSync(learnDir)) {
          const files = fs.readdirSync(learnDir).filter((f) => f.endsWith(".md"));
          learningCount = files.length;
          learningNames = files.map((f) => f.replace(".md", ""));
        }
      } catch {}

      // Count subagent runs
      let subagentCount = 0;
      try {
        const subDir = path.join(cwd, ".pi", "subagents");
        if (fs.existsSync(subDir)) {
          subagentCount = fs.readdirSync(subDir).length;
        }
      } catch {}

      // Generate report
      const lines = [
        "# Session Report",
        "",
        `Generated: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
        `Project: ${path.basename(cwd)}`,
        "",
        "## Progress",
        "",
        "```",
        progress.slice(0, 2000),
        "```",
        "",
        "## Summary",
        "",
        `- Learnings captured: **${learningCount}**`,
        learningNames.length > 0 ? `  - ${learningNames.map((n) => `\`${n}\``).join(", ")}` : "",
        `- Subagent runs: **${subagentCount}**`,
        "",
        "## Commands",
        "",
        "| Command | Purpose |",
        "|---------|---------|",
        "| `/learn` | Distill this session into learnings |",
        "| `/review` | Automated PR review vs. main |",
        "| `/report` | Generate this report |",
        "",
      ].filter(Boolean).join("\n");

      if (format === "json") {
        const json = {
          timestamp: new Date().toISOString(),
          project: path.basename(cwd),
          progress: progress.slice(0, 500),
          learnings: { count: learningCount, names: learningNames },
          subagentRuns: subagentCount,
        };
        ctx.ui.notify("```json\n" + JSON.stringify(json, null, 2) + "\n```", "info");
      } else {
        ctx.ui.notify(lines, "info");
      }
    },
  });
}
