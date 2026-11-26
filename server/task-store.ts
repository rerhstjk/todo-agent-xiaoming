import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const priorities = ["low", "normal", "high"] as const;
export type Priority = (typeof priorities)[number];

export const efforts = ["small", "medium", "large"] as const;
export type Effort = (typeof efforts)[number];

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

/**
 * 任务清单里唯一必填的字段是 id / title / done，其余都是可选扩展字段。
 * 存储层使用 looseObject 解析，因此旧清单或人工写入的额外字段都不会丢失。
 */
export interface Task {
  id: string;
  title: string;
  done: boolean;
  note?: string;
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  subtasks?: Subtask[];
  [key: string]: unknown;
}

const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);

const TITLE_MAX_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface NewTask {
  title: string;
  note?: string;
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  subtasks?: string[];
}

/** 值为 null 表示清空该扩展字段，undefined 表示不修改。 */
export interface TaskPatch {
  title?: string;
  done?: boolean;
  note?: string | null;
  dueDate?: string | null;
  priority?: Priority | null;
  effort?: Effort | null;
  subtasks?: Subtask[] | null;
}

export interface TaskStore {
  list(): Task[];
  get(id: string): Task | undefined;
  create(input: string | NewTask): Task;
  update(id: string, changes: TaskPatch): Task | undefined;
  remove(id: string): boolean;
}

export function isDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value);
}

export function taskDueDate(task: Task): string | undefined {
  return isDateString(task.dueDate) ? task.dueDate : undefined;
}

export function taskPriority(task: Task): Priority | undefined {
  const value: unknown = task.priority;
  return typeof value === "string" && (priorities as readonly string[]).includes(value)
    ? (value as Priority)
    : undefined;
}

export function taskEffort(task: Task): Effort | undefined {
  const value: unknown = task.effort;
  return typeof value === "string" && (efforts as readonly string[]).includes(value)
    ? (value as Effort)
    : undefined;
}

export function taskSubtasks(task: Task): Subtask[] {
  const value: unknown = task.subtasks;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Subtask => {
    if (typeof item !== "object" || item === null) return false;
    const subtask = item as Partial<Subtask>;
    return (
      typeof subtask.id === "string" &&
      typeof subtask.title === "string" &&
      typeof subtask.done === "boolean"
    );
  });
}

export function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("任务标题不能为空。");
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw new Error(`任务标题不能超过 ${TITLE_MAX_LENGTH} 个字符。`);
  }
  return trimmed;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filename, "utf8"));
    } catch {
      throw new Error(`任务清单文件 ${filename} 不是有效的 JSON，请修复或删除后重试。`);
    }
    return taskList.parse(raw) as Task[];
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  function toTask(input: string | NewTask): Task {
    const draft = typeof input === "string" ? { title: input } : input;
    const task: Task = { id: randomUUID(), title: normalizeTitle(draft.title), done: false };
    if (draft.note?.trim()) task.note = draft.note.trim();
    if (isDateString(draft.dueDate)) task.dueDate = draft.dueDate;
    if (draft.priority) task.priority = draft.priority;
    if (draft.effort) task.effort = draft.effort;

    const subtasks = (draft.subtasks ?? [])
      .map((title) => ({ id: randomUUID(), title: title.trim(), done: false }))
      .filter((subtask) => subtask.title.length > 0);
    if (subtasks.length > 0) task.subtasks = subtasks;
    return task;
  }

  return {
    list,

    get(id) {
      return list().find((task) => task.id === id);
    },

    create(input) {
      const task = toTask(input);
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;
      if (changes.title !== undefined)
        changes = { ...changes, title: normalizeTitle(changes.title) };

      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (value === null) delete task[key];
        else task[key] = value;
      }

      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}

let shared: TaskStore | undefined;

/** 服务端共用一个指向 data/tasks.json 的实例，智能体与任务 API 必须读写同一份清单。 */
export function defaultTaskStore(): TaskStore {
  shared ??= createJsonTaskStore(join("data", "tasks.json"));
  return shared;
}
