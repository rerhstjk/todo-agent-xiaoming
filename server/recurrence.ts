import { addDays, parseDateString, startOfDay, toDateString } from "./dates.ts";

/** 重复任务的周期。 */
export const repeats = ["daily", "weekly", "monthly"] as const;
export type Repeat = (typeof repeats)[number];

export const REPEAT_LABELS: Record<Repeat, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
};

export function isRepeat(value: unknown): value is Repeat {
  return typeof value === "string" && (repeats as readonly string[]).includes(value);
}

/** 某个月有多少天。 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 算下一次重复的日期。没有截止日期时从今天开始算，
 * 每月重复遇到 31 号会落到下个月最后一天（例如 2 月 28 日）。
 */
export function nextDueDate(dueDate: string | undefined, repeat: Repeat, now = new Date()): string {
  const base = (dueDate ? parseDateString(dueDate) : undefined) ?? startOfDay(now);
  if (repeat === "daily") return toDateString(addDays(base, 1));
  if (repeat === "weekly") return toDateString(addDays(base, 7));

  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  const nextMonth = month + 1;
  const nextYear = year + Math.floor(nextMonth / 12);
  const normalizedMonth = nextMonth % 12;
  return toDateString(
    new Date(nextYear, normalizedMonth, Math.min(day, daysInMonth(nextYear, normalizedMonth))),
  );
}
