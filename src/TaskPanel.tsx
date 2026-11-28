import { useState } from "react";
import type { ApiTask } from "./chat-client.ts";
import { TaskCalendar } from "./TaskCalendar.tsx";
import {
  compareTasks,
  dueBucket,
  dueText,
  effortHours,
  effortText,
  endOfWeek,
  isOverdue,
  toDateString,
  type DueBucket,
} from "./task-dates.ts";

type Priority = "high" | "normal" | "low";
type Status = "open" | "overdue" | "done";
type TimeFilter = "all" | "today" | "tomorrow" | "week" | "more";
type PriorityFilter = "all" | Priority;
type EffortFilter = "all" | "short" | "medium" | "long" | "none";

const PRIORITY_LABELS: Record<Priority, string> = { high: "高", normal: "中", low: "低" };

const STATUSES: { value: Status; label: string; empty: string }[] = [
  { value: "open", label: "待办", empty: "没有符合条件的待办，改改上面的筛选试试。" },
  { value: "overdue", label: "逾期", empty: "没有逾期的任务，节奏保持得不错。" },
  { value: "done", label: "已完成", empty: "还没有完成的任务。" },
];

const TIME_OPTIONS: { value: TimeFilter; label: string }[] = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "tomorrow", label: "明天" },
  { value: "week", label: "本周" },
  { value: "more", label: "更多" },
];

const EFFORT_OPTIONS: { value: EffortFilter; label: string }[] = [
  { value: "all", label: "全部工作量" },
  { value: "short", label: "1 小时以内" },
  { value: "medium", label: "1–3 小时" },
  { value: "long", label: "3 小时以上" },
  { value: "none", label: "未估算" },
];

const GROUP_META: Record<DueBucket | "done", { label: string }> = {
  overdue: { label: "逾期" },
  today: { label: "今天" },
  tomorrow: { label: "明天" },
  week: { label: "本周" },
  more: { label: "更多" },
  done: { label: "已完成" },
};

const OPEN_GROUPS: Exclude<DueBucket, "overdue">[] = ["today", "tomorrow", "week", "more"];

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
  const [status, setStatus] = useState<Status>("open");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [effortFilter, setEffortFilter] = useState<EffortFilter>("all");
  const today = toDateString(new Date());
  const weekEnd = endOfWeek();

  // 时间 / 优先级 / 工作量三个筛选先叠加，再在结果里算状态数量。
  const pool = tasks.filter((task) => {
    const priority = task.priority ?? "normal";
    if (priorityFilter !== "all" && priority !== priorityFilter) return false;

    const hours = effortHours(task);
    if (effortFilter === "none" && hours !== undefined) return false;
    if (effortFilter === "short" && !(hours !== undefined && hours <= 1)) return false;
    if (effortFilter === "medium" && !(hours !== undefined && hours > 1 && hours <= 3))
      return false;
    if (effortFilter === "long" && !(hours !== undefined && hours > 3)) return false;

    if (timeFilter !== "all" && dueBucket(task, today, weekEnd) !== timeFilter) return false;
    return true;
  });

  const sorted = [...pool].sort(compareTasks);
  const openTasks = sorted.filter((task) => !task.done && !isOverdue(task));
  const overdueTasks = sorted.filter((task) => isOverdue(task));
  const doneTasks = sorted.filter((task) => task.done);
  const counts: Record<Status, number> = {
    open: openTasks.length,
    overdue: overdueTasks.length,
    done: doneTasks.length,
  };

  const visible = status === "open" ? openTasks : status === "overdue" ? overdueTasks : doneTasks;
  const emptyText = STATUSES.find((item) => item.value === status)?.empty ?? "";

  const groups: { key: DueBucket | "done"; tasks: ApiTask[] }[] =
    status === "open"
      ? OPEN_GROUPS.map((key) => ({
          key,
          tasks: visible.filter((task) => dueBucket(task, today, weekEnd) === key),
        }))
      : [{ key: status === "done" ? "done" : "overdue", tasks: visible }];
  const shownGroups = groups.filter((group) => group.tasks.length > 0);

  function renderRow(task: ApiTask) {
    const subtasks = task.subtasks ?? [];
    const finished = subtasks.filter((item) => item.done).length;
    const overdue = isOverdue(task);
    const priority = task.priority ?? "normal";
    return (
      <div key={task.id} role="row" className={`panel-row${task.done ? " done" : ""}`}>
        <div className="cell-title" role="cell">
          <button
            className="check"
            aria-label={task.done ? `把「${task.title}」重新打开` : `把「${task.title}」标记为完成`}
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
          {effortText(task)}
        </span>
        <span className="cell-priority" role="cell">
          <span className={`priority ${priority}`}>{PRIORITY_LABELS[priority]}</span>
        </span>
      </div>
    );
  }

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
          <div className="panel-tabs" role="tablist" aria-label="任务状态">
            {STATUSES.map((item) => (
              <button
                key={item.value}
                role="tab"
                aria-selected={status === item.value}
                className={status === item.value ? "active" : ""}
                onClick={() => setStatus(item.value)}
              >
                {item.label} {counts[item.value]}
              </button>
            ))}
          </div>
        )}
        <div className="panel-filters">
          {view === "list" && (
            <select
              aria-label="按时间筛选"
              className="panel-select"
              value={timeFilter}
              onChange={(event) => setTimeFilter(event.target.value as TimeFilter)}
            >
              {TIME_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
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
            {EFFORT_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
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
            shownGroups.map((group) => (
              <div className={`panel-group group-${group.key}`} key={group.key} role="rowgroup">
                <div className="panel-group-head">
                  <span className="group-tag">{GROUP_META[group.key].label}</span>
                  <span className="group-count">{group.tasks.length}</span>
                </div>
                {group.tasks.map(renderRow)}
              </div>
            ))
          )}
        </div>
      )}
      <p className="panel-note">可以直接在对话里说「牛奶买好了」让小明更新清单。</p>
    </aside>
  );
}
