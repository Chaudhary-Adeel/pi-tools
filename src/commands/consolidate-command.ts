// /consolidate — audit and reorganize learning files in .pi/memory/learnings/.
//
// Spawns a pi subprocess that reads all learnings, identifies opportunities to
// promote (to system/), merge (similar topics), or archive (obsolete), and
// takes action. The subprocess runs with `pi -p --no-session` (same pattern as
// the /learn command's distillLearnings).

import { spawn } from "node:child_process";
import { getPiCommand } from "../lib/shared.ts";
import { findMemoryRoot, ensureMemoryDirs } from "../lib/memory.ts";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── consolidation prompt builder ──────────────────────────────────────────────

function buildConsolidationPrompt(learningsDir: string, learningsList: string): string {
  return [
    "You are a memory-consolidation agent. Your job is to audit and reorganize",
    "the learning files in the project's memory system.",
    "",
    "## Context",
    `The learnings directory is: ${learningsDir}/`,
    "",
    "These are the learning files currently present:",
    learningsList,
    "",
    "## Procedure",
    "",
    "1. Read each learning file (use the read_file tool) to understand what it covers.",
    "",
    "2. For each learning, decide ONE of:",
    "   - **Promote** to system/: The learning captures a high-reuse pattern,",
    "     convention, or critical fact that should be injected into context",
    "     EVERY session. Move it to system/ with priority=1 (or bumps existing",
    "     system file's priority up). Update frontmatter description accordingly.",
    "   - **Merge** with another: Two or more learnings cover the same or very",
    "     closely related topic. Create ONE consolidated file with the combined",
    "     knowledge, then remove the originals. Use kebab-case for the filename.",
    "   - **Archive**: The learning is stale/obsolete (technology changed, bug",
    "     was permanently fixed, pattern no longer applies). Move it to",
    "     ../archive/ (i.e. .pi/memory/archive/, sibling of learnings/ — same",
    "     location the Memory Health Engine uses; create it if needed).",
    "   - **Keep**: The learning is fine as-is — leave it alone.",
    "",
    "3. Take action using bash (mv, rm, mkdir), write, and edit tools:",
    "   - Promote: `bash mv ${learningsDir}/<file>.md ${learningsDir}/../system/<file>.md`",
    "     then edit the frontmatter to add priority: 1 (lower = loaded first).",
    "   - Merge: Write a new consolidated file, then remove the originals.",
    "     Use write to create the merged file and bash rm to delete originals.",
    "   - Archive: `bash mkdir -p ${learningsDir}/../archive && bash mv ${learningsDir}/<file>.md ${learningsDir}/../archive/<file>.md`",
    "",
    "4. Be conservative: only promote if the learning is genuinely worth loading",
    "   into every session's context (that's expensive). Only merge if the topics",
    "   are truly overlapping. Only archive if the learning has NO future value.",
    "",
    "5. When done, reply with a structured one-line summary of every action taken:",
    '   "PROMOTED: <file1>.md → system/ | MERGED: <file2>.md + <file3>.md → <consolidated>.md | ARCHIVED: <file4>.md | KEPT: <file5>.md"',
    "   If nothing needed changing, reply: 'No consolidation needed — all learnings are clean.'",
    "",
    "Do the work now. Read the files, decide, act, then report.",
  ].join("\n");
}

// ── spawning the consolidator ─────────────────────────────────────────────────

function spawnConsolidator(cwd: string, learningsDir: string, learningsList: string): Promise<string> {
  const prompt = buildConsolidationPrompt(learningsDir, learningsList);
  const invocation = getPiCommand();
  const baseArgs = [...invocation.args, "-p", "--no-session"];
  const env = { ...process.env, PI_TOOLS_CONSOLIDATE: "1" };

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
    proc.on("error", () => resolve("Consolidation subprocess failed to start."));
  });
}

// ── register ──────────────────────────────────────────────────────────────────

export function registerConsolidateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("consolidate", {
    description: "Audit and reorganize memory learnings (promote, merge, archive)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const root = findMemoryRoot(cwd) ?? ensureMemoryDirs(cwd);
      const learningsDir = path.join(root, "learnings");

      // List learnings upfront so we can show the user what exists
      if (!fs.existsSync(learningsDir)) {
        ctx.ui.notify("No learnings directory yet — nothing to consolidate.", "info");
        return;
      }
      const files = fs.readdirSync(learningsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => d.name);

      if (files.length === 0) {
        ctx.ui.notify("No learning files exist yet — nothing to consolidate.", "info");
        return;
      }

      const learningsList = files.map((f) => `- ${f}`).join("\n");

      ctx.ui.setStatus("consolidate", "🧠 Consolidating learnings…");
      ctx.ui.notify(
        `🧠 Auditing ${files.length} learning file(s) in learnings/…`,
        "info",
      );

      try {
        const result = await spawnConsolidator(cwd, learningsDir, learningsList);
        ctx.ui.notify(
          result || "Consolidation complete.",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("consolidate", undefined);
      }
    },
  });
}
