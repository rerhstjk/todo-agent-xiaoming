import { useState } from "react";
import type { ApiTask } from "./chat-client.ts";
import { TaskCalendar } from "./TaskCalendar.tsx";
import { compareTasks, dueText, endOfWeek, isOverdue, toDateString } from "./task-dates.ts";

type Priority = "high" | "normal" | "low";
type Effort = "small" | "medium" | "large";

const PRIORITY_LABELS: Record<Priority, string> = { high: "高", normal: "中", low: "低" };
const EFFORT_LABELS: Record<Effort, string> = { small: "小", medium: "中", large: "大" };

type Filter = "open" | "today" | "week" | "overdue" | "done";
type PriorityFilter = "all" | Priority;
type EffortFilter = "all" | Effort;

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
  const [view, setView] = useState<"list" | "calendar">("list");
  const [filter, setFilter] = useState<Filter>("open");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [effortFilter, setEffortFilter] = useState<EffortFilter>("all");
  const today = toDateString(new Date());
  const weekEnd = endOfWeek();

  // 先按优先级/工作量过滤，再在剩下的任务里算各状态的数量，两个筛选叠加生效。
  const pool = tasks.filter((task) => {
    const priority = task.priority ?? "normal";
    if (priorityFilter !== "all" && priority !== priorityFilter) return false;
    if (effortFilter !== "all" && task.effort !== effortFilter) return false;
    return true;
  });
  const sorted = [...pool].sort(compareTasks);
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
      <div className="panel-views" role="tablist" aria-label="清单视图">
        <button
          role="tab"
          aria-selected={view === "list"}
          className={view === "list" ? "active" : ""}
          onClick={() => setView("list")}
        >
          清单
        </button>
        <button
          role="tab"
          aria-selected={view === "calendar"}
          className={view === "calendar" ? "active" : ""}
          onClick={() => setView("calendar")}
        >
          日历
        </button>
      </div>
      {notice && (
        <p className="panel-notice" role="status">
          {notice}
        </p>
      )}
      <div className="panel-toolbar">
        {view === "list" && (
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
        )}
        <div className="panel-filters">
          <select
            aria-label="按优先级筛选"
            className="panel-select"
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as PriorityFilter)}
          >
            <option value="all">全部优先级</option>
            <option value="high">高优先级</option>
            <option value="normal">中优先级</option>
            <option value="low">低优先级</option>
          </select>
          <select
            aria-label="按工作量筛选"
            className="panel-select"
            value={effortFilter}
            onChange={(event) => setEffortFilter(event.target.value as EffortFilter)}
          >
            <option value="all">全部工作量</option>
            <option value="small">工作量：小</option>
            <option value="medium">工作量：中</option>
            <option value="large">工作量：大</option>
          </select>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view === "calendar" ? (
        <TaskCalendar tasks={pool} onToggle={onToggle} />
      ) : (
        <div className="panel-table" role="table" aria-label="任务表格">
          <div className="panel-row panel-row-head" role="row">
            <span role="columnheader">任务名称</span>
            <span role="columnheader">截止时间</span>
            <span role="columnheader">工作量</span>
            <span role="columnheader">优先级</span>
          </div>
          {visible.length === 0 ? (
            <p className="panel-empty">{loading ? "正在读取清单…" : emptyText}</p>
          ) : (
            visible.map((task) => {
              const subtasks = task.subtasks ?? [];
              const finished = subtasks.filter((item) => item.done).length;
              const overdue = isOverdue(task);
              const priority = task.priority ?? "normal";
              return (
                <div key={task.id} role="row" className={`panel-row${task.done ? " done" : ""}`}>
                  <div className="cell-title" role="cell">
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
                        {subtasks.length > 0 && (
                          <span className="subtask-count">
                            子任务 {finished}/{subtasks.length}
                          </span>
                        )}
                      </div>
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
                  </div>
                  <span className={`cell-due${overdue ? " overdue" : ""}`} role="cell">
                    {dueText(task)}
                  </span>
                  <span className="cell-effort" role="cell">
                    {task.effort ? EFFORT_LABELS[task.effort] : "—"}
                  </span>
                  <span className="cell-priority" role="cell">
                    <span className={`priority ${priority}`}>{PRIORITY_LABELS[priority]}</span>
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
      <p className="panel-note">可以直接在对话里说「牛奶买好了」让小明更新清单。</p>
    </aside>
  );
}
