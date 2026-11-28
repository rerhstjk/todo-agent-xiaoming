import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { toEffortHours } from "./effort.ts";
import { isRepeat, type Repeat } from "./recurrence.ts";

export const priorities = ["low", "normal", "high"] as const;
export type Priority = (typeof priorities)[number];

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
  /** 开始日期，YYYY-MM-DD；用于「从明天开始」这类安排。 */
  startDate?: string;
  /** 开始时刻，HH:mm；只有 startDate 存在时才有意义。 */
  startTime?: string;
  dueDate?: string;
  /** 截止时刻，HH:mm；只有 dueDate 存在时才有意义。 */
  dueTime?: string;
  priority?: Priority;
  /** 预计用时（小时），0.25–100。 */
  effort?: number;
  /** 自定义标签，例如「生活」「采购」。 */
  tags?: string[];
  /** 重复周期；有值时完成一条会生成下一次。 */
  repeat?: Repeat;
  /** 用户是否给这条任务打开了提醒（默认不提醒）。 */
  remind?: boolean;
  /** 自定义提醒时刻，格式 YYYY-MM-DDTHH:mm（本地时间）；为空时用开始前 30 分钟 + 截止前 10 分钟。 */
  reminderAt?: string[];
  subtasks?: Subtask[];
  [key: string]: unknown;
}

const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);

const TITLE_MAX_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const REMINDER_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export interface NewTask {
  title: string;
  note?: string;
  /** 开始日期，YYYY-MM-DD；用于「从明天开始」这类安排。 */
  startDate?: string;
  /** 开始时刻，HH:mm；只有 startDate 存在时才有意义。 */
  startTime?: string;
  dueDate?: string;
  /** 截止时刻，HH:mm；只有 dueDate 存在时才有意义。 */
  dueTime?: string;
  priority?: Priority;
  effort?: number;
  tags?: string[];
  repeat?: Repeat;
  remind?: boolean;
  reminderAt?: string[];
  subtasks?: string[];
}

/** 值为 null 表示清空该扩展字段，undefined 表示不修改。 */
export interface TaskPatch {
  title?: string;
  done?: boolean;
  note?: string | null;
  startDate?: string | null;
  startTime?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: Priority | null;
  effort?: number | null;
  tags?: string[] | null;
  repeat?: Repeat | null;
  remind?: boolean | null;
  reminderAt?: string[] | null;
  subtasks?: Subtask[] | null;
}

export interface TaskStore {
  list(): Task[];
  get(id: string): Task | undefined;
  create(input: string | NewTask): Task;
  update(id: string, changes: TaskPatch): Task | undefined;
  remove(id: string): boolean;
  /** 撤销最近一次删除；内存里只保留最近 20 条，重启后清空。 */
  restoreLast?(): Task | undefined;
  /** 对话编辑回滚：整份清单快照（深拷贝）。 */
  snapshotAll?(): Task[];
  /** 用快照覆盖整份清单并落盘。 */
  restoreAll?(tasks: Task[]): void;
}

export function isDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value);
}

export function isTimeString(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

export function taskDueTime(task: Task): string | undefined {
  return isTimeString(task.dueTime) ? task.dueTime : undefined;
}

export function isReminderMoment(value: unknown): value is string {
  return typeof value === "string" && REMINDER_PATTERN.test(value);
}

/** 规整自定义提醒时刻：只保留合法且不重复的项，最多 5 个。 */
export function normalizeReminderAt(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isReminderMoment(raw)) continue;
    seen.add(raw);
    if (seen.size >= 5) break;
  }
  return [...seen];
}

export function taskReminderAt(task: Task): string[] {
  return normalizeReminderAt(task.reminderAt);
}

export function taskRemind(task: Task): boolean {
  return task.remind === true;
}

export function taskStartDate(task: Task): string | undefined {
  return isDateString(task.startDate) ? task.startDate : undefined;
}

export function taskStartTime(task: Task): string | undefined {
  return isDateString(task.startDate) && isTimeString(task.startTime) ? task.startTime : undefined;
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

/** 读任务的工作量（小时），兼容旧数据里的 small/medium/large。 */
export function taskEffortHours(task: Task): number | undefined {
  return toEffortHours(task.effort);
}

const TAGS_MAX = 10;
const TAG_MAX_LENGTH = 20;

/** 规整标签：去掉 #、空白和重复项，最多 10 个、每个 20 字。 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, "").slice(0, TAG_MAX_LENGTH);
    if (!tag) continue;
    seen.add(tag);
    if (seen.size >= TAGS_MAX) break;
  }
  return [...seen];
}

export function taskTags(task: Task): string[] {
  return normalizeTags(task.tags);
}

export function taskRepeat(task: Task): Repeat | undefined {
  return isRepeat(task.repeat) ? task.repeat : undefined;
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

  // 被删掉的任务先留在内存里，供「撤销」恢复；不落盘，重启后就没有了。
  const deleted: Task[] = [];

  function toTask(input: string | NewTask): Task {
    const draft = typeof input === "string" ? { title: input } : input;
    const task: Task = { id: randomUUID(), title: normalizeTitle(draft.title), done: false };
    if (draft.note?.trim()) task.note = draft.note.trim();
    if (isDateString(draft.startDate)) task.startDate = draft.startDate;
    if (isDateString(draft.startDate) && isTimeString(draft.startTime))
      task.startTime = draft.startTime;
    if (isDateString(draft.dueDate)) task.dueDate = draft.dueDate;
    if (isDateString(draft.dueDate) && isTimeString(draft.dueTime)) task.dueTime = draft.dueTime;
    if (draft.priority) task.priority = draft.priority;
    const effort = toEffortHours(draft.effort);
    if (effort !== undefined) task.effort = effort;
    const tags = normalizeTags(draft.tags);
    if (tags.length > 0) task.tags = tags;
    if (isRepeat(draft.repeat)) task.repeat = draft.repeat;
    if (draft.remind === true) task.remind = true;
    const reminderAt = normalizeReminderAt(draft.reminderAt);
    if (reminderAt.length > 0) task.reminderAt = reminderAt;

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

    snapshotAll() {
      return structuredClone(list());
    },

    restoreAll(tasks) {
      save(taskList.parse(tasks) as Task[]);
    },

    remove(id) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return false;
      deleted.push(structuredClone(task));
      if (deleted.length > 20) deleted.shift();

      save(tasks.filter((item) => item.id !== id));
      return true;
    },

    restoreLast() {
      const task = deleted.pop();
      if (!task) return undefined;
      const tasks = list();
      // 极端情况下同 id 已经被重新创建，换一个 id 避免覆盖。
      const restored = tasks.some((item) => item.id === task.id)
        ? { ...task, id: randomUUID() }
        : task;
      save([...tasks, restored]);
      return restored;
    },
  };
}

let shared: TaskStore | undefined;

/** 服务端共用一个指向 data/tasks.json 的实例，智能体与任务 API 必须读写同一份清单。 */
export function defaultTaskStore(): TaskStore {
  shared ??= createJsonTaskStore(join("data", "tasks.json"));
  return shared;
}
