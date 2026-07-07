// Structured task list persisted at .pi/tasks.json.
//
// Backs the `tasks` tool (agent-managed checklist for progressive task
// resolution) and the /newTask command. Kept separate from
// .pi/memory/system/progress.md — progress.md is free-form narrative,
// tasks.json is structured state the agent updates as it works.

import * as fs from "node:fs";
import * as path from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  id: number;
  subject: string;
  status: TaskStatus;
  /** Optional running notes: blockers, decisions, outcome. */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export function tasksFilePath(cwd: string): string {
  return path.join(cwd, ".pi", "tasks.json");
}

export function loadTasks(cwd: string): TaskItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFilePath(cwd), "utf-8"));
    return Array.isArray(parsed) ? (parsed as TaskItem[]) : [];
  } catch {
    return [];
  }
}

export function saveTasks(cwd: string, tasks: TaskItem[]): void {
  const file = tasksFilePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(tasks, null, 2) + "\n", "utf-8");
}

export function addTasks(cwd: string, subjects: string[]): TaskItem[] {
  const tasks = loadTasks(cwd);
  const now = new Date().toISOString();
  let nextId = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
  const added: TaskItem[] = [];
  for (const subject of subjects) {
    const s = subject.trim();
    if (!s) continue;
    const item: TaskItem = { id: nextId++, subject: s, status: "pending", createdAt: now, updatedAt: now };
    tasks.push(item);
    added.push(item);
  }
  saveTasks(cwd, tasks);
  return added;
}

export function updateTask(
  cwd: string,
  id: number,
  patch: Partial<Pick<TaskItem, "subject" | "status" | "notes">>,
): TaskItem | undefined {
  const tasks = loadTasks(cwd);
  const task = tasks.find((t) => t.id === id);
  if (!task) return undefined;
  if (patch.subject !== undefined) task.subject = patch.subject;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.notes !== undefined) task.notes = patch.notes;
  task.updatedAt = new Date().toISOString();
  saveTasks(cwd, tasks);
  return task;
}

export function clearCompleted(cwd: string): number {
  const tasks = loadTasks(cwd);
  const remaining = tasks.filter((t) => t.status !== "completed");
  const removed = tasks.length - remaining.length;
  if (removed > 0) saveTasks(cwd, remaining);
  return removed;
}

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

export function formatTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) return "No tasks.";
  return tasks
    .map((t) => {
      let line = `${STATUS_ICON[t.status]} #${t.id} ${t.subject}`;
      if (t.notes) line += `\n      ${t.notes}`;
      return line;
    })
    .join("\n");
}

/** Open-task block injected into the system prompt, or "" when idle. */
export function formatTasksInjection(cwd: string): string {
  const open = loadTasks(cwd).filter((t) => t.status !== "completed");
  if (open.length === 0) return "";
  return [
    "<task_list>",
    "Open tasks (manage with the `tasks` tool — mark in_progress before starting, completed when verified done):",
    formatTaskList(open),
    "</task_list>",
  ].join("\n");
}
