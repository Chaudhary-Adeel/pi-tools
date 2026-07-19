// Plugin/Hook system — user-defined project hooks and custom tools.
//
// Configure in .pi/plugins.yml (YAML):
//   hooks:
//     pre_edit:  ["npm run format ${file}"]
//     post_test: ["notify-send 'Tests passed'"]
//     on_session_start: ["echo 'Starting session'"]
//   custom_tools:
//     - name: deploy_staging
//       command: "bash scripts/deploy.sh staging"
//       description: "Deploy to staging environment"

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PluginConfig {
  hooks?: Record<string, string[]>;
  custom_tools?: {
    name: string;
    command: string;
    description?: string;
  }[];
}

export function loadPlugins(cwd: string): PluginConfig {
  const configPath = path.join(cwd, ".pi", "plugins.yml");
  try {
    const content = fs.readFileSync(configPath, "utf8");
    return parseYaml(content) as PluginConfig;
  } catch {
    return {};
  }
}

function parseYaml(content: string): any {
  // Minimal YAML parser for our simple config format
  // Falls back to JSON if js-yaml isn't available
  const lines = content.split("\n");
  const result: any = {};
  let currentKey = "";
  let inList = false;
  let listItems: string[] = [];

  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const keyMatch = /^(\w[\w_]*):\s*$/.exec(line);
    if (keyMatch) {
      if (currentKey) {
        if (inList) result[currentKey] = listItems;
        else result[currentKey] = true;
      }
      currentKey = keyMatch[1]!;
      inList = false;
      listItems = [];
      continue;
    }
    const itemMatch = /^\s+-\s+(.+)$/.exec(line);
    if (itemMatch) {
      inList = true;
      listItems.push(itemMatch[1]!);
      continue;
    }
    const valMatch = /^\s+(\w[\w_]*):\s*(.+)$/.exec(line);
    if (valMatch && currentKey) {
      if (!result[currentKey]) result[currentKey] = {};
      result[currentKey][valMatch[1]!] = valMatch[2]!;
    }
  }
  if (currentKey && inList) result[currentKey] = listItems;

  return result;
}

export function runHook(cwd: string, hookName: string, vars: Record<string, string> = {}): void {
  const config = loadPlugins(cwd);
  const commands = config.hooks?.[hookName] ?? [];
  for (const cmd of commands) {
    let resolved = cmd;
    for (const [k, v] of Object.entries(vars)) {
      resolved = resolved.replace(`\${${k}}`, v);
    }
    try {
      execSync(resolved, { cwd, stdio: "pipe", timeout: 60_000 });
    } catch (err) {
      console.warn(`[plugins] Hook '${hookName}' failed:`, (err as Error).message);
    }
  }
}

export function registerPluginCommand(pi: ExtensionAPI): void {
  pi.registerCommand("plugins", {
    description: "List installed plugins and custom tools from .pi/plugins.yml",
    handler: async (_args, ctx) => {
      const config = loadPlugins(ctx.cwd);
      const lines: string[] = ["## Plugins (.pi/plugins.yml)"];

      if (config.hooks && Object.keys(config.hooks).length > 0) {
        lines.push("", "**Hooks:**");
        for (const [name, cmds] of Object.entries(config.hooks)) {
          lines.push(`  \`${name}\`: ${cmds.length} command(s)`);
        }
      }

      if (config.custom_tools && config.custom_tools.length > 0) {
        lines.push("", "**Custom Tools:**");
        for (const tool of config.custom_tools) {
          lines.push(`  \`${tool.name}\`: ${tool.description ?? tool.command}`);
        }
      }

      if ((!config.hooks || Object.keys(config.hooks).length === 0) &&
          (!config.custom_tools || config.custom_tools.length === 0)) {
        lines.push("", "No plugins configured. Create .pi/plugins.yml to add hooks and custom tools.");
        lines.push("", "Example:");
        lines.push("```yaml");
        lines.push("hooks:");
        lines.push("  pre_edit: [\"npm run format ${file}\"]");
        lines.push("custom_tools:");
        lines.push("  - name: deploy");
        lines.push("    command: \"bash scripts/deploy.sh\"");
        lines.push("    description: \"Deploy to production\"");
        lines.push("```");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
