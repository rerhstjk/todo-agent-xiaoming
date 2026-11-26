import { randomUUID } from "node:crypto";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { findDateText, parseDateString, relativeDayLabel, toDateString } from "./dates.ts";
import {
  buildTaskListReply,
  formatTaskList,
  pendingSummary,
  type TaskListScope,
} from "./format.ts";
import { normalizeForMatch, resolveTask } from "./matching.ts";
import {
  efforts,
  priorities,
  taskSubtasks,
  type Effort,
  type Priority,
  type Subtask,
  type Task,
  type TaskPatch,
  type TaskStore,
} from "./task-store.ts";

/** 交给模型的工具清单，参数描述直接写中文，减少模型猜字段的情况。 */
export const toolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "新建一条待办任务。用户说「记一下…」「提醒我…」「添加…」时调用。一句话里有多个任务时，每个任务各调用一次。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "任务标题，去掉语气词，例如「买牛奶」" },
          dueDate: {
            type: "string",
            description: "截止日期，格式 YYYY-MM-DD。用户没提到日期就不要传。",
          },
          priority: {
            type: "string",
            enum: [...priorities],
            description: "优先级：high 高、normal 中（默认）、low 低。",
          },
          effort: {
            type: "string",
            enum: [...efforts],
            description: "工作量：small 小、medium 中、large 大。用户没提到就不要传。",
          },
          note: { type: "string", description: "补充备注，可为空。" },
          subtasks: {
            type: "array",
            items: { type: "string" },
            description: "子任务标题列表，用户提到拆步骤时使用。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "查看任务清单。用户问「我有哪些任务」「还剩什么」「今天有什么到期」时调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: {
            type: "string",
            enum: ["all", "open", "done", "today", "overdue"],
            description: "all 全部、open 未完成、done 已完成、today 今天到期、overdue 已逾期。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "修改一条已有任务：标记完成/未完成、改标题、改截止日期、改优先级、改工作量、改备注。一次可以修改多个字段。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "要修改的任务标题或其中的关键词，例如「牛奶」" },
          newTitle: { type: "string", description: "新的任务标题，不改标题就不要传。" },
          done: { type: "boolean", description: "true 标记完成，false 重新打开。" },
          dueDate: {
            type: "string",
            description: "新的截止日期 YYYY-MM-DD；传空字符串表示清除截止日期；不修改就不要传。",
          },
          priority: {
            type: "string",
            enum: [...priorities, "none"],
            description: "新优先级；none 表示清除优先级。",
          },
          effort: {
            type: "string",
            enum: [...efforts, "none"],
            description: "新的工作量；none 表示清除工作量。",
          },
          note: { type: "string", description: "新的备注；传空字符串表示清除备注。" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "删除一条任务。用户说「删掉」「不要了」「去掉」时调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "要删除的任务标题或其中的关键词" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_subtasks",
      description: "给任务添加、完成或删除子任务。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "action", "subtask"],
        properties: {
          title: { type: "string", description: "父任务的标题或关键词" },
          action: {
            type: "string",
            enum: ["add", "complete", "remove"],
            description: "add 新增、complete 完成、remove 删除子任务。",
          },
          subtask: { type: "string", description: "子任务标题" },
        },
      },
    },
  },
];

const createArgs = z.object({
  title: z.string().trim().min(1).max(200),
  dueDate: z.string().optional(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
  subtasks: z.array(z.string()).max(20).optional(),
});

const listArgs = z.object({
  scope: z.enum(["all", "open", "done", "today", "overdue"]).optional(),
});

const updateArgs = z.object({
  title: z.string().trim().min(1),
  newTitle: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
  dueDate: z.string().optional(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const deleteArgs = z.object({
  title: z.string().trim().min(1),
});

const subtaskArgs = z.object({
  title: z.string().trim().min(1),
  action: z.enum(["add", "complete", "remove"]),
  subtask: z.string().trim().min(1).max(200),
});

export interface PublicTask {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  note?: string;
  subtasks?: Subtask[];
}

export interface ToolOutcome {
  ok: boolean;
  /** 是否真的改动了清单。模型兜底时用它判断能否重跑规则引擎。 */
  changed: boolean;
  /** 给模型看的中文结果，可以直接作为回复依据。 */
  message: string;
  data?: unknown;
}

export function toPublicTask(task: Task): PublicTask {
  const result: PublicTask = { id: task.id, title: task.title, done: task.done };
  if (typeof task.dueDate === "string" && task.dueDate) result.dueDate = task.dueDate;
  if (task.priority) result.priority = task.priority;
  if (task.effort) result.effort = task.effort;
  if (task.note) result.note = task.note;
  const subtasks = taskSubtasks(task);
  if (subtasks.length > 0) result.subtasks = subtasks;
  return result;
}

export function runTool(
  store: TaskStore,
  name: string,
  rawArgs: unknown,
  now = new Date(),
): ToolOutcome {
  try {
    switch (name) {
      case "create_task":
        return createTask(store, rawArgs, now);
      case "list_tasks":
        return listTasks(store, rawArgs, now);
      case "update_task":
        return updateTask(store, rawArgs, now);
      case "delete_task":
        return deleteTask(store, rawArgs, now);
      case "manage_subtasks":
        return manageSubtasks(store, rawArgs, now);
      default:
        return {
          ok: false,
          changed: false,
          message: `未知工具「${name}」，请不要调用不存在的工具。`,
        };
    }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      message: error instanceof Error ? error.message : "工具执行失败，请稍后重试。",
    };
  }
}

function createTask(store: TaskStore, rawArgs: unknown, now: Date): ToolOutcome {
  const args = createArgs.parse(rawArgs);
  const duplicate = store
    .list()
    .find((task) => !task.done && normalizeForMatch(task.title) === normalizeForMatch(args.title));

  const task = store.create({
    title: args.title,
    dueDate: normalizeDueDate(args.dueDate, now),
    priority: parsePriority(args.priority) ?? undefined,
    effort: parseEffort(args.effort) ?? undefined,
    note: args.note?.trim() || undefined,
    subtasks: args.subtasks,
  });

  const lines = [
    `已记下「${task.title}」${describeNewTask(task, now)}。`,
    pendingSummary(store.list()),
  ];
  if (duplicate) lines.push(`清单里本来就有一条同名的未完成任务「${duplicate.title}」。`);

  return { ok: true, changed: true, message: lines.join(" "), data: toPublicTask(task) };
}

function describeNewTask(task: Task, now: Date): string {
  const details: string[] = [];
  if (typeof task.dueDate === "string" && task.dueDate) {
    details.push(`截止 ${relativeDayLabel(task.dueDate, now)}`);
  }
  if (task.priority === "high") details.push("高优先级");
  if (task.priority === "low") details.push("低优先级");
  if (task.effort) details.push(`工作量${task.effort}`);
  return details.length > 0 ? `（${details.join(" · ")}）` : "";
}

function listTasks(store: TaskStore, rawArgs: unknown, now: Date): ToolOutcome {
  const args = listArgs.parse(rawArgs ?? {});
  const scope: TaskListScope = args.scope ?? "all";
  const tasks = store.list();
  return {
    ok: true,
    changed: false,
    message: buildTaskListReply(tasks, scope, now),
    data: tasks.map(toPublicTask),
  };
}

function updateTask(store: TaskStore, rawArgs: unknown, now: Date): ToolOutcome {
  const args = updateArgs.parse(rawArgs);
  const tasks = store.list();
  const resolution = resolveTask(tasks, args.title);
  if (resolution.kind === "missing") return taskNotFound(tasks, args.title);
  if (resolution.kind === "ambiguous") return taskAmbiguous(resolution.candidates);

  const task = resolution.task;
  const changes: TaskPatch = {};
  if (args.done !== undefined) changes.done = args.done;
  if (args.newTitle) changes.title = args.newTitle;

  if (args.dueDate !== undefined) {
    const value = args.dueDate.trim();
    if (!value) changes.dueDate = null;
    else {
      const dueDate = normalizeDueDate(value, now);
      if (!dueDate) {
        return {
          ok: false,
          changed: false,
          message: `无法识别日期「${args.dueDate}」，请用 YYYY-MM-DD 格式。`,
        };
      }
      changes.dueDate = dueDate;
    }
  }

  const priority = parsePriority(args.priority);
  if (priority !== undefined) changes.priority = priority;
  const effort = parseEffort(args.effort);
  if (effort !== undefined) changes.effort = effort;
  if (args.note !== undefined) changes.note = args.note.trim() || null;

  if (Object.keys(changes).length === 0) {
    return { ok: false, changed: false, message: "这次没有需要修改的字段。" };
  }

  const updated = store.update(task.id, changes);
  if (!updated)
    return { ok: false, changed: false, message: `「${task.title}」已经不在清单里了。` };

  const message =
    args.done === undefined
      ? `已更新「${updated.title}」。`
      : args.done
        ? `已把「${updated.title}」标记为已完成。`
        : `已把「${updated.title}」重新标记为待办。`;
  return {
    ok: true,
    changed: true,
    message: `${message}${pendingSummary(store.list())}`,
    data: toPublicTask(updated),
  };
}

function deleteTask(store: TaskStore, rawArgs: unknown, _now: Date): ToolOutcome {
  const args = deleteArgs.parse(rawArgs);
  const tasks = store.list();
  const resolution = resolveTask(tasks, args.title);
  if (resolution.kind === "missing") return taskNotFound(tasks, args.title);
  if (resolution.kind === "ambiguous") return taskAmbiguous(resolution.candidates);

  const task = resolution.task;
  store.remove(task.id);
  return {
    ok: true,
    changed: true,
    message: `已删除「${task.title}」。${pendingSummary(store.list())}`,
    data: { id: task.id, title: task.title },
  };
}

function manageSubtasks(store: TaskStore, rawArgs: unknown, _now: Date): ToolOutcome {
  const args = subtaskArgs.parse(rawArgs);
  const tasks = store.list();
  const resolution = resolveTask(tasks, args.title);
  if (resolution.kind === "missing") return taskNotFound(tasks, args.title);
  if (resolution.kind === "ambiguous") return taskAmbiguous(resolution.candidates);

  const task = resolution.task;
  const subtasks = taskSubtasks(task);
  const existing = findSubtask(subtasks, args.subtask);

  if (args.action === "add") {
    if (existing) {
      return {
        ok: false,
        changed: false,
        message: `「${task.title}」下已经有子任务「${existing.title}」了。`,
      };
    }
    const next = [...subtasks, { id: randomUUID(), title: args.subtask, done: false }];
    store.update(task.id, { subtasks: next });
    return {
      ok: true,
      changed: true,
      message: `已给「${task.title}」添加子任务「${args.subtask}」。${pendingSummary(store.list())}`,
      data: toPublicTask({ ...task, subtasks: next }),
    };
  }

  if (!existing) {
    return {
      ok: false,
      changed: false,
      message: `「${task.title}」下没有子任务「${args.subtask}」。`,
    };
  }

  if (args.action === "complete") {
    if (existing.done)
      return { ok: false, changed: false, message: `子任务「${existing.title}」之前就完成了。` };
    const next = subtasks.map((item) => (item.id === existing.id ? { ...item, done: true } : item));
    store.update(task.id, { subtasks: next });
    return {
      ok: true,
      changed: true,
      message: `已完成子任务「${existing.title}」（「${task.title}」进度 ${next.filter((item) => item.done).length}/${next.length}）。${pendingSummary(store.list())}`,
      data: toPublicTask({ ...task, subtasks: next }),
    };
  }

  const next = subtasks.filter((item) => item.id !== existing.id);
  store.update(task.id, { subtasks: next });
  return {
    ok: true,
    changed: true,
    message: `已删除子任务「${existing.title}」。`,
    data: toPublicTask({ ...task, subtasks: next }),
  };
}

function taskNotFound(tasks: Task[], hint: string): ToolOutcome {
  const open = tasks.filter((task) => !task.done);
  const visible = open.length > 0 ? open : tasks;
  const list = formatTaskList(visible, {
    heading: open.length > 0 ? "当前待办：" : "当前清单：",
    limit: 10,
  });
  return {
    ok: false,
    changed: false,
    message: `没找到和「${hint}」对应的任务。请向用户确认任务名称。\n${list}`,
    data: { tasks: tasks.map(toPublicTask) },
  };
}

function taskAmbiguous(candidates: Task[]): ToolOutcome {
  return {
    ok: false,
    changed: false,
    message: `有多条任务都可能匹配，不能直接修改，请先向用户确认是哪一条：${candidates
      .map((task) => `「${task.title}」`)
      .join("、")}。`,
    data: { candidates: candidates.map(toPublicTask) },
  };
}

function findSubtask(subtasks: Subtask[], hint: string): Subtask | undefined {
  const normalized = normalizeForMatch(hint);
  return (
    subtasks.find((item) => normalizeForMatch(item.title) === normalized) ??
    subtasks.find((item) => normalizeForMatch(item.title).includes(normalized)) ??
    subtasks.find((item) => normalized.includes(normalizeForMatch(item.title)))
  );
}

function normalizeDueDate(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const date = parseDateString(trimmed);
  if (date) return toDateString(date);
  return findDateText(trimmed, now)?.value;
}

function parsePriority(value: string | undefined): Priority | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "clear" || normalized === "无")
    return null;
  if (["high", "高", "高优先级", "重要", "紧急"].includes(normalized)) return "high";
  if (["low", "低", "低优先级", "不急"].includes(normalized)) return "low";
  if (["normal", "medium", "中", "中优先级", "普通"].includes(normalized)) return "normal";
  return undefined;
}

function parseEffort(value: string | undefined): Effort | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "clear" || normalized === "无")
    return null;
  if (["small", "小", "小工作量"].includes(normalized)) return "small";
  if (["medium", "中", "中工作量"].includes(normalized)) return "medium";
  if (["large", "大", "大工作量"].includes(normalized)) return "large";
  return undefined;
}
