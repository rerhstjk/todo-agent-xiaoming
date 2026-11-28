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

/** 开始时刻：有 HH:mm 就取那一刻，否则按当天 09:00 算。 */
export function startMoment(task: ApiTask): number | undefined {
  const date = parseDateString(task.startDate);
  if (!date) return undefined;
  const [hour, minute] = (task.startTime ?? "09:00").split(":").map(Number);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour ?? 9,
    minute ?? 0,
  ).getTime();
}

export interface TaskReminder {
  at: number;
  kind: "start" | "due" | "custom";
  label: string;
}

const MINUTE = 60 * 1000;

function clockString(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 任务实际会提醒的时刻（与服务端 `server/reminders.ts` 保持一致）：
 * 用户指定了提醒时刻就只按指定的来，否则开始前 30 分钟一次（老数据的截止时间也补一次）。
 */
export function reminderPlan(task: ApiTask): TaskReminder[] {
  const custom = (task.reminderAt ?? []).filter(
    (value) => !Number.isNaN(new Date(value).getTime()),
  );
  if (custom.length === 0 && task.remind !== true) return [];
  if (custom.length > 0) {
    return custom.map((value) => {
      const at = new Date(value).getTime();
      const sameDay =
        toDateString(new Date(at)) === toDateString(new Date())
          ? ""
          : relativeDayLabel(toDateString(new Date(at))) + " ";
      return { at, kind: "custom" as const, label: `提醒 ${sameDay}${clockString(at)}` };
    });
  }

  const plan: TaskReminder[] = [];
  const start = startMoment(task);
  if (start !== undefined) {
    const at = start - 30 * MINUTE;
    plan.push({ at, kind: "start", label: `开始前 30 分钟（${clockString(at)}）` });
  }
  const due = deadline(task);
  if (due !== undefined) {
    const at = due - 10 * MINUTE;
    plan.push({ at, kind: "due", label: `截止前 10 分钟（${clockString(at)}）` });
  }
  const seen = new Set<number>();
  return plan.filter((entry) => {
    if (seen.has(entry.at)) return false;
    seen.add(entry.at);
    return true;
  });
}

/** 铃铛的悬浮说明。 */
export function reminderDetail(task: ApiTask): string {
  const plan = reminderPlan(task);
  return plan.length > 0 ? plan.map((entry) => entry.label).join("、") : "";
}

/** 开始时刻已经过去、还没完成，就算逾期；只有日期时按当天 23:59 算。 */
export function scheduleMoment(task: ApiTask): number | undefined {
  const date = parseDateString(task.startDate ?? task.dueDate);
  if (!date) return undefined;
  const [hour, minute] = (task.startTime ?? task.dueTime ?? "23:59").split(":").map(Number);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour ?? 23,
    minute ?? 59,
  ).getTime();
}

export type UrgencyLevel = "overdue" | "now" | "soon" | "today" | "later" | "none";

export type TaskUrgency = { level: UrgencyLevel; label: string };

function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return `${days} 天`;
}

/**
 * 紧急度：逾期 / 1 小时内 / 6 小时内 / 24 小时内 / 更远。
 * 只考虑未完成任务；没有任何时间时不标颜色。
 */
export function urgency(task: ApiTask, now = Date.now()): TaskUrgency {
  const moment = scheduleMoment(task);
  if (task.done || moment === undefined) return { level: "none", label: "" };
  const diff = moment - now;
  if (diff < 0) return { level: "overdue", label: `逾期 ${spanText(-diff)}` };
  if (diff <= 60 * 60_000) return { level: "now", label: `剩 ${spanText(diff)}` };
  if (diff <= 6 * 60 * 60_000) return { level: "soon", label: `剩 ${spanText(diff)}` };
  if (diff <= 24 * 60 * 60_000) return { level: "today", label: `剩 ${spanText(diff)}` };
  return { level: "later", label: "" };
}

export function isOverdue(task: ApiTask): boolean {
  if (task.done) return false;
  const moment = scheduleMoment(task);
  return moment !== undefined && moment < Date.now();
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

/** 开始时间列：今天 09:00 / 明天 / 11月30日 / —。 */
export function startText(task: ApiTask): string {
  const date = task.startDate ?? task.dueDate;
  if (date) {
    const time = (task.startTime ?? task.dueTime) ? ` ${task.startTime ?? task.dueTime}` : "";
    return `${relativeDayLabel(date)}${time}`;
  }
  return task.startTime ?? task.dueTime ?? "—";
}

/**
 * 默认排序：先按开始时间，早的在前；没有开始时间时用截止时刻顶替。
 * 时间相同、或两边都没有时间时，高优先级在前。
 */
export function compareTasks(a: ApiTask, b: ApiTask): number {
  const weight: Record<string, number> = { high: 0, normal: 1, low: 2 };
  const priority = (task: ApiTask) => weight[task.priority ?? "normal"] ?? 1;
  const moment = (task: ApiTask) => startMoment(task) ?? deadline(task);

  const left = moment(a);
  const right = moment(b);
  if (left !== undefined && right !== undefined && left !== right) return left - right;
  if (left !== undefined && right === undefined) return -1;
  if (left === undefined && right !== undefined) return 1;
  return priority(a) - priority(b);
}

export type DueBucket = "overdue" | "today" | "tomorrow" | "week" | "more";

function addDaysString(date: string, days: number): string {
  const parsed = parseDateString(date) ?? new Date();
  parsed.setDate(parsed.getDate() + days);
  return toDateString(parsed);
}

/** 把任务按开始时间分到「逾期 / 今天 / 明天 / 本周 / 更多」。 */
export function dueBucket(
  task: ApiTask,
  today = toDateString(new Date()),
  weekEnd = endOfWeek(),
): DueBucket {
  const date = task.startDate ?? task.dueDate;
  if (!date) return "more";
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date === addDaysString(today, 1)) return "tomorrow";
  if (date <= weekEnd) return "week";
  return "more";
}

const LEGACY_EFFORT_HOURS: Record<string, number> = {
  small: 1,
  medium: 3,
  large: 6,
  小: 1,
  中: 3,
  大: 6,
};

/** 任务预计用时（小时）；兼容旧的 small/medium/large 数据。 */
export function effortHours(task: ApiTask): number | undefined {
  const value: unknown = task.effort;
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const hours = Number(value);
  if (Number.isFinite(hours) && hours > 0) return hours;
  return LEGACY_EFFORT_HOURS[value];
}

/** 表格里的工作量单元格：2 小时 / 半小时 / —。 */
export function effortText(task: ApiTask): string {
  const hours = effortHours(task);
  if (hours === undefined) return "—";
  if (hours === 0.25) return "15 分钟";
  if (hours === 0.5) return "半小时";
  return `${hours} 小时`;
}

/** 本周的最后一天（周日）。 */
export function endOfWeek(today = new Date()): string {
  const end = new Date(today);
  end.setDate(today.getDate() + (today.getDay() === 0 ? 0 : 7 - today.getDay()));
  return toDateString(end);
}
