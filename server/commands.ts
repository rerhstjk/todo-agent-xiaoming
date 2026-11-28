import { randomUUID } from "node:crypto";
import { normalizeForMatch, resolveTask } from "./matching.ts";
import { nextDueDate, type Repeat } from "./recurrence.ts";
import { selectTasks, type TaskScope } from "./selection.ts";
import {
  taskDueDate,
  taskDueTime,
  taskEffortHours,
  taskPriority,
  taskRepeat,
  taskStartDate,
  taskStartTime,
  taskSubtasks,
  taskTags,
  type Priority,
  type Subtask,
  type Task,
  type TaskPatch,
  type TaskStore,
} from "./task-store.ts";

/**
 * 清单的领域层：把「对清单做一件事」表达成 Command，执行后返回结构化 Result。
 * 规则引擎和模型工具都只是把各自协议的输入翻译成 Command，再把 Result 交给 replies 渲染。
 */
export type SubtaskAction = "add" | "complete" | "remove";

export interface NewTaskInput {
  title: string;
  startDate?: string;
  startTime?: string;
  dueDate?: string;
  dueTime?: string;
  priority?: Priority;
  /** 预计用时（小时）。 */
  effort?: number;
  note?: string;
  tags?: string[];
  repeat?: Repeat;
  remind?: boolean;
  /** 自定义提醒时刻，格式 YYYY-MM-DDTHH:mm。 */
  reminderAt?: string[];
  subtasks?: string[];
}

export type Command =
  | { kind: "create"; input: NewTaskInput }
  | { kind: "list"; scope?: TaskScope }
  | { kind: "setDone"; hint: string; done: boolean }
  | { kind: "remove"; hint: string }
  | { kind: "rename"; hint: string; title: string }
  | { kind: "update"; hint: string; patch: TaskPatch }
  /** 带 taskId 时直接按 id 定位，避免同名的多条任务产生歧义。 */
  | { kind: "subtask"; hint: string; action: SubtaskAction; subtask: string; taskId?: string }
  | { kind: "clearDone" }
  | { kind: "undo" };

export type ResultStatus = "ok" | "unchanged" | "missing" | "ambiguous" | "invalid";

export type ResultReason =
  | "already-done"
  | "already-open"
  | "duplicate-subtask"
  | "subtask-missing"
  | "subtask-already-done"
  | "no-fields"
  | "nothing-to-undo"
  | "empty-list";

export interface CommandResult {
  command: Command;
  status: ResultStatus;
  /** 是否真的改动了清单。 */
  changed: boolean;
  /** 执行完之后的完整清单快照。 */
  tasks: Task[];
  /** list 命令筛出来的任务。 */
  selection?: Task[];
  scope?: TaskScope;
  /** 本次操作涉及的任务（操作后的状态）。 */
  task?: Task;
  hint?: string;
  candidates?: Task[];
  reason?: ResultReason;
  subtask?: Subtask;
  /** 任务当前的全部子任务（操作后）。 */
  subtasks?: Subtask[];
  /** 创建时发现同名未完成任务。 */
  duplicate?: Task;
  /** 改名前的标题，渲染「把 A 改成 B」时用。 */
  previousTitle?: string;
  cleared?: number;
  /** 完成重复任务时自动生成的下一次任务。 */
  nextTask?: Task;
  /** 适配层给出的说明，例如日期格式无法识别。 */
  message?: string;
}

export function execute(store: TaskStore, command: Command, now = new Date()): CommandResult {
  switch (command.kind) {
    case "create":
      return create(store, command);
    case "list":
      return list(store, command, now);
    case "setDone":
      return setDone(store, command, now);
    case "remove":
      return remove(store, command);
    case "rename":
      return rename(store, command);
    case "update":
      return update(store, command);
    case "subtask":
      return subtask(store, command);
    case "clearDone":
      return clearDone(store, command);
    case "undo":
      return undo(store, command);
  }
}

function create(store: TaskStore, command: Extract<Command, { kind: "create" }>): CommandResult {
  const { input } = command;
  const duplicate = store
    .list()
    .find((task) => !task.done && normalizeForMatch(task.title) === normalizeForMatch(input.title));

  const task = store.create(input);
  return {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    task,
    duplicate,
  };
}

function list(
  store: TaskStore,
  command: Extract<Command, { kind: "list" }>,
  now: Date,
): CommandResult {
  const scope = command.scope ?? "all";
  const tasks = store.list();
  return {
    command,
    status: "ok",
    changed: false,
    tasks,
    selection: selectTasks(tasks, scope, now),
    scope,
  };
}

function setDone(
  store: TaskStore,
  command: Extract<Command, { kind: "setDone" }>,
  now: Date,
): CommandResult {
  const tasks = store.list();
  const located = locate(command, tasks);
  if ("failed" in located) return located.failed;
  const task = located.task;

  if (task.done === command.done) {
    return {
      command,
      status: "unchanged",
      changed: false,
      tasks,
      task,
      reason: command.done ? "already-done" : "already-open",
    };
  }

  const updated = store.update(task.id, { done: command.done });
  const result: CommandResult = {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    task: updated ?? task,
  };

  // 重复任务：完成当前这一条后，自动排好下一次，避免用户每天手动重记。
  if (updated && command.done) {
    result.nextTask = createNextOccurrence(store, updated, now);
    if (result.nextTask) result.tasks = store.list();
  }
  return result;
}

/**
 * 完成一条重复任务后，按原任务的日期、标签、预计用时等复制出下一次。
 * 对话和清单面板最后都走这里，避免两边行为不一致。
 */
export function createNextOccurrence(
  store: TaskStore,
  task: Task,
  now = new Date(),
): Task | undefined {
  const repeat = taskRepeat(task);
  if (!repeat) return undefined;
  return store.create({
    title: task.title,
    note: typeof task.note === "string" ? task.note : undefined,
    startDate: nextDueDate(taskStartDate(task), repeat, now),
    startTime: taskStartTime(task),
    dueDate: nextDueDate(taskDueDate(task), repeat, now),
    dueTime: taskDueTime(task),
    priority: taskPriority(task),
    effort: taskEffortHours(task),
    tags: taskTags(task),
    repeat,
    remind: task.remind === true,
    reminderAt: shiftReminderAt(task, repeat),
    subtasks: taskSubtasks(task).map((item) => item.title),
  });
}

/** 自定义提醒时刻跟着下一次的日期一起顺延；默认提醒不用存时刻。 */
function shiftReminderAt(task: Task, repeat: Repeat): string[] | undefined {
  const values = Array.isArray(task.reminderAt) ? task.reminderAt : [];
  if (values.length === 0) return undefined;
  const oldDate = taskDueDate(task) ?? taskStartDate(task);
  if (!oldDate) return undefined;
  const nextDate = nextDueDate(oldDate, repeat, new Date());
  const days = Math.round(
    (new Date(`${nextDate}T00:00`).getTime() - new Date(`${oldDate}T00:00`).getTime()) / 86_400_000,
  );
  if (!Number.isFinite(days) || days === 0) return values;
  return values.map((value) => {
    const [date, time] = value.split("T");
    const shifted = new Date(`${date}T00:00`);
    shifted.setDate(shifted.getDate() + days);
    const year = shifted.getFullYear();
    const month = String(shifted.getMonth() + 1).padStart(2, "0");
    const day = String(shifted.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}T${time ?? "09:00"}`;
  });
}

function remove(store: TaskStore, command: Extract<Command, { kind: "remove" }>): CommandResult {
  const tasks = store.list();
  const located = locate(command, tasks);
  if ("failed" in located) return located.failed;
  const task = located.task;
  store.remove(task.id);
  return {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    task,
  };
}

function rename(store: TaskStore, command: Extract<Command, { kind: "rename" }>): CommandResult {
  const tasks = store.list();
  const located = locate(command, tasks);
  if ("failed" in located) return located.failed;
  const task = located.task;
  const updated = store.update(task.id, { title: command.title });
  return {
    command,
    status: updated ? "ok" : "missing",
    changed: Boolean(updated),
    tasks: store.list(),
    task: updated ?? task,
    hint: command.hint,
    previousTitle: task.title,
  };
}

function update(store: TaskStore, command: Extract<Command, { kind: "update" }>): CommandResult {
  const tasks = store.list();
  if (Object.keys(command.patch).length === 0) {
    return {
      command,
      status: "invalid",
      changed: false,
      tasks,
      reason: "no-fields",
    };
  }

  const located = locate(command, tasks);
  if ("failed" in located) return located.failed;
  const task = located.task;
  // 清掉日期时，时刻也没有意义了，一起删掉，避免留下孤立的 17:00。
  const patch =
    command.patch.dueDate === null ? { ...command.patch, dueTime: null } : command.patch;
  const updated = store.update(task.id, patch);
  return {
    command,
    status: updated ? "ok" : "missing",
    changed: Boolean(updated),
    tasks: store.list(),
    task: updated ?? task,
    hint: command.hint,
  };
}

function subtask(store: TaskStore, command: Extract<Command, { kind: "subtask" }>): CommandResult {
  const tasks = store.list();
  const known = command.taskId ? store.get(command.taskId) : undefined;
  const located = known ? { task: known } : locate(command, tasks);
  if ("failed" in located) return located.failed;
  const task = located.task;
  const current = taskSubtasks(task);
  const existing = findSubtask(current, command.subtask);

  if (command.action === "add") {
    if (existing) {
      return {
        command,
        status: "unchanged",
        changed: false,
        tasks,
        task,
        reason: "duplicate-subtask",
        subtask: existing,
        subtasks: current,
      };
    }
    const next = [...current, { id: randomUUID(), title: command.subtask, done: false }];
    const updated = store.update(task.id, { subtasks: next });
    return {
      command,
      status: "ok",
      changed: true,
      tasks: store.list(),
      task: updated ?? task,
      subtask: next[next.length - 1],
      subtasks: next,
    };
  }

  if (!existing) {
    return {
      command,
      status: "unchanged",
      changed: false,
      tasks,
      task,
      reason: "subtask-missing",
      subtasks: current,
    };
  }

  if (command.action === "complete" && existing.done) {
    return {
      command,
      status: "unchanged",
      changed: false,
      tasks,
      task,
      reason: "subtask-already-done",
      subtask: existing,
      subtasks: current,
    };
  }

  const next =
    command.action === "complete"
      ? current.map((item) => (item.id === existing.id ? { ...item, done: true } : item))
      : current.filter((item) => item.id !== existing.id);
  const updated = store.update(task.id, { subtasks: next });
  return {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    task: updated ?? task,
    subtask: command.action === "complete" ? { ...existing, done: true } : existing,
    subtasks: next,
  };
}

function clearDone(
  store: TaskStore,
  command: Extract<Command, { kind: "clearDone" }>,
): CommandResult {
  const tasks = store.list();
  const done = tasks.filter((task) => task.done);
  if (done.length === 0) {
    return {
      command,
      status: "unchanged",
      changed: false,
      tasks,
      reason: "empty-list",
    };
  }

  for (const task of done) store.remove(task.id);
  return {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    cleared: done.length,
  };
}

function undo(store: TaskStore, command: Extract<Command, { kind: "undo" }>): CommandResult {
  const restored = store.restoreLast?.();
  if (!restored) {
    return {
      command,
      status: "unchanged",
      changed: false,
      tasks: store.list(),
      reason: "nothing-to-undo",
    };
  }
  return {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    task: restored,
  };
}

/**
 * 定位命令要作用的任务；定位失败时把 missing / ambiguous 折进结果里，
 * 由调用方直接返回，渲染交给 replies。
 */
function locate(command: Command, tasks: Task[]): { task: Task } | { failed: CommandResult } {
  const resolution = resolveTask(tasks, "hint" in command ? command.hint : "");
  if (resolution.kind === "found") return { task: resolution.task };
  return {
    failed: {
      command,
      status: resolution.kind === "ambiguous" ? "ambiguous" : "missing",
      changed: false,
      tasks,
      hint: "hint" in command ? command.hint : undefined,
      candidates: resolution.kind === "ambiguous" ? resolution.candidates : undefined,
    },
  };
}

/** 先按完整标题匹配，再按包含关系兜底。 */
function findSubtask(subtasks: Subtask[], hint: string): Subtask | undefined {
  const normalized = normalizeForMatch(hint);
  return (
    subtasks.find((item) => normalizeForMatch(item.title) === normalized) ??
    subtasks.find((item) => normalizeForMatch(item.title).includes(normalized)) ??
    subtasks.find((item) => normalized.includes(normalizeForMatch(item.title)))
  );
}
