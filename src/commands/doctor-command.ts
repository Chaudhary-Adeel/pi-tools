// /doctor command — Memory health audit with a scored checklist.
//
// Reads every .md file in .pi/memory/ and runs seven checks:
//   a) Frontmatter validity (description field)
//   b) Token budget (>80% usage)
//   c) Orphaned learnings (no description)
//   d) Empty files (frontmatter only, no body)
//   e) Duplicate learnings (similar descriptions)
//   f) System bloat (>8 system files)
//   g) Stale progress (progress.md not updated in 7+ days)
//
// Displays results in a TUI panel with a health score and
// recommendations. Keyboard: q/Esc close, r refresh, ↑↓ scroll.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { findMemoryRoot, loadProgress } from "../lib/memory.ts";
import { computeFootprint } from "../lib/memory-map.ts";
import { formatBytes, jaccardWordSimilarity } from "../lib/shared.ts";

// ── types ──────────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
  recommendation: string;
  deduction: number; // percentage points deducted from health score
}

interface DoctorReport {
  checks: CheckResult[];
  score: number; // 0-100
  memoryRoot: string | null;
  systemCount: number;
  learningCount: number;
}

// ── checks ──────────────────────────────────────────────────────────────────

function runChecks(cwd: string): DoctorReport {
  const root = findMemoryRoot(cwd);
  if (!root) {
    return {
      checks: [
        {
          label: "Memory directory",
          pass: false,
          detail: "No .pi/memory/ directory found.",
          recommendation: "Create .pi/memory/system/ and .pi/memory/learnings/ to start building persistent memory.",
          deduction: 100,
        },
      ],
      score: 0,
      memoryRoot: null,
      systemCount: 0,
      learningCount: 0,
    };
  }

  const checks: CheckResult[] = [];
  const fp = computeFootprint(cwd);
  // Reuse files already loaded by computeFootprint — no redundant disk I/O.
  const systemFiles = fp.systemFiles;
  const learningFiles = fp.learningFiles;

  // Collect ALL .md files for frontmatter/empty checks from the
  // footprint's file lists (already loaded).
  const allFiles: { relPath: string; raw: string; frontmatter: Record<string, unknown>; body: string }[] = [
    ...systemFiles,
    ...learningFiles,
  ];

  // ── Check A: Frontmatter validity ─────────────────────────────────────
  const missingDesc: string[] = [];
  for (const f of allFiles) {
    if (!f.frontmatter.description || String(f.frontmatter.description).trim() === "") {
      missingDesc.push(f.relPath);
    }
  }

  checks.push({
    label: "Frontmatter validity",
    pass: missingDesc.length === 0,
    detail: missingDesc.length === 0
      ? "All files have a description field."
      : `${missingDesc.length} file(s) missing description: ${missingDesc.join(", ")}`,
    recommendation: "Add a `description` field to the YAML frontmatter so the agent can understand what each file contains.",
    deduction: missingDesc.length * 10,
  });

  // ── Check B: Token budget ────────────────────────────────────────────
  const budgetUsage = fp.budgetUtilization;
  checks.push({
    label: "Token budget",
    pass: budgetUsage <= 80,
    detail: budgetUsage <= 80
      ? `Budget at ${budgetUsage.toFixed(1)}% (${fp.injectedTokens.toLocaleString()}/${fp.tokenBudget.toLocaleString()} tokens injected).`
      : `Budget at ${budgetUsage.toFixed(1)}% — over 80% threshold! (${fp.injectedTokens.toLocaleString()}/${fp.tokenBudget.toLocaleString()} tokens injected).`,
    recommendation: budgetUsage > 80
      ? "Consider moving low-priority system files to learnings/ or consolidating them."
      : "No action needed.",
    deduction: budgetUsage > 80 ? 15 : 0,
  });

  // ── Check C: Orphaned learnings ──────────────────────────────────────
  const orphaned: string[] = [];
  for (const f of learningFiles) {
    if (!f.frontmatter.description || String(f.frontmatter.description).trim() === "") {
      orphaned.push(f.relPath);
    }
  }
  checks.push({
    label: "Orphaned learnings",
    pass: orphaned.length === 0,
    detail: orphaned.length === 0
      ? "All learning files have descriptions (readable by agent)."
      : `${orphaned.length} learning file(s) without descriptions — invisible to agent: ${orphaned.join(", ")}`,
    recommendation: "Add a `description` YAML frontmatter field to each file.",
    deduction: orphaned.length * 15,
  });

  // ── Check D: Empty files ─────────────────────────────────────────────
  const emptyFiles: string[] = [];
  for (const f of allFiles) {
    if (!f.body || f.body.trim() === "") {
      emptyFiles.push(f.relPath);
    }
  }
  checks.push({
    label: "Empty files",
    pass: emptyFiles.length === 0,
    detail: emptyFiles.length === 0
      ? "No empty files (frontmatter + body content)."
      : `${emptyFiles.length} file(s) with no body content: ${emptyFiles.join(", ")}`,
    recommendation: "Either add content or delete empty stub files.",
    deduction: emptyFiles.length * 5,
  });

  // ── Check E: Duplicate learnings ─────────────────────────────────────
  const duplicates: string[] = [];
  for (let i = 0; i < learningFiles.length; i++) {
    const a = learningFiles[i]!;
    const descA = String(a.frontmatter.description ?? "");
    if (!descA) continue;
    for (let j = i + 1; j < learningFiles.length; j++) {
      const b = learningFiles[j]!;
      const descB = String(b.frontmatter.description ?? "");
      if (!descB) continue;
      const sim = jaccardWordSimilarity(descA, descB);
      if (sim > 0.65) {
        duplicates.push(`${a.relPath} ↔ ${b.relPath} (${(sim * 100).toFixed(0)}% similar)`);
      }
    }
  }
  checks.push({
    label: "Duplicate learnings",
    pass: duplicates.length === 0,
    detail: duplicates.length === 0
      ? "No significantly overlapping learning descriptions detected."
      : `${duplicates.length} pair(s) of similar learnings: ${duplicates.join("; ")}`,
    recommendation: "Consider merging or differentiating learning files with similar descriptions.",
    deduction: duplicates.length * 10,
  });

  // ── Check F: System bloat ────────────────────────────────────────────
  checks.push({
    label: "System bloat",
    pass: systemFiles.length <= 8,
    detail: systemFiles.length <= 8
      ? `${systemFiles.length} system file(s) — healthy count.`
      : `${systemFiles.length} system file(s) — may bloat context!`,
    recommendation: systemFiles.length > 8
      ? "Consider moving some system files to learnings/ or merging smaller files."
      : "No action needed.",
    deduction: systemFiles.length > 8 ? (systemFiles.length - 8) * 3 : 0,
  });

  // ── Check G: Stale progress ──────────────────────────────────────────
  const progress = loadProgress(cwd);
  let staleDays = 0;
  let isStale = false;

  if (progress) {
    // Check the file's mtime
    const fp = path.join(root, "system", "progress.md");
    try {
      const stat = fs.statSync(fp);
      staleDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      isStale = staleDays > 7;
    } catch {
      // Can't stat — treat as not stale
    }
  }

  checks.push({
    label: "Stale progress",
    pass: !isStale,
    detail: !progress
      ? "No progress.md file found."
      : isStale
        ? `progress.md last updated ${staleDays.toFixed(0)} days ago — may be stale.`
        : `progress.md updated ${staleDays.toFixed(0)} day(s) ago — current.`,
    recommendation: isStale
      ? "Review and update progress.md to reflect current status."
      : !progress
        ? "Create .pi/memory/system/progress.md to track task progress."
        : "No action needed.",
    deduction: isStale ? 10 : 0,
  });

  // ── Health score ──────────────────────────────────────────────────────
  const totalDeduction = checks.reduce((sum, c) => sum + c.deduction, 0);
  const score = Math.max(0, 100 - totalDeduction);

  return {
    checks,
    score,
    memoryRoot: root,
    systemCount: systemFiles.length,
    learningCount: learningFiles.length,
  };
}

// ── TUI rendering ──────────────────────────────────────────────────────────

interface DoctorUIState {
  scroll: number;
  width: number;
  height: number;
}

function renderDoctorView(report: DoctorReport, state: DoctorUIState, theme: any): string[] {
  const content: string[] = [];

  // ── Header ───────────────────────────────────────────────────────────
  const scoreColor = report.score >= 80 ? "success" : report.score >= 50 ? "warning" : "error";
  const scoreBar = "█".repeat(Math.round(report.score / 10)) +
    "░".repeat(Math.max(0, 10 - Math.round(report.score / 10)));

  content.push(theme.fg("accent", theme.bold("🩺 Memory Health Audit")));
  content.push("");
  content.push(`  Score: ${theme.fg(scoreColor, theme.bold(`${report.score}%`))}  ${theme.fg(scoreColor, scoreBar)}`);
  content.push(`  Root: ${theme.fg("dim", report.memoryRoot ?? "(not found)")}`);
  content.push(`  Files: ${report.systemCount} system + ${report.learningCount} learnings`);
  content.push("");

  // ── Checks ───────────────────────────────────────────────────────────
  for (const check of report.checks) {
    const icon = check.pass
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");
    const label = check.pass
      ? theme.fg("text", check.label)
      : theme.fg("error", check.label);

    content.push(`${icon} ${label} ${theme.fg("dim", `(-${check.deduction}%)`)}`);
    content.push(`   ${theme.fg("dim", check.detail)}`);

    if (!check.pass) {
      content.push(`   ${theme.fg("warning", "→")} ${theme.fg("dim", truncateToWidth(check.recommendation, state.width - 6))}`);
    }
    content.push("");
  }

  // Scroll window: the caller reserves the last returned line for its own
  // footer (overwrites it in place), so the viewport is height - 1 lines.
  const viewportHeight = Math.max(1, state.height - 1);
  const maxScroll = Math.max(0, content.length - viewportHeight);
  state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
  const visible = content.slice(state.scroll, state.scroll + viewportHeight);
  while (visible.length < viewportHeight) {
    visible.push(theme.fg("dim", "~"));
  }

  return visible;
}

// ── register ───────────────────────────────────────────────────────────────

export function registerDoctorCommand(pi: ExtensionAPI): void {
  pi.registerCommand("doctor", {
    description: "Audit memory health — checks frontmatter, budget, orphans, bloat, and more",
    handler: async (_args, ctx) => {
      let report = runChecks(ctx.cwd);

      ctx.ui.setStatus("doctor", "Memory Health Audit");

      const state: DoctorUIState = {
        scroll: 0,
        width: 80,
        height: 24,
      };

      const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
        let lastWidth = tui.terminal.columns;
        let lastHeight = tui.terminal.rows;

        const render = (): string[] => {
          const w = tui.terminal.columns;
          const h = tui.terminal.rows;
          state.width = w;
          state.height = h;

          const lines = renderDoctorView(report, state, theme);

          // Footer
          const keys = ["↑↓ scroll", "r refresh", "q/Esc close"];
          const footerText = keys.join(" │ ");
          lines[lines.length - 1] = theme.fg("dim", truncateToWidth(footerText, w));

          return lines;
        };

        return {
          render(w: number) {
            if (w !== lastWidth) lastWidth = w;
            const currentH = tui.terminal.rows;
            if (currentH !== lastHeight) lastHeight = currentH;
            return render();
          },
          invalidate() {},
          handleInput(data: string) {
            // Arrow keys
            if (data === "\x1b[A") {
              state.scroll = Math.max(0, state.scroll - 1);
              tui.requestRender();
              return;
            }
            if (data === "\x1b[B") {
              state.scroll += 1;
              tui.requestRender();
              return;
            }

            // Refresh
            if (data === "r" || data === "R") {
              report = runChecks(ctx.cwd);
              tui.requestRender();
              return;
            }

            // Close
            if (data === "q" || data === "Q" || data === "\x1b") {
              ctx.ui.setStatus("doctor", undefined);
              done(undefined);
              return;
            }
          },
        };
      });

      ctx.ui.setStatus("doctor", undefined);
      if (result !== undefined) {
        // rarely used; reserved for future extension
      }
    },
  });
}
