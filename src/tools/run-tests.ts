// run_tests — run the project's test suite and return structured results.
// Auto-detects the test framework and parses pass/fail/skip counts + failures.

import { Type } from "typebox";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, exists } from "../lib/shared.ts";

// ── framework detection ──────────────────────────────────────────────────────

interface Framework {
  name: string;
  cmd: string;
  /** Command to run a single test file. */
  fileCmd: (file: string) => string;
  /** Parse stdout into structured results. */
  parse: (stdout: string, stderr: string) => TestResults;
}

interface TestResults {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: string;
  failures: { file?: string; test: string; error: string }[];
  raw: string;
}

function guessFramework(cwd: string): Framework | null {
  const pkgPath = path.join(cwd, "package.json");
  let pkg: any = {};
  try { pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf8")); } catch {}

  // Jest / Vitest
  if (exists(path.join(cwd, "node_modules/.bin/vitest"))) {
    return {
      name: "Vitest",
      cmd: "npx vitest run --reporter verbose",
      fileCmd: (f) => `npx vitest run --reporter verbose "${f}"`,
      parse: parseJestVitest,
    };
  }
  if (exists(path.join(cwd, "node_modules/.bin/jest"))) {
    return {
      name: "Jest",
      cmd: "npx jest --verbose",
      fileCmd: (f) => `npx jest --verbose "${f}"`,
      parse: parseJestVitest,
    };
  }

  // Node test runner (node --test)
  const scripts = pkg.scripts ?? {};
  if (scripts.test && scripts.test.includes("--test")) {
    return {
      name: "Node Test Runner",
      cmd: `npm test`,
      fileCmd: (f) => `node --experimental-strip-types --test "${f}"`,
      parse: parseNodeTest,
    };
  }

  // Pytest
  if (exists(path.join(cwd, "pytest.ini")) || exists(path.join(cwd, "pyproject.toml"))) {
    return {
      name: "Pytest",
      cmd: "pytest -v",
      fileCmd: (f) => `pytest -v "${f}"`,
      parse: parsePytest,
    };
  }

  // Go test
  if (exists(path.join(cwd, "go.mod"))) {
    return {
      name: "Go Test",
      cmd: "go test ./... -v",
      fileCmd: (f) => `go test "${f}" -v`,
      parse: parseGoTest,
    };
  }

  // Cargo test (Rust)
  if (exists(path.join(cwd, "Cargo.toml"))) {
    return {
      name: "Cargo Test",
      cmd: "cargo test",
      fileCmd: (f) => `cargo test`,
      parse: parseCargoTest,
    };
  }

  // Fallback: try npm test
  if (scripts.test) {
    return {
      name: "npm test",
      cmd: "npm test",
      fileCmd: () => "npm test",
      parse: parseGeneric,
    };
  }

  return null;
}

// ── parsers ──────────────────────────────────────────────────────────────────

function parseJestVitest(stdout: string, _stderr: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], raw: stdout };
  // Tests: 5 passed, 2 failed, 1 skipped, 8 total
  const summaryRe = /Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed(?:,\s+(\d+)\s+skipped)?(?:,\s+(\d+)\s+total)?/;
  const m = summaryRe.exec(stdout);
  if (m) {
    results.passed = parseInt(m[1] ?? "0");
    results.failed = parseInt(m[2] ?? "0");
    results.skipped = parseInt(m[3] ?? "0");
    results.total = parseInt(m[4] ?? String(results.passed + results.failed + results.skipped));
  }
  // Extract failures: "  ● Test Name" followed by the error
  const failLines = stdout.split("\n");
  let current: { test: string; error: string[] } | null = null;
  for (const line of failLines) {
    if (/^\s*[●•]\s/.test(line)) {
      if (current) results.failures.push({ test: current.test, error: current.error.join("\n") });
      current = { test: line.replace(/^\s*[●•]\s*/, "").trim(), error: [] };
    } else if (current) {
      if (/^\s*(Tests:|Test Suites:|Snapshots:|Time:)/.test(line)) break;
      current.error.push(line);
    }
  }
  if (current) results.failures.push({ test: current.test, error: current.error.join("\n") });
  return results;
}

function parseNodeTest(stdout: string, _stderr: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], raw: stdout };
  const passRe = /^ok\s+\d+/gm;
  const failRe = /^not ok\s+\d+/gm;
  results.passed = (stdout.match(passRe) ?? []).length;
  results.failed = (stdout.match(failRe) ?? []).length;
  results.total = results.passed + results.failed;
  // Node test failures
  const lines = stdout.split("\n");
  let inFail = false;
  let failName = "";
  let failErr: string[] = [];
  for (const line of lines) {
    if (line.startsWith("not ok ")) {
      if (inFail && failName) results.failures.push({ test: failName, error: failErr.join("\n") });
      inFail = true;
      failName = line.replace(/^not ok \d+ - /, "").trim();
      failErr = [];
    } else if (inFail && line.startsWith("ok ")) {
      inFail = false;
    } else if (inFail) {
      failErr.push(line);
    }
  }
  if (inFail && failName) results.failures.push({ test: failName, error: failErr.join("\n") });
  return results;
}

function parsePytest(stdout: string, _stderr: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], raw: stdout };
  // Look for the summary line: 5 passed, 2 failed, 1 skipped in 2.3s
  const sumRe = /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+(skipped|deselected))?/;
  const m = sumRe.exec(stdout);
  if (m) {
    results.passed = parseInt(m[1] ?? "0");
    results.failed = parseInt(m[2] ?? "0");
    results.skipped = parseInt(m[3] ?? "0");
    results.total = results.passed + results.failed + results.skipped;
  }
  return results;
}

function parseGoTest(stdout: string, _stderr: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], raw: stdout };
  const passRe = /--- PASS:/g;
  const failRe = /--- FAIL:/g;
  const skipRe = /--- SKIP:/g;
  results.passed = (stdout.match(passRe) ?? []).length;
  results.failed = (stdout.match(failRe) ?? []).length;
  results.skipped = (stdout.match(skipRe) ?? []).length;
  results.total = results.passed + results.failed + results.skipped;
  return results;
}

function parseCargoTest(stdout: string, _stderr: string): TestResults {
  const results: TestResults = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], raw: stdout };
  const sumRe = /test result:\s+ok\.\s+(\d+)\s+passed(?:;\s+(\d+)\s+failed)?/;
  const m = sumRe.exec(stdout);
  if (m) {
    results.passed = parseInt(m[1] ?? "0");
    results.failed = parseInt(m[2] ?? "0");
    results.total = results.passed + results.failed;
  }
  return results;
}

function parseGeneric(stdout: string, _stderr: string): TestResults {
  return { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], raw: stdout };
}

// ── register ─────────────────────────────────────────────────────────────────

export function registerRunTests(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description:
      "Run the project's test suite and return structured results: pass/fail/skip " +
      "counts plus detailed failure messages. Auto-detects the test framework " +
      "(Jest, Vitest, Node Test Runner, Pytest, Go Test, Cargo Test) and can run " +
      "a single file or the full suite.",
    promptSnippet: "run the test suite and report results",
    promptGuidelines: [
      "Run after making code changes to verify nothing is broken.",
      "Use file_path to run only the tests relevant to your changes.",
      "Only claim done after all tests pass.",
    ],
    parameters: Type.Object({
      file_path: Type.Optional(
        Type.String({ description: "Run tests for a specific file instead of the full suite." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const framework = guessFramework(cwd);

      if (!framework) {
        return text(
          "No supported test framework detected. Supported: Jest, Vitest, Node Test Runner, Pytest, Go Test, Cargo Test. " +
          "Use bash to run tests manually.",
          { framework: "unknown" },
        );
      }

      const cmd = params.file_path
        ? framework.fileCmd(params.file_path as string)
        : framework.cmd;

      let stdout = "";
      let stderr = "";
      try {
        stdout = execSync(cmd, {
          cwd,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 5 * 60 * 1000, // 5 min
        });
      } catch (e: any) {
        stdout = e.stdout ?? "";
        stderr = e.stderr ?? "";
        if (!stdout && !stderr) throw e;
      }

      const results = framework.parse(stdout, stderr);
      const fullOutput = stdout ? stdout : stderr;

      if (results.failed === 0 && results.total > 0) {
        return text(
          `All ${results.total} tests passed${results.skipped ? ` (${results.skipped} skipped)` : ""}${results.duration ? ` in ${results.duration}` : ""}.`,
          { framework: framework.name, ...results, raw: truncate(fullOutput) },
        );
      }

      const failureDetails = results.failures.length > 0
        ? "\n\nFailures:\n" + results.failures
            .slice(0, 10)
            .map((f) => `  ✗ ${f.test}\n    ${f.error.split("\n").slice(0, 3).join("\n    ")}`)
            .join("\n")
        : "";

      return text(
        truncate(
          `${results.passed} passed, ${results.failed} failed${results.skipped ? `, ${results.skipped} skipped` : ""} (${results.total} total).` +
          failureDetails,
        ),
        { framework: framework.name, ...results, raw: truncate(fullOutput) },
      );
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("run_tests"));
      if (args.file_path) t += theme.fg("dim", ` ${args.file_path as string}`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const d = result.details as Record<string, unknown> | undefined;
      if (context.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      const failed = (d?.failed as number) ?? 0;
      const passed = (d?.passed as number) ?? 0;
      const total = (d?.total as number) ?? 0;
      const icon = failed > 0 ? theme.fg("error", "✗") : theme.fg("success", "✓");
      let summary = `${icon} ${theme.fg("muted", `${passed}/${total} passed`)}`;
      if (failed > 0) summary += ` ${theme.fg("error", `${failed} failed`)}`;
      summary += theme.fg("dim", ` (${d?.framework ?? "?"})`);
      if (expanded) {
        const head = firstText(result).split("\n").slice(0, 15).join("\n");
        summary += "\n" + theme.fg("dim", head);
      }
      return new Text(summary, 0, 0);
    },
  });
}
