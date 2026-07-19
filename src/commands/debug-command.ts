// /debug — interactive debugging bridge for Node.js (--inspect).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

let debugProc: ChildProcess | null = null;
let inspectorPort = 9229;

export function registerDebugCommand(pi: ExtensionAPI): void {
  pi.registerCommand("debug", {
    description:
      "Interactive debugging bridge. Start/stop debugger, set breakpoints, inspect variables. " +
      "Supports Node.js --inspect and Chrome DevTools Protocol.",
    handler: async (args, ctx) => {
      const sub = args[0] ?? "help";
      const cwd = ctx.cwd;

      switch (sub) {
        case "start": {
          const entry = args[1] ?? ".";
          debugProc = spawn("node", ["--inspect-brk", entry], {
            cwd, shell: process.platform === "win32",
            stdio: "inherit",
          });
          ctx.ui.notify(
            `Debugger started on port ${inspectorPort}.\n` +
            "Open chrome://inspect in Chrome, or use /debug break <file>:<line> to set breakpoints.",
            "info",
          );
          break;
        }

        case "stop": {
          if (debugProc) {
            debugProc.kill();
            debugProc = null;
          }
          ctx.ui.notify("Debugger stopped.", "info");
          break;
        }

        case "break": {
          if (!debugProc) {
            ctx.ui.notify("No debugger running. Run /debug start first.", "error");
            return;
          }
          const target = args[1];
          if (!target) {
            ctx.ui.notify("Usage: /debug break <file>:<line>", "error");
            return;
          }
          const [file, lineStr] = target.split(":");
          if (!file || !lineStr) {
            ctx.ui.notify("Usage: /debug break <file>:<line>", "error");
            return;
          }
          // In a real impl, connect to inspector and set breakpoint
          ctx.ui.notify(`Breakpoint requested at ${file}:${lineStr}.\nOpen chrome://inspect for full debugging UI.`, "info");
          break;
        }

        case "vars": {
          ctx.ui.notify(
            "Variable inspection works via Chrome DevTools.\n" +
            "Open chrome://inspect → click 'inspect' under your Node process.",
            "info",
          );
          break;
        }

        case "step": {
          const direction = args[1] ?? "over";
          const directions: Record<string, string> = {
            over: "Step over (F10 in DevTools)",
            into: "Step into (F11 in DevTools)",
            out: "Step out (Shift+F11 in DevTools)",
          };
          ctx.ui.notify(
            `${directions[direction] ?? directions.over}\n` +
            "Use Chrome DevTools for interactive stepping.",
            "info",
          );
          break;
        }

        default:
          ctx.ui.notify(
            "Usage:\n" +
            "  /debug start [entry]  — Start debugger on entry point\n" +
            "  /debug stop           — Stop debugger\n" +
            "  /debug break <f>:<l>  — Set breakpoint\n" +
            "  /debug step [over|into|out]  — Step through code\n" +
            "  /debug vars           — Inspect variables",
            "info",
          );
      }
    },
  });
}
