// Auto-capture learnings — distill a finished coding session into durable,
// reusable memory files under .pi/memory/learnings/.
//
// Two entry points use this:
//   - The session_shutdown hook (index.ts) → background, non-blocking capture.
//   - The /learn command                    → foreground, visible capture.
//
// How it works: we build a compact transcript of the session (user/assistant
// text + which files were edited/written), then spawn a fresh `pi -p`
// subprocess whose job is to read that transcript and WRITE 0–N learning files
// using its own write/edit tools. The subprocess runs in non-interactive
// ("print") mode, so this extension's auto-capture hook does NOT fire inside it
// (the hook is gated on ctx.mode === "tui"), preventing infinite recursion.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getPiCommand } from "./shared.ts";
import { findMemoryRoot, ensureMemoryDirs } from "./memory.ts";

// ── transcript building ──────────────────────────────────────────────────

export interface SessionSummary {
  /** Human-readable transcript (user/assistant turns + tool activity). */
  transcript: string;
  /** Absolute/relative paths of files edited or written this session. */
  filesChanged: string[];
  /** Number of user turns. */
  userTurns: number;
  /** Number of assistant turns. */
  assistantTurns: number;
}

const FILE_TOOLS = new Set(["edit", "write", "create_file", "apply_patch"]);

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as any).type === "text") {
      parts.push(String((part as any).text ?? ""));
    }
  }
  return parts.join("\n");
}

/** Build a compact transcript from session entries (as returned by
 *  ctx.sessionManager.getBranch()). Only message entries are used. */
export function buildSessionSummary(entries: unknown[]): SessionSummary {
  const lines: string[] = [];
  const filesChanged = new Set<string>();
  let userTurns = 0;
  let assistantTurns = 0;

  for (const entry of entries) {
    const e = entry as any;
    if (!e || e.type !== "message" || !e.message) continue;
    const msg = e.message;

    if (msg.role === "user") {
      const txt = extractText(msg.content).trim();
      if (txt) {
        userTurns++;
        lines.push(`USER: ${txt}`);
      }
      continue;
    }

    if (msg.role === "assistant") {
      assistantTurns++;
      const txt = extractText(msg.content).trim();
      if (txt) lines.push(`ASSISTANT: ${txt}`);
      // Capture tool calls (file edits/writes) for the "files changed" list.
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && part.type === "toolCall") {
            const name = String(part.name ?? "");
            const args = part.arguments ?? {};
            const p = args.path ?? args.file_path ?? args.filePath ?? args.filename;
            if (FILE_TOOLS.has(name) && typeof p === "string") {
              filesChanged.add(p);
            }
          }
        }
      }
      continue;
    }
    // toolResult messages are intentionally skipped to keep the transcript lean.
  }

  return {
    transcript: lines.join("\n\n"),
    filesChanged: [...filesChanged],
    userTurns,
    assistantTurns,
  };
}

/** Heuristic: is this session worth distilling? Avoids noisy captures from
 *  trivial sessions (a one-line greeting) while still catching short-but-
 *  substantive ones (a single explicit "remember this …" insight). */
export function hasMeaningfulActivity(summary: SessionSummary): boolean {
  // Any file edits/writes → real work happened.
  if (summary.filesChanged.length > 0) return true;
  // Need at least one full exchange.
  if (summary.userTurns < 1 || summary.assistantTurns < 1) return false;
  // A multi-turn back-and-forth, OR a single substantive exchange with enough
  // content to plausibly contain a durable insight.
  if (summary.userTurns >= 3 && summary.assistantTurns >= 3) return true;
  return summary.transcript.length >= 600;
}

// ── distillation prompt ────────────────────────────────────────────────────

function buildDistillPrompt(summary: SessionSummary, learningsDir: string): string {
  const MAX = 24_000;
  let transcript = summary.transcript;
  if (transcript.length > MAX) {
    // Keep the tail — most conclusions/decisions land near the end.
    transcript = `... [earlier transcript truncated] ...\n\n${transcript.slice(-MAX)}`;
  }

  const filesNote =
    summary.filesChanged.length > 0
      ? `\nFiles edited/written this session:\n${summary.filesChanged.map((f) => `- ${f}`).join("\n")}\n`
      : "";

  return [
    "You are a memory-distillation agent. A coding session just ended.",
    "Your ONLY job: extract durable, reusable learnings worth remembering for",
    "FUTURE sessions in this project, and save each as a Markdown file in",
    `${learningsDir}/.`,
    "",
    "What qualifies as a learning (capture these):",
    "- Root causes of bugs that were fixed, and how they were fixed.",
    "- Non-obvious API quirks, gotchas, or constraints discovered.",
    "- Project conventions, architecture facts, or design decisions.",
    "- Commands/workflows that worked (build, test, deploy specifics).",
    "",
    "What to IGNORE (do NOT capture):",
    "- One-off trivia, secrets/tokens, or anything specific to this single chat.",
    "- The literal conversation or a play-by-play summary.",
    "- Anything already obvious from reading the code.",
    "",
    "Procedure:",
    `1. List existing files in ${learningsDir}/ (use your ls/bash tool).`,
    "2. Read a couple if their names look related, to avoid duplicates.",
    "3. Decide on AT MOST 3 genuinely new, reusable learnings.",
    "   - If a learning updates an existing file, EDIT that file instead of adding a new one.",
    "   - If nothing is worth saving, do nothing and reply exactly: No new learnings.",
    "4. For each new learning, WRITE a file:",
    `   ${learningsDir}/<kebab-case-topic>.md`,
    "   with this exact frontmatter format:",
    "   ---",
    '   description: "<one concise line describing what this covers>"',
    "   ---",
    "   # <Title>",
    "   <concise body — a few bullet points or short paragraphs>",
    "5. Keep each learning focused and short. Quality over quantity.",
    "",
    "When done, reply with a one-line summary of what you saved (or 'No new learnings.').",
    filesNote,
    "── SESSION TRANSCRIPT ──",
    transcript,
  ].join("\n");
}

// ── spawning the distiller ──────────────────────────────────────────────────

export interface DistillOptions {
  cwd: string;
  summary: SessionSummary;
  /** Model pattern to use for the distiller (defaults to whatever pi picks). */
  model?: string;
  /** Run detached + unref'd so it survives parent exit (used at shutdown). */
  background?: boolean;
  /** Abort signal (foreground use). */
  signal?: AbortSignal;
}

export interface DistillResult {
  /** Final text the distiller reported. */
  output: string;
  /** Learning files that appeared/changed during distillation. */
  newOrChanged: string[];
  exitCode: number;
}

function listLearningFiles(learningsDir: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(learningsDir)) return out;
  for (const name of fs.readdirSync(learningsDir)) {
    if (!name.endsWith(".md")) continue;
    const fp = path.join(learningsDir, name);
    try {
      out.set(name, fs.statSync(fp).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Spawn the distiller. In background mode resolves immediately (fire-and-forget). */
export function distillLearnings(opts: DistillOptions): Promise<DistillResult> {
  const { cwd, summary, model, background, signal } = opts;
  ensureMemoryDirs(cwd);
  const root = findMemoryRoot(cwd) ?? path.join(cwd, ".pi/memory");
  const learningsDir = path.join(root, "learnings");

  const before = listLearningFiles(learningsDir);
  const prompt = buildDistillPrompt(summary, learningsDir);

  const invocation = getPiCommand();
  const baseArgs = [...invocation.args, "-p", "--no-session"];
  if (model) baseArgs.push("--model", model);

  // Belt-and-suspenders recursion guard (the hook also checks ctx.mode).
  const env = { ...process.env, PI_TOOLS_DISTILL: "1" };

  if (background) {
    // Fire-and-forget: detached so it outlives the exiting parent.
    try {
      const child = spawn(invocation.command, [...baseArgs, prompt], {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      /* best-effort */
    }
    return Promise.resolve({ output: "", newOrChanged: [], exitCode: 0 });
  }

  // Foreground: capture final assistant text and detect changed files.
  return new Promise<DistillResult>((resolve) => {
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
    proc.on("close", (code) => {
      if (buffer.trim()) onLine(buffer);
      const after = listLearningFiles(learningsDir);
      const newOrChanged: string[] = [];
      for (const [name, mtime] of after) {
        const prev = before.get(name);
        if (prev === undefined || mtime > prev) newOrChanged.push(name);
      }
      resolve({ output: output.trim(), newOrChanged, exitCode: code ?? 0 });
    });
    proc.on("error", () => resolve({ output: "", newOrChanged: [], exitCode: 1 }));

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 3000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}
