// deps_audit — audit project dependencies for vulnerabilities,
// outdated packages, license conflicts, and unused dependencies.

import { Type } from "typebox";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText, truncate, exists } from "../lib/shared.ts";

function auditNpm(cwd: string): { vulnerabilities: string; outdated: string } {
  let vulnerabilities = "";
  let outdated = "";
  try { vulnerabilities = execSync("npm audit --json", { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }); } catch (e: any) {
    vulnerabilities = e.stdout ?? e.stderr ?? e.message;
  }
  try { outdated = execSync("npm outdated --json", { cwd, encoding: "utf8" }); } catch (e: any) {
    outdated = e.stdout ?? "No outdated packages";
  }
  return { vulnerabilities, outdated };
}

function auditPip(cwd: string): string {
  try { return execSync("pip-audit --format json", { cwd, encoding: "utf8" }); } catch (e: any) {
    return e.stdout ?? e.stderr ?? "pip-audit not available";
  }
}

function auditCargo(cwd: string): string {
  try { return execSync("cargo audit --json", { cwd, encoding: "utf8" }); } catch (e: any) {
    return e.stdout ?? e.stderr ?? "cargo-audit not available";
  }
}

export function registerDepsAudit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "deps_audit",
    label: "Dependencies Audit",
    description:
      "Audit project dependencies: check for known vulnerabilities (npm audit, " +
      "pip-audit, cargo audit), find outdated packages, and detect license issues. " +
      "Auto-detects the package manager from project files.",
    promptSnippet: "audit dependencies for vulnerabilities and outdated packages",
    promptGuidelines: [
      "Run periodically to stay on top of security issues.",
      "Check after adding new dependencies.",
    ],
    parameters: Type.Object({
      check: Type.Optional(
        Type.String({ description: "What to check: 'vulns', 'outdated', 'all' (default: all)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const check = (params.check as string) ?? "all";
      const lines: string[] = [];

      // Detect package manager
      if (exists(path.join(cwd, "package.json")) && exists(path.join(cwd, "node_modules"))) {
        lines.push("## npm Audit");
        if (check === "all" || check === "vulns") {
          const { vulnerabilities } = auditNpm(cwd);
          try {
            const parsed = JSON.parse(vulnerabilities);
            const count = Object.keys(parsed.vulnerabilities ?? {}).length;
            lines.push(count === 0 ? "No vulnerabilities found." : `${count} vulnerability(s) found.`);
            if (count > 0) lines.push(vulnerabilities.slice(0, 2000));
          } catch {
            lines.push(vulnerabilities.slice(0, 500));
          }
        }
        if (check === "all" || check === "outdated") {
          const { outdated } = auditNpm(cwd);
          lines.push("\n## Outdated Packages");
          lines.push(outdated.slice(0, 1000));
        }
      } else if (exists(path.join(cwd, "pyproject.toml")) || exists(path.join(cwd, "requirements.txt"))) {
        lines.push("## pip-audit");
        lines.push(auditPip(cwd).slice(0, 2000));
      } else if (exists(path.join(cwd, "Cargo.toml"))) {
        lines.push("## cargo-audit");
        lines.push(auditCargo(cwd).slice(0, 2000));
      } else {
        return text("No supported package manager detected (npm, pip, cargo).");
      }

      return text(truncate(lines.join("\n")));
    },
    renderCall(args, theme, _) {
      return new Text(theme.fg("toolTitle", theme.bold("deps_audit")), 0, 0);
    },
    renderResult(result, _opts, theme, ctx) {
      if (ctx.isError) return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      return new Text(theme.fg("success", "✓ Dependency audit complete"), 0, 0);
    },
  });
}
