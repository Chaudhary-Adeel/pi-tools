// lint — run the project's linter and return structured error/warning output.
// Auto-detects ESLint, Ruff (Python), Clippy (Rust), golangci-lint (Go).

import { Type } from "typebox";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, exists } from "../lib/shared.ts";

interface Framework {
  name: string;
  cmd: string;
  fixCmd?: string;
  parse: (stdout: string, stderr: string, cwd: string) => LintResults;
}

interface LintResults {
  errors: number;
  warnings: number;
  total: number;
  items: { file: string; line?: number; col?: number; severity: string; message: string }[];
}

function guessLinter(cwd: string): Framework | null {
  if (exists(path.join(cwd, "node_modules/.bin/eslint"))) {
    return {
      name: "ESLint",
      cmd: "npx eslint . --format stylish",
      fixCmd: "npx eslint . --fix",
      parse: parseESLint,
    };
  }
  if (exists(path.join(cwd, ".eslintrc")) || exists(path.join(cwd, ".eslintrc.js")) || exists(path.join(cwd, "eslint.config.js")) || exists(path.join(cwd, "eslint.config.mjs"))) {
    return { name: "ESLint", cmd: "npx eslint . --format stylish", fixCmd: "npx eslint . --fix", parse: parseESLint };
  }
  if (exists(path.join(cwd, "pyproject.toml")) || exists(path.join(cwd, "ruff.toml")) || exists(path.join(cwd, ".ruff.toml"))) {
    return { name: "Ruff", cmd: "ruff check .", fixCmd: "ruff check --fix .", parse: parseRuff };
  }
  if (exists(path.join(cwd, "Cargo.toml"))) {
    return { name: "Clippy", cmd: "cargo clippy --message-format short", parse: parseClippy };
  }
  if (exists(path.join(cwd, "go.mod"))) {
    return { name: "golangci-lint", cmd: "golangci-lint run ./...", parse: parseGolangci };
  }
  return null;
}

function parseESLint(stdout: string, _: string, cwd: string): LintResults {
  const results: LintResults = { errors: 0, warnings: 0, total: 0, items: [] };
  // ESLint stylish: /path/to/file.js
  //   1:5  error    Message  rule-name
  //   3:10 warning  Message  rule-name
  const lines = stdout.split("\n");
  let currentFile = "";
  for (const line of lines) {
    const fileMatch = /^(.+\.(js|ts|jsx|tsx|vue|svelte))$/i.exec(line.trim());
    if (fileMatch) {
      currentFile = path.relative(cwd, fileMatch[1]!).replace(/\\/g, "/");
      continue;
    }
    const issueRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/;
    const m = issueRe.exec(line);
    if (m) {
      const severity = m[3]!;
      results.items.push({
        file: currentFile,
        line: parseInt(m[1]!),
        col: parseInt(m[2]!),
        severity,
        message: `${m[4]!.trim()} [${m[5]!.trim()}]`,
      });
      if (severity === "error") results.errors++;
      else results.warnings++;
      results.total++;
    }
  }
  return results;
}

function parseRuff(stdout: string, _: string, cwd: string): LintResults {
  const results: LintResults = { errors: 0, warnings: 0, total: 0, items: [] };
  const lines = stdout.split("\n");
  for (const line of lines) {
    // file.py:10:5: E501 Line too long
    const m = /^(.+):(\d+):(\d+):\s+(\w+)\s+(.+)$/.exec(line.trim());
    if (m) {
      results.items.push({
        file: path.relative(cwd, m[1]!).replace(/\\/g, "/"),
        line: parseInt(m[2]!),
        col: parseInt(m[3]!),
        severity: "error",
        message: `${m[4]} ${m[5]}`,
      });
      results.errors++;
      results.total++;
    }
  }
  return results;
}

function parseClippy(stdout: string, _: string, cwd: string): LintResults {
  const results: LintResults = { errors: 0, warnings: 0, total: 0, items: [] };
  const lines = stdout.split("\n");
  for (const line of lines) {
    // src/main.rs:10:5: warning: message
    // src/main.rs:10:5: error: message
    const m = /^(.+\.rs):(\d+):(\d+):\s+(warning|error):\s+(.+)$/.exec(line.trim());
    if (m) {
      const severity = m[4]!;
      results.items.push({
        file: path.relative(cwd, m[1]!).replace(/\\/g, "/"),
        line: parseInt(m[2]!),
        col: parseInt(m[3]!),
        severity,
        message: m[5]!,
      });
      if (severity === "error") results.errors++;
      else results.warnings++;
      results.total++;
    }
  }
  return results;
}

function parseGolangci(stdout: string, _: string, cwd: string): LintResults {
  const results: LintResults = { errors: 0, warnings: 0, total: 0, items: [] };
  const lines = stdout.split("\n");
  for (const line of lines) {
    // file.go:10:5: message (linter_name)
    const m = /^(.+\.go):(\d+):(\d+):\s+(.+)$/.exec(line.trim());
    if (m) {
      results.items.push({
        file: path.relative(cwd, m[1]!).replace(/\\/g, "/"),
        line: parseInt(m[2]!),
        col: parseInt(m[3]!),
        severity: "warning",
        message: m[4]!,
      });
      results.warnings++;
      results.total++;
    }
  }
  return results;
}

// ── register ─────────────────────────────────────────────────────────────────

export function registerLint(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "lint",
    label: "Lint",
    description:
      "Run the project's linter and return structured error/warning output " +
      "with file:line:message locations. Auto-detects ESLint, Ruff, Clippy, golangci-lint. " +
      "Supports --fix for auto-fixable issues.",
    promptSnippet: "run the linter and report issues",
    promptGuidelines: [
      "Run after code changes to catch style/quality issues before committing.",
      "Use --fix to auto-correct fixable issues.",
    ],
    parameters: Type.Object({
      fix: Type.Optional(
        Type.Boolean({ description: "Auto-fix fixable issues (default false)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const framework = guessLinter(cwd);

      if (!framework) {
        return text(
          "No supported linter detected. Supported: ESLint, Ruff, Clippy, golangci-lint. " +
          "Install one or use bash to run lint manually.",
          { framework: "unknown" },
        );
      }

      const cmd = params.fix && framework.fixCmd ? framework.fixCmd : framework.cmd;

      let stdout = "";
      let stderr = "";
      try {
        stdout = execSync(cmd, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
      } catch (e: any) {
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
        // Linters exit non-zero when issues found — that's expected
      }

      const results = framework.parse(stdout, stderr, cwd);

      if (results.total === 0) {
        return text("No lint issues found.", { framework: framework.name, ...results });
      }

      const details = results.items
        .slice(0, 30)
        .map((i) => `  ${i.severity === "error" ? "✗" : "⚠"} ${i.file}${i.line ? `:${i.line}` : ""}  ${i.message}`)
        .join("\n");

      return text(
        truncate(`${results.errors} error(s), ${results.warnings} warning(s), ${results.total} total.\n\n${details}`),
        { framework: framework.name, ...results },
      );
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("lint"));
      if (args.fix) t += theme.fg("dim", " --fix");
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      const errors = (d?.errors as number) ?? 0;
      const warnings = (d?.warnings as number) ?? 0;
      const total = (d?.total as number) ?? 0;
      if (total === 0) return new Text(theme.fg("success", "✓ Lint clean"), 0, 0);
      let summary = errors > 0
        ? theme.fg("error", `✗ ${errors} error(s)`)
        : theme.fg("success", "✓ No errors");
      if (warnings) summary += ` ${theme.fg("warning", `${warnings} warning(s)`)}`;
      summary += theme.fg("dim", ` (${d?.framework ?? "?"})`);
      return new Text(summary, 0, 0);
    },
  });
}
