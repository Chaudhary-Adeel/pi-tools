// web_fetch + web_search
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, htmlToText, formatBytes } from "../lib/shared.ts";
import { cachedFetch } from "../cvm/http-cache.ts";
import { deltaCheck, deltaRecord } from "../cvm/delta.ts";

const UA =
  "Mozilla/5.0 (compatible; pi-coding-toolkit/0.1; +https://pi.dev)";

// ── SSRF protection ──────────────────────────────────────────────────────────

const PRIVATE_IPV4 = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
];

function isPrivateHost(hostname: string): boolean {
  for (const re of PRIVATE_IPV4) {
    if (re.test(hostname)) return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (hostname === "::1" || hostname === "::") return true;
  if (/^fc[0-9a-f]{2}:/i.test(hostname)) return true; // fc00::/7
  if (/^fd[0-9a-f]{2}:/i.test(hostname)) return true; // fd00::/8
  if (/^fe80:/i.test(hostname)) return true;           // fe80::/10
  return false;
}

/** Validate a URL for SSRF — returns null if OK, error message string if blocked. */
function validateUrl(rawUrl: string): string | null {
  if (!/^https?:\/\//i.test(rawUrl)) {
    return `Refusing to fetch non-http(s) URL: ${rawUrl}`;
  }
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  if (isPrivateHost(hostname)) {
    return `Refusing to fetch URL targeting private/reserved IP: ${hostname}`;
  }
  return null;
}

export function registerWebTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_fetch",
    label: "Fetch URL",
    description:
      "Fetch a URL over HTTP(S) and return its readable text content. " +
      "Use for reading docs, articles, API responses, or any single web page.",
    promptSnippet: "fetch a web page or HTTP resource as text",
    promptGuidelines: [
      "It strips HTML to plain text and truncates very large pages — ask for a narrower URL if you need a specific section.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL to fetch." }),
      max_chars: Type.Optional(
        Type.Number({
          description: "Max characters to return (default 30000).",
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "If true, return the raw body without HTML-to-text conversion " +
            "(useful for JSON/XML/plaintext endpoints).",
        }),
      ),
      force_full: Type.Optional(
        Type.Boolean({
          description:
            "Return full content even if this URL was already fetched " +
            "unchanged (use after compaction, when it's no longer in context).",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { url, max_chars, raw } = params;
      const urlError = validateUrl(url);
      if (urlError) throw new Error(urlError);
      // CVM HTTP cache: fresh copies skip the network entirely; stale ones
      // revalidate with ETag/Last-Modified and 304s cost no download.
      let res: Awaited<ReturnType<typeof cachedFetch>>;
      try {
        res = await cachedFetch(ctx.cwd, url, {
          headers: { "User-Agent": UA, Accept: "*/*" },
          signal,
          ttlMs: 5 * 60_000,
        });
      } catch (e) {
        throw new Error(`Network error fetching ${url}: ${(e as Error).message}`);
      }
      const ct = res.contentType;
      const body = res.body;
      const isHtml = /text\/html|application\/xhtml/i.test(ct);
      const out = raw || !isHtml ? body : htmlToText(body);
      const finalText = truncate(out, max_chars ?? 30_000);
      const cacheNote = res.source === "network" ? "" : ` [cvm: ${res.source}]`;
      const header = `HTTP ${res.status}${cacheNote} — ${url}\nContent-Type: ${ct}\n\n`;
      const details = {
        status: res.status,
        contentType: ct,
        finalUrl: res.finalUrl,
        charCount: finalText.length,
        byteCount: body.length,
        isHtml,
        raw: raw ?? false,
        cacheSource: res.source,
      };

      // Delta mode: an unchanged page the model already saw becomes a stub.
      const deltaKey = `web:${url}:${raw ? "raw" : "text"}:${max_chars ?? 30_000}`;
      if (!params.force_full) {
        const delta = deltaCheck(deltaKey, finalText);
        if (delta.kind === "unchanged") return text(header + delta.stub, { ...details, delta: "unchanged" });
        if (delta.kind === "diff") return text(header + delta.diff, { ...details, delta: "diff" });
      } else {
        deltaRecord(deltaKey, finalText);
      }
      return text(header + finalText, details);
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("web_fetch "));
      t += theme.fg("muted", args.url as string);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
      const d = result.details as Record<string, unknown> | undefined;
      if (d?.status && (d.status as number) >= 400) {
        return new Text(
          theme.fg("error", `✗ HTTP ${d.status} — ${d.finalUrl as string}`),
          0, 0,
        );
      }
      const url = (d?.finalUrl as string) ?? "?";
      const chars = d?.charCount as number | undefined;
      const bytes = d?.byteCount as number | undefined;
      const ct = (d?.contentType as string) ?? "";
      const isHtml = d?.isHtml as boolean | undefined;
      const kind = isHtml ? "html→text" : ct.split(";")[0] || "unknown";
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", url);
      summary += "  " + theme.fg("dim", `${formatBytes(bytes ?? chars ?? 0)}`);
      summary += "  " + theme.fg("dim", kind);
      if (expanded) {
        const preview = firstText(result);
        const head = preview.split("\n").slice(0, 6).join("\n");
        if (head.length < preview.length) {
          summary += "\n" + theme.fg("dim", head) + "\n" + theme.fg("dim", "…");
        } else {
          summary += "\n" + theme.fg("dim", head);
        }
      }
      return new Text(summary, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return a ranked list of result titles, URLs and " +
      "snippets. Follow up with web_fetch to read a result in full.",
    promptSnippet: "search the web for current information",
    promptGuidelines: [
      "Use web_search when you need information you don't have or that may have changed recently.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      max_results: Type.Optional(
        Type.Number({ description: "How many results to return (default 8)." }),
      ),
    }),
    async execute(_id, params, signal) {
      const max = params.max_results ?? 8;
      const results = await search(params.query, max, signal);
      if (results.length === 0) {
        return text(`No results for: ${params.query}`);
      }
      const body = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}${
              r.snippet ? `\n   ${r.snippet}` : ""
            }`,
        )
        .join("\n\n");
      return text(`Search results for "${params.query}":\n\n${body}`, {
        results,
        query: params.query,
      });
    },
    renderCall(args, theme, _context) {
      const q = (args.query as string) ?? "?";
      let t = theme.fg("toolTitle", theme.bold("web_search "));
      t += theme.fg("muted", `"${q}"`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const d = result.details as Record<string, unknown> | undefined;
      const results = d?.results as SearchResult[] | undefined;
      const count = results?.length ?? 0;
      if (count === 0) {
        return new Text(theme.fg("dim", "No results"), 0, 0);
      }
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `${count} result(s)`);
      if (expanded && results) {
        for (const r of results) {
          summary += "\n  " + theme.fg("accent", r.title);
          summary += "  " + theme.fg("dim", r.url);
        }
      }
      return new Text(summary, 0, 0);
    },
  });
}

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** Search backend. Prefers Tavily if TAVILY_API_KEY is set (better quality),
 *  otherwise falls back to a keyless DuckDuckGo HTML scrape. */
async function search(
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: max,
        }),
        signal,
      });
      const data = (await res.json()) as {
        results?: { title: string; url: string; content?: string }[];
      };
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      }));
    } catch {
      // fall through to DDG
    }
  }
  return duckDuckGo(query, max, signal);
}

async function duckDuckGo(
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  const html = await res.text();
  const results: SearchResult[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < max) {
    let url = decodeDdgUrl(m[1]);
    const title = htmlToTextInline(m[2]);
    if (url && title) results.push({ title, url });
  }
  // Best-effort snippets
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let s: RegExpExecArray | null;
  let idx = 0;
  while ((s = snipRe.exec(html)) && idx < results.length) {
    results[idx].snippet = htmlToTextInline(s[1]);
    idx++;
  }
  return results;
}

function decodeDdgUrl(href: string): string {
  // DDG wraps targets like //duckduckgo.com/l/?uddg=<encoded>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  return href.startsWith("//") ? "https:" + href : href;
}

function htmlToTextInline(s: string): string {
  return htmlToText(s).replace(/\s+/g, " ").trim();
}
