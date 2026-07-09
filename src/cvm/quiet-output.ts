// Quiet Output — compact oversized tool output before it reaches the model.
//
// Complements the rest of the CVM (which avoids re-sending UNCHANGED
// content) by handling the orthogonal case: a single tool call whose output
// is simply too big the FIRST time — a huge `bash` stdout dump, a `grep`
// with thousands of hits, a full-file `read` with no line limit. None of
// that is "duplicate," so delta mode and the HTTP cache don't help.
//
// Mechanism (deterministic line-trimming, never AI summarization): output
// over the threshold is replaced with a head+tail preview; the full text is
// stashed in the CVM's existing content-addressed cold store (free dedup +
// brotli compression) and the model is given its fingerprint to retrieve
// the complete text on demand via the `read_artifact` tool.

import { coldPut } from "./cold-store.ts";
import { estimateTokens, fingerprint, shortFp } from "./fingerprint.ts";
import { HotCache } from "./hot-cache.ts";
import { cvmMetrics, recordTokensSaved } from "./metrics.ts";

export interface QuietOutputThresholds {
  /** Compact when output exceeds this many characters... */
  maxChars: number;
  /** ...or this many lines (whichever triggers first). */
  maxLines: number;
  /** Head/tail lines kept in the preview for normal output. */
  headLines: number;
  tailLines: number;
  /** Larger allocation for error output — diagnostics matter more. */
  errorHeadLines: number;
  errorTailLines: number;
}

export const DEFAULT_QUIET_THRESHOLDS: QuietOutputThresholds = {
  maxChars: 12_000,
  maxLines: 240,
  headLines: 100,
  tailLines: 60,
  errorHeadLines: 160,
  errorTailLines: 120,
};

export interface CompactedOutput {
  preview: string;
  fp: string;
  originalLines: number;
  originalChars: number;
  tokensSaved: number;
}

/** Tools whose output should never be compacted by this generic layer —
 *  either because they already apply their own tailored truncation/preview
 *  (spawn_subagents' multi-section head/tail) or because a short-circuit
 *  reply (ask_user) is never large enough to matter. */
export const QUIET_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["spawn_subagents", "ask_user"]);

// Quiet Output runs at context-assembly time (the `context` event), which
// re-scans the ENTIRE message history before every single LLM call. Past
// tool-result content never changes once written, so recomputing the
// line-split/slice/join for the same large blob on every subsequent turn
// would be pure waste — memoize the shape by content fingerprint. Metrics
// (tokens saved, compaction count) still fire on every call: a cache hit
// still represents a real saving for THAT outbound request.
const compactionCache = new HotCache<CompactedOutput | null>({
  capacity: 500,
  ttlMs: 4 * 60 * 60_000,
  report: false,
});

function computeCompaction(
  cwd: string,
  text: string,
  isError: boolean,
  thresholds: QuietOutputThresholds,
): CompactedOutput | null {
  const lines = text.split("\n");
  if (text.length <= thresholds.maxChars && lines.length <= thresholds.maxLines) return null;

  const head = isError ? thresholds.errorHeadLines : thresholds.headLines;
  const tail = isError ? thresholds.errorTailLines : thresholds.tailLines;

  // Nothing to trim if the whole thing already fits in head+tail.
  if (lines.length <= head + tail) return null;

  const fp = coldPut(cwd, text);
  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(lines.length - tail);
  const omitted = lines.length - head - tail;

  const preview = [
    ...headLines,
    `… [${omitted.toLocaleString()} lines omitted — full output stashed as artifact ${shortFp(fp)}] …`,
    `Use read_artifact({ fp: "${fp}" }) to retrieve the complete text if you need it.`,
    ...tailLines,
  ].join("\n");

  const tokensSaved = Math.max(0, estimateTokens(text) - estimateTokens(preview));
  return { preview, fp, originalLines: lines.length, originalChars: text.length, tokensSaved };
}

/** Decide whether `text` needs compaction, and produce it if so. Returns
 *  undefined when the text is already small enough — callers should make no
 *  changes in that case. Memoized by content fingerprint (see above). */
export function compactIfLarge(
  cwd: string,
  text: string,
  isError: boolean,
  thresholds: QuietOutputThresholds = DEFAULT_QUIET_THRESHOLDS,
): CompactedOutput | undefined {
  const cacheKey = `${isError ? "e" : "o"}:${fingerprint(text)}`;
  let cached = compactionCache.get(cacheKey);
  if (cached === undefined) {
    cached = computeCompaction(cwd, text, isError, thresholds);
    compactionCache.set(cacheKey, cached);
  }
  if (cached === null) return undefined;

  recordTokensSaved(cached.tokensSaved);
  cvmMetrics().quietOutput.compactions++;
  return cached;
}

/** Test hook. */
export function clearCompactionCache(): void {
  compactionCache.clear();
}

// ── read() default line limit ───────────────────────────────────────────────

const NON_TEXT_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".woff", ".woff2", ".ttf", ".otf",
  ".mp3", ".mp4", ".mov", ".wav", ".exe", ".dll", ".so", ".wasm",
]);

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
}

/** True when a default line limit is safe to inject for this path — skipped
 *  for images/binaries where "lines" don't apply and Pi's own read tool
 *  handles them differently (e.g. image previews). */
export function shouldApplyReadDefaultLimit(filePath: string): boolean {
  return !NON_TEXT_EXTENSIONS.has(extOf(filePath));
}

/** Mutate a read-tool input in place to cap unlimited reads at a sane
 *  default. Returns true if it changed anything. Pure/testable: takes a
 *  plain input object, no Pi types required. */
export function applyReadDefaultLimit(
  input: { path?: string; limit?: number },
  defaultLimit: number,
): boolean {
  if (input.limit !== undefined) return false;
  if (!input.path || !shouldApplyReadDefaultLimit(input.path)) return false;
  input.limit = defaultLimit;
  return true;
}

export const DEFAULT_READ_LIMIT = 120;
