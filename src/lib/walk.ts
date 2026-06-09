// Dependency-free recursive directory walk with sensible ignores.
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".pi",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface WalkOptions {
  /** Extra directory names to skip. */
  ignore?: string[];
  /** Stop after this many files (safety valve). */
  limit?: number;
}

/** Yields absolute file paths under `root`, skipping common noise dirs. */
export async function* walk(
  root: string,
  opts: WalkOptions = {},
): AsyncGenerator<string> {
  const ignore = new Set([...DEFAULT_IGNORES, ...(opts.ignore ?? [])]);
  let count = 0;
  const limit = opts.limit ?? 50_000;

  async function* recurse(dir: string): AsyncGenerator<string> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently
    }
    for (const e of entries) {
      if (count >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        yield* recurse(full);
      } else if (e.isFile()) {
        count++;
        yield full;
      }
    }
  }

  yield* recurse(root);
}
