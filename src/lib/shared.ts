// Small helpers shared across tools. No external deps — Node builtins only.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Result shape returned by tool execute() — `details` is required in Pi ≥0.80. */
export type ToolResult = AgentToolResult<unknown>;

// ── SSRF: shared private/reserved-IP matcher (used by web_fetch + browser) ──

const PRIVATE_IPV4 = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
];

/** True if `hostname` is a private, loopback, link-local, or reserved IP literal. */
export function isPrivateHost(hostname: string): boolean {
  // URL.prototype.hostname keeps brackets around IPv6 literals ("[::1]") —
  // strip them so callers passing a raw `new URL(...).hostname` still match.
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  for (const re of PRIVATE_IPV4) {
    if (re.test(h)) return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (h === "::1" || h === "::") return true;
  if (/^fc[0-9a-f]{2}:/i.test(h)) return true; // fc00::/7
  if (/^fd[0-9a-f]{2}:/i.test(h)) return true; // fd00::/8
  if (/^fe80:/i.test(h)) return true;           // fe80::/10
  return false;
}

/** Wrap plain text into the AgentToolResult shape Pi expects. */
export function text(s: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: s }], details };
}

/** First text block of a tool result, for renderResult() implementations.
 *  Content items are a TextContent | ImageContent union in Pi ≥0.80, so
 *  renderers must narrow before touching `.text`. */
export function firstText(result: AgentToolResult<unknown>, fallback = ""): string {
  for (const part of result.content) {
    if (part.type === "text") return part.text;
  }
  return fallback;
}

/** Format byte counts into human-readable strings. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Truncate long output so a single tool call can't blow the context window.
 *  Keeps head + tail, which is what's usually useful (start of a file / file
 *  listing, plus the tail of command output where errors live). */
export function truncate(s: string, max = 30_000): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.25));
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n... [${omitted.toLocaleString()} characters truncated] ...\n\n${tail}`;
}

/** Strip HTML to roughly-readable text. Good enough for feeding a page to the
 *  model; not a full DOM parser. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Jaccard similarity over word sets (words >2 chars, case-insensitive).
 *  0 = disjoint, 1 = identical vocabulary. Used for lightweight duplicate
 *  detection (memory learnings, descriptions) — not a semantic embedding,
 *  just word overlap, which is enough to catch near-identical prose. */
export function jaccardWordSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsA = words(a);
  const wordsB = words(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

/** Convert a glob pattern (supports **, *, ?) into a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        re += "[^]*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash after **
      } else {
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else if (c === "/") {
      re += "[/\\\\]"; // match either separator (Windows + POSIX)
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

/** Repository name for the current working directory: the basename of the
 *  origin remote URL when set, else the git toplevel dir, else the cwd. */
export function getRepoName(cwd: string): string {
  const run = (cmd: string): string | undefined => {
    try {
      return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const remote = run("git remote get-url origin");
  if (remote) {
    const base = remote.split("/").pop() ?? remote;
    return base.replace(/\.git$/, "");
  }
  const toplevel = run("git rev-parse --show-toplevel");
  return path.basename(toplevel ?? cwd);
}

/** Resolve how to invoke the `pi` CLI for spawning subprocesses.
 *  Mirrors the logic used by the subagent spawner so distillation can reuse it. */
export function getPiCommand(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  // Bun virtual scripts point into $bunfs — not useful for spawning.
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGeneric = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGeneric) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

/** Check if a path exists (sync, lightweight). */
export function exists(p: string): boolean {
  try { fs.accessSync(p, fs.constants.F_OK); return true } catch { return false }
}

