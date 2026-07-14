// CVM observability — one registry every layer reports into.
//
// Counters are cheap (plain numbers), always on, and exported by /cvm.
// Token savings are estimates (~4 chars/token) meant for trend visibility,
// not billing accuracy.

export interface LayerStats {
  hits: number;
  misses: number;
}

export interface CVMMetrics {
  hot: LayerStats;
  http: LayerStats & { notModified: number; bytesSaved: number };
  delta: { unchangedReturns: number; diffReturns: number; fullReturns: number };
  symbols: { filesParsed: number; filesReused: number; lookups: number };
  context: { resolves: number; expansions: number; avgConfidence: number };
  quietOutput: { compactions: number; readLimitApplied: number };
  tokensSaved: number;
}

function emptyMetrics(): CVMMetrics {
  return {
    hot: { hits: 0, misses: 0 },
    http: { hits: 0, misses: 0, notModified: 0, bytesSaved: 0 },
    delta: { unchangedReturns: 0, diffReturns: 0, fullReturns: 0 },
    symbols: { filesParsed: 0, filesReused: 0, lookups: 0 },
    context: { resolves: 0, expansions: 0, avgConfidence: 0 },
    quietOutput: { compactions: 0, readLimitApplied: 0 },
    tokensSaved: 0,
  };
}

let metrics: CVMMetrics = emptyMetrics();

export function cvmMetrics(): CVMMetrics {
  return metrics;
}

export function resetCvmMetrics(): void {
  metrics = emptyMetrics();
}

export function recordTokensSaved(tokens: number): void {
  metrics.tokensSaved += Math.max(0, tokens);
}

export function recordConfidence(confidence: number): void {
  const c = metrics.context;
  // Running average over resolves.
  c.avgConfidence = (c.avgConfidence * c.resolves + confidence) / (c.resolves + 1);
  c.resolves++;
}

function ratio(s: LayerStats): string {
  const total = s.hits + s.misses;
  return total === 0 ? "n/a" : `${((s.hits / total) * 100).toFixed(0)}% (${s.hits}/${total})`;
}

export function formatCvmMetrics(): string {
  const m = metrics;
  return [
    "CVM metrics (this session):",
    `  est. prompt tokens saved: ${m.tokensSaved.toLocaleString()}`,
    `  hot cache hit ratio:      ${ratio(m.hot)}`,
    `  http cache:               ${ratio(m.http)}, ${m.http.notModified} conditional 304s, ` +
      `${(m.http.bytesSaved / 1024).toFixed(1)} KB not re-downloaded`,
    `  delta mode:               ${m.delta.unchangedReturns} unchanged stubs, ` +
      `${m.delta.diffReturns} diffs, ${m.delta.fullReturns} full reads`,
    `  symbol index (warm):      ${m.symbols.filesReused} files reused, ` +
      `${m.symbols.filesParsed} parsed, ${m.symbols.lookups} lookups`,
    `  context resolves:         ${m.context.resolves} (${m.context.expansions} auto-expansions, ` +
      `avg confidence ${(m.context.avgConfidence * 100).toFixed(0)}%)`,
    `  quiet output:             ${m.quietOutput.compactions} large output(s) compacted, ` +
      `${m.quietOutput.readLimitApplied} read() call(s) capped`,
  ].join("\n");
}
