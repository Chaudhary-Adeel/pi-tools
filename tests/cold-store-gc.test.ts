// Tests for cvm/cold-store.ts — specifically coldPrune (GC), which is not
// covered in cvm.test.ts. The basic put/get/has/stats roundtrip is already
// tested there; this file focuses on the reclamation logic.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  coldPut,
  coldGet,
  coldHas,
  coldStats,
  coldPrune,
} from "../src/cvm/cold-store.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cold-gc-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Store N unique blobs and return their fingerprints. */
function storeBlobs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => coldPut(tmpDir, `blob-content-${i}-${"x".repeat(50)}`));
}

/** Back-date every cold object's mtime by `ms` milliseconds. */
function backdateObjects(ms: number): void {
  const root = path.join(tmpDir, ".pi", "cvm", "objects");
  if (!fs.existsSync(root)) return;
  const past = new Date(Date.now() - ms);
  for (const shard of fs.readdirSync(root)) {
    const dir = path.join(root, shard);
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      fs.utimesSync(file, past, past);
    }
  }
}

// ── no-op when nothing is stored ────────────────────────────────────────────

describe("coldPrune — empty store", () => {
  test("returns zero deleted and zero freed when the store is empty", () => {
    const result = coldPrune(tmpDir);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.bytesFreed, 0);
  });
});

// ── age-based eviction ───────────────────────────────────────────────────────

describe("coldPrune — age eviction", () => {
  test("does not evict fresh objects", () => {
    storeBlobs(3);
    const result = coldPrune(tmpDir, { maxAgeMs: 60_000 }); // 1-min grace
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(coldStats(tmpDir).objects, 3);
  });

  test("evicts objects older than maxAgeMs", () => {
    const fps = storeBlobs(3);
    backdateObjects(15 * 24 * 60 * 60_000); // 15 days old
    const result = coldPrune(tmpDir, { maxAgeMs: 14 * 24 * 60 * 60_000 });
    assert.strictEqual(result.deleted, 3);
    assert.ok(result.bytesFreed > 0);
    for (const fp of fps) {
      assert.strictEqual(coldHas(tmpDir, fp), false, `${fp} should have been deleted`);
    }
  });

  test("spares objects in liveFps even when they are old", () => {
    const [fp1, fp2, fp3] = storeBlobs(3);
    backdateObjects(15 * 24 * 60 * 60_000);
    const result = coldPrune(tmpDir, {
      maxAgeMs: 14 * 24 * 60 * 60_000,
      liveFps: new Set([fp1!]),
    });
    // fp1 must survive; fp2 and fp3 should be gone
    assert.strictEqual(result.deleted, 2);
    assert.ok(coldHas(tmpDir, fp1!), "live fp1 must survive");
    assert.ok(!coldHas(tmpDir, fp2!));
    assert.ok(!coldHas(tmpDir, fp3!));
  });
});

// ── size-cap eviction ────────────────────────────────────────────────────────

describe("coldPrune — size cap eviction", () => {
  test("evicts oldest objects when total size exceeds maxBytes", () => {
    // Store 5 blobs, then set a very tight size cap
    const fps = storeBlobs(5);
    // After age pass (no evictions — fresh objects), check size cap.
    // Set maxBytes to 1 byte so everything is over budget.
    const result = coldPrune(tmpDir, { maxAgeMs: 99999 * 24 * 60 * 60_000, maxBytes: 1 });
    assert.ok(result.deleted > 0, "at least some blobs should be evicted for size");
    assert.ok(result.bytesFreed > 0);
    // At least one was deleted; the store should be smaller
    assert.ok(coldStats(tmpDir).objects < fps.length);
  });

  test("spares liveFps from size-cap eviction too", () => {
    const fps = storeBlobs(4);
    // Pin the first fingerprint as live
    coldPrune(tmpDir, {
      maxAgeMs: 99999 * 24 * 60 * 60_000,
      maxBytes: 1,
      liveFps: new Set([fps[0]!]),
    });
    // The live fp must still exist
    assert.ok(coldHas(tmpDir, fps[0]!), "pinned fp0 must survive size cap");
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe("coldPrune — idempotency", () => {
  test("second prune run after eviction reports zero deleted", () => {
    storeBlobs(2);
    backdateObjects(20 * 24 * 60 * 60_000);
    const first = coldPrune(tmpDir, { maxAgeMs: 14 * 24 * 60 * 60_000 });
    assert.strictEqual(first.deleted, 2);

    const second = coldPrune(tmpDir, { maxAgeMs: 14 * 24 * 60 * 60_000 });
    assert.strictEqual(second.deleted, 0);
    assert.strictEqual(second.bytesFreed, 0);
  });
});

// ── data integrity after partial prune ──────────────────────────────────────

describe("coldPrune — survivors are readable", () => {
  test("surviving blobs still round-trip after a prune run", () => {
    const content = "survivor-blob-content";
    const survivorFp = coldPut(tmpDir, content);

    // Create another blob and age only that one
    const [victimFp] = storeBlobs(1);
    backdateObjects(20 * 24 * 60 * 60_000);
    // Un-age the survivor by touching it
    const survivorPath = path.join(tmpDir, ".pi", "cvm", "objects", survivorFp!.slice(0, 2), `${survivorFp!.slice(2)}.br`);
    const now = new Date();
    fs.utimesSync(survivorPath, now, now);

    coldPrune(tmpDir, { maxAgeMs: 14 * 24 * 60 * 60_000 });

    // Survivor readable, victim gone
    assert.strictEqual(coldGet(tmpDir, survivorFp!), content);
    assert.strictEqual(coldHas(tmpDir, victimFp!), false);
  });
});
