import type { ApiTask } from "./chat-client.ts";
import { deadline } from "./task-dates.ts";

/** 到点前 1 分钟内提醒（轮询 30 秒，最多晚半分钟）；刚过期 10 分钟内的任务也补一次。 */
export const REMINDER_LOOKAHEAD_MS = 60 * 1000;
export const REMINDER_GRACE_MS = 10 * 60 * 1000;

export interface PendingReminder {
  key: string;
  task: ApiTask;
  at: number;
}

/** 同一任务的同一个截止时刻只提醒一次，用 id + 时间戳当去重键。 */
export function reminderKey(task: ApiTask, at: number): string {
  return `${task.id}:${at}`;
}

/** 纯函数：算出此刻应该弹通知的任务，方便单测与调试。 */
export function dueReminders(
  tasks: ApiTask[],
  now: number,
  alreadyNotified: (key: string) => boolean,
): PendingReminder[] {
  const pending: PendingReminder[] = [];
  for (const task of tasks) {
    if (task.done) continue;
    const at = deadline(task);
    if (at === undefined) continue;
    const remaining = at - now;
    if (remaining > REMINDER_LOOKAHEAD_MS || remaining < -REMINDER_GRACE_MS) continue;
    const key = reminderKey(task, at);
    if (alreadyNotified(key)) continue;
    pending.push({ key, task, at });
  }
  return pending;
}
