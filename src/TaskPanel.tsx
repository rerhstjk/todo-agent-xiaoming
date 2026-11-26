import { useState } from "react";
import type { ApiTask } from "./chat-client.ts";

const PRIORITY_LABELS: Record<string, string> = {
  high: "高优先级",
  normal: "中优先级",
  low: "低优先级",
};
const EFFORT_LABELS: Record<string, string> = {
  small: "工作量小",
  medium: "工作量中",
  large: "工作量大",
};

function toDateString(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 把截止日期说成“今天 / 明天 / 已逾期 / 11月30日”。 */
function dueLabel(dueDate: string): string {
  const today = toDateString(new Date());
  const [year, month, day] = dueDate.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  if (!year || !month || !day) return dueDate;
  const days = Math.round(
    (Date.UTC(year, month - 1, day) - Date.UTC(todayYear!, todayMonth! - 1, todayDay!)) /
      86_400_000,
  );
  if (days < 0) return "已逾期";
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  if (days === 2) return "后天到期";
  if (days <= 7) return `${days} 天后到期`;
  return `${month}月${day}日到期`;
}

function isOverdue(task: ApiTask, today: string): boolean {
  return !task.done && typeof task.dueDate === "string" && task.dueDate < today;
}

function compareTasks(a: ApiTask, b: ApiTask): number {
  const weight: Record<string, number> = { high: 0, normal: 1, low: 2 };
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.priority !== b.priority) {
    return (weight[a.priority ?? "normal"] ?? 1) - (weight[b.priority ?? "normal"] ?? 1);
  }
  return 0;
}

export function TaskPanel({
  tasks,
  loading,
  error,
  onToggle,
  onDelete,
  onRefresh,
}: {
  tasks: ApiTask[];
  loading: boolean;
  error: string;
  onToggle: (task: ApiTask) => void;
  onDelete: (task: ApiTask) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "done">("open");
  const today = toDateString(new Date());
  const open = tasks.filter((task) => !task.done).sort(compareTasks);
  const done = tasks.filter((task) => task.done).sort(compareTasks);
  const visible = filter === "done" ? done : open;

  return (
    <aside className="panel" aria-label="待办清单">
      <div className="panel-head">
        <h2>待办清单</h2>
        <button className="ghost" onClick={onRefresh} disabled={loading} aria-label="刷新清单">
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div className="panel-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={filter === "open"}
          className={filter === "open" ? "active" : ""}
          onClick={() => setFilter("open")}
        >
          待办 {open.length}
        </button>
        <button
          role="tab"
          aria-selected={filter === "done"}
          className={filter === "done" ? "active" : ""}
          onClick={() => setFilter("done")}
        >
          已完成 {done.length}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {visible.length === 0 ? (
        <p className="panel-empty">
          {loading
            ? "正在读取清单…"
            : filter === "done"
              ? "还没有完成的任务。"
              : "清单是空的，跟小明说一声就行。"}
        </p>
      ) : (
        <ul className="panel-list">
          {visible.map((task) => {
            const subtasks = task.subtasks ?? [];
            const finished = subtasks.filter((item) => item.done).length;
            return (
              <li key={task.id} className={task.done ? "done" : ""}>
                <button
                  className="check"
                  aria-label={
                    task.done ? `把「${task.title}」重新打开` : `把「${task.title}」标记为完成`
                  }
                  aria-pressed={task.done}
                  onClick={() => onToggle(task)}
                >
                  {task.done ? "✓" : "○"}
                </button>
                <div className="task-body">
                  <span className="task-title">{task.title}</span>
                  <span className="task-meta">
                    {isOverdue(task, today) && <em className="overdue">已逾期</em>}
                    {task.dueDate && <span>{dueLabel(task.dueDate)}</span>}
                    {task.priority && task.priority !== "normal" && (
                      <span className={`priority ${task.priority}`}>
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                    )}
                    {task.effort && <span>{EFFORT_LABELS[task.effort]}</span>}
                    {subtasks.length > 0 && (
                      <span>
                        子任务 {finished}/{subtasks.length}
                      </span>
                    )}
                  </span>
                </div>
                <button
                  className="delete"
                  aria-label={`删除「${task.title}」`}
                  onClick={() => onDelete(task)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="panel-note">可以直接在对话里说「牛奶买好了」让小明更新清单。</p>
    </aside>
  );
}
