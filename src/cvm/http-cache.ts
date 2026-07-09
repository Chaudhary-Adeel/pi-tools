// HTTP cache — never download unchanged resources.
//
// Validators (ETag / Last-Modified) live in the warm store; bodies live in
// cold storage keyed by content fingerprint. Flow per URL:
//
//   fresh TTL          → serve from cache, zero network
//   stale + validators → conditional GET; 304 refreshes TTL for free
//   stale, no match    → full download, body content-addressed into cold
//
// Only 200 responses are cached. Bodies are deduplicated automatically: two
// URLs with identical content share one cold object.

import { coldGet, coldPut } from "./cold-store.ts";
import { cvmMetrics } from "./metrics.ts";
import { getWarmStore } from "./warm-store.ts";

export interface CachedResponse {
  status: number;
  contentType: string;
  body: string;
  /** "network" | "fresh" (TTL hit, no request) | "revalidated" (304) */
  source: "network" | "fresh" | "revalidated";
  finalUrl: string;
}

export interface CachedFetchOptions {
  /** How long a cached copy is served without any request (default 5 min). */
  ttlMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function cachedFetch(
  cwd: string,
  url: string,
  options: CachedFetchOptions = {},
): Promise<CachedResponse> {
  const warm = getWarmStore(cwd);
  const m = cvmMetrics().http;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = Date.now();

  const cached = warm.httpGet(url);
  const cachedBody = cached ? coldGet(cwd, cached.fp) : undefined;

  // Fresh within TTL — no network at all. The caller's ttlMs acts like a
  // max-age request directive: it can shorten (never extend) freshness.
  const freshUntil = cached ? Math.min(cached.ttlAt, cached.fetchedAt + ttlMs) : 0;
  if (cached && cachedBody !== undefined && freshUntil > now) {
    m.hits++;
    m.bytesSaved += cachedBody.length;
    return {
      status: cached.status,
      contentType: cached.contentType,
      body: cachedBody,
      source: "fresh",
      finalUrl: url,
    };
  }

  // Conditional request when we hold validators.
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (cached && cachedBody !== undefined) {
    if (cached.etag) headers["If-None-Match"] = cached.etag;
    if (cached.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  }

  const res = await fetch(url, { headers, redirect: "follow", signal: options.signal });

  if (res.status === 304 && cached && cachedBody !== undefined) {
    m.hits++;
    m.notModified++;
    m.bytesSaved += cachedBody.length;
    warm.httpUpsert({ ...cached, fetchedAt: now, ttlAt: now + ttlMs });
    return {
      status: cached.status,
      contentType: cached.contentType,
      body: cachedBody,
      source: "revalidated",
      finalUrl: url,
    };
  }

  m.misses++;
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  // Cap what we persist: brotliCompressSync on multi-MB bodies would block
  // the event loop (and the TUI). Oversized bodies are returned uncached.
  const MAX_CACHED_BODY = 4 * 1024 * 1024;
  if (res.status === 200 && body.length <= MAX_CACHED_BODY) {
    const fp = coldPut(cwd, body);
    // Honor Cache-Control: no-store by not persisting at all.
    const cc = res.headers.get("cache-control") ?? "";
    if (!/\bno-store\b/i.test(cc)) {
      warm.httpUpsert({
        url,
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        fp,
        fetchedAt: now,
        ttlAt: now + ttlMs,
        status: res.status,
        contentType,
      });
    }
  }

  return { status: res.status, contentType, body, source: "network", finalUrl: res.url || url };
}
