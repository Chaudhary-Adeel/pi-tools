// Memory map — structured index of all agent memory, auto-generated
// from .pi/memory/. Provides the agent with a map of its own knowledge.
//
// The map is a Markdown file (.pi/memory/memory-map.md) that enumerates:
//   - System memory files (always injected) with descriptions and sizes
//   - Learning files (on-demand) with descriptions and sizes
//   - Progress state
//   - Token budget and injection stats
//
// Also provides utility functions to compute memory footprint stats.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  findMemoryRoot,
  loadSystemMemory,
  listLearnings,
  loadProgress,
  parseMemoryFile,
  type MemoryFile,
  type Progress,
} from "./memory.ts";
import { formatBytes } from "./shared.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface MemoryFootprint {
  /** All system memory files (always injected) */
  systemFiles: MemoryFile[];
  /** All learning files (on-demand) */
  learningFiles: MemoryFile[];
  /** Total bytes of all memory files */
  totalBytes: number;
  /** Estimated tokens of all memory files */
  totalTokens: number;
  /** Bytes injected into context each turn (system files only) */
  injectedBytes: number;
  /** Estimated tokens injected each turn */
  injectedTokens: number;
  /** Token budget limit for injected memory */
  tokenBudget: number;
  /** Budget utilization percentage */
  budgetUtilization: number;
  /** Whether memory root was found */
  hasMemory: boolean;
  /** Path to memory root */
  memoryRoot: string | null;
  /** Current progress state */
  progress: Progress | null;
}

export interface MemoryStats {
  /** Number of system files */
  systemCount: number;
  /** Number of learning files */
  learningCount: number;
  /** Total file count */
  totalCount: number;
  /** Total bytes on disk */
  totalBytes: number;
  /** Estimated total tokens (chars / 4) */
  totalTokens: number;
  /** Bytes injected per turn */
  injectedBytes: number;
  /** Estimated injected tokens per turn */
  injectedTokens: number;
  /** Current token budget */
  tokenBudget: number;
  /** % of budget used by current system files */
  budgetUtilization: number;
}

// ── token budget ──────────────────────────────────────────────────────────

/** Read token budget from PI_MEMORY_TOKEN_BUDGET env var, fall back to 4000. */
export function getTokenBudget(): number {
  const env = process.env.PI_MEMORY_TOKEN_BUDGET;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 4000;
}

// ── footprint computation ─────────────────────────────────────────────────

/** Estimate tokens from character count (rough: ~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Compute the full memory footprint for a project. */
export function computeFootprint(cwd: string, tokenBudget?: number): MemoryFootprint {
  const budget = tokenBudget ?? getTokenBudget();
  const root = findMemoryRoot(cwd);
  if (!root) {
    return {
      systemFiles: [],
      learningFiles: [],
      totalBytes: 0,
      totalTokens: 0,
      injectedBytes: 0,
      injectedTokens: 0,
      tokenBudget: budget,
      budgetUtilization: 0,
      hasMemory: false,
      memoryRoot: null,
      progress: null,
    };
  }

  const systemFiles = loadSystemMemory(cwd);
  const learningFiles = listLearnings(cwd);
  const progress = loadProgress(cwd);

  let injectedBytes = 0;
  let injectedTokens = 0;
  for (const f of systemFiles) {
    injectedBytes += Buffer.byteLength(f.raw, "utf-8");
    injectedTokens += estimateTokens(f.raw);
  }

  let totalBytes = injectedBytes;
  let totalTokens = injectedTokens;
  for (const f of learningFiles) {
    totalBytes += Buffer.byteLength(f.raw, "utf-8");
    totalTokens += estimateTokens(f.raw);
  }

  return {
    systemFiles,
    learningFiles,
    totalBytes,
    totalTokens,
    injectedBytes,
    injectedTokens,
    tokenBudget: budget,
    budgetUtilization: injectedTokens > 0 ? (injectedTokens / budget) * 100 : 0,
    hasMemory: true,
    memoryRoot: root,
    progress,
  };
}

/** Compute compact stats (no file lists). */
export function computeStats(cwd: string, tokenBudget?: number): MemoryStats {
  const fp = computeFootprint(cwd, tokenBudget);
  return {
    systemCount: fp.systemFiles.length,
    learningCount: fp.learningFiles.length,
    totalCount: fp.systemFiles.length + fp.learningFiles.length,
    totalBytes: fp.totalBytes,
    totalTokens: fp.totalTokens,
    injectedBytes: fp.injectedBytes,
    injectedTokens: fp.injectedTokens,
    tokenBudget: fp.tokenBudget,
    budgetUtilization: fp.budgetUtilization,
  };
}

// ── memory map generation ─────────────────────────────────────────────────

const MAP_HEADER = `# Memory Map

> Auto-generated index of the agent's persistent memory in \`.pi/memory/\`.
> Regenerate with the \`memory_map\` tool (action: "generate") or by asking the agent to update it.

`;

/** Generate a human-readable memory map Markdown file. */
export function generateMemoryMap(cwd: string, tokenBudget?: number): string {
  const fp = computeFootprint(cwd, tokenBudget);
  if (!fp.hasMemory) {
    return MAP_HEADER + "\n⚠️ No memory directory found. Run `ensureMemoryDirs(cwd)` or create `.pi/memory/`.\n";
  }

  const lines: string[] = [];
  lines.push(MAP_HEADER);

  // ── summary stats ──────────────────────────────────────────────────
  lines.push("## Summary");
  lines.push("");
  lines.push("| Category | Files | Size | Tokens (est.) |");
  lines.push("|----------|------:|-----:|-------------:|");
  lines.push(`| 🧠 **System Memory** (injected each turn) | ${fp.systemFiles.length} | ${formatBytes(fp.injectedBytes)} | ~${fp.injectedTokens.toLocaleString()} |`);
  lines.push(`| 📚 **Learnings** (on-demand) | ${fp.learningFiles.length} | ${formatBytes(fp.totalBytes - fp.injectedBytes)} | ~${(fp.totalTokens - fp.injectedTokens).toLocaleString()} |`);
  lines.push(`| **Total** | ${fp.systemFiles.length + fp.learningFiles.length} | ${formatBytes(fp.totalBytes)} | ~${fp.totalTokens.toLocaleString()} |`);
  lines.push("");
  lines.push(`**Token budget:** ${fp.tokenBudget.toLocaleString()} tokens | **Budget used:** ${fp.budgetUtilization.toFixed(1)}%`);
  lines.push("");

  // ── system memory detail ────────────────────────────────────────────
  lines.push("## 🧠 System Memory (always injected)");
  lines.push("");
  if (fp.systemFiles.length === 0) {
    lines.push("> No system memory files yet. Create `.pi/memory/system/*.md` files with YAML frontmatter.");
  } else {
    for (const f of fp.systemFiles) {
      const desc = f.frontmatter.description ?? "(no description)";
      const priority = f.frontmatter.priority ?? "—";
      const size = Buffer.byteLength(f.raw, "utf-8");
      const tokens = estimateTokens(f.raw);
      lines.push(`### \`${f.relPath}\``);
      lines.push("");
      lines.push(`- **Description:** ${desc}`);
      lines.push(`- **Priority:** ${priority}  |  **Size:** ${formatBytes(size)}  |  **Tokens:** ~${tokens.toLocaleString()}`);
      lines.push(`- **Path:** \`${f.path}\``);
      lines.push("");
    }
  }

  // ── learnings detail ────────────────────────────────────────────────
  lines.push("## 📚 Learnings (loaded on-demand)");
  lines.push("");
  if (fp.learningFiles.length === 0) {
    lines.push("> No learning files yet. Create `.pi/memory/learnings/<topic>.md` files with YAML frontmatter.");
  } else {
    for (const f of fp.learningFiles) {
      const desc = f.frontmatter.description ?? "(no description)";
      const size = Buffer.byteLength(f.raw, "utf-8");
      const tokens = estimateTokens(f.raw);
      lines.push(`- **\`${f.relPath}\`** — ${desc}  (${formatBytes(size)}, ~${tokens.toLocaleString()} tokens)`);
    }
    lines.push("");
  }

  // ── progress state ──────────────────────────────────────────────────
  if (fp.progress) {
    lines.push("## 📋 Current Progress");
    lines.push("");
    lines.push(`- **Task:** ${fp.progress.task}`);
    lines.push(`- **Status:** ${fp.progress.status.replace(/_/g, " ")}`);
    if (fp.progress.checklist.length > 0) {
      const done = fp.progress.checklist.filter((c) => c.done).length;
      const total = fp.progress.checklist.length;
      lines.push(`- **Checklist:** ${done}/${total} done`);
    }
    if (fp.progress.openDecisions.length > 0) {
      lines.push(`- **Open decisions:** ${fp.progress.openDecisions.length}`);
    }
    if (fp.progress.nextSteps.length > 0) {
      lines.push(`- **Next steps:** ${fp.progress.nextSteps.length}`);
    }
    lines.push("");
  }

  // ── memory topology ─────────────────────────────────────────────────
  lines.push("## 🗺️ Memory Topology");
  lines.push("");
  lines.push("```");
  lines.push(`.pi/memory/`);
  lines.push(`├── memory-map.md          ← this file`);
  lines.push(`├── system/                ← injected into context every turn`);
  for (const f of fp.systemFiles) {
    const name = path.basename(f.relPath);
    lines.push(`│   ├── ${name}`);
  }
  if (fp.systemFiles.length === 0) lines.push("│   (empty)");
  lines.push(`└── learnings/             ← loaded on-demand by agent`);
  for (const f of fp.learningFiles) {
    const name = path.basename(f.relPath);
    lines.push(`    ├── ${name}`);
  }
  if (fp.learningFiles.length === 0) lines.push("    (empty)");
  lines.push("```");
  lines.push("");

  // ── recommendations ─────────────────────────────────────────────────
  lines.push("## 💡 Management Tips");
  lines.push("");
  if (fp.budgetUtilization > 80) {
    lines.push("- ⚠️ **Budget nearly full.** Consider consolidating system files or moving some to learnings.");
  }
  if (fp.systemFiles.length > 5) {
    lines.push("- 📊 **Many system files.** Each adds to context cost. Consider merging smaller files or moving low-priority ones to learnings.");
  }
  if (fp.learningFiles.length === 0) {
    lines.push("- 📚 **Start building learnings.** Document patterns, decisions, and discoveries in `.pi/memory/learnings/`.");
  }
  lines.push("- Use **`/memory`** to see the full interactive memory dashboard at any time.");
  lines.push("- The agent can read/write memory files with normal `read`/`edit`/`write` tools.");
  lines.push("");

  // ── timestamp ───────────────────────────────────────────────────────
  lines.push(`---`);
  lines.push(`*Map generated ${new Date().toISOString()}*`);

  return lines.join("\n");
}

/** Read the current memory map file content, or generate a fresh one. */
export function readMemoryMap(cwd: string): string {
  const root = findMemoryRoot(cwd);
  if (!root) return "No memory directory found. Create `.pi/memory/` first.";

  const mapPath = path.join(root, "memory-map.md");
  if (fs.existsSync(mapPath)) {
    return fs.readFileSync(mapPath, "utf-8");
  }
  // Generate fresh
  const map = generateMemoryMap(cwd);
  try {
    fs.writeFileSync(mapPath, map, "utf-8");
  } catch {
    // Read-only project — return generated content without saving
  }
  return map;
}

/** Write a fresh memory map to disk. */
export function updateMemoryMap(cwd: string): string {
  const root = findMemoryRoot(cwd);
  if (!root) return "No memory directory found.";

  const map = generateMemoryMap(cwd);
  const mapPath = path.join(root, "memory-map.md");
  fs.writeFileSync(mapPath, map, "utf-8");
  return mapPath;
}

// ── formatting ────────────────────────────────────────────────────────────

/** Format a compact one-line view of memory footprint. */
export function formatFootprintLine(stats: MemoryStats): string {
  const injected = stats.injectedTokens > 0 ? `+${stats.injectedTokens.toLocaleString()}` : "0";
  return `🧠 ${stats.systemCount}S + ${stats.learningCount}L | ${formatBytes(stats.totalBytes)} | ~${stats.injectedTokens.toLocaleString()}t/inject | ${stats.budgetUtilization.toFixed(0)}% budget`;
}
