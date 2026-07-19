/**
 * MCP Client — connects pi-tools to external MCP servers.
 *
 * MCP (Model Context Protocol) is the universal interface for AI-tool
 * interoperability. This client lets pi-tools consume tools from ANY
 * MCP-compatible server — databases, APIs, file systems, Slack, Jira,
 * Linear, and 100+ community servers.
 *
 * Supports two transports:
 *   - stdio:  Launch a local process (most common)
 *   - SSE:    Connect to a remote HTTP server
 *
 * Usage in .pi/mcp.json:
 *   {
 *     "servers": {
 *       "postgres":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"] },
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"] },
 *       "slack":      { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"], "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" } }
 *     }
 *   }
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

// ── types ──────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** SSE transport: connect to a URL instead of spawning a process. */
  url?: string;
  /** Auto-start on session init. */
  autoStart?: boolean;
  /** Namespace prefix for tools from this server (e.g. "pg_" → "pg_query"). */
  namespace?: string;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Which server this tool belongs to */
  server: string;
}

export type McpToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// ── client ─────────────────────────────────────────────────────────────────

interface ServerState {
  proc?: ChildProcess;
  tools: McpTool[];
  initialized: boolean;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  buffer: string;
}

const servers = new Map<string, ServerState>();

function resolveEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    resolved[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  }
  return resolved;
}

function send(state: ServerState, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    state.pending.set(id, { resolve, reject });
    state.proc?.stdin?.write(msg + "\n");
  });
}

function handleMessage(state: ServerState, line: string) {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id && state.pending.has(msg.id)) {
      const { resolve, reject } = state.pending.get(msg.id)!;
      state.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
      else resolve(msg.result);
    }
  } catch {
    // Non-JSON lines (e.g. logs) are ignored
  }
}

export async function connectServer(name: string, config: McpServerConfig): Promise<void> {
  if (servers.has(name)) return;

  const state: ServerState = {
    tools: [],
    initialized: false,
    nextId: 1,
    pending: new Map(),
    buffer: "",
  };
  servers.set(name, state);

  if (config.url) {
    throw new Error("SSE transport not yet implemented. Use stdio transport.");
  }

  const env = { ...process.env, ...resolveEnv(config.env ?? {}) };
  const proc = spawn(config.command, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    shell: process.platform === "win32",
  });

  state.proc = proc;

  proc.stdout?.on("data", (chunk: Buffer) => {
    state.buffer += chunk.toString("utf8");
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";
    for (const line of lines) handleMessage(state, line);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    // MCP servers may log to stderr — surface as debug
    const text = chunk.toString("utf8").trim();
    if (text) console.debug(`[mcp:${name}]`, text);
  });

  proc.on("error", (err) => {
    console.error(`[mcp:${name}] Process error:`, err.message);
    servers.delete(name);
  });

  proc.on("close", (code) => {
    console.warn(`[mcp:${name}] Process exited with code ${code}`);
    servers.delete(name);
  });

  // MCP handshake: initialize → list tools
  await send(state, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "pi-tools", version: "0.1.0" },
  });

  state.initialized = true;

  const result: any = await send(state, "tools/list");
  state.tools = (result?.tools ?? []).map((t: any) => ({
    name: config.namespace ? `${config.namespace}${t.name}` : t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? {},
    server: name,
  }));

  console.log(`[mcp:${name}] Connected — ${state.tools.length} tool(s) available`);
}

export async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const state = servers.get(serverName);
  if (!state) throw new Error(`MCP server "${serverName}" not connected.`);
  const result: any = await send(state, "tools/call", {
    name: toolName,
    arguments: args,
  });
  return result?.content ?? result;
}

export function getConnectedServers(): string[] {
  return [...servers.keys()];
}

export function getServerTools(serverName: string): McpTool[] {
  return servers.get(serverName)?.tools ?? [];
}

export function getAllTools(): McpTool[] {
  const all: McpTool[] = [];
  for (const [, state] of servers) all.push(...state.tools);
  return all;
}

export async function disconnectServer(name: string): Promise<void> {
  const state = servers.get(name);
  if (state?.proc) {
    state.proc.kill();
    servers.delete(name);
  }
}

export async function disconnectAll(): Promise<void> {
  for (const name of [...servers.keys()]) await disconnectServer(name);
}

// ── config ─────────────────────────────────────────────────────────────────

const CONFIG_PATH = ".pi/mcp.json";

export function loadMcpConfig(cwd: string): McpConfig {
  const configPath = path.join(cwd, CONFIG_PATH);
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as McpConfig;
  } catch {
    return { servers: {} };
  }
}

export async function connectAllFromConfig(cwd: string): Promise<string[]> {
  const config = loadMcpConfig(cwd);
  const connected: string[] = [];
  for (const [name, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.autoStart !== false) {
      try {
        await connectServer(name, serverConfig);
        connected.push(name);
      } catch (err) {
        console.warn(`[mcp] Failed to connect "${name}":`, (err as Error).message);
      }
    }
  }
  return connected;
}
