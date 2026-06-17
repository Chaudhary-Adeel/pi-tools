// /serve command — Start an HTTP API server + open-source tunnel for mobile/remote access.
//
// POST /api/prompt  { prompt: string } → { result: string }
// GET  /api/health  → { status: "ok", model: string, uptime: number }
//
// Tunneling: auto-launches `bore` (https://github.com/ekzhang/bore) if installed,
// otherwise shows one-liner install instructions. No npm deps added.

import * as http from "node:http";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPiCommand } from "../lib/shared.ts";

// ── config ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8420;
const MAX_BODY = 64 * 1024; // 64 KB max request body
const PROMPT_TIMEOUT = 5 * 60 * 1000; // 5 minutes per prompt

// ── helpers ─────────────────────────────────────────────────────────────────

/** Check if `bore` is available in PATH. */
function boreAvailable(): boolean {
  try {
    execSync("bore --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Launch bore tunnel. Returns the public URL or null. */
function startBoreTunnel(port: number): { proc: ChildProcess; url: Promise<string | null> } {
  const proc = spawn("bore", ["local", String(port), "--to", "bore.pub"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = new Promise<string | null>((resolve) => {
    let output = "";
    const timeout = setTimeout(() => resolve(null), 15_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      // bore output: "listening at bore.pub:XXXXX" or similar
      const m = output.match(/bore\.pub:\d+/);
      if (m) {
        clearTimeout(timeout);
        resolve(`http://${m[0]}`);
      }
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve(null);
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });

  return { proc, url };
}

/** Generate a simple random API key. */
function generateKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let key = "pi-";
  for (let i = 0; i < 16; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

// ── HTTP server ─────────────────────────────────────────────────────────────

interface PiServer extends http.Server {
  _apiKey: string;
}

function createServer(cwd: string): PiServer {
  const apiKey = generateKey();

  const server = http.createServer(async (req, res) => {
    // CORS — allow mobile app / any origin
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check (skip for health)
    const auth = req.headers["authorization"];
    if (req.url !== "/api/health" && auth !== `Bearer ${apiKey}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", hint: "Use Authorization: Bearer <key>" }));
      return;
    }

    // ── GET /api/health ──────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", model: "pi", uptime: Math.floor((Date.now() - startTime) / 1000) }));
      return;
    }

    // ── POST /api/prompt ─────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/api/prompt") {
      let body = "";
      req.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload too large" }));
          req.destroy();
        }
      });

      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const prompt = parsed.prompt;
          if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing or empty 'prompt' field" }));
            return;
          }

          let model = parsed.model;
          if (model && typeof model !== "string") model = undefined;

          // Build pi command with optional model
          const { command, args } = getPiCommand();
          const finalArgs = [...args];
          if (model) finalArgs.push("--model", model);
          finalArgs.push("-p", prompt);

          const result = await new Promise<string>((resolve) => {
            const child = spawn(command, finalArgs, {
              cwd,
              env: { ...process.env, PI_NO_COLOR: "1", NO_COLOR: "1" },
              stdio: ["ignore", "pipe", "pipe"],
              timeout: PROMPT_TIMEOUT,
            });

            let out = "";
            child.stdout.on("data", (c: Buffer) => {
              out += c.toString();
              if (out.length > 500_000) { child.kill(); out = out.slice(0, 500_000) + "\n…(truncated)"; }
            });
            child.on("close", () => resolve(out.trim() || "(empty response)"));
            child.on("error", () => resolve("Error: failed to spawn pi"));
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
        }
      });
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }) as PiServer;

  server._apiKey = apiKey;
  return server;
}

let startTime = 0;

// ── TUI panel ───────────────────────────────────────────────────────────────

interface PanelState {
  port: number;
  apiKey: string;
  tunnelUrl: string | null;
  tunnelStatus: "connecting" | "connected" | "unavailable";
  requestCount: number;
  lastRequest: string;
}

function renderPanel(s: PanelState, theme: any): string[] {
  const lines: string[] = [];
  const dim = (t: string) => theme.fg("dim", t);
  const accent = (t: string) => theme.fg("accent", t);
  const success = (t: string) => theme.fg("success", t);
  const warn = (t: string) => theme.fg("warning", t);
  const bold = (t: string) => theme.bold(t);

  lines.push("");
  lines.push(bold("  🔗 Pi Remote Server"));
  lines.push(dim("  ──────────────────────────────────────────"));
  lines.push("");
  lines.push(`  ${dim("API Key:")}  ${accent(s.apiKey)}`);
  lines.push(`  ${dim("Port:")}    ${s.port}`);
  lines.push("");

  // Tunnel status
  if (s.tunnelUrl) {
    lines.push(`  ${success("●")} ${dim("Tunnel:")}  ${accent(s.tunnelUrl)}`);
  } else if (s.tunnelStatus === "connecting") {
    lines.push(`  ${warn("◌")} ${dim("Tunnel:")}  connecting to bore.pub…`);
  } else {
    lines.push(`  ${dim("○")} ${dim("Tunnel:")}  ${dim("not available — install bore for public URL")}`);
    lines.push(`  ${dim("         brew install bore     # or: cargo install bore-cli")}`);
  }

  lines.push("");
  lines.push(`  ${dim("Requests:")} ${s.requestCount}`);
  if (s.lastRequest) lines.push(`  ${dim("Last:")}     ${s.lastRequest.slice(0, 60)}`);

  lines.push("");
  lines.push("  " + dim("Endpoints:"));
  lines.push(`  ${accent("POST")} /api/prompt  ${dim("{ prompt: string, model?: string }")}`);
  lines.push(`  ${accent("GET")}  /api/health`);
  lines.push("");
  lines.push("  " + dim("Example:"));
  lines.push(`  ${dim("curl -H 'Authorization: Bearer")} ${accent(s.apiKey)}${dim("' \\")}`);
  lines.push(`  ${dim("  -d '{\"prompt\":\"list files\"}'")} ${accent(`http://localhost:${s.port}/api/prompt`)}`);

  if (s.tunnelUrl) {
    lines.push("");
    lines.push(`  ${dim("Mobile:")} ${accent(s.tunnelUrl + "/api/prompt")}`);
  }

  return lines;
}

// ── register ────────────────────────────────────────────────────────────────

export function registerServeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("serve", {
    description: "Start HTTP API server + bore tunnel for mobile/remote access",
    handler: async (_args, ctx) => {
      const state: PanelState = {
        port: DEFAULT_PORT,
        apiKey: "",
        tunnelUrl: null,
        tunnelStatus: "unavailable",
        requestCount: 0,
        lastRequest: "",
      };

      // Create and start server
      const server = createServer(ctx.cwd);
      state.apiKey = server._apiKey;
      startTime = Date.now();

      // Count requests
      server.on("request", (req) => {
        state.requestCount++;
        if (req.url) state.lastRequest = req.url;
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(state.port, () => resolve());
        server.on("error", reject);
      });

      ctx.ui.setStatus("serve", `Pi Server :${state.port}`);

      // Try bore tunnel
      let boreProc: ChildProcess | null = null;
      if (boreAvailable()) {
        state.tunnelStatus = "connecting";
        const { proc, url } = startBoreTunnel(state.port);
        boreProc = proc;
        url.then((u) => {
          if (u) {
            state.tunnelUrl = u;
            state.tunnelStatus = "connected";
            ctx.ui.setStatus("serve", `Pi Server :${state.port} → ${u}`);
          } else {
            state.tunnelStatus = "unavailable";
          }
        });
      }

      // TUI panel
      const result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
        let lastWidth = tui.terminal.columns;
        let lastHeight = tui.terminal.rows;

        const render = (): string[] => renderPanel(state, theme);

        // Periodic refresh for request counter
        const interval = setInterval(() => {
          tui.requestRender();
        }, 1000);

        return {
          render(w: number) {
            if (w !== lastWidth) lastWidth = w;
            const currentH = tui.terminal.rows;
            if (currentH !== lastHeight) lastHeight = currentH;
            return render();
          },
          invalidate() {},
          handleInput(data: string) {
            if (data === "q" || data === "Q" || data === "\x1b") {
              done(null);
            }
          },
          dispose() {
            clearInterval(interval);
          },
        };
      });

      // Cleanup
      if (boreProc) boreProc.kill();
      server.close();
      ctx.ui.clearStatus("serve");
    },
  });
}
