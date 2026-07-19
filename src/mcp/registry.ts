/**
 * MCP Command — /mcp to manage MCP server connections.
 *
 * Usage:
 *   /mcp              — list connected servers and their tool counts
 *   /mcp connect <name>  — connect to a server from .pi/mcp.json
 *   /mcp disconnect <name> — disconnect a server
 *   /mcp serve         — start pi-tools as an MCP server (for Claude Desktop, etc.)
 *   /mcp bootstrap     — generate a .pi/mcp.json with recommended servers
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  connectServer,
  disconnectServer,
  loadMcpConfig,
  connectAllFromConfig,
  getAllTools,
  getConnectedServers,
  getServerTools,
} from "./client.ts";
import { startMcpServer } from "./server.ts";

export function registerMcpCommand(pi: ExtensionAPI): void {
  pi.registerCommand("mcp", {
    description:
      "Manage MCP (Model Context Protocol) connections. Connect to external MCP servers " +
      "(Postgres, Slack, Jira, Filesystem, etc.) or expose pi-tools as an MCP server.",
    handler: async (args, ctx) => {
      const subCmd = args[0] ?? "list";
      const cwd = ctx.cwd;

      switch (subCmd) {
        case "list":
        case "ls": {
          const servers = getConnectedServers();
          if (servers.length === 0) {
            ctx.ui.notify(
              "No MCP servers connected.\n\n" +
                "Add servers to .pi/mcp.json and run /mcp connect <name>, or /mcp bootstrap to generate a template.",
              "info",
            );
            return;
          }
          const lines = ["Connected MCP servers:"];
          for (const name of servers) {
            const tools = getServerTools(name);
            lines.push(`  ${name} — ${tools.length} tool(s)`);
            for (const t of tools.slice(0, 5)) {
              lines.push(`    → ${t.name}: ${t.description.slice(0, 60)}`);
            }
            if (tools.length > 5) lines.push(`    … and ${tools.length - 5} more`);
          }
          lines.push("\nRun /mcp connect <name> to add more.");
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "connect":
        case "add": {
          const name = args[1];
          if (!name) {
            ctx.ui.notify("Usage: /mcp connect <server-name>", "error");
            return;
          }
          const config = loadMcpConfig(cwd);
          const serverConfig = config.servers[name];
          if (!serverConfig) {
            const available = Object.keys(config.servers).join(", ") || "(none)";
            ctx.ui.notify(
              `Server "${name}" not found in .pi/mcp.json.\n` +
                `Available servers: ${available}\n` +
                "Run /mcp bootstrap to generate a template.",
              "error",
            );
            return;
          }
          try {
            await connectServer(name, serverConfig);
            const tools = getServerTools(name);
            ctx.ui.notify(`Connected to "${name}" — ${tools.length} tool(s) available.`, "info");
          } catch (err) {
            ctx.ui.notify(`Failed to connect "${name}": ${(err as Error).message}`, "error");
          }
          break;
        }

        case "disconnect":
        case "rm": {
          const name = args[1];
          if (!name) {
            ctx.ui.notify("Usage: /mcp disconnect <server-name>", "error");
            return;
          }
          await disconnectServer(name);
          ctx.ui.notify(`Disconnected from "${name}".`, "info");
          break;
        }

        case "serve": {
          ctx.ui.notify(
            "Starting pi-tools as MCP server on stdio…\n\n" +
              "Configure your MCP client with:\n" +
              '  {"command": "pi", "args": ["--mcp"]}\n\n' +
              "Or add to Claude Desktop config:\n" +
              '  "pi-tools": {"command": "pi", "args": ["--mcp"]}',
            "info",
          );
          startMcpServer();
          break;
        }

        case "bootstrap": {
          const configPath = path.join(cwd, ".pi", "mcp.json");
          const template = {
            servers: {
              filesystem: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-filesystem", cwd],
                autoStart: true,
                description: "Read/write files in the project directory",
              },
              postgres: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432/mydb"],
                autoStart: false,
                description: "Query Postgres databases",
              },
              github: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-github"],
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
                autoStart: false,
                description: "GitHub API access",
              },
            },
          };
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
          ctx.ui.notify(
            `Created ${configPath}\n\n` +
              "Edit this file to configure your MCP servers, then run /mcp connect <name>.",
            "info",
          );
          break;
        }

        default:
          ctx.ui.notify(
            "Usage: /mcp [list|connect|disconnect|serve|bootstrap]",
            "error",
          );
      }
    },
  });
}
