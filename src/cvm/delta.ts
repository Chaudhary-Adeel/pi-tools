// Delta mode — never resend identical context within a session.
//
// A per-session ledger maps logical resources (a file read, a URL fetch) to
// the fingerprint of the content last returned to the model. On repeat:
//   identical content → a short "unchanged" stub instead of the full body
//   changed content   → a compact line diff against what the model last saw
//
// The ledger is deliberately session-scoped (in memory, reset on
// session_start): after compaction or restart the model may genuinely lack
// the content, and stubbing it would starve reasoning. Every stub carries an
// escape hatch (force_full) for exactly that case.

import { estimateTokens, fingerprint, shortFp } from "./fingerprint.ts";
import { HotCache } from "./hot-cache.ts";
import { cvmMetrics, recordTokensSaved } from "./metrics.ts";

interface LedgerEntry {
  fp: string;
  content: string; // last content sent — needed to diff the next version
}

// Ledger content lives in a bounded hot cache so huge files can't pin memory.
const ledger = new HotCache<LedgerEntry>({
  capacity: 256,
  ttlMs: 4 * 60 * 60_000,
  maxBytes: 24 * 1024 * 1024,
  report: false,
});

export type DeltaResult =
  | { kind: "full" }
  | { kind: "unchanged"; stub: string }
  | { kind: "diff"; diff: string };

/** Compact line diff: trims the common prefix/suffix and shows only the
 *  changed middle of both versions. Deterministic, no external deps. */
export function compactDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const parts: string[] = [
    `@@ lines ${start + 1}-${endA + 1} → ${start + 1}-${endB + 1} @@`,
  ];
  for (const line of removed.slice(0, 200)) parts.push(`- ${line}`);
  if (removed.length > 200) parts.push(`- … ${removed.length - 200} more removed lines`);
  for (const line of added.slice(0, 200)) parts.push(`+ ${line}`);
  if (added.length > 200) parts.push(`+ … ${added.length - 200} more added lines`);
  return parts.join("\n");
}

/** Check content against the ledger and record it as sent. */
export function deltaCheck(key: string, content: string): DeltaResult {
  const fp = fingerprint(content);
  const prev = ledger.get(key);
  ledger.set(key, { fp, content });

  if (!prev) {
    cvmMetrics().delta.fullReturns++;
    return { kind: "full" };
  }

  if (prev.fp === fp) {
    cvmMetrics().delta.unchangedReturns++;
    recordTokensSaved(estimateTokens(content));
    return {
      kind: "unchanged",
      stub:
        `[CVM] Unchanged since your last retrieval (${shortFp(fp)}, ` +
        `${content.split("\n").length} lines, ~${estimateTokens(content)} tokens) — ` +
        "content omitted because it is already in your context. " +
        "If it is NOT in your context anymore (e.g. after compaction), retry with force_full: true.",
    };
  }

  const diff = compactDiff(prev.content, content);
  // A near-total rewrite defeats the purpose of a diff — send full content.
  // Compare in lines: the diff carries one line per changed line plus a header.
  const diffLines = diff.split("\n").length;
  const contentLines = content.split("\n").length;
  if (diffLines > contentLines + 1) {
    cvmMetrics().delta.fullReturns++;
    return { kind: "full" };
  }
  cvmMetrics().delta.diffReturns++;
  recordTokensSaved(Math.max(0, estimateTokens(content) - estimateTokens(diff)));
  return {
    kind: "diff",
    diff:
      `[CVM] Changed since your last retrieval (${shortFp(prev.fp)} → ${shortFp(fp)}). ` +
      `Diff against the version in your context:\n${diff}\n` +
      "(retry with force_full: true for the complete current content)",
  };
}

/** Record content as sent without checking — used by force_full paths so
 *  the ledger always reflects what the model most recently saw. */
export function deltaRecord(key: string, content: string): void {
  ledger.set(key, { fp: fingerprint(content), content });
}

/** Reset on session start — a fresh context has seen nothing. */
export function resetDeltaLedger(): void {
  ledger.clear();
}
