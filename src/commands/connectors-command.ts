// /connectors — list the connectors this package provides: which external
// systems pi can touch, through which tools/commands, and what they need.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Connector {
  name: string;
  what: string;
  surface: string[]; // tools and commands
  needs?: string; // setup / env requirements
}

const CONNECTORS: Connector[] = [
  {
    name: "Web",
    what: "Fetch pages and search the web",
    surface: ["web_fetch", "web_search"],
    needs: "TAVILY_API_KEY optional (falls back to DuckDuckGo)",
  },
  {
    name: "Browser (CDP)",
    what: "Drive a real Chromium browser over the DevTools Protocol",
    surface: [
      "browser_navigate", "browser_snapshot", "browser_click", "browser_type",
      "browser_evaluate", "browser_console", "browser_screenshot", "/skill:browser",
    ],
    needs: "Chrome/Chromium with --remote-debugging-port=9222 (skills/browser/start.sh)",
  },
  {
    name: "GitHub",
    what: "Search code/repos and read files on GitHub",
    surface: ["github_explore"],
    needs: "GITHUB_TOKEN optional (higher rate limits, private repos)",
  },
  {
    name: "Code intelligence",
    what: "Local code navigation and progressive understanding",
    surface: ["read_file", "grep_search", "glob_files", "code_references"],
  },
  {
    name: "Memory",
    what: "Persistent project memory across sessions (.pi/memory/)",
    surface: ["memory_map", "memory_search", "/memory", "/learn", "/doctor", "/consolidate", "/init"],
  },
  {
    name: "Subagents",
    what: "Parallel pi subprocesses with isolated context",
    surface: ["spawn_subagents", "/agents", "/newTask"],
    needs: "Optional lighter model via /config subagentModel",
  },
  {
    name: "Tasks",
    what: "Structured task list for progressive task resolution (.pi/tasks.json)",
    surface: ["tasks"],
  },
  {
    name: "HTTP server",
    what: "Expose this session over HTTP + bore tunnel for mobile/remote",
    surface: ["/serve"],
  },
];

export function registerConnectorsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("connectors", {
    description: "List connectors provided by pi-tools (tools, commands, requirements)",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const lines: string[] = ["pi-tools connectors:"];
      for (const c of CONNECTORS) {
        const toolNames = c.surface.filter((s) => !s.startsWith("/"));
        const activeCount = toolNames.filter((t) => active.has(t)).length;
        const state =
          toolNames.length === 0
            ? ""
            : activeCount === toolNames.length
              ? " ✓"
              : activeCount === 0
                ? " ✗ (tools inactive)"
                : ` ◐ ${activeCount}/${toolNames.length} active`;
        lines.push(`\n${c.name}${state} — ${c.what}`);
        lines.push(`  ${c.surface.join(", ")}`);
        if (c.needs) lines.push(`  needs: ${c.needs}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
