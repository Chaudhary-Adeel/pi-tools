// Tests for lib/config.ts — layered pi-tools configuration.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CONFIG_DEFAULTS,
  DEFAULT_SUBAGENT_MODEL,
  loadConfig,
  saveConfig,
  getGreetingName,
  getGitIdentity,
  getSubagentModel,
  invalidateConfigCache,
  projectConfigPath,
} from "../src/lib/config.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-config-"));
  invalidateConfigCache();
  delete process.env.PI_SUBAGENT_MODEL;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  invalidateConfigCache();
  delete process.env.PI_SUBAGENT_MODEL;
});

describe("loadConfig", () => {
  test("returns empty object when no config files exist", () => {
    assert.deepStrictEqual(loadConfig(tmpDir), {});
  });

  test("reads project config", () => {
    saveConfig(tmpDir, { gitName: "test.bot" }, "project");
    assert.strictEqual(loadConfig(tmpDir).gitName, "test.bot");
  });

  test("survives malformed JSON", () => {
    const p = projectConfigPath(tmpDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{not json", "utf-8");
    invalidateConfigCache();
    assert.deepStrictEqual(loadConfig(tmpDir), {});
  });
});

describe("saveConfig", () => {
  test("merges patches instead of replacing", () => {
    saveConfig(tmpDir, { gitName: "a" }, "project");
    saveConfig(tmpDir, { gitEmail: "b@c.d" }, "project");
    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.gitName, "a");
    assert.strictEqual(cfg.gitEmail, "b@c.d");
  });

  test("empty string clears a key back to default", () => {
    saveConfig(tmpDir, { greetingName: "Custom" }, "project");
    saveConfig(tmpDir, { greetingName: "" }, "project");
    assert.strictEqual(getGreetingName(tmpDir), CONFIG_DEFAULTS.greetingName);
  });

  test("invalidates the read cache", () => {
    assert.strictEqual(loadConfig(tmpDir).gitName, undefined);
    saveConfig(tmpDir, { gitName: "fresh" }, "project");
    assert.strictEqual(loadConfig(tmpDir).gitName, "fresh");
  });
});

describe("getters with defaults", () => {
  test("getGreetingName falls back to default", () => {
    assert.strictEqual(getGreetingName(tmpDir), CONFIG_DEFAULTS.greetingName);
  });

  test("getGitIdentity falls back to defaults", () => {
    assert.deepStrictEqual(getGitIdentity(tmpDir), {
      name: CONFIG_DEFAULTS.gitName,
      email: CONFIG_DEFAULTS.gitEmail,
    });
  });

  test("getGitIdentity uses configured values", () => {
    saveConfig(tmpDir, { gitName: "me", gitEmail: "me@example.com" }, "project");
    assert.deepStrictEqual(getGitIdentity(tmpDir), { name: "me", email: "me@example.com" });
  });

  test("getSubagentModel: unset → DEFAULT_SUBAGENT_MODEL", () => {
    assert.strictEqual(getSubagentModel(tmpDir), DEFAULT_SUBAGENT_MODEL);
  });

  test("getSubagentModel: config value used", () => {
    saveConfig(tmpDir, { subagentModel: "small-model" }, "project");
    assert.strictEqual(getSubagentModel(tmpDir), "small-model");
  });

  test('getSubagentModel: "inherit" → undefined (use pi\'s default model)', () => {
    saveConfig(tmpDir, { subagentModel: "inherit" }, "project");
    assert.strictEqual(getSubagentModel(tmpDir), undefined);
  });

  test("getSubagentModel: env overrides config", () => {
    saveConfig(tmpDir, { subagentModel: "small-model" }, "project");
    process.env.PI_SUBAGENT_MODEL = "env-model";
    assert.strictEqual(getSubagentModel(tmpDir), "env-model");
  });
});
