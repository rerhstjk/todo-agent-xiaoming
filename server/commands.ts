import { randomUUID } from "node:crypto";
import { normalizeForMatch, resolveTask } from "./matching.ts";
import { selectTasks, type TaskScope } from "./selection.ts";
import {
  taskSubtasks,
  type Effort,
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
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  note?: string;
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
  | { kind: "clearDone" };

export type ResultStatus = "ok" | "unchanged" | "missing" | "ambiguous" | "invalid";

export type ResultReason =
  | "already-done"
  | "already-open"
  | "duplicate-subtask"
  | "subtask-missing"
  | "subtask-already-done"
  | "no-fields"
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
      return setDone(store, command);
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

function setDone(store: TaskStore, command: Extract<Command, { kind: "setDone" }>): CommandResult {
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
  return {
    command,
    status: "ok",
    changed: true,
    tasks: store.list(),
    task: updated ?? task,
  };
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
  const updated = store.update(task.id, command.patch);
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
