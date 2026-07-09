// /config — configure pi-tools settings interactively (or inline).
//
//   /config                    interactive: pick a setting, enter a value
//   /config <key> <value>      set directly, e.g. /config gitName adeel.bot
//   /config show               print current effective config
//
// Settings live in .pi/pi-tools.json (project) or ~/.pi/pi-tools.json
// (global). Project overrides global.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DEFAULTS,
  loadConfig,
  saveConfig,
  getSubagentModel,
  projectConfigPath,
  globalConfigPath,
  type PiToolsConfig,
} from "../lib/config.ts";

interface Field {
  key: keyof PiToolsConfig;
  label: string;
  hint: string;
}

const FIELDS: Field[] = [
  { key: "gitName", label: "Git name", hint: "user.name injected into git commits" },
  { key: "gitEmail", label: "Git email", hint: "user.email injected into git commits" },
  { key: "greetingName", label: "Greetings name", hint: "name shown in the footer" },
  { key: "subagentModel", label: "Subagent model", hint: "lighter model for spawn_subagents (empty = inherit)" },
  { key: "autoDelegate", label: "Auto-delegate", hint: "delegation harness hints/nudges: on or off (default on)" },
  { key: "memoryHealth", label: "Memory health", hint: "autonomous memory healing sweeps: on or off (default on)" },
];

function effectiveValue(cfg: PiToolsConfig, key: keyof PiToolsConfig): string {
  const v = cfg[key] ?? (CONFIG_DEFAULTS as Record<string, string | undefined>)[key];
  return v === undefined ? "(inherit)" : String(v);
}

function summary(cwd: string): string {
  const cfg = loadConfig(cwd);
  const lines = FIELDS.map((f) => `  ${f.label}: ${effectiveValue(cfg, f.key)}`);
  const sub = getSubagentModel(cwd);
  if (sub && process.env.PI_SUBAGENT_MODEL) {
    lines.push(`  (subagent model overridden by PI_SUBAGENT_MODEL=${sub})`);
  }
  return lines.join("\n");
}

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("config", {
    description: "Configure pi-tools: git identity, greetings name, subagent model",
    getArgumentCompletions: (prefix) => {
      const keys = [...FIELDS.map((f) => f.key as string), "show"];
      return keys
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ value: k, label: k }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // ── /config show ──
      if (trimmed === "show") {
        ctx.ui.notify(`pi-tools config (effective):\n${summary(ctx.cwd)}`, "info");
        return;
      }

      // ── /config <key> <value> ──
      if (trimmed) {
        const [key, ...rest] = trimmed.split(/\s+/);
        const field = FIELDS.find((f) => f.key === key);
        if (!field) {
          ctx.ui.notify(
            `Unknown setting "${key}". Use one of: ${FIELDS.map((f) => f.key).join(", ")}`,
            "error",
          );
          return;
        }
        const value = rest.join(" ");
        const file = saveConfig(ctx.cwd, { [field.key]: value } as PiToolsConfig, "project");
        ctx.ui.notify(
          value
            ? `✓ ${field.label} set to "${value}" (${file})`
            : `✓ ${field.label} cleared (${file})`,
          "info",
        );
        return;
      }

      // ── interactive ──
      if (!ctx.hasUI) {
        ctx.ui.notify("No UI available. Use: /config <key> <value>", "error");
        return;
      }

      const cfg = loadConfig(ctx.cwd);
      const options = FIELDS.map(
        (f) => `${f.label} — ${effectiveValue(cfg, f.key)}`,
      );
      const picked = await ctx.ui.select("Configure pi-tools", [...options, "Show all"]);
      if (picked === undefined) return;
      if (picked === "Show all") {
        ctx.ui.notify(`pi-tools config (effective):\n${summary(ctx.cwd)}`, "info");
        return;
      }

      const field = FIELDS[options.indexOf(picked)];
      if (!field) return;

      const value = await ctx.ui.input(
        `${field.label} (${field.hint})`,
        effectiveValue(cfg, field.key),
      );
      if (value === undefined) return;

      const scope = await ctx.ui.select("Save where?", [
        `This project (${projectConfigPath(ctx.cwd)})`,
        `Global (${globalConfigPath()})`,
      ]);
      if (scope === undefined) return;

      const file = saveConfig(
        ctx.cwd,
        { [field.key]: value.trim() } as PiToolsConfig,
        scope.startsWith("Global") ? "global" : "project",
      );
      ctx.ui.notify(`✓ ${field.label} saved to ${file}`, "info");
    },
  });
}
