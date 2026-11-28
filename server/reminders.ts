import { formatShortChineseDate, startOfDay } from "./dates.ts";
import {
  taskDueDate,
  taskDueTime,
  taskRemind,
  taskReminderAt,
  taskStartDate,
  taskStartTime,
  type Task,
} from "./task-store.ts";

export type ReminderKind = "start" | "due" | "custom";

export interface ReminderMoment {
  at: number;
  kind: ReminderKind;
  label: string;
}

const MINUTE = 60 * 1000;
/** 默认在开始前 30 分钟提醒。 */
export const START_REMIND_BEFORE_MINUTES = 30;
/** 默认在截止前 10 分钟提醒。 */
export const DUE_REMIND_BEFORE_MINUTES = 10;

function atMoment(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0).getTime();
}

function clockText(timestamp: number, reference?: string): string {
  const date = new Date(timestamp);
  const hh = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (reference === undefined) return hh;
  const sameDay =
    startOfDay(date).getTime() === startOfDay(new Date(`${reference}T00:00`)).getTime();
  return sameDay ? hh : `${formatShortChineseDate(date).replace(/ 周.$/, "")} ${hh}`;
}

/** 自定义提醒时刻的展示文案，例如「提醒 11月28日 14:30」。 */
export function reminderMomentLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = startOfDay(new Date()).getTime();
  const day = startOfDay(date).getTime();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (day === today) return `今天 ${clock}`;
  return `${formatShortChineseDate(date).replace(/ 周.$/, "")} ${clock}`;
}

/**
 * 任务实际会提醒的时刻：
 * - 用户指定了提醒时刻 → 只按指定的来；
 * - 否则开始前 30 分钟、截止前 10 分钟各一次（有开始/截止时间才有）。
 */
export function taskReminderMoments(task: Task): ReminderMoment[] {
  if (!taskRemind(task)) return [];
  const custom = taskReminderAt(task);
  if (custom.length > 0) {
    return custom.map((iso) => ({
      at: new Date(iso).getTime(),
      kind: "custom" as const,
      label: reminderMomentLabel(iso),
    }));
  }

  const moments: ReminderMoment[] = [];
  const startDate = taskStartDate(task);
  if (startDate) {
    const at =
      atMoment(startDate, taskStartTime(task) ?? "09:00") - START_REMIND_BEFORE_MINUTES * MINUTE;
    moments.push({
      at,
      kind: "start",
      label: `开始前 ${START_REMIND_BEFORE_MINUTES} 分钟（${clockText(at, startDate)}）`,
    });
  }
  const dueDate = taskDueDate(task);
  if (dueDate) {
    const at = atMoment(dueDate, taskDueTime(task) ?? "23:59") - DUE_REMIND_BEFORE_MINUTES * MINUTE;
    moments.push({
      at,
      kind: "due",
      label: `截止前 ${DUE_REMIND_BEFORE_MINUTES} 分钟（${clockText(at, dueDate)}）`,
    });
  }

  // 开始和截止是同一刻时只提醒一次。
  const seen = new Set<number>();
  return moments.filter((moment) => {
    if (seen.has(moment.at)) return false;
    seen.add(moment.at);
    return true;
  });
}

/** 给对话用的提醒说明，例如「开始前 30 分钟（14:30）、截止前 10 分钟（16:50）」。 */
export function formatReminderPlan(task: Task): string {
  const moments = taskReminderMoments(task);
  if (moments.length === 0) return "";
  return moments.map((moment) => moment.label).join("、");
}
