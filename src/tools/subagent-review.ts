// subagent-review.ts — interactive subagent prompt review before execution.
//
// When the LLM calls spawn_subagents, this component shows a preview of
// each task's prompt and lets the user expand/edit via Ctrl+O before the
// subagents are launched.

import { Container, Text, matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";

// ── types ──────────────────────────────────────────────────────────────────

export interface SubagentTask {
  prompt: string;
  context?: string;
}

export type ReviewAction =
  | { type: "run" }
  | { type: "edit"; index: number }
  | { type: "cancel" };

// ── component ──────────────────────────────────────────────────────────────

export class SubagentReviewer {
  private tasks: SubagentTask[];
  private selectedIndex = 0;

  constructor(
    tasks: SubagentTask[],
    private theme: Theme,
    private keybindings: KeybindingsManager,
    private done: (action: ReviewAction) => void,
  ) {
    this.tasks = tasks;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) this.selectedIndex--;
    } else if (matchesKey(data, Key.down)) {
      if (this.selectedIndex < this.tasks.length - 1) this.selectedIndex++;
    } else if (matchesKey(data, Key.ctrl("o"))) {
      this.done({ type: "edit", index: this.selectedIndex });
    } else if (matchesKey(data, Key.enter)) {
      this.done({ type: "run" });
    } else if (matchesKey(data, Key.escape)) {
      this.done({ type: "cancel" });
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // Header
    const n = this.tasks.length;
    lines.push(
      t.fg("accent", t.bold(`Review Subagents (${n} task${n === 1 ? "" : "s"})`)),
    );
    lines.push("");

    // Task list
    for (let i = 0; i < n; i++) {
      const task = this.tasks[i];
      const firstLine = task.prompt.split("\n")[0] ?? task.prompt;
      const preview = firstLine.length > 60 ? firstLine.slice(0, 57) + "…" : firstLine;
      const isSelected = i === this.selectedIndex;

      const prefix = isSelected ? "› " : "  ";
      const styled = isSelected
        ? t.bg("selectedBg", t.fg("accent", `${prefix}#${i + 1} ${preview}`))
        : t.fg("dim", `${prefix}#${i + 1} `) + t.fg("muted", preview);

      lines.push(truncateToWidth(styled, width));
    }

    lines.push("");

    // Footer help
    const help = t.fg("dim", "↑↓ navigate  Ctrl+O expand/edit  Enter proceed  Esc cancel");
    lines.push(truncateToWidth(help, width));

    return lines;
  }

  invalidate(): void {
    // No persistent cache needed — render is cheap.
  }
}
