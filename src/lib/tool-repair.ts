// Tool-input repair — makes weaker/open models (DeepSeek and friends) as
// reliable at tool calling as frontier models, without changing the model.
//
// Why this lives inside execute(), not a pre-validation hook
// ------------------------------------------------------------------------
// Pi's own core (pi-agent-core's agent-loop.js -> pi-ai's validateToolArguments)
// already runs TypeBox's Value.Convert + a strict Check on every tool call
// BEFORE any extension hook fires. If that Check fails, Pi throws
// immediately and returns a raw validation-error tool result — our
// `tool_call` extension hook never even sees the call. Confirmed by reading
// the actual bundled source (node_modules/@earendil-works/pi-coding-agent/
// node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js,
// node_modules/@earendil-works/pi-ai/dist/utils/validation.js), not assumed.
//
// This is architecturally different from a system that owns its whole
// tool-calling pipeline end-to-end: we can't intercept before Pi's schema
// check the way a fully custom harness can. The two things we CAN control:
//
//   1. For pi-tools' own tool schemas: widen the declared parameter type
//      with a permissive fallback member (e.g. Type.Union([Type.Array(...),
//      Type.String()])) so malformed shapes (stringified JSON, a bare
//      single item, a bare string) pass Pi's Check instead of being
//      rejected upstream, then repair the value for real inside execute(),
//      where we have full control. repairArrayInput() below is that repair.
//
//   2. For ANY tool's plain string fields (including Pi's built-in
//      edit/write/read `path`), a `tool_call` handler CAN still mutate
//      event.input in place before execution, with no re-validation — this
//      works because a wrong-but-valid string (e.g. a markdown auto-link
//      leaking into a path) passes Pi's Check just fine; it's not a schema
//      failure, just a semantically wrong value. unwrapDegenerateMarkdownLink()
//      below is built for exactly that hook.
//
// TypeBox's own Value.Convert (see node_modules/typebox/build/value/convert/
// try/try_array.mjs) already wraps a bare non-array value as [value] for
// array-typed fields — so "bare string instead of array" is partially
// handled upstream. It does NOT parse a JSON-stringified array first, which
// is exactly the trap: '["a","b"]' becomes ['["a","b"]'] instead of
// ["a","b"]. repairArrayInput() below runs its own ordered pass and fixes
// that specific gap, in addition to everything TypeBox's Convert won't have
// already normalized (because we widen with a permissive union member that
// TypeBox's FromUnion treats as an immediate match, leaving the raw value
// untouched for us to repair ourselves — see from_union.mjs's "already
// matches one member -> return unchanged" fast path).

import { Type, type TSchema } from "typebox";

// ── telemetry ────────────────────────────────────────────────────────────

export interface ToolRepairStats {
  repaired: number;
  invalid: number;
  byTool: Map<string, { repaired: number; invalid: number }>;
}

let stats: ToolRepairStats = { repaired: 0, invalid: 0, byTool: new Map() };

export function resetToolRepairStats(): void {
  stats = { repaired: 0, invalid: 0, byTool: new Map() };
}

export function toolRepairStats(): ToolRepairStats {
  return stats;
}

/** Record that a tool's input was successfully repaired before execution. */
export function recordRepair(toolName: string): void {
  const bucket = stats.byTool.get(toolName) ?? { repaired: 0, invalid: 0 };
  stats.repaired++;
  bucket.repaired++;
  stats.byTool.set(toolName, bucket);
}

/** Record that a tool's input was malformed in a way repair couldn't fix. */
export function recordUnrepairable(toolName: string): void {
  const bucket = stats.byTool.get(toolName) ?? { repaired: 0, invalid: 0 };
  stats.invalid++;
  bucket.invalid++;
  stats.byTool.set(toolName, bucket);
}

/** Record a repaired path field (markdown auto-link unwrap). */
export function recordPathRepair(toolName: string): void {
  recordRepair(toolName);
}

export function formatToolRepairStats(): string {
  if (stats.byTool.size === 0) {
    return "Tool-input repair: no malformed tool calls seen this session.";
  }
  const lines = [`Tool-input repair (this session): ${stats.repaired} repaired, ${stats.invalid} unrepairable`];
  for (const [tool, s] of stats.byTool) {
    lines.push(`  ${tool}: ${s.repaired} repaired, ${s.invalid} unrepairable`);
  }
  return lines.join("\n");
}

// ── array-shape repair ──────────────────────────────────────────────────
//
// Ordered pipeline, applied only when the raw value ISN'T already a valid
// array (valid input is never touched — that's the whole point):
//
//   1. string -> JSON.parse -> array?           ("['a','b']" as a string)
//   2. null/undefined -> []                     (optional field sent as null)
//   3. object with sequential numeric keys -> Object.values()
//                                                 ({"0":"a","1":"b"})
//   4. anything else (a bare object, a bare non-JSON string, a number...)
//      -> wrap as a single-element array          (bare item where an array
//                                                   of one was meant)
//
// Order matters: step 1 MUST run before step 4, or a stringified array gets
// wrapped as a single-element array containing the raw JSON string instead
// of being parsed into the array it represents.

export interface RepairResult<T> {
  value: T[];
  /** True only when the input was PRESENT but malformed. An absent optional
   *  field (undefined) is not a repair — counting it as one would log a
   *  false positive on every call that simply omits an optional array. */
  repaired: boolean;
  /** Which step fixed it, for telemetry/debugging. Empty if input was
   *  already valid or absent. */
  method?:
    | "json-string-parse"
    | "null-to-empty"
    | "numeric-keyed-object"
    | "wrap-bare-value";
}

function isSequentialNumericKeyed(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  return keys.every((k, i) => k === String(i));
}

/** Repair a value that should be an array but might have arrived in one of
 *  the shapes a weaker model commonly sends instead. Never touches an
 *  already-valid array. */
export function repairArrayInput<T = unknown>(value: unknown): RepairResult<T> {
  if (Array.isArray(value)) {
    return { value: value as T[], repaired: false };
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return { value: parsed as T[], repaired: true, method: "json-string-parse" };
      }
    } catch {
      /* not JSON — fall through to bare-value wrap below */
    }
  }

  // An omitted optional field is absent, not broken — no repair to report.
  // An explicit `null`, however, IS the classic "sent null instead of
  // omitting the field" mistake, so that one counts.
  if (value === undefined) {
    return { value: [], repaired: false };
  }
  if (value === null) {
    return { value: [], repaired: true, method: "null-to-empty" };
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (isSequentialNumericKeyed(obj)) {
      return { value: Object.values(obj) as T[], repaired: true, method: "numeric-keyed-object" };
    }
  }

  // Bare item (object, non-JSON string, number, boolean) where an array of
  // one was meant — must run last, after the JSON-string-parse attempt.
  return { value: [value as T], repaired: true, method: "wrap-bare-value" };
}

// ── markdown auto-link leak (path fields) ───────────────────────────────
//
// Some models emit filesystem paths as a markdown auto-link — the
// post-training chat distribution ("always link file references") leaking
// through the tool boundary. Only the degenerate case (link text equals the
// URL minus its protocol) is unwrapped; a real markdown link some model
// pastes for an unrelated reason passes through untouched.

const MD_AUTOLINK_RE = /\[([^\]]+)\]\((?:https?:\/\/)?([^)]+)\)/g;

export function unwrapDegenerateMarkdownLink(value: string): string {
  return value.replace(MD_AUTOLINK_RE, (whole, linkText: string, urlNoProto: string) =>
    linkText === urlNoProto ? linkText : whole,
  );
}

// ── schema helper ────────────────────────────────────────────────────────
//
// Self-documenting marker for pi-tools' own tool schemas: signals "this
// field is a filesystem path", so a reader (human or future repair logic)
// knows path-specific cleanup applies here. The actual auto-link fix is
// wired generically by field name in lib/tool-repair-register.ts, since a
// `tool_call` handler doesn't have direct access to the schema object for
// built-in tools it doesn't own — but this still documents intent at the
// declaration site, same spirit as a dedicated pathString() type.
export function pathString(description?: string): TSchema {
  return Type.String({ description, "x-pi-tools-path": true } as Record<string, unknown>);
}
