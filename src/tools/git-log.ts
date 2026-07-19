// git_log — structured git history tools.
// Show recent commits, blame a file:line, show who last touched a file, and
// find the commit that introduced a change.

import { Type } from "typebox";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate } from "../lib/shared.ts";

// ── types ───────────────────────────────────────────────────────────────────

interface Commit {
  hash: string;
  date: string;
  author: string;
  message: string;
}

function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  // %H = full hash, %ad = date, %an = author, %s = subject
  const lines = stdout.trim().split("\n");
  for (const line of lines) {
    const parts = line.split("|", 4);
    if (parts.length >= 4) {
      commits.push({
        hash: parts[0]!.trim().slice(0, 8),
        date: parts[1]!.trim(),
        author: parts[2]!.trim(),
        message: parts[3]!.trim(),
      });
    }
  }
  return commits;
}

function checkGit(cwd: string): void {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });
  } catch {
    throw new Error("Not a git repository (or git not installed).");
  }
}

// ── register ─────────────────────────────────────────────────────────────────

export function registerGitLog(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "git_log",
    label: "Git History",
    description:
      "Show recent git commits, blame a specific file:line to see who last " +
      "changed it, or show commits touching a specific file. Useful for " +
      "understanding code history and ownership before refactoring.",
    promptSnippet: "show git history, blame, or file history",
    promptGuidelines: [
      "Use before refactoring a function: git_log --blame the file to see who wrote it and when.",
      "Use git_log --file to see recent changes to a specific module.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "One of: 'log' (recent commits), 'blame' (who changed a file:line), 'file' (commits touching a file).",
        default: "log",
      }),
      file_path: Type.Optional(
        Type.String({ description: "File path for blame or file-history (relative to cwd)." }),
      ),
      line: Type.Optional(
        Type.Number({ description: "Line number for blame (1-based)." }),
      ),
      count: Type.Optional(
        Type.Number({ description: "Number of commits to show (default 20)." }),
      ),
      author: Type.Optional(
        Type.String({ description: "Filter by author name/email." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      checkGit(ctx.cwd);
      const action = (params.action as string) ?? "log";
      const count = (params.count as number) ?? 20;
      const format = "--format=%H|%ad|%an|%s";
      const dateOpts = "--date=short";

      if (action === "blame") {
        if (!params.file_path) throw new Error("'file_path' is required for blame.");
        const target = params.line
          ? `${params.file_path}#L${params.line}`
          : params.file_path as string;
        try {
          const stdout = execSync(`git log ${format} ${dateOpts} -n 1 -- "${params.file_path}"`, {
            cwd: ctx.cwd, encoding: "utf8",
          });
          const blame = execSync(`git blame -L ${params.line ?? 1},${params.line ?? 1} -- "${params.file_path}"`, {
            cwd: ctx.cwd, encoding: "utf8",
          });
          const lastCommit = parseLog(stdout)[0];
          return text(
            `Blame for ${target}:\n${blame.trim()}\n\nLast commit: ${lastCommit?.hash} ${lastCommit?.author} — ${lastCommit?.message}`,
            { action: "blame", file: params.file_path, line: params.line, commit: lastCommit },
          );
        } catch (e: any) {
          throw new Error(`git blame failed: ${e.message}`);
        }
      }

      if (action === "file") {
        if (!params.file_path) throw new Error("'file_path' is required for file history.");
        const authFilter = params.author ? `--author="${params.author}"` : "";
        const stdout = execSync(
          `git log ${format} ${dateOpts} ${authFilter} -n ${count} -- "${params.file_path}"`,
          { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 1024 * 1024 },
        );
        const commits = parseLog(stdout);
        if (commits.length === 0) {
          return text(`No commits found for ${params.file_path}.`);
        }
        return text(
          `Recent commits for ${params.file_path} (${commits.length}):\n` +
          commits.map((c) => `  ${c.hash} ${c.date} ${c.author}  ${c.message}`).join("\n"),
          { action: "file", file: params.file_path, count: commits.length },
        );
      }

      // Default: log
      const authFilter = params.author ? `--author="${params.author}"` : "";
      const fileFilter = params.file_path ? `-- "${params.file_path}"` : "";
      const stdout = execSync(
        `git log ${format} ${dateOpts} ${authFilter} -n ${count} ${fileFilter}`,
        { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      const commits = parseLog(stdout);
      if (commits.length === 0) {
        return text("No commits found.");
      }
      return text(
        truncate(
          `Last ${commits.length} commits:\n` +
          commits.map((c) => `  ${c.hash} ${c.date} ${c.author}  ${c.message}`).join("\n"),
        ),
        { action: "log", count: commits.length },
      );
    },
    renderCall(args, theme, _context) {
      const action = (args.action as string) ?? "log";
      let t = theme.fg("toolTitle", theme.bold(`git_log ${action}`));
      if (args.file_path) t += theme.fg("dim", ` ${args.file_path as string}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      const action = d?.action ?? "?";
      const count = d?.count;
      let summary = theme.fg("success", "✓ ") + theme.fg("muted", `git ${action}`);
      if (typeof count === "number") summary += theme.fg("dim", ` (${count})`);
      if (expanded) {
        summary += "\n" + theme.fg("dim", firstText(result).split("\n").slice(0, 12).join("\n"));
      }
      return new Text(summary, 0, 0);
    },
  });
}
