import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cachedFetch } from "../src/cvm/http-cache.ts";
import { coldStats } from "../src/cvm/cold-store.ts";
import { closeWarmStore } from "../src/cvm/warm-store.ts";
import { resetCvmMetrics } from "../src/cvm/metrics.ts";

let tmpDir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-http-cache-"));
  originalFetch = globalThis.fetch;
  resetCvmMetrics();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeWarmStore(tmpDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function fakeResponse(init: { status?: number; headers?: Record<string, string>; body?: string }): Response {
  const status = init.status ?? 200;
  const body = NULL_BODY_STATUSES.has(status) ? null : (init.body ?? "");
  return new Response(body, { status, headers: init.headers ?? {} });
}

describe("cachedFetch", () => {
  test("network miss on first fetch, cached on second within TTL", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return fakeResponse({ body: "hello", headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const first = await cachedFetch(tmpDir, "https://example.com/a", { ttlMs: 60_000 });
    assert.strictEqual(first.source, "network");
    assert.strictEqual(first.body, "hello");

    const second = await cachedFetch(tmpDir, "https://example.com/a", { ttlMs: 60_000 });
    assert.strictEqual(second.source, "fresh");
    assert.strictEqual(second.body, "hello");
    assert.strictEqual(calls, 1, "fresh hit must not touch the network");
  });

  test("stale + validators → conditional GET, 304 revalidates and refreshes validators", async () => {
    let call = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return fakeResponse({
          body: "v1",
          headers: { etag: "\"abc\"", "content-type": "text/plain" },
        });
      }
      // Second call must be a conditional GET carrying the stored ETag.
      const headers = init?.headers as Record<string, string> | undefined;
      assert.strictEqual(headers?.["If-None-Match"], "\"abc\"");
      return fakeResponse({ status: 304, headers: { etag: "\"xyz-rotated\"" } });
    }) as typeof fetch;

    const first = await cachedFetch(tmpDir, "https://example.com/b", { ttlMs: -1 });
    assert.strictEqual(first.source, "network");

    const second = await cachedFetch(tmpDir, "https://example.com/b", { ttlMs: -1 });
    assert.strictEqual(second.source, "revalidated");
    assert.strictEqual(second.body, "v1", "304 must reuse the cached body");

    // A third fetch's conditional request should now carry the ROTATED etag
    // from the 304 response, not the original one.
    let thirdSawRotatedEtag = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      thirdSawRotatedEtag = headers?.["If-None-Match"] === "\"xyz-rotated\"";
      return fakeResponse({ status: 304 });
    }) as typeof fetch;
    await cachedFetch(tmpDir, "https://example.com/b", { ttlMs: -1 });
    assert.ok(thirdSawRotatedEtag, "304 responses must rotate stored validators");
  });

  test("Cache-Control: no-store is never persisted to cold storage", async () => {
    globalThis.fetch = (async () =>
      fakeResponse({ body: "secret", headers: { "cache-control": "no-store" } })) as typeof fetch;

    const before = coldStats(tmpDir);
    await cachedFetch(tmpDir, "https://example.com/c");
    const after = coldStats(tmpDir);
    assert.strictEqual(after.objects, before.objects, "no-store body must not be written to cold storage");

    // A second fetch of the same URL must go to the network again (nothing cached).
    let secondCallHappened = false;
    globalThis.fetch = (async () => {
      secondCallHappened = true;
      return fakeResponse({ body: "secret", headers: { "cache-control": "no-store" } });
    }) as typeof fetch;
    await cachedFetch(tmpDir, "https://example.com/c");
    assert.ok(secondCallHappened);
  });

  test("follows redirects and returns the final URL", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "https://example.com/old") {
        return fakeResponse({ status: 302, headers: { location: "https://example.com/new" } });
      }
      return fakeResponse({ body: "moved", headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const res = await cachedFetch(tmpDir, "https://example.com/old");
    assert.strictEqual(res.body, "moved");
    assert.strictEqual(res.finalUrl, "https://example.com/new");
  });

  test("validateUrl is re-run on every redirect hop and can block a hop", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "https://example.com/redirect-me") {
        return fakeResponse({ status: 302, headers: { location: "http://169.254.169.254/secret" } });
      }
      return fakeResponse({ body: "should never get here" });
    }) as typeof fetch;

    const seen: string[] = [];
    const validateUrl = (u: string) => {
      seen.push(u);
      return u.includes("169.254.169.254") ? "blocked internal target" : null;
    };

    await assert.rejects(
      () => cachedFetch(tmpDir, "https://example.com/redirect-me", { validateUrl }),
      /blocked internal target/,
    );
    assert.deepStrictEqual(seen, ["https://example.com/redirect-me", "http://169.254.169.254/secret"]);
  });

  test("too many redirects throws instead of looping forever", async () => {
    globalThis.fetch = (async (url: string) => {
      const n = Number(url.split("/").pop());
      return fakeResponse({ status: 302, headers: { location: `https://example.com/hop/${n + 1}` } });
    }) as typeof fetch;

    await assert.rejects(
      () => cachedFetch(tmpDir, "https://example.com/hop/0"),
      /Too many redirects/,
    );
  });
});
