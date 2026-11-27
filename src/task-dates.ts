import type { ApiTask } from "./chat-client.ts";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把 `YYYY-MM-DD` 解析成当天 0 点的本地时间，非法日期返回 undefined。 */
export function parseDateString(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 最近几天的相对说法：昨天 / 今天 / 明天 / 后天 / 周五 / 11月30日。 */
export function relativeDayLabel(dueDate: string, today = new Date()): string {
  const date = parseDateString(dueDate);
  if (!date) return dueDate;
  const diff = Math.round(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86_400_000,
  );
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === -1) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** “11月26日 周四”。 */
export function chineseDate(dueDate: string): string {
  const date = parseDateString(dueDate);
  if (!date) return dueDate;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

/** 截止时刻：有 HH:mm 就取那一刻，否则取当天 23:59。 */
export function deadline(task: ApiTask): number | undefined {
  const date = parseDateString(task.dueDate);
  if (!date) return undefined;
  const [hour, minute] = (task.dueTime ?? "23:59").split(":").map(Number);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour ?? 23,
    minute ?? 59,
  ).getTime();
}

export function isOverdue(task: ApiTask): boolean {
  const moment = deadline(task);
  return !task.done && moment !== undefined && moment < Date.now();
}

/** 列表里的截止时间：今天 17:00 / 明天 09:30 / 11月30日 / 已逾期 · 11月26日。 */
export function dueText(task: ApiTask): string {
  if (!task.dueDate) return "—";
  const date = parseDateString(task.dueDate);
  if (!date) return task.dueDate;
  const time = task.dueTime ? ` ${task.dueTime}` : "";
  if (isOverdue(task)) return `已逾期 · ${date.getMonth() + 1}月${date.getDate()}日${time}`;
  return `${relativeDayLabel(task.dueDate)}${time}`;
}

export function compareTasks(a: ApiTask, b: ApiTask): number {
  const weight: Record<string, number> = { high: 0, normal: 1, low: 2 };
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if ((a.dueTime ?? "") !== (b.dueTime ?? "")) {
    return (a.dueTime ?? "23:59") < (b.dueTime ?? "23:59") ? -1 : 1;
  }
  if (a.priority !== b.priority) {
    return (weight[a.priority ?? "normal"] ?? 1) - (weight[b.priority ?? "normal"] ?? 1);
  }
  return 0;
}

/** 本周的最后一天（周日）。 */
export function endOfWeek(today = new Date()): string {
  const end = new Date(today);
  end.setDate(today.getDate() + (today.getDay() === 0 ? 0 : 7 - today.getDay()));
  return toDateString(end);
}
