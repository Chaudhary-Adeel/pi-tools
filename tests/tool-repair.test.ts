// Tests for lib/tool-repair.ts — normalizing the malformed-but-recoverable
// tool arguments weaker/open models emit.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";

import {
  repairArrayInput,
  unwrapDegenerateMarkdownLink,
  recordRepair,
  recordUnrepairable,
  resetToolRepairStats,
  toolRepairStats,
  formatToolRepairStats,
} from "../src/lib/tool-repair.ts";
import { normalizeSubTasks, registerSubagentTool } from "../src/tools/subagents.ts";

describe("repairArrayInput", () => {
  test("already-valid arrays are returned untouched", () => {
    const input = ["a", "b"];
    const r = repairArrayInput<string>(input);
    assert.strictEqual(r.repaired, false);
    assert.strictEqual(r.value, input, "must be the same reference, not a copy");
  });

  test("empty array is valid, not 'repaired' into something else", () => {
    const r = repairArrayInput<string>([]);
    assert.strictEqual(r.repaired, false);
    assert.deepStrictEqual(r.value, []);
  });

  test("stringified JSON array is parsed, not wrapped", () => {
    // The ordering trap: if bare-string-wrap ran first, this would become
    // ['["a","b"]'] instead of ["a","b"].
    const r = repairArrayInput<string>('["a","b"]');
    assert.strictEqual(r.method, "json-string-parse");
    assert.deepStrictEqual(r.value, ["a", "b"]);
  });

  test("stringified JSON array of objects is parsed", () => {
    const r = repairArrayInput<{ prompt: string }>('[{"prompt":"x"}]');
    assert.strictEqual(r.method, "json-string-parse");
    assert.deepStrictEqual(r.value, [{ prompt: "x" }]);
  });

  test("explicit null counts as a repair (sent null instead of omitting)", () => {
    const r = repairArrayInput(null);
    assert.deepStrictEqual(r.value, []);
    assert.strictEqual(r.repaired, true);
    assert.strictEqual(r.method, "null-to-empty");
  });

  test("an ABSENT optional field is not a repair (no false-positive telemetry)", () => {
    // Regression: counting undefined as "repaired" logged a bogus repair on
    // every call that simply omitted an optional array field (e.g. ask_user
    // with no choices — the common case).
    const r = repairArrayInput(undefined);
    assert.deepStrictEqual(r.value, []);
    assert.strictEqual(r.repaired, false);
    assert.strictEqual(r.method, undefined);
  });

  test("sequential numeric-keyed object becomes an array", () => {
    const r = repairArrayInput<string>({ "0": "a", "1": "b" });
    assert.strictEqual(r.method, "numeric-keyed-object");
    assert.deepStrictEqual(r.value, ["a", "b"]);
  });

  test("non-sequential keyed object is treated as a single bare value", () => {
    const obj = { prompt: "hello" };
    const r = repairArrayInput(obj);
    assert.strictEqual(r.method, "wrap-bare-value");
    assert.deepStrictEqual(r.value, [obj]);
  });

  test("bare non-JSON string is wrapped, not parsed", () => {
    const r = repairArrayInput<string>("just a task");
    assert.strictEqual(r.method, "wrap-bare-value");
    assert.deepStrictEqual(r.value, ["just a task"]);
  });

  test("a JSON string that isn't an array is wrapped, not spread", () => {
    // '{"a":1}' parses as JSON but isn't an array — must not be mistaken
    // for a parseable array, and must not lose data.
    const r = repairArrayInput('{"a":1}');
    assert.strictEqual(r.method, "wrap-bare-value");
    assert.deepStrictEqual(r.value, ['{"a":1}']);
  });

  test("numbers and booleans are wrapped", () => {
    assert.deepStrictEqual(repairArrayInput(42).value, [42]);
    assert.deepStrictEqual(repairArrayInput(false).value, [false]);
  });
});

describe("unwrapDegenerateMarkdownLink", () => {
  test("unwraps the degenerate case (link text === url without protocol)", () => {
    assert.strictEqual(
      unwrapDegenerateMarkdownLink("/proj/[notes.md](http://notes.md)"),
      "/proj/notes.md",
    );
    assert.strictEqual(
      unwrapDegenerateMarkdownLink("[src/index.ts](https://src/index.ts)"),
      "src/index.ts",
    );
  });

  test("unwraps when there is no protocol at all", () => {
    assert.strictEqual(unwrapDegenerateMarkdownLink("[a.md](a.md)"), "a.md");
  });

  test("leaves a REAL markdown link untouched", () => {
    const real = "[click here](https://example.com)";
    assert.strictEqual(unwrapDegenerateMarkdownLink(real), real);
  });

  test("leaves ordinary paths untouched", () => {
    assert.strictEqual(unwrapDegenerateMarkdownLink("/usr/local/bin"), "/usr/local/bin");
    assert.strictEqual(unwrapDegenerateMarkdownLink(""), "");
  });

  test("leaves a path containing brackets but no link syntax untouched", () => {
    assert.strictEqual(unwrapDegenerateMarkdownLink("/proj/[id]/page.tsx"), "/proj/[id]/page.tsx");
  });
});

describe("normalizeSubTasks", () => {
  test("valid task array passes through unrepaired", () => {
    const r = normalizeSubTasks([{ prompt: "a" }, { prompt: "b", context: "c" }]);
    assert.strictEqual(r.repaired, false);
    assert.deepStrictEqual(r.tasks, [{ prompt: "a" }, { prompt: "b", context: "c" }]);
  });

  test("stringified JSON array of task objects", () => {
    const r = normalizeSubTasks('[{"prompt":"alpha"},{"prompt":"beta"}]');
    assert.strictEqual(r.repaired, true);
    assert.deepStrictEqual(r.tasks, [{ prompt: "alpha" }, { prompt: "beta" }]);
  });

  test("single bare task object", () => {
    const r = normalizeSubTasks({ prompt: "only one" });
    assert.strictEqual(r.repaired, true);
    assert.deepStrictEqual(r.tasks, [{ prompt: "only one" }]);
  });

  test("bare prompt string", () => {
    const r = normalizeSubTasks("do the thing");
    assert.strictEqual(r.repaired, true);
    assert.deepStrictEqual(r.tasks, [{ prompt: "do the thing" }]);
  });

  test("array of bare strings instead of {prompt} objects", () => {
    const r = normalizeSubTasks(["first", "second"]);
    assert.strictEqual(r.repaired, true);
    assert.deepStrictEqual(r.tasks, [{ prompt: "first" }, { prompt: "second" }]);
  });

  test("near-miss key names for the prompt are accepted", () => {
    assert.deepStrictEqual(normalizeSubTasks([{ task: "via task" }]).tasks, [{ prompt: "via task" }]);
    assert.deepStrictEqual(normalizeSubTasks([{ instruction: "via instruction" }]).tasks, [
      { prompt: "via instruction" },
    ]);
  });

  test("entries with no usable prompt are dropped", () => {
    const r = normalizeSubTasks([{ prompt: "keep" }, { unrelated: 1 }, { prompt: "   " }]);
    assert.deepStrictEqual(r.tasks, [{ prompt: "keep" }]);
  });

  test("null yields no tasks (caller surfaces a usable error)", () => {
    assert.deepStrictEqual(normalizeSubTasks(null).tasks, []);
  });

  test("absent tasks is not reported as a repair", () => {
    const r = normalizeSubTasks(undefined);
    assert.deepStrictEqual(r.tasks, []);
    assert.strictEqual(r.repaired, false);
  });

  test("context is preserved when present", () => {
    const r = normalizeSubTasks('[{"prompt":"p","context":"ctx"}]');
    assert.deepStrictEqual(r.tasks, [{ prompt: "p", context: "ctx" }]);
  });
});

// These assert the CENTRAL design premise against Pi's real validator: a
// permissive union member lets malformed shapes reach execute() (where we
// repair them), whereas a strict array makes Pi reject the call upstream
// before any extension code runs.
describe("permissive schemas vs Pi's real validateToolArguments", () => {
  const SUBTASK = Type.Object({ prompt: Type.String(), context: Type.Optional(Type.String()) });
  const strict: any = { name: "t", parameters: Type.Object({ tasks: Type.Array(SUBTASK) }) };
  const permissive: any = {
    name: "t",
    parameters: Type.Object({ tasks: Type.Union([Type.Array(SUBTASK), SUBTASK, Type.String()]) }),
  };
  const validate = (tool: any, args: unknown) => {
    try {
      return { ok: true, value: validateToolArguments(tool, { name: "t", arguments: args } as any) };
    } catch {
      return { ok: false as const, value: undefined };
    }
  };

  test("strict schema REJECTS a stringified array upstream (the bug)", () => {
    assert.strictEqual(validate(strict, { tasks: '[{"prompt":"a"}]' }).ok, false);
  });

  test("permissive schema lets it reach execute(), where repair fixes it", () => {
    const r = validate(permissive, { tasks: '[{"prompt":"a"}]' });
    assert.strictEqual(r.ok, true);
    const normalized = normalizeSubTasks((r.value as any).tasks);
    assert.deepStrictEqual(normalized.tasks, [{ prompt: "a" }]);
  });

  test("permissive schema still passes genuinely valid input unchanged", () => {
    const valid = { tasks: [{ prompt: "a" }, { prompt: "b" }] };
    const r = validate(permissive, valid);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.value, valid);
    assert.strictEqual(normalizeSubTasks((r.value as any).tasks).repaired, false);
  });
});

describe("unrepairable input is counted once, with model-readable guidance", () => {
  beforeEach(() => resetToolRepairStats());

  test("spawn_subagents: unusable tasks -> 1 unrepairable, 0 repairs, shape hint", async () => {
    const tools: Record<string, any> = {};
    const fakePi: any = {
      registerTool: (d: any) => { tools[d.name] = d; },
      registerCommand: () => {}, registerMessageRenderer: () => {}, sendMessage: () => {}, on: () => {},
    };
    registerSubagentTool(fakePi);
    const ctx: any = { cwd: process.cwd(), ui: { notify() {}, setStatus() {}, setWidget() {} } };

    const res = await tools["spawn_subagents"].execute("c", { tasks: null }, undefined, undefined, ctx);
    const s = toolRepairStats();
    // Regression: this used to record BOTH a repair and an unrepairable.
    assert.strictEqual(s.invalid, 1);
    assert.strictEqual(s.repaired, 0, "must not also count a repair");
    const txt = res.content[0].text as string;
    assert.match(txt, /prompt/, "must tell the model the expected shape");
    assert.doesNotMatch(txt, /^Error:/, "guidance should not read as a hard error");
  });
});

describe("repair telemetry", () => {
  beforeEach(() => resetToolRepairStats());

  test("counts repairs and unrepairables per tool", () => {
    recordRepair("tasks");
    recordRepair("tasks");
    recordUnrepairable("spawn_subagents");
    const s = toolRepairStats();
    assert.strictEqual(s.repaired, 2);
    assert.strictEqual(s.invalid, 1);
    assert.deepStrictEqual(s.byTool.get("tasks"), { repaired: 2, invalid: 0 });
    assert.deepStrictEqual(s.byTool.get("spawn_subagents"), { repaired: 0, invalid: 1 });
  });

  test("formats a quiet message when nothing was repaired", () => {
    assert.match(formatToolRepairStats(), /no malformed tool calls/);
  });

  test("formats per-tool breakdown once repairs happen", () => {
    recordRepair("write");
    const out = formatToolRepairStats();
    assert.match(out, /1 repaired/);
    assert.match(out, /write/);
  });
});
