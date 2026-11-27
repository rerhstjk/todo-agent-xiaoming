import { addDays, deadlineMoment, startOfDay, toDateString } from "./dates.ts";
import { taskDueDate, taskDueTime, type Task } from "./task-store.ts";

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

/** 有截止时间的排在前面：先按日期，再按当天时刻，没有日期的排在最后。 */
export function sortByDue(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const leftDate = taskDueDate(a) ?? "9999-99-99";
    const rightDate = taskDueDate(b) ?? "9999-99-99";
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    return (taskDueTime(a) ?? "23:59").localeCompare(taskDueTime(b) ?? "23:59");
  });
}

/** 已经超过截止时刻的未完成任务；无时刻的按当天 23:59 算。 */
export function isOverdue(task: Task, now: Date): boolean {
  if (task.done) return false;
  const due = taskDueDate(task);
  if (!due) return false;
  const moment = deadlineMoment(due, taskDueTime(task));
  return moment !== undefined && moment.getTime() < now.getTime();
}

export function overdueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => isOverdue(task, now));
}

/** 指定某一天到期的任务（包含已完成的，便于展示当天结果）。 */
export function dueOnDate(tasks: Task[], date: string): Task[] {
  return sortByDue(tasks.filter((task) => taskDueDate(task) === date));
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
          const due = taskDueDate(task);
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
