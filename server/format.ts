import { dayDiff, deadlineMoment, relativeDayLabel } from "./dates.ts";
import {
  taskDueDate,
  taskDueTime,
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

/** 距离截止时间不到一天（含已逾期）的未完成任务，展示时加感叹号提醒。 */
export const URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isUrgent(task: Task, now = new Date()): boolean {
  if (task.done) return false;
  const due = taskDueDate(task);
  if (!due) return false;
  const moment = deadlineMoment(due, taskDueTime(task));
  if (!moment) return false;
  return moment.getTime() - now.getTime() <= URGENT_WINDOW_MS;
}

/** “○ 买牛奶（截止 明天 · 高优先级）”这样的一行；快到截止时间时前面加“!”。 */
export function formatTaskLine(task: Task, now = new Date()): string {
  const mark = isUrgent(task, now) ? "! " : "";
  return `${mark}${task.done ? "✓" : "○"} ${task.title}${taskDetails(task, now)}`;
}

/** 带子任务明细的多行展示：第一行是任务，缩进列出每个子任务的标题和完成状态。 */
export function formatTaskBlock(task: Task, now = new Date()): string {
  const line = formatTaskLine(task, now);
  const subtasks = taskSubtasks(task);
  if (subtasks.length === 0) return line;
  const detail = subtasks.map((subtask) => `　　${subtask.done ? "✓" : "○"} ${subtask.title}`);
  return [line, ...detail].join("\n");
}

/** 任务标题后面的补充信息，例如“（截止 明天 · 高优先级 · 子任务 1/2）”。 */
export function taskDetails(task: Task, now: Date): string {
  const details: string[] = [];
  const due = taskDueDate(task);
  if (due) {
    const days = dayDiff(due, now);
    const label = relativeDayLabel(due, now);
    const time = taskDueTime(task);
    const moment = `${label}${time ? ` ${time}` : ""}`;
    const overdue =
      !task.done &&
      (() => {
        const deadline = deadlineMoment(due, time);
        return deadline !== undefined && deadline.getTime() < now.getTime();
      })();
    if (overdue) details.push(`截止 ${moment}，已逾期`);
    else if (days === 0 && !task.done) details.push(time ? `${moment} 到期` : "今天到期");
    else details.push(`截止 ${moment}`);
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
  const visible = tasks.slice(0, limit).map((task) => formatTaskBlock(task, now));
  const lines = visible.flatMap((block) => block.split("\n"));
  if (tasks.length > visible.length) {
    lines.push(`……还有 ${tasks.length - visible.length} 项没有显示。`);
  }
  return [heading, ...lines].join("\n");
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
