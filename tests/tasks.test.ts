// Tests for lib/tasks.ts — persistent structured task list.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  addTasks,
  clearCompleted,
  formatTaskList,
  formatTasksInjection,
  loadTasks,
  updateTask,
} from "../src/lib/tasks.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-tasks-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("addTasks", () => {
  test("assigns sequential ids and pending status", () => {
    const added = addTasks(tmpDir, ["first", "second"]);
    assert.strictEqual(added.length, 2);
    assert.deepStrictEqual(added.map((t) => t.id), [1, 2]);
    assert.ok(added.every((t) => t.status === "pending"));
  });

  test("ids keep increasing after deletions", () => {
    addTasks(tmpDir, ["a"]);
    updateTask(tmpDir, 1, { status: "completed" });
    clearCompleted(tmpDir);
    const [b] = addTasks(tmpDir, ["b"]);
    assert.strictEqual(b!.id, 1); // list empty again → restart from 1
    const [c] = addTasks(tmpDir, ["c"]);
    assert.strictEqual(c!.id, 2);
  });

  test("skips blank subjects", () => {
    const added = addTasks(tmpDir, ["  ", "real"]);
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0]!.subject, "real");
  });
});

describe("updateTask", () => {
  test("updates status and notes", () => {
    addTasks(tmpDir, ["work"]);
    const updated = updateTask(tmpDir, 1, { status: "in_progress", notes: "started" });
    assert.strictEqual(updated?.status, "in_progress");
    assert.strictEqual(updated?.notes, "started");
    assert.strictEqual(loadTasks(tmpDir)[0]!.status, "in_progress");
  });

  test("returns undefined for unknown id", () => {
    assert.strictEqual(updateTask(tmpDir, 99, { status: "completed" }), undefined);
  });
});

describe("clearCompleted", () => {
  test("removes only completed tasks", () => {
    addTasks(tmpDir, ["a", "b", "c"]);
    updateTask(tmpDir, 2, { status: "completed" });
    const removed = clearCompleted(tmpDir);
    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(loadTasks(tmpDir).map((t) => t.subject), ["a", "c"]);
  });
});

describe("formatting", () => {
  test("formatTaskList marks statuses", () => {
    addTasks(tmpDir, ["a", "b"]);
    updateTask(tmpDir, 1, { status: "in_progress" });
    updateTask(tmpDir, 2, { status: "completed" });
    const out = formatTaskList(loadTasks(tmpDir));
    assert.match(out, /\[~\] #1 a/);
    assert.match(out, /\[x\] #2 b/);
  });

  test("formatTasksInjection is empty when nothing is open", () => {
    assert.strictEqual(formatTasksInjection(tmpDir), "");
    addTasks(tmpDir, ["done soon"]);
    updateTask(tmpDir, 1, { status: "completed" });
    assert.strictEqual(formatTasksInjection(tmpDir), "");
  });

  test("formatTasksInjection lists open tasks in a tagged block", () => {
    addTasks(tmpDir, ["open item"]);
    const block = formatTasksInjection(tmpDir);
    assert.match(block, /^<task_list>/);
    assert.match(block, /open item/);
    assert.match(block, /<\/task_list>$/);
  });
});
