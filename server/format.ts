import {
  dayDiff,
  formatShortChineseDate,
  parseDateString,
  relativeDayLabel,
  toDateString,
} from "./dates.ts";
import {
  taskDueDate,
  taskEffort,
  taskPriority,
  taskSubtasks,
  type Effort,
  type Priority,
  type Task,
} from "./task-store.ts";

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "高优先级",
  normal: "中优先级",
  low: "低优先级",
};

export const EFFORT_LABELS: Record<Effort, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

export type TaskListScope = "all" | "open" | "done" | "today" | "overdue";

/** “○ 买牛奶（截止 明天 · 高优先级）”这样的一行。 */
export function formatTaskLine(task: Task, now = new Date()): string {
  return `${task.done ? "✓" : "○"} ${task.title}${describeTaskMeta(task, now)}`;
}

function describeTaskMeta(task: Task, now: Date): string {
  const details: string[] = [];
  const due = taskDueDate(task);
  if (due) {
    const days = dayDiff(due, now);
    const label = relativeDayLabel(due, now);
    if (days < 0 && !task.done) details.push(`截止 ${label}，已逾期`);
    else if (days === 0 && !task.done) details.push("今天到期");
    else details.push(`截止 ${label}`);
  }

  const priority = taskPriority(task);
  if (priority && priority !== "normal") details.push(PRIORITY_LABELS[priority]);

  const effort = taskEffort(task);
  if (effort) details.push(`工作量${EFFORT_LABELS[effort]}`);

  const subtasks = taskSubtasks(task);
  if (subtasks.length > 0) {
    details.push(`子任务 ${subtasks.filter((item) => item.done).length}/${subtasks.length}`);
  }

  if (task.note) details.push(`备注：${task.note}`);

  return details.length > 0 ? `（${details.join(" · ")}）` : "";
}

export interface ListOptions {
  /** 列表上方的说明，默认按清单整体情况生成。 */
  heading?: string;
  /** 为空时的提示语。 */
  emptyText?: string;
  /** 最多显示多少行，超出时提示还有多少条。 */
  limit?: number;
  now?: Date;
}

export function formatTaskList(tasks: Task[], options: ListOptions = {}): string {
  const now = options.now ?? new Date();
  if (tasks.length === 0) {
    return options.emptyText ?? "清单还是空的。跟我说「记一下买牛奶」就能添加第一条任务。";
  }

  const heading = options.heading ?? summarize(tasks);
  const limit = options.limit ?? 20;
  const visible = tasks.slice(0, limit).map((task) => formatTaskLine(task, now));
  if (tasks.length > visible.length) {
    visible.push(`……还有 ${tasks.length - visible.length} 项没有显示。`);
  }
  return [heading, ...visible].join("\n");
}

/** “清单里共有 2 项任务（1 项待办、1 项已完成）：” */
export function summarize(tasks: Task[]): string {
  if (tasks.length === 0) return "清单还是空的：";
  const open = tasks.filter((task) => !task.done).length;
  const done = tasks.length - open;
  if (done === 0) return `清单里共有 ${tasks.length} 项待办：`;
  if (open === 0) return `清单里共有 ${tasks.length} 项任务，全部已完成：`;
  return `清单里共有 ${tasks.length} 项任务（${open} 项待办、${done} 项已完成）：`;
}

/** 操作完成后的一句话总结，例如“还有 1 项待办：取快递”。 */
export function pendingSummary(tasks: Task[]): string {
  const open = tasks.filter((task) => !task.done);
  if (open.length === 0) {
    return tasks.length === 0 ? "清单已经清空了。" : "清单里没有待办了，全部完成。";
  }
  if (open.length > 5) return `还剩 ${open.length} 项待办。`;
  return `还有 ${open.length} 项待办：${open.map((task) => `「${task.title}」`).join("、")}。`;
}

/** “今天到期”的清单。 */
export function dueOn(tasks: Task[], now: Date): Task[] {
  const today = toDateString(now);
  return tasks.filter((task) => taskDueDate(task) === today);
}

export function sortByDue(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const left = taskDueDate(a) ?? "9999-99-99";
    const right = taskDueDate(b) ?? "9999-99-99";
    return left.localeCompare(right);
  });
}

export function overdueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    if (task.done) return false;
    const due = taskDueDate(task);
    if (!due || !parseDateString(due)) return false;
    return dayDiff(due, now) < 0;
  });
}

/** 按“查看范围”生成清单回复，规则引擎和模型工具共用同一套文案。 */
export function buildTaskListReply(tasks: Task[], scope: TaskListScope, now: Date): string {
  if (tasks.length === 0) {
    return "清单还是空的。跟我说「记一下买牛奶」就能添加第一条任务。";
  }

  const open = sortByDue(tasks.filter((task) => !task.done));
  const done = tasks.filter((task) => task.done);
  const overdue = overdueTasks(tasks, now);
  const overdueNames = overdue.map((task) => `「${task.title}」`).join("、");

  if (scope === "today") {
    const due = dueOn(tasks, now);
    if (due.length === 0) {
      const extra =
        overdue.length > 0 ? `另有 ${overdue.length} 项已经逾期：${overdueNames}。` : "";
      return `今天（${formatShortChineseDate(now)}）没有到期的任务。${extra}`;
    }
    const lines = [
      formatTaskList(due, {
        heading: `今天（${formatShortChineseDate(now)}）有 ${due.length} 项任务到期：`,
        now,
      }),
    ];
    if (overdue.length > 0) lines.push(`另有 ${overdue.length} 项已经逾期：${overdueNames}。`);
    return lines.join("\n");
  }

  if (scope === "overdue") {
    return overdue.length > 0
      ? formatTaskList(overdue, { heading: `有 ${overdue.length} 项任务已经逾期：`, now })
      : "没有逾期的任务，节奏保持得不错。";
  }

  if (scope === "open") {
    return open.length > 0
      ? formatTaskList(open, { heading: `还有 ${open.length} 项待办：`, now })
      : "清单里没有待办了，全部完成。";
  }

  if (scope === "done") {
    return done.length > 0
      ? formatTaskList(done, { heading: `已完成 ${done.length} 项：`, now })
      : "还没有已完成的任务。";
  }

  const lines = [formatTaskList([...open, ...done], { now })];
  if (overdue.length > 0) lines.push(`注意：其中 ${overdue.length} 项已经逾期。`);
  return lines.join("\n");
}
