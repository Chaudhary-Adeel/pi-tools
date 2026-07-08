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
