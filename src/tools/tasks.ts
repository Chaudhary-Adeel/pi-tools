// tasks — structured task list for progressive task resolution.
//
// The agent breaks multi-step work into tasks, marks each in_progress before
// starting and completed only after verifying it. Open tasks are re-injected
// into the system prompt each session so work survives compaction/restarts.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { text, firstText } from "../lib/shared.ts";
import {
  addTasks,
  clearCompleted,
  formatTaskList,
  loadTasks,
  updateTask,
  type TaskStatus,
} from "../lib/tasks.ts";

export function registerTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tasks",
    label: "Task List",
    description:
      "Manage a persistent structured task list (.pi/tasks.json) for " +
      "multi-step work. Actions: 'add' (subjects: one or more task titles), " +
      "'update' (id + status/subject/notes), 'list', 'clear_done'. " +
      "Statuses: pending → in_progress → completed. Mark a task in_progress " +
      "before starting it and completed only after verifying the work.",
    promptSnippet: "track multi-step work in a structured task list",
    promptGuidelines: [
      "For any task with 3+ distinct steps, call tasks {action:'add'} up front, then keep statuses current as you work.",
      "Only mark a task completed after you've verified the work (build/tests/behavior) — not when you merely finished typing.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("clear_done"),
        ],
        { description: "What to do." },
      ),
      subjects: Type.Optional(
        Type.Array(Type.String(), {
          description: "For 'add': one or more task titles (imperative form).",
        }),
      ),
      id: Type.Optional(Type.Number({ description: "For 'update': the task id." })),
      status: Type.Optional(
        Type.Union(
          [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
          { description: "For 'update': new status." },
        ),
      ),
      subject: Type.Optional(Type.String({ description: "For 'update': new title." })),
      notes: Type.Optional(
        Type.String({ description: "For 'update': blockers, decisions, outcome." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      switch (params.action) {
        case "add": {
          const subjects = params.subjects ?? [];
          if (subjects.length === 0) throw new Error("'add' needs subjects: [...titles].");
          const added = addTasks(cwd, subjects);
          return text(
            `Added ${added.length} task(s):\n${formatTaskList(added)}`,
            { count: added.length, open: openCount(cwd) },
          );
        }
        case "update": {
          if (params.id === undefined) throw new Error("'update' needs an id.");
          const updated = updateTask(cwd, params.id, {
            status: params.status as TaskStatus | undefined,
            subject: params.subject,
            notes: params.notes,
          });
          if (!updated) throw new Error(`No task with id ${params.id}.`);
          return text(`Updated:\n${formatTaskList([updated])}`, {
            id: updated.id,
            status: updated.status,
            open: openCount(cwd),
          });
        }
        case "list": {
          const tasks = loadTasks(cwd);
          return text(formatTaskList(tasks), {
            count: tasks.length,
            open: tasks.filter((t) => t.status !== "completed").length,
          });
        }
        case "clear_done": {
          const removed = clearCompleted(cwd);
          return text(`Removed ${removed} completed task(s).`, {
            removed,
            open: openCount(cwd),
          });
        }
        default:
          throw new Error(`Unknown action: ${String(params.action)}`);
      }
    },
    renderCall(args, theme, _context) {
      let t = theme.fg("toolTitle", theme.bold("tasks "));
      t += theme.fg("muted", (args.action as string) ?? "?");
      if (args.action === "update" && args.id !== undefined) {
        t += theme.fg("dim", ` #${args.id}`);
        if (args.status) t += theme.fg("dim", ` → ${args.status as string}`);
      }
      if (args.action === "add" && Array.isArray(args.subjects)) {
        t += theme.fg("dim", ` (${args.subjects.length})`);
      }
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result, "Error")), 0, 0);
      }
      const d = result.details as Record<string, unknown> | undefined;
      const open = (d?.open as number) ?? 0;
      let summary =
        theme.fg("success", "✓ ") + theme.fg("muted", `${open} open task(s)`);
      if (expanded) summary += "\n" + theme.fg("dim", firstText(result));
      return new Text(summary, 0, 0);
    },
  });
}

function openCount(cwd: string): number {
  return loadTasks(cwd).filter((t) => t.status !== "completed").length;
}
