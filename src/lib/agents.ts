// Subagent presets — reusable roles for spawn_subagents and /newTask.
//
// A preset is just a prompt prefix that scopes what the subagent should do
// and how it should report back. Listed by /agents; applied by /newTask
// when the task starts with "<preset>:".

export interface AgentPreset {
  name: string;
  description: string;
  promptPrefix: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    name: "explorer",
    description: "Read-only research: find files, trace code paths, summarize findings",
    promptPrefix:
      "You are a read-only research agent. Do NOT edit, write, or run state-changing commands. " +
      "Investigate the codebase and report findings as concise bullet points with file:line references.",
  },
  {
    name: "coder",
    description: "Implement a scoped change, verify it, report the diff",
    promptPrefix:
      "You are an implementation agent. Make the requested change with minimal, surgical edits. " +
      "Verify with build/tests before finishing and report exactly what you changed and what you verified.",
  },
  {
    name: "reviewer",
    description: "Review code for bugs, edge cases, and simplifications — no edits",
    promptPrefix:
      "You are a code review agent. Do NOT edit anything. Look for correctness bugs, unhandled edge " +
      "cases, and simplification opportunities. Report findings ranked by severity with file:line references.",
  },
  {
    name: "tester",
    description: "Run the test suite / exercise a change and report results honestly",
    promptPrefix:
      "You are a verification agent. Run the relevant builds/tests, exercise the affected behavior, " +
      "and report pass/fail results honestly, including full output for any failure.",
  },
];

export function findPreset(name: string): AgentPreset | undefined {
  const lower = name.toLowerCase();
  return AGENT_PRESETS.find((p) => p.name === lower);
}

/** Split "reviewer: check the auth flow" into preset + rest, if prefixed.
 *  `taskText` is the raw text after the "preset:" prefix (set only when a
 *  preset matched) — callers building a short label should use it instead
 *  of re-slicing the original input, since the separator can include
 *  arbitrary whitespace ("preset : task"). */
export function applyPreset(prompt: string): { preset?: AgentPreset; prompt: string; taskText?: string } {
  const m = /^(\w+)\s*:\s*(.+)$/s.exec(prompt.trim());
  if (m) {
    const preset = findPreset(m[1]!);
    if (preset) {
      const taskText = m[2]!.trim();
      return { preset, prompt: `${preset.promptPrefix}\n\nTask: ${taskText}`, taskText };
    }
  }
  return { prompt: prompt.trim() };
}
