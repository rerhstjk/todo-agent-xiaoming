import { useEffect, useRef } from "react";
import type { ApiTask } from "./chat-client.ts";
import { dueReminders, type PendingReminder } from "./reminder-window.ts";

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

/**
 * 页面打开期间轮询任务；每个提醒时刻只弹一次浏览器通知，
 * 并回调 onDue 让页面内也给出提示，避免系统通知被专注模式或系统设置拦掉时用户什么都看不到。
 */
export function useTaskReminders(
  tasks: ApiTask[],
  enabled: boolean,
  onDue?: (reminder: PendingReminder) => void,
): void {
  const notified = useRef<Set<string> | null>(null);
  if (notified.current === null) notified.current = loadNotified();
  const onDueRef = useRef(onDue);
  onDueRef.current = onDue;

  useEffect(() => {
    if (!enabled) return;
    if (typeof Notification === "undefined") return;

    const check = () => {
      const pending = dueReminders(tasks, Date.now(), (key) => notified.current?.has(key) ?? false);
      for (const reminder of pending) {
        notified.current?.add(reminder.key);
        if (notified.current) saveNotified(notified.current);
        onDueRef.current?.(reminder);
        if (Notification.permission !== "granted") continue;
        try {
          const title =
            reminder.kind === "start"
              ? "任务快开始了"
              : reminder.kind === "due"
                ? "任务快到截止时间了"
                : "任务提醒";
          new Notification(title, {
            body: `${reminder.task.title} · ${reminder.label}`,
            tag: reminder.key,
          });
        } catch (error) {
          // Safari 在某些状态下会拒绝构造通知；页面内的提示已经兜住了。
          console.warn("[xiaoming] 无法弹出系统通知，已改为页面内提示：", error);
        }
      }
    };

    check();
    // Safari 在后台标签页会节流定时器，回到前台、窗口重新获得焦点时都补查一次。
    const timer = window.setInterval(check, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [tasks, enabled]);
}
