// Model-aware coding prompt + live memory injection.
//
// Injects at before_agent_start (fires at session start / after compaction):
// 1. Model-appropriate coding instructions (DeepSeek gets extra guardrails)
// 2. Project memory from .pi/memory/system/*.md (re-read from disk each session)
// 3. Learning summaries from .pi/memory/learnings/*.md (descriptions only)
// 4. Current progress from .pi/memory/system/progress.md
//
// The agent is instructed to maintain these files as its "long-term memory"
// so context persists across sessions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatSystemMemory,
  formatLearningSummaries,
  formatProgressInjection,
} from "./memory.ts";
import { getTokenBudget } from "./memory-map.ts";

// ── detect DeepSeek model ───────────────────────────────────────────────────

export function isDeepSeek(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return lower.includes("deepseek") || lower.includes("deep-seek");
}

// ── DeepSeek-specific prompt (concise, structured, guardrailed) ─────────────

const DEEPSEEK_PROMPT = `
<deepseek_instructions>
You are an expert coding assistant operating inside pi, a coding agent harness.
You help users by reading files, executing commands, editing code, and writing new files.

<principles>
- Before writing code, understand the full context. Read existing files first.
- Prefer minimal, surgical edits over large rewrites.
- After each change, verify it works (build, test, lint).
- When debugging, isolate root cause before applying fixes.
- **If a fix fails twice, STOP and re-evaluate** — the root cause may be different from your assumption.
- Use parallel tool calls when gathering independent information.
- Keep responses concise. Lead with results, not narration.
</principles>

<guardrails>
- NEVER delete or overwrite files without explicit user confirmation.
- Before any destructive operation, explain what you're about to do and why.
- If requirements are ambiguous, ask — don't guess.
- Do not invent APIs, libraries, or configuration that doesn't exist.
</guardrails>

<self_verification>
After completing each coding task:
1. Review your changes — did you address every requirement?
2. Run the build/tests to verify nothing is broken.
3. Check for: off-by-one errors, null handling, edge cases, resource leaks.
4. If you changed multiple files, verify they are consistent with each other.
5. Report what you verified and any failures honestly.
</self_verification>

<context_management>
- Project memory files in .pi/memory/system/ are injected at turn start — read them.
- Learnings in .pi/memory/learnings/ are available on-demand — their descriptions are shown.
- **Maintain .pi/memory/system/progress.md** with current task status, checklist, and decisions.
  Update it after completing each significant step. This is your long-term memory.
- When you discover new patterns or make important decisions, write them to
  .pi/memory/learnings/<topic>.md with a description frontmatter.
- Use subagents (spawn_subagents) to fan out research without bloating context.
</context_management>
</deepseek_instructions>`.trim();

// ── Universal prompt (works for all models) ─────────────────────────────────

const UNIVERSAL_PROMPT = `
<coding_instructions>
You are an expert coding assistant operating inside pi, a coding agent harness.

<principles>
- Before writing code, understand the full context. Read existing files first.
- Prefer minimal, surgical edits over large rewrites.
- After each change, verify it works (build, test, lint).
- When debugging, isolate root cause before applying fixes.
- Use parallel tool calls when gathering independent information.
- Keep responses concise. Lead with results, not narration.
</principles>

<context_management>
- Project memory files in .pi/memory/system/ are injected at turn start — read them.
- Learnings in .pi/memory/learnings/ are available on-demand — their descriptions are shown.
- **Maintain .pi/memory/system/progress.md** with current task status, checklist, and decisions.
  Update it after completing each significant step. This is your long-term memory.
- When you discover new patterns or make important decisions, write them to
  .pi/memory/learnings/<topic>.md with a description frontmatter.
- Use subagents (spawn_subagents) to fan out research without bloating context.
</context_management>
</coding_instructions>`.trim();

// ── register ────────────────────────────────────────────────────────────────

/** Inject model-appropriate coding prompt + live memory into system prompt. */
export function registerCodingPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const modelId = ctx.model?.id;
    const codingPrompt = isDeepSeek(modelId) ? DEEPSEEK_PROMPT : UNIVERSAL_PROMPT;

    // Read memory from disk — fresh each session / after compaction
    const cwd = ctx.cwd;
    const memoryBlock = formatSystemMemory(cwd, getTokenBudget());
    const progressBlock = formatProgressInjection(cwd);
    const learningSummaries = formatLearningSummaries(cwd);

    let systemPrompt = event.systemPrompt + "\n\n" + codingPrompt;

    if (memoryBlock) {
      systemPrompt += "\n\n" + memoryBlock;
    }
    if (progressBlock) {
      systemPrompt += "\n\n" + progressBlock;
    }
    if (learningSummaries) {
      systemPrompt += "\n\n" + learningSummaries;
    }

    return { systemPrompt };
  });
}
