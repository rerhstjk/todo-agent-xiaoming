import { useEffect, useState } from "react";
import type { ApiTask } from "./chat-client.ts";
import { TaskCalendar } from "./TaskCalendar.tsx";
import type { ReminderPermission } from "./use-reminders.ts";
import {
  compareTasks,
  dueBucket,
  effortHours,
  effortText,
  endOfWeek,
  isOverdue,
  reminderDetail,
  startText,
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
  undo,
  onUndo,
  onBatchDone,
  onBatchDelete,
  reminder,
  reminderOn,
  onToggleReminders,
}: {
  tasks: ApiTask[];
  loading: boolean;
  error: string;
  notice?: string;
  /** 最近一次删除的提示与可撤销数量。 */
  undo?: { count: number; label: string } | null;
  onToggle: (task: ApiTask) => void;
  onToggleSubtask: (task: ApiTask, subtaskId: string) => void;
  onDelete: (task: ApiTask) => void;
  onRefresh: () => void;
  onUndo: () => void;
  onBatchDone: (tasks: ApiTask[]) => void;
  onBatchDelete: (tasks: ApiTask[]) => void;
  reminder: ReminderPermission;
  reminderOn: boolean;
  onToggleReminders: () => void;
}) {
  const [view, setView] = useState<"list" | "calendar">("list");
  const [status, setStatus] = useState<Status>("open");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [effortFilter, setEffortFilter] = useState<EffortFilter>("all");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const activeFilters =
    (tagFilter !== "all" ? 1 : 0) +
    (timeFilter !== "all" ? 1 : 0) +
    (priorityFilter !== "all" ? 1 : 0) +
    (effortFilter !== "all" ? 1 : 0);
  // 每隔半分钟重算一次，让「过了开始时间」自动进入逾期，不用手动刷新。
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const today = toDateString(new Date());
  const weekEnd = endOfWeek();

  const allTags = [...new Set(tasks.flatMap((task) => task.tags ?? []))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
  const keyword = query.trim().toLowerCase();

  // 搜索、标签、时间、优先级、工作量先叠加，再在结果里算状态数量。
  const pool = tasks.filter((task) => {
    if (tagFilter !== "all" && !(task.tags ?? []).includes(tagFilter)) return false;
    if (keyword) {
      const haystack = [task.title, task.note ?? "", ...(task.tags ?? [])].join(" ").toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

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
  const selectedTasks = visible.filter((task) => selected.has(task.id));

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectVisible() {
    setSelected(
      new Set(selectedTasks.length === visible.length ? [] : visible.map((task) => task.id)),
    );
  }

  function renderRow(task: ApiTask) {
    const subtasks = task.subtasks ?? [];
    const finished = subtasks.filter((item) => item.done).length;
    const overdue = isOverdue(task);
    const priority = task.priority ?? "normal";
    const repeat =
      task.repeat === "daily"
        ? "每天"
        : task.repeat === "weekly"
          ? "每周"
          : task.repeat === "monthly"
            ? "每月"
            : "";
    return (
      <div key={task.id} role="row" className={`panel-row${task.done ? " done" : ""}`}>
        <div className="cell-title" role="cell">
          {selectMode && (
            <input
              type="checkbox"
              className="row-select"
              aria-label={`选择「${task.title}」`}
              checked={selected.has(task.id)}
              onChange={() => toggleSelected(task.id)}
            />
          )}
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
              {repeat && <span className="repeat-tag">{repeat}</span>}
              {task.remind === true && (
                <span
                  className="bell"
                  title={`已设置提醒：${reminderDetail(task)}`}
                  aria-label={`已设置提醒：${reminderDetail(task)}`}
                >
                  🔔
                </span>
              )}
              {(task.tags ?? []).map((tag) => (
                <span className="tag-pill" key={tag}>
                  #{tag}
                </span>
              ))}
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
        </div>
        <span className={`cell-start${overdue ? " overdue" : ""}`} role="cell">
          {startText(task)}
        </span>
        <span className="cell-effort" role="cell">
          {effortText(task)}
        </span>
        <span className="cell-priority" role="cell">
          <span className={`priority ${priority}`}>{PRIORITY_LABELS[priority]}</span>
        </span>
        <span className="cell-delete" role="cell">
          <button
            className="delete"
            aria-label={`删除「${task.title}」`}
            onClick={() => onDelete(task)}
          >
            ×
          </button>
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
        <div className="panel-head-actions">
          <button
            className={`ghost${reminderOn ? " active" : ""}`}
            type="button"
            aria-pressed={reminderOn}
            onClick={onToggleReminders}
            disabled={reminder === "unsupported"}
            title={
              reminder === "denied"
                ? "浏览器已拒绝通知权限，可在站点设置里重新允许"
                : reminder === "unsupported"
                  ? "当前浏览器不支持系统通知"
                  : "任务快开始时弹出浏览器通知"
            }
          >
            {reminder === "unsupported"
              ? "无提醒"
              : reminder === "denied"
                ? "提醒被拒"
                : reminderOn
                  ? "提醒已开"
                  : "开启提醒"}
          </button>
          <button className="ghost" onClick={onRefresh} disabled={loading} aria-label="刷新清单">
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
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
      {undo && (
        <div className="panel-undo" role="status">
          <span>{undo.label}</span>
          <button type="button" onClick={onUndo}>
            撤销
          </button>
        </div>
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
        <div className="panel-tools">
          <input
            className="panel-search"
            type="search"
            value={query}
            placeholder="搜索标题、备注或标签…"
            aria-label="搜索任务"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className={`panel-toggle${showFilters || activeFilters > 0 ? " active" : ""}`}
            aria-expanded={showFilters}
            onClick={() => setShowFilters((value) => !value)}
          >
            筛选{activeFilters > 0 ? ` ${activeFilters}` : ""}
          </button>
          {view === "list" && (
            <button
              type="button"
              className={`panel-toggle${selectMode ? " active" : ""}`}
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode((value) => !value);
                setSelected(new Set());
              }}
            >
              {selectMode ? "退出多选" : "多选"}
            </button>
          )}
        </div>
        {showFilters && (
          <div className="panel-filters">
            <select
              aria-label="按标签筛选"
              className="panel-select"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="all">全部标签</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
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
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view === "list" && selectMode && (
        <div className="panel-batch">
          <button type="button" className="batch-select" onClick={selectVisible}>
            {selectedTasks.length === visible.length ? "取消全选" : "全选当前"}
          </button>
          {selectedTasks.length > 0 && (
            <>
              <span className="batch-count">已选 {selectedTasks.length} 项</span>
              <button
                type="button"
                onClick={() => {
                  onBatchDone(selectedTasks);
                  setSelected(new Set());
                }}
              >
                完成
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  onBatchDelete(selectedTasks);
                  setSelected(new Set());
                }}
              >
                删除
              </button>
              <button type="button" className="batch-cancel" onClick={() => setSelected(new Set())}>
                取消
              </button>
            </>
          )}
        </div>
      )}
      {view === "calendar" ? (
        <TaskCalendar tasks={pool} onToggle={onToggle} />
      ) : (
        <div className="panel-table" role="table" aria-label="任务表格">
          <div className="panel-row panel-row-head" role="row">
            <span role="columnheader">任务名称</span>
            <span role="columnheader">开始时间</span>
            <span role="columnheader">工作量</span>
            <span role="columnheader">优先级</span>
            <span role="columnheader" aria-label="操作" />
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
