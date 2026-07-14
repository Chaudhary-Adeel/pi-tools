// Cold storage — content-addressed, brotli-compressed blobs on disk.
//
// Layout mirrors git's object store: .pi/cvm/objects/<fp[0:2]>/<fp[2:]>.br
// A blob is written once per unique content (the fingerprint IS the key) and
// never rewritten — writes to an existing fingerprint are no-ops, which is
// what makes "never download identical content twice" cheap to guarantee.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fingerprint } from "./fingerprint.ts";
import { cvmDir } from "./warm-store.ts";

function objectPath(cwd: string, fp: string): string {
  return path.join(cvmDir(cwd), "objects", fp.slice(0, 2), `${fp.slice(2)}.br`);
}

/** Store content; returns its fingerprint. No-op if already stored. */
export function coldPut(cwd: string, content: string | Buffer): string {
  const fp = fingerprint(content);
  const file = objectPath(cwd, fp);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const compressed = zlib.brotliCompressSync(
      typeof content === "string" ? Buffer.from(content, "utf-8") : content,
      { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
    );
    // Write via temp + rename so a crash never leaves a truncated object.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, compressed);
    fs.renameSync(tmp, file);
  }
  return fp;
}

/** Load content by fingerprint, or undefined if not stored. */
export function coldGet(cwd: string, fp: string): string | undefined {
  try {
    const compressed = fs.readFileSync(objectPath(cwd, fp));
    return zlib.brotliDecompressSync(compressed).toString("utf-8");
  } catch {
    return undefined;
  }
}

export function coldHas(cwd: string, fp: string): boolean {
  return fs.existsSync(objectPath(cwd, fp));
}

/** Total objects and compressed bytes, for /cvm stats. */
export function coldStats(cwd: string): { objects: number; bytes: number } {
  const root = path.join(cvmDir(cwd), "objects");
  let objects = 0;
  let bytes = 0;
  try {
    for (const shard of fs.readdirSync(root)) {
      const dir = path.join(root, shard);
      for (const f of fs.readdirSync(dir)) {
        objects++;
        bytes += fs.statSync(path.join(dir, f)).size;
      }
    }
  } catch {
    /* no objects yet */
  }
  return { objects, bytes };
}

export interface ColdPruneOptions {
  /** Objects older than this (by mtime) become eligible for deletion,
   *  unless their fingerprint is in `liveFps`. Default 14 days. */
  maxAgeMs?: number;
  /** Hard cap on total retained bytes; if still over budget after the
   *  age pass, oldest eligible objects are removed next. Default 200MB. */
  maxBytes?: number;
  /** Fingerprints that must never be deleted — e.g. still referenced by an
   *  unexpired warm-store http row (see WarmStore.httpAllFps). Objects
   *  outside this set (like Quiet Output artifact stashes, which have no
   *  persistent index) are reclaimed purely by age/size, which is why the
   *  default maxAgeMs is generous — it's the only safety margin they get. */
  liveFps?: ReadonlySet<string>;
}

/** Reclaim disk space: cold objects accumulate forever otherwise (nothing
 *  else in the CVM ever deletes them). Two passes — age first, then size
 *  cap if still over budget — both skip anything in `liveFps`. */
export function coldPrune(cwd: string, opts: ColdPruneOptions = {}): { deleted: number; bytesFreed: number } {
  const maxAgeMs = opts.maxAgeMs ?? 14 * 24 * 60 * 60_000;
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const liveFps = opts.liveFps ?? new Set<string>();
  const root = path.join(cvmDir(cwd), "objects");
  const now = Date.now();

  interface Obj { file: string; fp: string; mtime: number; size: number }
  const objs: Obj[] = [];
  try {
    for (const shard of fs.readdirSync(root)) {
      const dir = path.join(root, shard);
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        const st = fs.statSync(file);
        objs.push({ file, fp: shard + f.replace(/\.br$/, ""), mtime: st.mtimeMs, size: st.size });
      }
    }
  } catch {
    return { deleted: 0, bytesFreed: 0 };
  }

  let deleted = 0;
  let bytesFreed = 0;
  const survivors: Obj[] = [];
  for (const o of objs) {
    if (!liveFps.has(o.fp) && now - o.mtime > maxAgeMs) {
      try {
        fs.unlinkSync(o.file);
        deleted++;
        bytesFreed += o.size;
      } catch {
        /* already gone */
      }
    } else {
      survivors.push(o);
    }
  }

  let totalBytes = survivors.reduce((s, o) => s + o.size, 0);
  if (totalBytes > maxBytes) {
    survivors.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const o of survivors) {
      if (totalBytes <= maxBytes) break;
      if (liveFps.has(o.fp)) continue;
      try {
        fs.unlinkSync(o.file);
        deleted++;
        bytesFreed += o.size;
        totalBytes -= o.size;
      } catch {
        /* already gone */
      }
    }
  }

  return { deleted, bytesFreed };
}
