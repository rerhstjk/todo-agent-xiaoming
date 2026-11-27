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

type Filter = "open" | "today" | "week" | "overdue" | "done";

/** 本周的最后一天（周日）。 */
function endOfWeek(): string {
  const date = new Date();
  const weekday = date.getDay();
  const end = new Date(date);
  end.setDate(date.getDate() + (weekday === 0 ? 0 : 7 - weekday));
  return toDateString(end);
}

export function TaskPanel({
  tasks,
  loading,
  error,
  onToggle,
  onToggleSubtask,
  onDelete,
  onRefresh,
}: {
  tasks: ApiTask[];
  loading: boolean;
  error: string;
  onToggle: (task: ApiTask) => void;
  onToggleSubtask: (task: ApiTask, subtaskId: string) => void;
  onDelete: (task: ApiTask) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const today = toDateString(new Date());
  const weekEnd = endOfWeek();
  const open = tasks.filter((task) => !task.done).sort(compareTasks);
  const done = tasks.filter((task) => task.done).sort(compareTasks);
  const todayTasks = tasks.filter((task) => task.dueDate === today).sort(compareTasks);
  const weekTasks = tasks
    .filter(
      (task) => !task.done && task.dueDate && task.dueDate >= today && task.dueDate <= weekEnd,
    )
    .sort(compareTasks);
  const overdueTasks = tasks.filter((task) => isOverdue(task, today)).sort(compareTasks);
  const counts: Record<Filter, number> = {
    open: open.length,
    today: todayTasks.length,
    week: weekTasks.length,
    overdue: overdueTasks.length,
    done: done.length,
  };
  const visible =
    filter === "done"
      ? done
      : filter === "today"
        ? todayTasks
        : filter === "week"
          ? weekTasks
          : filter === "overdue"
            ? overdueTasks
            : open;
  const emptyText =
    filter === "done"
      ? "还没有完成的任务。"
      : filter === "today"
        ? "今天没有到期的任务。"
        : filter === "week"
          ? "本周剩下的时间没有到期的任务。"
          : filter === "overdue"
            ? "没有逾期的任务，节奏保持得不错。"
            : "清单是空的，跟小明说一声就行。";

  return (
    <aside className="panel" aria-label="待办清单">
      <div className="panel-head">
        <h2>待办清单</h2>
        <button className="ghost" onClick={onRefresh} disabled={loading} aria-label="刷新清单">
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      <div className="panel-tabs" role="tablist">
        {(
          [
            ["open", "待办"],
            ["today", "今天"],
            ["week", "本周"],
            ["overdue", "逾期"],
            ["done", "已完成"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "active" : ""}
            onClick={() => setFilter(value)}
          >
            {label} {counts[value]}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {visible.length === 0 ? (
        <p className="panel-empty">{loading ? "正在读取清单…" : emptyText}</p>
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
                  {subtasks.length > 0 && (
                    <ul className="subtask-list">
                      {subtasks.map((subtask) => (
                        <li key={subtask.id} className={subtask.done ? "done" : ""}>
                          <button
                            className="subtask-check"
                            aria-label={
                              subtask.done
                                ? `把子任务「${subtask.title}」重新打开`
                                : `完成子任务「${subtask.title}」`
                            }
                            aria-pressed={subtask.done}
                            onClick={() => onToggleSubtask(task, subtask.id)}
                          >
                            {subtask.done ? "✓" : "○"}
                          </button>
                          <span className="subtask-title">{subtask.title}</span>
                        </li>
                      ))}
                    </ul>
                  )}
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
