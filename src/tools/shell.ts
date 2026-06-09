// run_shell
import { Type } from "typebox";
import { exec } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, truncate } from "../lib/shared.ts";

export function registerShellTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_shell",
    label: "Run Shell",
    description:
      "Run a shell command and return combined stdout/stderr and exit code. " +
      "Uses the platform default shell (PowerShell/cmd on Windows, sh on POSIX).",
    promptSnippet: "run a shell command",
    promptGuidelines: [
      "Use run_shell to build, test, run git, or inspect the environment.",
      "Avoid interactive commands (they will hang). Redirect or pass non-interactive flags.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "The command line to execute." }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory (default: session cwd)." }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Kill the command after this many ms (default 120000)." }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;
      const timeout = params.timeout_ms ?? 120_000;
      return await new Promise((resolve) => {
        const child = exec(
          params.command,
          { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            const code =
              err && typeof (err as { code?: number }).code === "number"
                ? (err as { code: number }).code
                : err
                  ? 1
                  : 0;
            const out = [
              stdout?.trim() ? stdout : "",
              stderr?.trim() ? `--- stderr ---\n${stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n");
            const header = `exit code: ${code}${
              err && (err as { killed?: boolean }).killed
                ? " (killed: timeout)"
                : ""
            }\n\n`;
            resolve(
              text(header + truncate(out || "(no output)"), {
                exitCode: code,
                killed: err && (err as { killed?: boolean }).killed,
              }),
            );
          },
        );
        // Wire cancellation to the running process.
        signal?.addEventListener("abort", () => child.kill(), { once: true });
      });
    },
    renderCall(args, theme, _context) {
      const cmd = (args.command as string) ?? "?";
      // Show first ~60 chars of the command
      const short = cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd;
      let t = theme.fg("toolTitle", theme.bold("$ "));
      t += theme.fg("muted", short);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const d = result.details as Record<string, unknown> | undefined;
      const code = d?.exitCode as number | undefined;
      const killed = d?.killed as boolean | undefined;
      if (killed) {
        return new Text(theme.fg("warning", "⏱ timeout"), 0, 0);
      }
      const label = code === 0
        ? theme.fg("success", "✓ exit 0")
        : theme.fg("error", `✗ exit ${code}`);
      let summary = label;
      if (expanded) {
        const body = result.content?.[0]?.text ?? "";
        if (body) summary += "\n" + theme.fg("dim", body);
      }
      return new Text(summary, 0, 0);
    },
  });
}
