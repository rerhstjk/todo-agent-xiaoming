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

/** 离截止不到一天（含已逾期）的未完成任务要加感叹号。 */
const URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function toDateString(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 截止时刻：有 HH:mm 就取那一刻，否则取当天 23:59。 */
function deadline(task: ApiTask): number | undefined {
  if (!task.dueDate) return undefined;
  const [year, month, day] = task.dueDate.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const [hour, minute] = (task.dueTime ?? "23:59").split(":").map(Number);
  return new Date(year, month - 1, day, hour ?? 23, minute ?? 59).getTime();
}

function isOverdue(task: ApiTask): boolean {
  const moment = deadline(task);
  return !task.done && moment !== undefined && moment < Date.now();
}

function isUrgent(task: ApiTask): boolean {
  const moment = deadline(task);
  return !task.done && moment !== undefined && moment - Date.now() <= URGENT_WINDOW_MS;
}

/** 把截止日期和时刻说成“今天 17:00 到期 / 已逾期 / 11月30日 到期”。 */
function dueLabel(task: ApiTask): string {
  if (!task.dueDate) return "";
  const dueDate = task.dueDate;
  const [year, month, day] = dueDate.split("-").map(Number);
  if (!year || !month || !day) return dueDate;
  const today = toDateString(new Date());
  const days = Math.round(
    (Date.UTC(year, month - 1, day) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  const time = task.dueTime ? ` ${task.dueTime}` : "";
  if (isOverdue(task)) return `已逾期 · ${month}月${day}日${time}`;
  if (days === 0) return `今天${time} 到期`;
  if (days === 1) return `明天${time} 到期`;
  if (days === 2) return `后天${time} 到期`;
  if (days < 0) return `已逾期 · ${month}月${day}日${time}`;
  if (days <= 7) return `${days} 天后${time} 到期`;
  return `${month}月${day}日${time} 到期`;
}

function compareTasks(a: ApiTask, b: ApiTask): number {
  const weight: Record<string, number> = { high: 0, normal: 1, low: 2 };
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if ((a.dueTime ?? "") !== (b.dueTime ?? "")) {
    return (a.dueTime ?? "23:59") < (b.dueTime ?? "23:59") ? -1 : 1;
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

const FILTERS: { value: Filter; label: string; empty: string }[] = [
  { value: "open", label: "待办", empty: "清单是空的，跟小明说一声就行。" },
  { value: "today", label: "今天", empty: "今天没有到期的任务。" },
  { value: "week", label: "本周", empty: "本周剩下的时间没有到期的任务。" },
  { value: "overdue", label: "逾期", empty: "没有逾期的任务，节奏保持得不错。" },
  { value: "done", label: "已完成", empty: "还没有完成的任务。" },
];

export function TaskPanel({
  tasks,
  loading,
  error,
  onToggle,
  onToggleSubtask,
  onDelete,
  onRefresh,
  notice,
}: {
  tasks: ApiTask[];
  loading: boolean;
  error: string;
  notice?: string;
  onToggle: (task: ApiTask) => void;
  onToggleSubtask: (task: ApiTask, subtaskId: string) => void;
  onDelete: (task: ApiTask) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const today = toDateString(new Date());
  const weekEnd = endOfWeek();
  const sorted = [...tasks].sort(compareTasks);
  const open = sorted.filter((task) => !task.done);
  const done = sorted.filter((task) => task.done);
  const todayTasks = sorted.filter((task) => task.dueDate === today);
  const weekTasks = open.filter(
    (task) => task.dueDate && task.dueDate >= today && task.dueDate <= weekEnd,
  );
  const overdueTasks = sorted.filter((task) => isOverdue(task));
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
  const emptyText = FILTERS.find((item) => item.value === filter)?.empty ?? "";

  return (
    <aside className="panel" aria-label="待办清单">
      <div className="panel-head">
        <div>
          <h2>全部任务</h2>
          <p className="panel-subtitle">用中文说一声就能新建、完成或删除任务。</p>
        </div>
        <button className="ghost" onClick={onRefresh} disabled={loading} aria-label="刷新清单">
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>
      {notice && (
        <p className="panel-notice" role="status">
          {notice}
        </p>
      )}
      <div className="panel-toolbar">
        <div className="panel-tabs" role="tablist">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              role="tab"
              aria-selected={filter === item.value}
              className={filter === item.value ? "active" : ""}
              onClick={() => setFilter(item.value)}
            >
              {item.label} {counts[item.value]}
            </button>
          ))}
        </div>
        <span className="panel-sort" title="清单按截止时间和时刻排序">
          ↑↓ 排序：截止时间
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="panel-columns" aria-hidden="true">
        <span>任务标题</span>
        <span>截止时间</span>
      </div>
      {visible.length === 0 ? (
        <p className="panel-empty">{loading ? "正在读取清单…" : emptyText}</p>
      ) : (
        <ul className="panel-list">
          {visible.map((task) => {
            const subtasks = task.subtasks ?? [];
            const finished = subtasks.filter((item) => item.done).length;
            const overdue = isOverdue(task);
            const urgent = isUrgent(task);
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
                  {task.done ? "✓" : ""}
                </button>
                <div className="task-body">
                  <div className="task-main">
                    <span className="task-title">{task.title}</span>
                    {urgent && (
                      <span
                        className={overdue ? "warning overdue" : "warning"}
                        title={overdue ? "已经超过截止时间" : "离截止不到一天"}
                        aria-label={overdue ? "已逾期" : "临近截止"}
                      >
                        !
                      </span>
                    )}
                    {task.dueDate && <span className="task-due">{dueLabel(task)}</span>}
                  </div>
                  {(task.priority || task.effort || subtasks.length > 0) && (
                    <span className="task-meta">
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
                  )}
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
