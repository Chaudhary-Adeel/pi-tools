import { test, describe } from "node:test";
import assert from "node:assert";
import { HotCache } from "../src/cvm/hot-cache.ts";

describe("HotCache", () => {
  test("get/set round-trip", () => {
    const c = new HotCache<string>({ report: false });
    c.set("a", "1");
    assert.strictEqual(c.get("a"), "1");
    assert.strictEqual(c.get("missing"), undefined);
  });

  test("evicts oldest entries once over entry-count capacity", () => {
    const c = new HotCache<string>({ capacity: 2, report: false });
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3"); // evicts "a"
    assert.strictEqual(c.get("a"), undefined);
    assert.strictEqual(c.get("b"), "2");
    assert.strictEqual(c.get("c"), "3");
  });

  test("get() refreshes recency (LRU, not pure FIFO)", () => {
    const c = new HotCache<string>({ capacity: 2, report: false });
    c.set("a", "1");
    c.set("b", "2");
    c.get("a"); // "a" is now most-recently-used
    c.set("c", "3"); // should evict "b", not "a"
    assert.strictEqual(c.get("a"), "1");
    assert.strictEqual(c.get("b"), undefined);
    assert.strictEqual(c.get("c"), "3");
  });

  test("respects TTL expiry", () => {
    const c = new HotCache<string>({ report: false });
    c.set("a", "1", -1); // already expired
    assert.strictEqual(c.get("a"), undefined);
  });

  test("evicts oldest entries once over the byte budget", () => {
    const c = new HotCache<string>({ maxBytes: 10, report: false });
    c.set("a", "12345"); // 5 bytes
    c.set("b", "12345"); // 5 bytes, total 10 — at budget
    c.set("c", "1"); // pushes over budget, evicts "a" (oldest, untouched since insert)
    assert.strictEqual(c.get("a"), undefined);
    assert.strictEqual(c.get("b"), "12345");
    assert.strictEqual(c.get("c"), "1");
  });

  test("a single value larger than the byte budget is rejected, not cached — and does not wipe the rest of the cache", () => {
    // Regression test: set() used to insert the oversized value FIRST and
    // then evict oldest-first until under budget, which for a single
    // over-budget value meant evicting every other entry (and finally
    // itself), silently emptying the entire cache on one big write.
    const c = new HotCache<string>({ maxBytes: 10, report: false });
    c.set("a", "12345"); // 5 bytes, well under budget
    c.set("huge", "x".repeat(1000)); // bigger than the whole budget
    assert.strictEqual(c.get("huge"), undefined, "oversized value must not be cached");
    assert.strictEqual(c.get("a"), "12345", "existing entries must survive an oversized write");
    assert.strictEqual(c.size, 1);
  });

  test("delete() and clear()", () => {
    const c = new HotCache<string>({ report: false });
    c.set("a", "1");
    c.delete("a");
    assert.strictEqual(c.get("a"), undefined);
    c.set("b", "2");
    c.set("c", "3");
    c.clear();
    assert.strictEqual(c.size, 0);
    assert.strictEqual(c.byteSize, 0);
  });

  test("getOr computes and caches on miss, reuses on hit", async () => {
    const c = new HotCache<number>({ report: false });
    let calls = 0;
    const compute = () => { calls++; return 42; };
    const first = await c.getOr("k", compute);
    const second = await c.getOr("k", compute);
    assert.strictEqual(first, 42);
    assert.strictEqual(second, 42);
    assert.strictEqual(calls, 1);
  });
});
