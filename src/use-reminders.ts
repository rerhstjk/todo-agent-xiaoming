import { useEffect, useRef } from "react";
import type { ApiTask } from "./chat-client.ts";
import { dueReminders } from "./reminder-window.ts";
import { dueText } from "./task-dates.ts";

const STORAGE_KEY = "xiaoming.reminded";
const MAX_REMEMBERED = 200;

export type ReminderPermission = "unsupported" | "default" | "granted" | "denied";

export function reminderPermission(): ReminderPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestReminderPermission(): Promise<ReminderPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

function loadNotified(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function saveNotified(notified: Set<string>): void {
  try {
    // 只记最近 200 条，避免 localStorage 无限增长。
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...notified].slice(-MAX_REMEMBERED)));
  } catch {
    // 隐私模式等场景写不进去也不影响提醒本身。
  }
}

/** 页面打开期间轮询任务；到截止前 30 分钟内弹一次浏览器通知（同一任务同一截止时刻只弹一次）。 */
export function useTaskReminders(tasks: ApiTask[]): void {
  const notified = useRef<Set<string> | null>(null);
  if (notified.current === null) notified.current = loadNotified();

  useEffect(() => {
    if (typeof Notification === "undefined") return;

    const check = () => {
      if (Notification.permission !== "granted") return;
      const pending = dueReminders(tasks, Date.now(), (key) => notified.current?.has(key) ?? false);
      for (const { key, task } of pending) {
        notified.current?.add(key);
        if (notified.current) saveNotified(notified.current);
        try {
          new Notification("任务快到期了", { body: `${task.title} · ${dueText(task)}`, tag: key });
        } catch {
          // 某些浏览器在后台标签页会拒绝构造通知，忽略即可。
        }
      }
    };

    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [tasks]);
}
