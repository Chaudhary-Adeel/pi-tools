// Delegation harness — makes subagent auto-utilization actually happen.
//
// Prompt rules alone don't reliably trigger fan-outs: the model reads them
// once at session start and then falls into serial read/grep loops. This
// module extends Pi's harness with live steering at the three moments where
// delegation pays:
//
//   1. Prompt shape  — a decomposable request (lists, multi-part asks,
//      repo-wide sweeps) gets a parallelization hint injected into THAT
//      turn's system prompt, when the plan is still being formed.
//   2. Research streaks — N sequential research-tool calls without a
//      spawn_subagents in the same loop triggers one steering nudge,
//      delivered mid-stream so the model can change course now.
//   3. Context pressure — when the context window fills past a threshold
//      and the loop is still doing primary research, a nudge suggests
//      delegating the remaining reading with output_to_files.
//
// Heuristics and the tracker are pure and unit-tested; the event wiring in
// harness-register.ts is thin. Nudges are rate-limited so they inform
// rather than nag, and everything can be disabled with /config autoDelegate off.

// ── classification ──────────────────────────────────────────────────────────

/** Tools that gather information rather than change state. Long serial runs
 *  of these are the signature of work a subagent fan-out should be doing. */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "read_file",
  "grep",
  "grep_search",
  "find",
  "glob_files",
  "ls",
  "web_fetch",
  "web_search",
  "github_explore",
  "code_references",
  "memory_search",
  "browser_snapshot",
]);

export function isResearchTool(name: string): boolean {
  return RESEARCH_TOOLS.has(name);
}

// ── prompt-shape analysis ───────────────────────────────────────────────────

const SWEEP_RE =
  /\b(review|audit|scan|analyz\w*|refactor|document|test|check|fix|improve|migrate|upgrade)\b[^.\n]{0,60}\b(whole|entire|all|every|each|repo|repository|codebase|project)\b/i;

const CONJUNCTION_RE = /\b(also|additionally|then|plus|as well as|and then)\b/gi;

/** Rough count of independent subtasks in a user prompt. Used to decide
 *  whether to inject a parallelization hint. Conservative: returns 1 for
 *  anything that doesn't clearly decompose. */
export function estimateSubtasks(prompt: string): number {
  const text = prompt.trim();
  if (!text) return 0;

  // Explicit list items are the strongest signal.
  const listItems = text
    .split("\n")
    .filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
  if (listItems >= 2) return listItems;

  let estimate = 1;

  // Repo-wide sweeps decompose by area even when phrased as one sentence.
  if (SWEEP_RE.test(text)) estimate = Math.max(estimate, 3);

  // Multi-part asks joined by conjunctions / semicolons / question marks.
  const conjunctions = text.match(CONJUNCTION_RE)?.length ?? 0;
  const semicolons = text.split(";").length - 1;
  const questions = Math.max(0, (text.match(/\?/g)?.length ?? 0) - 1);
  estimate = Math.max(estimate, 1 + conjunctions + semicolons + questions);

  return estimate;
}

/** System-prompt block injected for decomposable prompts. */
export function parallelizationHint(subtasks: number): string {
  return [
    "<parallelization_hint>",
    `This request looks decomposable into ~${subtasks} independent subtasks.`,
    "Before serial exploration, plan a spawn_subagents fan-out: one self-contained",
    "prompt per subtask (every path/fact included), output_to_files: true for bulky",
    "results. Work directly only on the parts that genuinely depend on each other.",
    "</parallelization_hint>",
  ].join("\n");
}

// ── delegation tracker ──────────────────────────────────────────────────────

export interface HarnessThresholds {
  /** Research calls in one agent loop before the streak nudge fires. */
  streak: number;
  /** Context percent at/above which the pressure nudge can fire. */
  contextPercent: number;
  /** Minimum research calls this loop for the pressure nudge to be relevant. */
  contextMinResearch: number;
  /** Max streak nudges per session. */
  maxStreakNudges: number;
}

export const DEFAULT_THRESHOLDS: HarnessThresholds = {
  streak: 5,
  contextPercent: 60,
  contextMinResearch: 3,
  maxStreakNudges: 3,
};

export interface HarnessStats {
  loops: number;
  researchCalls: number;
  subagentSpawns: number;
  subagentTasks: number;
  streakNudges: number;
  contextNudges: number;
  lastPromptSubtasks: number;
  hintsInjected: number;
}

/** Tracks tool usage per agent loop and decides when a nudge is warranted.
 *  Pure state machine — no Pi APIs — so it's directly unit-testable. */
export class DelegationTracker {
  private thresholds: HarnessThresholds;
  private researchThisLoop = 0;
  private spawnedThisLoop = false;
  private nudgedThisLoop = false;
  private contextNudged = false;
  readonly stats: HarnessStats = {
    loops: 0,
    researchCalls: 0,
    subagentSpawns: 0,
    subagentTasks: 0,
    streakNudges: 0,
    contextNudges: 0,
    lastPromptSubtasks: 0,
    hintsInjected: 0,
  };

  constructor(thresholds: HarnessThresholds = DEFAULT_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  /** Call on agent_start — a new loop begins. */
  beginLoop(): void {
    this.stats.loops++;
    this.researchThisLoop = 0;
    this.spawnedThisLoop = false;
    this.nudgedThisLoop = false;
  }

  recordPromptAnalysis(subtasks: number, hinted: boolean): void {
    this.stats.lastPromptSubtasks = subtasks;
    if (hinted) this.stats.hintsInjected++;
  }

  recordToolStart(toolName: string, subagentTaskCount = 0): void {
    if (toolName === "spawn_subagents") {
      this.spawnedThisLoop = true;
      this.stats.subagentSpawns++;
      this.stats.subagentTasks += subagentTaskCount;
    } else if (isResearchTool(toolName)) {
      this.researchThisLoop++;
      this.stats.researchCalls++;
    }
  }

  /** After each tool finishes: returns nudge text when a serial research
   *  streak should be broken up, at most once per loop / maxStreakNudges
   *  per session. */
  maybeStreakNudge(): string | undefined {
    if (this.spawnedThisLoop || this.nudgedThisLoop) return undefined;
    if (this.stats.streakNudges >= this.thresholds.maxStreakNudges) return undefined;
    if (this.researchThisLoop < this.thresholds.streak) return undefined;
    this.nudgedThisLoop = true;
    this.stats.streakNudges++;
    return (
      `[pi-tools harness] ${this.researchThisLoop} sequential research calls in this loop. ` +
      "If the remaining lookups are independent, fan them out NOW with one spawn_subagents " +
      "call — a self-contained prompt per lookup, output_to_files: true for large results. " +
      "Continue directly only for steps that genuinely depend on each other's output."
    );
  }

  /** At turn end: returns nudge text when context pressure says the rest of
   *  the research belongs in subagents. Once per session. */
  maybeContextNudge(contextPercent: number | null | undefined): string | undefined {
    if (contextPercent == null || this.contextNudged) return undefined;
    if (this.spawnedThisLoop) return undefined;
    if (contextPercent < this.thresholds.contextPercent) return undefined;
    if (this.researchThisLoop < this.thresholds.contextMinResearch) return undefined;
    this.contextNudged = true;
    this.stats.contextNudges++;
    return (
      `[pi-tools harness] Context window is at ${Math.round(contextPercent)}%. ` +
      "Delegate the remaining reading/research to spawn_subagents with output_to_files: true " +
      "and keep only conclusions in this context. Consider updating .pi/memory/system/progress.md " +
      "so nothing is lost if compaction hits."
    );
  }

  /** Human-readable stats block for /harness. */
  formatStats(): string {
    const s = this.stats;
    const ratio =
      s.researchCalls > 0
        ? `${((s.subagentTasks / (s.subagentTasks + s.researchCalls)) * 100).toFixed(0)}%`
        : "n/a";
    return [
      "Delegation harness (this session):",
      `  agent loops:        ${s.loops}`,
      `  research calls:     ${s.researchCalls}`,
      `  subagent spawns:    ${s.subagentSpawns} (${s.subagentTasks} tasks)`,
      `  delegation ratio:   ${ratio} of lookups ran in subagents`,
      `  hints injected:     ${s.hintsInjected} (last prompt ≈ ${s.lastPromptSubtasks} subtasks)`,
      `  nudges sent:        ${s.streakNudges} streak, ${s.contextNudges} context-pressure`,
      "",
      `Thresholds: streak ≥ ${this.thresholds.streak} research calls/loop, ` +
        `context ≥ ${this.thresholds.contextPercent}%. Disable with /config autoDelegate off.`,
    ].join("\n");
  }
}
