// Tracks subagent LLM token usage that the main agent's footer doesn't see.
//
// Subagents run in separate `pi --no-session` processes. Their API calls
// (input/output tokens, cache, cost) never appear in the main session's
// message branch — so `ctx.sessionManager.getBranch()` won't find them.
// The footer currently only shows main-agent usage, which undercounts
// the real total.
//
// This module accumulates subagent usage so the footer can add it in.

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

let _usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

/** Accumulate subagent usage from a completed run. */
export function addSubagentUsage(u: SubagentUsage): void {
  _usage.input += u.input;
  _usage.output += u.output;
  _usage.cacheRead += u.cacheRead;
  _usage.cacheWrite += u.cacheWrite;
  _usage.cost += u.cost;
  _usage.turns += u.turns;
}

/** Current cumulative subagent usage. */
export function getSubagentUsage(): SubagentUsage {
  return { ..._usage };
}

/** Reset (called on session_start). */
export function resetSubagentTokens(): void {
  _usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
