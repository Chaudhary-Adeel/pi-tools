// /agents — show the subagent setup: model, nesting policy, and presets.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_PRESETS } from "../lib/agents.ts";
import { getSubagentModel } from "../lib/config.ts";

export function registerAgentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("agents", {
    description: "List subagent presets and the subagent model configuration",
    handler: async (_args, ctx) => {
      const model = getSubagentModel(ctx.cwd);
      const mainModel = ctx.model?.id ?? "(none)";
      const lines: string[] = [
        "Subagents (parallel pi subprocesses, isolated context):",
        `  main model:      ${mainModel}`,
        `  subagent model:  ${model ?? `inherit (${mainModel}) — set a lighter one via /config subagentModel`}`,
        "  nesting:         blocked — subagents cannot spawn subagents",
        "",
        "Presets (use as '/newTask <preset>: <task>' or in spawn_subagents prompts):",
        ...AGENT_PRESETS.map((p) => `  ${p.name.padEnd(9)} ${p.description}`),
        "",
        "Commands: /newTask <prompt> · /newTask background <prompt>",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
