// Small helpers shared across tools. No external deps — Node builtins only.

import type { ToolResult } from "@earendil-works/pi-coding-agent";

/** Wrap plain text into the ToolResult shape Pi expects. */
export function text(s: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: s }], details };
}

/** An error result. Prefer `throw new Error(...)` inside execute(), which Pi
 *  turns into an error result automatically; use this when you want to return
 *  a soft failure the model can recover from without aborting the turn. */
export function errorText(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
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
