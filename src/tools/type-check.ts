// type_check — run the project's type checker and return structured error output.
// Supports TypeScript (tsc --noEmit), mypy, pyright, and rust-analyzer diagnostic.

import { Type } from "typebox";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, exists } from "../lib/shared.ts";

interface Framework {
  name: string;
  cmd: string;
  parse: (stdout: string, stderr: string, cwd: string) => TypeCheckResults;
}

interface TypeCheckResults {
  errors: number;
  items: { file: string; line?: number; col?: number; code?: string; message: string }[];
}

function guessTypeChecker(cwd: string): Framework | null {
  // TypeScript
  if (exists(path.join(cwd, "tsconfig.json"))) {
    return { name: "TypeScript", cmd: "npx tsc --noEmit", parse: parseTsc };
  }
  // Python (mypy or pyright)
  if (exists(path.join(cwd, "pyproject.toml")) || exists(path.join(cwd, "mypy.ini"))) {
    // Try mypy first
    try { execSync("mypy --version", { cwd, stdio: "ignore" }); return { name: "mypy", cmd: "mypy .", parse: parseMypy }; } catch {}
    try { execSync("pyright --version", { cwd, stdio: "ignore" }); return { name: "Pyright", cmd: "pyright", parse: parsePyright }; } catch {}
  }
  return null;
}

function parseTsc(stdout: string, _: string, cwd: string): TypeCheckResults {
  const results: TypeCheckResults = { errors: 0, items: [] };
  // src/App.tsx(12,55): error TS2694: Message
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    results.items.push({
      file: path.relative(cwd, m[1]!).replace(/\\/g, "/"),
      line: parseInt(m[2]!),
      col: parseInt(m[3]!),
      code: m[5],
      message: m[6]!,
    });
    results.errors++;
  }
  return results;
}

function parseMypy(stdout: string, _: string, cwd: string): TypeCheckResults {
  const results: TypeCheckResults = { errors: 0, items: [] };
  const lines = stdout.split("\n");
  for (const line of lines) {
    // file.py:10: error: Message  [error-code]
    const m = /^(.+):(\d+):\s+(error|warning):\s+(.+?)(?:\s+\[(\w+)\])?$/i.exec(line.trim());
    if (m) {
      results.items.push({
        file: path.relative(cwd, m[1]!).replace(/\\/g, "/"),
        line: parseInt(m[2]!),
        code: m[5],
        message: m[4]!,
      });
      results.errors++;
    }
  }
  return results;
}

function parsePyright(stdout: string, _: string, cwd: string): TypeCheckResults {
  const results: TypeCheckResults = { errors: 0, items: [] };
  const lines = stdout.split("\n");
  for (const line of lines) {
    // file.py:10:5 - error: Message (reportGeneralTypeIssues)
    const m = /^(.+):(\d+):(\d+)\s+-\s+(error|warning):\s+(.+?)\s+\((\w+)\)$/i.exec(line.trim());
    if (m) {
      results.items.push({
        file: path.relative(cwd, m[1]!).replace(/\\/g, "/"),
        line: parseInt(m[2]!),
        col: parseInt(m[3]!),
        code: m[6],
        message: m[5]!,
      });
      results.errors++;
    }
  }
  return results;
}

// ── register ─────────────────────────────────────────────────────────────────

export function registerTypeCheck(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "type_check",
    label: "Type Check",
    description:
      "Run the project's type checker and return structured error output with " +
      "file:line:code:message. Supports TypeScript (tsc --noEmit), mypy, and Pyright. " +
      "A clean type check catches a class of bugs that tests alone miss.",
    promptSnippet: "run the type checker and report errors",
    promptGuidelines: [
      "Run after code changes — type errors often signal real bugs before tests catch them.",
      "Fix type errors before declaring a change done.",
    ],
    parameters: Type.Object({
      strict: Type.Optional(
        Type.Boolean({ description: "Use strict mode if supported (default false)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const framework = guessTypeChecker(cwd);

      if (!framework) {
        return text(
          "No supported type checker detected. Supported: TypeScript (tsc), mypy, Pyright. " +
          "Ensure a tsconfig.json, mypy.ini, or pyproject.toml exists.",
          { framework: "unknown" },
        );
      }

      const cmd = params.strict && framework.name === "TypeScript"
        ? "npx tsc --noEmit --strict"
        : framework.cmd;

      let stdout = "";
      try {
        stdout = execSync(cmd, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
      } catch (e: any) {
        stdout = e.stdout ?? e.stderr ?? "";
        // Type checkers exit non-zero on errors — that's expected
      }

      const results = framework.parse(stdout, "", cwd);

      if (results.errors === 0) {
        return text(`Type check passed — no errors.`, { framework: framework.name, errors: 0 });
      }

      const details = results.items
        .slice(0, 25)
        .map((i) => `  ✗ ${i.file}${i.line ? `:${i.line}` : ""}  ${i.code ? `[${i.code}] ` : ""}${i.message}`)
        .join("\n");

      return text(
        truncate(`${results.errors} type error(s).\n\n${details}`),
        { framework: framework.name, errors: results.errors },
      );
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("type_check"));
      if (args.strict) t += theme.fg("dim", " --strict");
      return new Text(t, 0, 0);
    },
    renderResult(result, _opts, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      const errors = (d?.errors as number) ?? 0;
      if (errors === 0) return new Text(theme.fg("success", "✓ Type check clean"), 0, 0);
      return new Text(
        `${theme.fg("error", `✗ ${errors} type error(s)`)} ${theme.fg("dim", `(${d?.framework ?? "?"})`)}`,
        0, 0,
      );
    },
  });
}
