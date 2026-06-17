// /init — initialize the project memory system by exploring the codebase and
// creating starter memory files in .pi/memory/system/.
//
// Spawns a pi subprocess that reads package.json, tsconfig.json, explores
// src/ structure, and creates conventions.md, commands.md, persona.md, and
// progress.md. Does NOT overwrite existing files (asks confirmation).

import { spawn } from "node:child_process";
import { getPiCommand } from "../lib/shared.ts";
import { ensureMemoryDirs, ensureProgressFile } from "../lib/memory.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ── init prompt builder ───────────────────────────────────────────────────────

function buildInitPrompt(cwd: string, memoryRoot: string): string {
  const systemDir = path.join(memoryRoot, "system");
  return [
    "You are a project-memory initialization agent. Your job is to explore",
    "this codebase and create the initial memory files that will be injected",
    "into every future coding session's context.",
    "",
    `The project root is: ${cwd}`,
    `The memory system directory is: ${systemDir}/`,
    "",
    "## Step 1: Explore the Codebase",
    "",
    "Read these files (use read_file tool) to understand the project:",
    "- package.json — project name, scripts, dependencies, devDependencies",
    "- tsconfig.json (if exists) — TypeScript configuration",
    "- .gitignore (if exists) — what's excluded",
    "- List the top-level directory structure (use bash ls)",
    "- List src/ contents to understand source layout",
    "",
    "From this analysis, detect:",
    "- Project type (Node.js, TypeScript, React, etc.)",
    "- Test framework (jest, vitest, node:test, etc.)",
    "- Build system (tsc, webpack, vite, none, etc.)",
    "- Linting (eslint, prettier, biome, etc.)",
    "- Any frameworks (Express, React, Vue, etc.)",
    "- Any notable conventions visible from the config",
    "",
    "## Step 2: Create Memory Files",
    "",
    "Create these files in the system/ directory. Use the write tool.",
    "**IMPORTANT: Before writing each file, check if it already exists.**",
    "If a file already exists, do NOT overwrite it — skip it and note that",
    "in your report. Use bash `ls` to check existence.",
    "",
    "### system/conventions.md",
    "Frontmatter:",
    "---",
    'description: "Coding standards, conventions, and architectural patterns for this project"',
    "priority: 2",
    "---",
    "",
    "Body: Document the coding conventions you can derive from the codebase:",
    "- Indentation, quoting, semicolons (from code style if detectable)",
    "- TypeScript strictness, module system",
    "- File organization patterns you observe in src/",
    "- Naming conventions (files, functions, variables)",
    "- Any architecture patterns visible (e.g., layered, feature-based)",
    "- Rule: include a section for Testing conventions (with placeholder",
    "  acknowledging it still needs to be documented)",
    "- Rule: include a section for Git conventions (with placeholder)",
    "",
    "Keep it concise but specific. Use the patterns you actually see in the code.",
    "",
    "### system/commands.md",
    "Frontmatter:",
    "---",
    'description: "Build, test, lint, and other common commands for this project"',
    "priority: 3",
    "---",
    "",
    "Body: Extract the actual commands from package.json scripts:",
    "- Build command (if any): the exact npm/npx/yarn command",
    "- Test command: the exact command, plus how to run a single test file",
    "- Lint command: the exact command",
    "- Type check (if TypeScript): npx tsc --noEmit",
    "- Install: npm install (or yarn/pnpm if lockfile indicates)",
    "- Any other useful scripts from package.json",
    "",
    "Format each as a code block with the command and a brief comment.",
    "",
    "### system/persona.md",
    "Frontmatter:",
    "---",
    'description: "Agent behavior preferences and interaction style"',
    "priority: 4",
    "---",
    "",
    "Body: Create sensible default interaction preferences:",
    "- Be concise — lead with results, not narration",
    "- Report failures honestly with output",
    "- Skip preambles and filler",
    "- Prefer surgical edits over full rewrites",
    "- Show only changed lines in diffs",
    "- Confirm before destructive operations",
    "- Always run build/tests after changes",
    "- Verify before claiming done",
    "",
    "This is a template the user can customize later.",
    "",
    "### system/progress.md",
    "Frontmatter:",
    "---",
    'description: "Current task progress, checklist, decisions, and next steps"',
    "priority: 0",
    "---",
    "",
    "Body: Create a task tracker template:",
    "- H1: `# Current Task` (placeholder, the agent will fill this)",
    '- H2: `## Status: Pending`',
    '- H2: `## Checklist` with 2-3 empty `- [ ] item` placeholders',
    '- H2: `## Open Decisions` with `1. Decision to make (context)` placeholder',
    '- H2: `## Next Steps` with 2 empty `- item` placeholders',
    "",
    "## Step 3: Report",
    "",
    "When done, reply with a structured summary of what you created:",
    '"Created: conventions.md, commands.md, persona.md, progress.md"',
    "For any files you skipped (already existed), note them:",
    '"Skipped (already exists): commands.md"',
    "",
    "Do the work now. Explore, detect, create, report.",
  ].join("\n");
}

// ── spawning the initializer ──────────────────────────────────────────────────

function spawnInitializer(cwd: string, memoryRoot: string): Promise<string> {
  const prompt = buildInitPrompt(cwd, memoryRoot);
  const invocation = getPiCommand();
  const baseArgs = [...invocation.args, "-p", "--no-session"];
  const env = { ...process.env, PI_TOOLS_INIT: "1" };

  return new Promise<string>((resolve) => {
    const proc = spawn(invocation.command, [...baseArgs, "--mode", "json", prompt], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let output = "";
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        for (const part of ev.message.content ?? []) {
          if (part?.type === "text") output = part.text;
        }
      }
    };

    proc.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      for (const l of parts) onLine(l);
    });
    proc.on("close", () => {
      if (buffer.trim()) onLine(buffer);
      resolve(output.trim());
    });
    proc.on("error", () => resolve("Initialization subprocess failed to start."));
  });
}

// ── register ──────────────────────────────────────────────────────────────────

export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("init", {
    description: "Initialize project memory by exploring the codebase and creating starter memory files",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;

      // Ensure the memory directory structure exists
      const memoryRoot = ensureMemoryDirs(cwd);

      // Create progress.md from the template (idempotent)
      ensureProgressFile(cwd);

      ctx.ui.setStatus("init", "🔍 Analyzing codebase…");
      ctx.ui.notify("🔍 Exploring codebase and creating memory files…", "info");

      try {
        const result = await spawnInitializer(cwd, memoryRoot);
        ctx.ui.notify(
          result || "Memory initialization complete.",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Init failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("init", undefined);
      }
    },
  });
}
