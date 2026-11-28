import { addDays, deadlineMoment, startOfDay, toDateString } from "./dates.ts";
import {
  taskDueDate,
  taskDueTime,
  taskPriority,
  taskStartDate,
  taskStartTime,
  type Task,
} from "./task-store.ts";

/**
 * 清单的“查看范围”。规则引擎和模型工具都只表达这个枚举，
 * 具体筛选规则集中在这里，避免两边各写一份。
 */
export type TaskScope = "all" | "open" | "done" | "today" | "tomorrow" | "week" | "overdue";

export const taskScopes: readonly TaskScope[] = [
  "all",
  "open",
  "done",
  "today",
  "tomorrow",
  "week",
  "overdue",
];

export function isTaskScope(value: unknown): value is TaskScope {
  return typeof value === "string" && (taskScopes as readonly string[]).includes(value);
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

function priorityWeight(task: Task): number {
  return PRIORITY_ORDER[taskPriority(task) ?? "normal"] ?? 1;
}

/** 清单现在只有一个时间轴：开始时间。老数据没有开始字段时用截止字段兜底。 */
function scheduleDate(task: Task): string | undefined {
  return taskStartDate(task) ?? taskDueDate(task);
}

function scheduleTime(task: Task): string | undefined {
  return taskStartTime(task) ?? taskDueTime(task);
}

/**
 * 默认排序：先按开始时间，早的在前。
 * 时间相同、或两边都没有时间时，高优先级在前。
 */
export function sortByDue(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    // 手动排过序时 position 优先；没排过的任务按时间。
    const positionA = typeof a.position === "number" ? a.position : Number.POSITIVE_INFINITY;
    const positionB = typeof b.position === "number" ? b.position : Number.POSITIVE_INFINITY;
    if (positionA !== positionB) return positionA - positionB;

    const left = scheduleMoment(a);
    const right = scheduleMoment(b);
    if (left !== right) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left < right ? -1 : 1;
    }
    return priorityWeight(a) - priorityWeight(b);
  });
}

function scheduleMoment(task: Task): number | undefined {
  const date = scheduleDate(task);
  if (!date) return undefined;
  return deadlineMoment(date, scheduleTime(task) ?? "09:00")?.getTime();
}

/** 开始时刻已经过去、还没完成就算逾期；只有日期时按当天 23:59 算。 */
export function isOverdue(task: Task, now: Date): boolean {
  if (task.done) return false;
  const date = scheduleDate(task);
  if (!date) return false;
  const moment = deadlineMoment(date, scheduleTime(task));
  return moment !== undefined && moment.getTime() < now.getTime();
}

export function overdueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => isOverdue(task, now));
}

/** 指定某一天到期的任务（包含已完成的，便于展示当天结果）。 */
export function dueOnDate(tasks: Task[], date: string): Task[] {
  return sortByDue(tasks.filter((task) => scheduleDate(task) === date));
}

export function dueOn(tasks: Task[], now: Date): Task[] {
  return dueOnDate(tasks, toDateString(now));
}

/** 本周的最后一天（周日）。周日当天查询本周只看今天。 */
export function endOfWeek(now: Date): Date {
  const weekday = startOfDay(now).getDay();
  return addDays(startOfDay(now), weekday === 0 ? 0 : 7 - weekday);
}

export function selectTasks(tasks: Task[], scope: TaskScope, now: Date): Task[] {
  switch (scope) {
    case "open":
      return sortByDue(tasks.filter((task) => !task.done));
    case "done":
      return tasks.filter((task) => task.done);
    case "today":
      return dueOn(tasks, now);
    case "tomorrow":
      return dueOnDate(tasks, toDateString(addDays(now, 1)));
    case "week": {
      const today = toDateString(now);
      const end = toDateString(endOfWeek(now));
      return sortByDue(
        tasks.filter((task) => {
          if (task.done) return false;
          const due = scheduleDate(task);
          return Boolean(due && due >= today && due <= end);
        }),
      );
    }
    case "overdue":
      return overdueTasks(tasks, now);
    case "all":
      return [
        ...sortByDue(tasks.filter((task) => !task.done)),
        ...tasks.filter((task) => task.done),
      ];
  }
}
