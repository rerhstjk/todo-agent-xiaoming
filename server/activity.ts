/**
 * 清单面板操作记录。
 *
 * 聊天接口和清单接口共用同一个 TaskStore，所以面板上的删除/勾选本身就会改动数据；
 * 但对话模型只看得到 messages，看不到「用户刚刚在面板上删掉了什么」。
 * 这里保留最近的面板操作，让智能体下一轮能理解上下文（也可以回答「刚才删了什么」）。
 * 记录只在内存里，重启即清空，不进入 data/tasks.json。
 */

export type ActivityKind = "created" | "updated" | "completed" | "reopened" | "deleted";

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  title: string;
}

export interface ActivityQuery {
  limit?: number;
  sinceMs?: number;
  now?: number;
}

/** 面板操作保留 30 分钟，够覆盖一段连续对话。 */
export const ACTIVITY_WINDOW_MS = 30 * 60 * 1000;

export class ActivityLog {
  private entries: ActivityEntry[] = [];

  record(entry: { kind: ActivityKind; title: string }, at = Date.now()): void {
    const title = entry.title.trim();
    if (!title) return;
    this.entries.push({ at, kind: entry.kind, title });
    // 只留最近 100 条，避免长时间运行时无限增长。
    if (this.entries.length > 100) this.entries.splice(0, this.entries.length - 100);
  }

  list({ limit = 10, sinceMs = ACTIVITY_WINDOW_MS, now = Date.now() }: ActivityQuery = {}) {
    const since = now - sinceMs;
    const recent = this.entries.filter((entry) => entry.at >= since);
    return recent.slice(Math.max(0, recent.length - limit));
  }

  /** 用户提到的任务最近被面板删掉时，返回原任务标题，用来给出更准确的解释。 */
  recentlyDeleted(hint: string, now = Date.now()): string | undefined {
    const value = hint.trim();
    if (!value) return undefined;
    const deleted = this.list({ sinceMs: ACTIVITY_WINDOW_MS, now, limit: 50 }).filter(
      (entry) => entry.kind === "deleted",
    );
    return deleted.find((entry) => entry.title.includes(value) || value.includes(entry.title))
      ?.title;
  }

  clear(): void {
    this.entries = [];
  }
}

/** 进程内共享的一份记录：清单接口写入，聊天接口读取。 */
export const defaultActivity = new ActivityLog();

export function describeActivity(entry: ActivityEntry): string {
  switch (entry.kind) {
    case "created":
      return `新建了「${entry.title}」`;
    case "completed":
      return `完成了「${entry.title}」`;
    case "reopened":
      return `把「${entry.title}」重新标记为未完成`;
    case "deleted":
      return `删除了「${entry.title}」`;
    case "updated":
      return `修改了「${entry.title}」`;
  }
}

export function formatActivityTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
