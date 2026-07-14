// Hot memory — in-process LRU + TTL cache, the CVM's "RAM".
//
// O(1) get/set via Map insertion-order recency (delete + re-insert moves a
// key to the back; the front is always the least recently used). No
// serialization: values are stored by reference. Capacity is entry-count
// based with an optional byte budget for string values.

import { cvmMetrics } from "./metrics.ts";

interface Entry<V> {
  value: V;
  expiresAt: number; // epoch ms; Infinity = no TTL
  bytes: number;
}

export interface HotCacheOptions {
  /** Max entries (default 512). */
  capacity?: number;
  /** Default TTL in ms (default 10 min). */
  ttlMs?: number;
  /** Optional byte budget across string/Buffer values (default 32 MB). */
  maxBytes?: number;
  /** Report hits/misses into the global CVM metrics (default true). */
  report?: boolean;
}

export class HotCache<V = unknown> {
  private map = new Map<string, Entry<V>>();
  private capacity: number;
  private ttlMs: number;
  private maxBytes: number;
  private bytes = 0;
  private report: boolean;

  constructor(options: HotCacheOptions = {}) {
    this.capacity = options.capacity ?? 512;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.report = options.report ?? true;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      if (this.report) cvmMetrics().hot.misses++;
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      this.delete(key);
      if (this.report) cvmMetrics().hot.misses++;
      return undefined;
    }
    // Refresh recency: Map preserves insertion order.
    this.map.delete(key);
    this.map.set(key, entry);
    if (this.report) cvmMetrics().hot.hits++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.delete(key); // reset recency + byte accounting
    const bytes = sizeOf(value);
    if (bytes > this.maxBytes) {
      // A single value bigger than the whole byte budget can never satisfy
      // evict()'s "under budget" condition while it's present — inserting
      // it would evict every other entry (including itself, last). Treat
      // it as uncacheable instead of wiping the cache to make room.
      return;
    }
    const entry: Entry<V> = {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
      bytes,
    };
    this.map.set(key, entry);
    this.bytes += bytes;
    this.evict();
  }

  /** get-or-compute in one step. */
  async getOr(key: string, compute: () => Promise<V> | V, ttlMs?: number): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  private evict(): void {
    while (this.map.size > this.capacity || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
  }
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Buffer.isBuffer(value)) return value.length;
  return 64; // nominal cost for objects held by reference
}
