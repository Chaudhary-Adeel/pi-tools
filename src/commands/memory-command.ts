// /memory command — interactive TUI dashboard that shows pi's memory footprint.
// Like looking inside pi's brain: what's stored, how much, what's injected,
// and how efficiently the token budget is being used.
//
// Features:
//   - Memory tree view (system vs learnings)
//   - Per-file sizes, token estimates, descriptions
//   - Token budget gauge
//   - Progress tracker summary
//   - Keyboard navigation: ↑↓ scroll, ←→ collapse/expand, Enter view file, q/Esc close
//   - Hotkey: Ctrl+M opens /memory

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { computeFootprint, generateMemoryMap, updateMemoryMap, estimateTokens, type MemoryFootprint, type MemoryStats } from "../lib/memory-map.ts";
import type { MemoryFile, Progress } from "../lib/memory.ts";
import { ensureMemoryDirs } from "../lib/memory.ts";
import { formatBytes } from "../lib/shared.ts";

// ── TUI rendering ─────────────────────────────────────────────────────────

interface MemoryUIState {
  scroll: number;
  selectedIndex: number;
  viewMode: "tree" | "system" | "learnings" | "progress";
  expandedSections: Set<string>;
  width: number;
  height: number;
}

function renderHeader(fp: MemoryFootprint, theme: any, width: number): string[] {
  const barW = Math.min(30, width - 30);
  const utilization = fp.budgetUtilization;
  const filled = Math.round((Math.min(100, utilization) / 100) * barW);
  const color = utilization > 80 ? "error" : utilization > 50 ? "warning" : "success";
  const bar = theme.fg(color, "█".repeat(filled) + "░".repeat(Math.max(0, barW - filled)));

  return [
    theme.fg("accent", theme.bold("🧠 Memory Dashboard")),
    "",
    theme.fg("dim", `  Memory root: ${fp.memoryRoot ?? "(not found)"}`),
    theme.fg("dim", `  System files: ${fp.systemFiles.length}  |  Learnings: ${fp.learningFiles.length}  |  Total: ${formatBytes(fp.totalBytes)}`),
    `  Budget: ${bar} ${theme.fg(color, theme.bold(`${fp.budgetUtilization.toFixed(0)}%`))}  (${fp.injectedTokens.toLocaleString()}/${fp.tokenBudget.toLocaleString()} tokens injected)`,
    "",
  ];
}

function renderTreeView(fp: MemoryFootprint, state: MemoryUIState, theme: any): string[] {
  const lines: string[] = [];
  let idx = 0;

  // System memory section
  const sysExpanded = state.expandedSections.has("system");
  const sysArrow = sysExpanded ? "▼" : "▶";
  const sysHighlight = state.selectedIndex === idx;
  const sysPrefix = sysHighlight ? theme.fg("accent", ">") : " ";
  lines.push(`${sysPrefix} ${sysArrow} ${theme.bold("🧠 System Memory")} (${fp.systemFiles.length} files, ${formatBytes(fp.injectedBytes)} injected)`);
  idx++;

  if (sysExpanded) {
    if (fp.systemFiles.length === 0) {
      lines.push(`     ${theme.fg("dim", "(empty — create files in .pi/memory/system/)")}`);
      idx++;
    } else {
      for (const f of fp.systemFiles) {
        const desc = (f.frontmatter.description as string) ?? "";
        const priority = f.frontmatter.priority ?? "—";
        const tokens = estimateTokens(f.raw);
        const sel = state.selectedIndex === idx;
        const marker = sel ? theme.fg("accent", ">") : " ";
        const name = sel ? theme.fg("accent", f.relPath) : theme.fg("text", f.relPath);
        lines.push(`${marker}   ${name}  ${theme.fg("dim", `[P${priority}] ~${tokens.toLocaleString()}t ${desc.slice(0, 40)}`)}`);
        idx++;
      }
    }
    // Progress file
    const progressIcon = fp.progress?.task ? theme.fg("success", "●") : theme.fg("dim", "○");
    const sel = state.selectedIndex === idx;
    const marker = sel ? theme.fg("accent", ">") : " ";
    const progressText = fp.progress?.task ? `${fp.progress.task} (${fp.progress.status})` : "(no active task)";
    lines.push(`${marker}   ${progressIcon} progress.md  ${theme.fg("dim", progressText)}`);
    idx++;
  }

  lines.push("");

  // Learnings section
  const learnExpanded = state.expandedSections.has("learnings");
  const learnArrow = learnExpanded ? "▼" : "▶";
  const learnHighlight = state.selectedIndex === idx;
  const learnPrefix = learnHighlight ? theme.fg("accent", ">") : " ";
  const learnBytes = fp.totalBytes - fp.injectedBytes;
  lines.push(`${learnPrefix} ${learnArrow} ${theme.bold("📚 Learnings")} (${fp.learningFiles.length} files, ${formatBytes(learnBytes)} on-demand)`);
  idx++;

  if (learnExpanded) {
    if (fp.learningFiles.length === 0) {
      lines.push(`     ${theme.fg("dim", "(empty — create files in .pi/memory/learnings/)")}`);
      idx++;
    } else {
      for (const f of fp.learningFiles) {
        const desc = (f.frontmatter.description as string) ?? "(no description)";
        const tokens = estimateTokens(f.raw);
        const sel = state.selectedIndex === idx;
        const marker = sel ? theme.fg("accent", ">") : " ";
        lines.push(`${marker}   ${theme.fg("text", f.relPath)}  ${theme.fg("dim", `~${tokens.toLocaleString()}t — ${desc.slice(0, 50)}`)}`);
        idx++;
      }
    }
  }

  // Fill remaining height
  while (lines.length < state.height - 1) {
    lines.push(theme.fg("dim", "~"));
  }

  return lines;
}

function renderSystemDetail(fp: MemoryFootprint, state: MemoryUIState, theme: any): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("🧠 System Memory (injected every turn)")));
  lines.push("");
  lines.push(theme.fg("dim", "  These files are injected into context at the start of every turn."));
  lines.push(theme.fg("dim", `  Token budget: ${fp.tokenBudget.toLocaleString()} | Used: ${fp.injectedTokens.toLocaleString()} (${fp.budgetUtilization.toFixed(1)}%)`));
  lines.push("");

  if (fp.systemFiles.length === 0) {
    lines.push(theme.fg("dim", "  No system memory files yet."));
  } else {
    for (let i = 0; i < fp.systemFiles.length; i++) {
      const f = fp.systemFiles[i]!;
      const sel = state.selectedIndex === i;
      const marker = sel ? theme.fg("accent", "▸") : " ";
      const name = sel ? theme.fg("accent", f.relPath) : theme.fg("text", f.relPath);
      const desc = f.frontmatter.description ?? "(no description)";
      const priority = f.frontmatter.priority ?? "—";
      const size = formatBytes(Buffer.byteLength(f.raw, "utf-8"));
      const tokens = estimateTokens(f.raw);
      lines.push(`${marker} ${name}`);
      lines.push(`     ${theme.fg("dim", `${desc}`)}`);
      lines.push(`     ${theme.fg("dim", `Priority: ${priority} | Size: ${size} | Tokens: ~${tokens.toLocaleString()}`)}`);
      lines.push("");
    }
  }

  while (lines.length < state.height - 1) lines.push(theme.fg("dim", "~"));
  return lines;
}

function renderLearningsDetail(fp: MemoryFootprint, state: MemoryUIState, theme: any): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("📚 Learnings (loaded on-demand)")));
  lines.push("");
  lines.push(theme.fg("dim", "  These files are available on-demand only. The agent sees descriptions"));
  lines.push(theme.fg("dim", "  and can load any file with the `read` tool when needed."));
  lines.push("");

  if (fp.learningFiles.length === 0) {
    lines.push(theme.fg("dim", "  No learning files yet."));
  } else {
    for (let i = 0; i < fp.learningFiles.length; i++) {
      const f = fp.learningFiles[i]!;
      const sel = state.selectedIndex === i;
      const marker = sel ? theme.fg("accent", "▸") : " ";
      const name = sel ? theme.fg("accent", f.relPath) : theme.fg("text", f.relPath);
      const desc = f.frontmatter.description ?? "(no description)";
      const size = formatBytes(Buffer.byteLength(f.raw, "utf-8"));
      const tokens = estimateTokens(f.raw);
      lines.push(`${marker} ${name}`);
      lines.push(`     ${theme.fg("dim", `${desc}`)}`);
      lines.push(`     ${theme.fg("dim", `Size: ${size} | Tokens: ~${tokens.toLocaleString()}`)}`);
      lines.push(`     ${theme.fg("dim", `Path: ${f.path}`)}`);
      lines.push("");
    }
  }

  while (lines.length < state.height - 1) lines.push(theme.fg("dim", "~"));
  return lines;
}

function renderProgressView(fp: MemoryFootprint, theme: any): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("📋 Progress Tracker")));
  lines.push("");

  const p = fp.progress;
  if (!p || !p.task) {
    lines.push(theme.fg("dim", "  No active task. Create `.pi/memory/system/progress.md` to start tracking."));
    return lines;
  }

  const statusColor = p.status === "done" ? "success" : p.status === "in_progress" ? "warning" : p.status === "blocked" ? "error" : "dim";
  lines.push(`  Task: ${theme.bold(p.task)}`);
  lines.push(`  Status: ${theme.fg(statusColor, p.status.replace(/_/g, " "))}`);
  lines.push("");

  if (p.checklist.length > 0) {
    lines.push("  " + theme.bold("Checklist:"));
    for (const item of p.checklist) {
      const icon = item.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
      const text = item.done ? theme.fg("dim", item.label) : item.label;
      lines.push(`    ${icon} ${text}`);
    }
    lines.push("");
  }

  if (p.openDecisions.length > 0) {
    lines.push("  " + theme.bold("Open Decisions:"));
    for (const d of p.openDecisions) {
      lines.push(`    ${theme.fg("warning", "?")} ${d}`);
    }
    lines.push("");
  }

  if (p.nextSteps.length > 0) {
    lines.push("  " + theme.bold("Next Steps:"));
    for (const s of p.nextSteps) {
      lines.push(`    ${theme.fg("accent", "→")} ${s}`);
    }
    lines.push("");
  }

  return lines;
}

// ── register ───────────────────────────────────────────────────────────────

export function registerMemoryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("memory", {
    description: "Show memory footprint — like looking inside pi's brain",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      ensureMemoryDirs(cwd);
      let fp = computeFootprint(cwd);

      const state: MemoryUIState = {
        scroll: 0,
        selectedIndex: 0,
        viewMode: "tree",
        expandedSections: new Set(["system", "learnings"]),
        width: 80,
        height: 24,
      };

      ctx.ui.setStatus("memory", "Memory Dashboard");

      const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
        let lastWidth = tui.terminal.columns;
        let lastHeight = tui.terminal.rows;

        const render = (): string[] => {
          const w = tui.terminal.columns;
          const h = tui.terminal.rows;
          state.width = w;
          state.height = h;

          const lines: string[] = [];
          lines.push(...renderHeader(fp, theme, w));

          // Main content
          switch (state.viewMode) {
            case "tree":
              lines.push(...renderTreeView(fp, state, theme));
              break;
            case "system":
              lines.push(...renderSystemDetail(fp, state, theme));
              break;
            case "learnings":
              lines.push(...renderLearningsDetail(fp, state, theme));
              break;
            case "progress":
              lines.push(...renderProgressView(fp, theme));
              break;
          }

          // Footer — keep the separator un-themed so width math stays correct,
          // then color the whole line once (theme.fg adds ANSI codes that must
          // not be counted toward visible width / truncation).
          const keys = [
            "↑↓ scroll",
            "←→ tab",
            "Enter view",
            "r refresh",
            "g generate map",
            "q/Esc close",
          ];
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
            // Tab switching
            if (data === "\x1b[D" || data === "\x1b[1;5D") {
              // Left arrow
              const modes: MemoryUIState["viewMode"][] = ["tree", "system", "learnings", "progress"];
              const idx = modes.indexOf(state.viewMode);
              state.viewMode = modes[(idx - 1 + modes.length) % modes.length]!;
              state.selectedIndex = 0;
              state.scroll = 0;
              tui.requestRender();
              return;
            }
            if (data === "\x1b[C" || data === "\x1b[1;5C") {
              // Right arrow
              const modes: MemoryUIState["viewMode"][] = ["tree", "system", "learnings", "progress"];
              const idx = modes.indexOf(state.viewMode);
              state.viewMode = modes[(idx + 1) % modes.length]!;
              state.selectedIndex = 0;
              state.scroll = 0;
              tui.requestRender();
              return;
            }

            // Up/Down
            if (data === "\x1b[A") {
              state.selectedIndex = Math.max(0, state.selectedIndex - 1);
              tui.requestRender();
              return;
            }
            if (data === "\x1b[B") {
              state.selectedIndex += 1;
              tui.requestRender();
              return;
            }

            // Enter — expand/collapse in tree view, view details otherwise
            if (data === "\r") {
              if (state.viewMode === "tree") {
                if (state.selectedIndex === 0) {
                  if (state.expandedSections.has("system")) {
                    state.expandedSections.delete("system");
                  } else {
                    state.expandedSections.add("system");
                  }
                } else if (state.selectedIndex === fp.systemFiles.length + 1 + (state.expandedSections.has("system") ? 1 : 0)) {
                  // Learnings section index varies based on expansion
                  if (state.expandedSections.has("learnings")) {
                    state.expandedSections.delete("learnings");
                  } else {
                    state.expandedSections.add("learnings");
                  }
                }
              }
              tui.requestRender();
              return;
            }

            // Refresh
            if (data === "r" || data === "R") {
              fp = computeFootprint(cwd);
              tui.requestRender();
              return;
            }

            // Generate memory map
            if (data === "g" || data === "G") {
              const mapPath = updateMemoryMap(cwd);
              ctx.ui.notify(`Memory map generated: ${mapPath}`, "info");
              tui.requestRender();
              return;
            }

            // Close
            if (data === "q" || data === "Q" || data === "\x1b") {
              ctx.ui.setStatus("memory", undefined);
              done(undefined);
              return;
            }
          },
        };
      });

      ctx.ui.setStatus("memory", undefined);
      if (result !== undefined) {
        // Result is rarely used; mostly for future extension
      }
    },
  });

  // NOTE: We intentionally do NOT register a Ctrl+M shortcut.
  // In terminals, Ctrl+M and Enter/Return are the same byte (0x0D / "\r"),
  // so binding "ctrl+m" would hijack the Enter key — every Enter press would
  // trigger the shortcut instead of submitting input. Use the /memory command.
}
