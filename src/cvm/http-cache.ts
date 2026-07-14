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
  /**
   * Called with each URL about to be fetched — including every redirect
   * hop — before the request is made. Return an error string to abort, or
   * null/undefined to allow. Without this, `redirect: "follow"` would let a
   * validated URL 302 its way to an unvalidated (e.g. internal) target.
   */
  validateUrl?: (url: string) => Promise<string | null> | string | null;
}

const MAX_REDIRECTS = 5;

/** Follow redirects manually, re-running `validateUrl` on every hop. */
async function fetchFollowingRedirects(
  startUrl: string,
  init: RequestInit,
  validateUrl: CachedFetchOptions["validateUrl"],
): Promise<{ res: Response; finalUrl: string }> {
  let currentUrl = startUrl;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) {
      throw new Error(`Too many redirects fetching ${startUrl}`);
    }
    if (validateUrl) {
      const err = await validateUrl(currentUrl);
      if (err) throw new Error(err);
    }
    const res = await fetch(currentUrl, { ...init, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (!isRedirect || !location) return { res, finalUrl: currentUrl };
    currentUrl = new URL(location, currentUrl).toString();
  }
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

  const { res, finalUrl } = await fetchFollowingRedirects(
    url,
    { headers, signal: options.signal },
    options.validateUrl,
  );

  if (res.status === 304 && cached && cachedBody !== undefined) {
    m.hits++;
    m.notModified++;
    m.bytesSaved += cachedBody.length;
    // Honor rotated validators from the 304 response instead of assuming
    // the old ones still apply.
    warm.httpUpsert({
      ...cached,
      etag: res.headers.get("etag") ?? cached.etag,
      lastModified: res.headers.get("last-modified") ?? cached.lastModified,
      fetchedAt: now,
      ttlAt: now + ttlMs,
    });
    return {
      status: cached.status,
      contentType: cached.contentType,
      body: cachedBody,
      source: "revalidated",
      finalUrl,
    };
  }

  m.misses++;
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  // Cap what we persist: brotliCompressSync on multi-MB bodies would block
  // the event loop (and the TUI). Oversized bodies are returned uncached.
  const MAX_CACHED_BODY = 4 * 1024 * 1024;
  // Honor Cache-Control: no-store by not persisting at all — check BEFORE
  // writing to cold storage, so no-store bodies never touch disk.
  const cc = res.headers.get("cache-control") ?? "";
  if (res.status === 200 && body.length <= MAX_CACHED_BODY && !/\bno-store\b/i.test(cc)) {
    const fp = coldPut(cwd, body);
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

  return { status: res.status, contentType, body, source: "network", finalUrl };
}
