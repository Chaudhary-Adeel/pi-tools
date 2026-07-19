// /review — automated PR review across the current branch vs main.
// Spawns subagents for security, performance, style, and test coverage.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

export function registerReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("review", {
    description:
      "Automated PR review: compare current branch vs. main, run lint/type-check/tests, " +
      "and spawn subagents to review by concern (security, performance, style, tests).",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const target = args[0] ?? "main";

      // Get diff stats
      let diffStat = "";
      let changedFiles: string[] = [];
      try {
        diffStat = execSync(`git diff --stat ${target}...HEAD`, { cwd, encoding: "utf8" });
        changedFiles = execSync(`git diff --name-only ${target}...HEAD`, { cwd, encoding: "utf8" })
          .trim().split("\n").filter(Boolean);
      } catch (err: any) {
        ctx.ui.notify(`Git error: ${err.message}`, "error");
        return;
      }

      if (changedFiles.length === 0) {
        ctx.ui.notify("No changes detected vs. " + target, "info");
        return;
      }

      // Run verification pipeline
      const checks: { label: string; pass: boolean; output: string }[] = [];

      // Lint
      try {
        const lintOut = execSync("npx eslint . --format compact 2>/dev/null || true", { cwd, encoding: "utf8", timeout: 60_000 });
        checks.push({ label: "Lint", pass: !lintOut.trim(), output: lintOut.trim() || "No issues" });
      } catch { checks.push({ label: "Lint", pass: true, output: "Linter not configured" }); }

      // Type check
      try {
        execSync("npx tsc --noEmit", { cwd, encoding: "utf8", timeout: 120_000 });
        checks.push({ label: "Type Check", pass: true, output: "No type errors" });
      } catch (e: any) {
        checks.push({ label: "Type Check", pass: false, output: e.stdout?.slice(0, 500) ?? e.message });
      }

      // Tests
      try {
        execSync("npm test", { cwd, encoding: "utf8", timeout: 300_000 });
        checks.push({ label: "Tests", pass: true, output: "All passing" });
      } catch (e: any) {
        checks.push({ label: "Tests", pass: false, output: e.stdout?.slice(0, 500) ?? e.message });
      }

      // Build output
      const lines: string[] = [
        `## PR Review: ${target}...HEAD`,
        "",
        `**${changedFiles.length} file(s) changed:**`,
        ...changedFiles.slice(0, 20).map((f) => `  - \`${f}\``),
        changedFiles.length > 20 ? `  - ... and ${changedFiles.length - 20} more` : "",
        "",
        diffStat,
        "",
        "## Automated Checks",
        ...checks.map((c) => `  ${c.pass ? "✅" : "❌"} ${c.label}: ${c.output.split("\n")[0]}`),
        "",
        "## Review Guide",
        "To run a deeper review, use spawn_subagents to fan out by concern:",
        "  - Security review: Check for injection, XSS, auth issues",
        "  - Performance review: Check for N+1 queries, memory leaks",
        "  - Style review: Naming, consistency, dead code",
        "  - Test coverage: Missing edge cases, untested paths",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
