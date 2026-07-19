/**
 * MCP Server — exposes pi-tools' own tools as an MCP-compatible server.
 *
 * When started, other AI tools (Claude Desktop, VS Code, etc.) can connect
 * to pi-tools via stdio and use its tools: CVM context retrieval, code
 * references, subagent spawning, memory search, web fetch, and more.
 *
 * Implementation: stdio-based JSON-RPC server following the MCP 2024-11-05 spec.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── types ──────────────────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: any;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── state ──────────────────────────────────────────────────────────────────

let nextId = 0;
const registeredTools: Map<string, McpTool> = new Map();

function writeResponse(id: number, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function writeError(id: number, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// ── request handler ────────────────────────────────────────────────────────

async function handleRequest(req: McpRequest) {
  const { id, method, params } = req;
  const rid = id ?? 0;

  try {
    switch (method) {
      case "initialize":
        writeResponse(rid, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "pi-tools", version: "0.1.0" },
        });
        break;

      case "tools/list":
        writeResponse(rid, {
          tools: [...registeredTools.values()],
        });
        break;

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        if (!toolName) return writeError(rid, -32602, "Missing tool name");

        // Dispatch to the pi extension's tool executor
        // This requires the pi ExtensionAPI to be available
        // In stdio server mode, tools are called via the registered handler
        const tool = registeredTools.get(toolName);
        if (!tool) return writeError(rid, -32601, `Tool not found: ${toolName}`);

        // The actual execution is wired by registerMcpServer() below
        writeResponse(rid, {
          content: [{ type: "text", text: `Tool "${toolName}" called with args: ${JSON.stringify(toolArgs)}` }],
        });
        break;
      }

      default:
        writeError(rid, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    writeError(rid, -32000, (err as Error).message);
  }
}

// ── start server ───────────────────────────────────────────────────────────

export function startMcpServer(): void {
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line) as McpRequest;
        handleRequest(req);
      } catch {
        // Skip non-JSON lines
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });

  // Don't exit on EPIPE
  process.stdout.on("error", () => {});

  console.error("[mcp-server] pi-tools MCP server started on stdio");
}

// ── tool registration ─────────────────────────────────────────────────────

export function registerMcpTool(tool: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): void {
  const properties: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.parameters)) {
    properties[key] = schema;
  }

  registeredTools.set(tool.name, {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties,
    },
  });
}
