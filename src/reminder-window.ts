import type { ApiTask } from "./chat-client.ts";
import { reminderPlan, type TaskReminder } from "./task-dates.ts";

/** 提醒时刻前 1 分钟内进入队列（轮询 30 秒，最多晚半分钟）；刚过 10 分钟内补一次。 */
export const REMINDER_LOOKAHEAD_MS = 60 * 1000;
export const REMINDER_GRACE_MS = 10 * 60 * 1000;

export interface PendingReminder extends TaskReminder {
  key: string;
  task: ApiTask;
}

/** 同一任务的同一个提醒时刻只提醒一次，用 id + 类型 + 时间戳当去重键。 */
export function reminderKey(task: ApiTask, at: number, kind: TaskReminder["kind"]): string {
  return `${task.id}:${kind}:${at}`;
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
    for (const entry of reminderPlan(task)) {
      const remaining = entry.at - now;
      if (remaining > REMINDER_LOOKAHEAD_MS || remaining < -REMINDER_GRACE_MS) continue;
      const key = reminderKey(task, entry.at, entry.kind);
      if (alreadyNotified(key)) continue;
      pending.push({ ...entry, key, task });
    }
  }
  return pending;
}
