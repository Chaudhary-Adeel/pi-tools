// github_explore — explore GitHub repositories for code references.
//
// Uses the public GitHub REST API (api.github.com) with zero dependencies.
// Set GITHUB_TOKEN (or GH_TOKEN) for higher rate limits and private-repo
// access. Actions:
//   search_code   find code across GitHub (or scoped to a repo)
//   search_repos  find repositories by topic/keywords
//   list_tree     list a repository's file tree
//   read_file     read one file from a repository
//
// Designed for progressive code understanding: search for a symbol first,
// then read only the files that matter.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate } from "../lib/shared.ts";
import { cachedFetch } from "../cvm/http-cache.ts";

const API = "https://api.github.com";

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pi-tools-github-explore",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Routed through the CVM HTTP cache: GitHub sends strong ETags, so repeat
// queries revalidate for free (304s also don't count against rate limits).
async function ghGet(cwd: string, path: string, signal?: AbortSignal, ttlMs = 5 * 60_000): Promise<unknown> {
  const res = await cachedFetch(cwd, `${API}${path}`, { headers: ghHeaders(), signal, ttlMs });
  if (res.status < 200 || res.status >= 300) {
    const hint =
      res.status === 403 && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN
        ? " (rate-limited — set GITHUB_TOKEN for higher limits)"
        : "";
    throw new Error(`GitHub API ${res.status} for ${path}${hint}: ${res.body.slice(0, 200)}`);
  }
  return JSON.parse(res.body);
}

function requireRepo(repo?: string): { owner: string; name: string } {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo ?? "");
  if (!m) throw new Error(`'repo' must be "owner/name", got: ${repo ?? "(missing)"}`);
  return { owner: m[1]!, name: m[2]! };
}

export function registerGitHubExploreTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "github_explore",
    label: "GitHub Explore",
    description:
      "Explore GitHub repositories to find code references and examples. " +
      "Actions: 'search_code' (query, optional repo to scope), 'search_repos' " +
      "(query), 'list_tree' (repo, optional dir path), 'read_file' (repo + " +
      "path, optional ref). Use search first, then read only relevant files. " +
      "Set GITHUB_TOKEN for higher rate limits.",
    promptSnippet: "search and read code in GitHub repositories",
    promptGuidelines: [
      "Use github_explore to find real-world usage of an API before writing code against it: search_code for the symbol, then read_file the best hits.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("search_code"),
          Type.Literal("search_repos"),
          Type.Literal("list_tree"),
          Type.Literal("read_file"),
        ],
        { description: "What to do." },
      ),
      query: Type.Optional(
        Type.String({
          description:
            "For search_code/search_repos: the search terms (GitHub search syntax allowed).",
        }),
      ),
      repo: Type.Optional(
        Type.String({
          description: "Repository as owner/name. Required for list_tree and read_file; scopes search_code.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "For read_file: file path in the repo. For list_tree: directory prefix filter.",
        }),
      ),
      ref: Type.Optional(
        Type.String({ description: "Branch, tag, or commit SHA (default: default branch)." }),
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Cap results for searches/tree (default 20)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const max = Math.min(50, Math.max(1, params.max_results ?? 20));

      switch (params.action) {
        case "search_code": {
          if (!params.query) throw new Error("'search_code' needs a query.");
          const q = params.repo ? `${params.query} repo:${params.repo}` : params.query;
          const data = (await ghGet(ctx.cwd,
            `/search/code?q=${encodeURIComponent(q)}&per_page=${max}`,
            signal,
          )) as { total_count: number; items: Array<{ repository: { full_name: string }; path: string; html_url: string }> };
          if (data.items.length === 0) return text(`No code results for: ${q}`);
          const body = data.items
            .map((it, i) => `${i + 1}. ${it.repository.full_name} — ${it.path}\n   ${it.html_url}`)
            .join("\n");
          return text(
            `${data.total_count} code result(s) for "${q}" (showing ${data.items.length}):\n\n${body}\n\nUse read_file with repo+path to inspect a hit.`,
            { total: data.total_count, shown: data.items.length },
          );
        }

        case "search_repos": {
          if (!params.query) throw new Error("'search_repos' needs a query.");
          const data = (await ghGet(ctx.cwd,
            `/search/repositories?q=${encodeURIComponent(params.query)}&per_page=${max}`,
            signal,
          )) as { total_count: number; items: Array<{ full_name: string; description: string | null; stargazers_count: number; language: string | null }> };
          if (data.items.length === 0) return text(`No repositories for: ${params.query}`);
          const body = data.items
            .map(
              (r, i) =>
                `${i + 1}. ${r.full_name} ★${r.stargazers_count}${r.language ? ` (${r.language})` : ""}\n   ${r.description ?? ""}`.trimEnd(),
            )
            .join("\n");
          return text(
            `${data.total_count} repositories for "${params.query}" (showing ${data.items.length}):\n\n${body}`,
            { total: data.total_count, shown: data.items.length },
          );
        }

        case "list_tree": {
          const { owner, name } = requireRepo(params.repo);
          const ref =
            params.ref ??
            ((await ghGet(ctx.cwd, `/repos/${owner}/${name}`, signal)) as { default_branch: string }).default_branch;
          const data = (await ghGet(ctx.cwd,
            `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
            signal,
          )) as { truncated: boolean; tree: Array<{ path: string; type: string; size?: number }> };
          const prefix = params.path?.replace(/^\/+|\/+$/g, "");
          let files = data.tree.filter((e) => e.type === "blob");
          if (prefix) files = files.filter((e) => e.path.startsWith(prefix));
          const shown = files.slice(0, Math.max(max, 100));
          const body = shown.map((e) => e.path).join("\n");
          const note = data.truncated || files.length > shown.length ? "\n… (truncated)" : "";
          return text(`${owner}/${name}@${ref} — ${files.length} file(s):\n\n${body}${note}`, {
            count: files.length,
            shown: shown.length,
            ref,
          });
        }

        case "read_file": {
          const { owner, name } = requireRepo(params.repo);
          if (!params.path) throw new Error("'read_file' needs a path.");
          const refQ = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
          const data = (await ghGet(ctx.cwd,
            `/repos/${owner}/${name}/contents/${params.path
              .split("/")
              .map(encodeURIComponent)
              .join("/")}${refQ}`,
            signal,
          )) as { type: string; encoding?: string; content?: string; size: number; html_url: string };
          if (data.type !== "file" || !data.content) {
            throw new Error(`${params.path} is not a readable file (type: ${data.type}).`);
          }
          const decoded = Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf-8");
          const numbered = decoded
            .split("\n")
            .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
            .join("\n");
          return text(
            `${owner}/${name} — ${params.path} (${data.size} bytes)\n${data.html_url}\n\n${truncate(numbered)}`,
            { size: data.size, path: params.path },
          );
        }

        default:
          throw new Error(`Unknown action: ${String(params.action)}`);
      }
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("github_explore "));
      t += theme.fg("muted", (args.action as string) ?? "?");
      const target = (args.repo as string) ?? (args.query as string) ?? "";
      if (target) t += theme.fg("dim", ` ${target}`);
      if (args.path) t += theme.fg("dim", ` ${args.path as string}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      const shown = (d?.shown as number) ?? (d?.count as number);
      let summary = theme.fg("success", "✓ ");
      summary += theme.fg("muted", shown != null ? `${shown} item(s)` : "done");
      if (expanded) {
        const head = firstText(result).split("\n").slice(0, 12).join("\n");
        summary += "\n" + theme.fg("dim", head);
      }
      return new Text(summary, 0, 0);
    },
  });
}
