// pi-tools persistent configuration.
//
// Two layers, merged with project taking precedence:
//   global:  ~/.pi/pi-tools.json
//   project: <cwd>/.pi/pi-tools.json
//
// Environment overrides beat both (PI_SUBAGENT_MODEL for subagentModel).
// Edited interactively via /config; read by the footer (greeting name),
// the git-identity hook, and the subagent spawner.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PiToolsConfig {
  /** Name shown on the footer's bottom line. */
  greetingName?: string;
  /** Git identity injected into `git commit` invocations. */
  gitName?: string;
  gitEmail?: string;
  /** Model passed to subagent subprocesses (`--model`). Defaults to
   *  DEFAULT_SUBAGENT_MODEL (a capable, agentic model) so subagents behave
   *  reliably without babysitting; override to something lighter/cheaper if
   *  your subtasks are simple, or "" to inherit the main session's model. */
  subagentModel?: string;
  /** Delegation harness (auto subagent-utilization steering). "off"/"false"
   *  disables hints and nudges. Default: on. */
  autoDelegate?: string | boolean;
  /** Memory Health Engine (autonomous scoring/healing of .pi/memory).
   *  "off"/"false" disables sweeps; /heal still works. Default: on. */
  memoryHealth?: string | boolean;
  /** Quiet Output (compact oversized tool output before it reaches the
   *  model). "off"/"false" disables compaction. Default: on. */
  quietOutput?: string | boolean;
}

export const CONFIG_DEFAULTS: Required<Pick<PiToolsConfig, "greetingName" | "gitName" | "gitEmail">> = {
  greetingName: "Muhammad Adeel Chaudhary",
  gitName: "adeel.bot",
  gitEmail: "adeel.bot@suadeo.net",
};

export function globalConfigPath(): string {
  return path.join(os.homedir(), ".pi", "pi-tools.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-tools.json");
}

function readJsonFile(p: string): PiToolsConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as PiToolsConfig) : {};
  } catch {
    return {};
  }
}

// Footer renders read config every frame — cache briefly to avoid disk I/O.
const CACHE_TTL_MS = 3000;
let cache: { cwd: string; value: PiToolsConfig; at: number } | undefined;

/** Merged config: project overrides global. No defaults applied — callers
 *  that want fallbacks use the getters below. */
export function loadConfig(cwd: string): PiToolsConfig {
  const now = Date.now();
  if (cache && cache.cwd === cwd && now - cache.at < CACHE_TTL_MS) return cache.value;
  const value = { ...readJsonFile(globalConfigPath()), ...readJsonFile(projectConfigPath(cwd)) };
  cache = { cwd, value, at: now };
  return value;
}

/** Drop the read cache (called after /config saves so changes show immediately). */
export function invalidateConfigCache(): void {
  cache = undefined;
}

/** Merge `patch` into the config file at the given scope. Returns the path written. */
export function saveConfig(
  cwd: string,
  patch: PiToolsConfig,
  scope: "project" | "global" = "project",
): string {
  const file = scope === "project" ? projectConfigPath(cwd) : globalConfigPath();
  const current = readJsonFile(file);
  const merged: Record<string, unknown> = { ...current, ...patch };
  // Drop keys explicitly set to undefined/empty string so they fall back.
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined || merged[k] === "") delete merged[k];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  invalidateConfigCache();
  return file;
}

export function getGreetingName(cwd: string): string {
  return loadConfig(cwd).greetingName ?? CONFIG_DEFAULTS.greetingName;
}

export function getGitIdentity(cwd: string): { name: string; email: string } {
  const cfg = loadConfig(cwd);
  return {
    name: cfg.gitName ?? CONFIG_DEFAULTS.gitName,
    email: cfg.gitEmail ?? CONFIG_DEFAULTS.gitEmail,
  };
}

/** Default subagent model — a capable, agentic model so spawned subagents
 *  behave reliably without babysitting, rather than silently inheriting
 *  whatever model the main session happens to be on. */
export const DEFAULT_SUBAGENT_MODEL = "claude-fable-5";

/** Model for subagent subprocesses. Falls back to DEFAULT_SUBAGENT_MODEL;
 *  set subagentModel to the literal "inherit" to use pi's default model
 *  instead (i.e. whatever the main session is running). */
export function getSubagentModel(cwd: string): string | undefined {
  const configured = process.env.PI_SUBAGENT_MODEL || loadConfig(cwd).subagentModel;
  if (configured === "inherit") return undefined;
  return configured || DEFAULT_SUBAGENT_MODEL;
}

function toggleEnabled(v: string | boolean | undefined): boolean {
  if (v === false) return false;
  if (typeof v === "string" && /^(off|false|0|no|disabled)$/i.test(v.trim())) return false;
  return true;
}

/** Whether the delegation harness (hints + nudges) is enabled. Default: on. */
export function isAutoDelegateEnabled(cwd: string): boolean {
  return toggleEnabled(loadConfig(cwd).autoDelegate);
}

/** Whether autonomous memory-health sweeps are enabled. Default: on. */
export function isMemoryHealthEnabled(cwd: string): boolean {
  return toggleEnabled(loadConfig(cwd).memoryHealth);
}

/** Whether Quiet Output compaction is enabled. Default: on. */
export function isQuietOutputEnabled(cwd: string): boolean {
  return toggleEnabled(loadConfig(cwd).quietOutput);
}
