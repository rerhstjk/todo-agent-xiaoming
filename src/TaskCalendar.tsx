import { useMemo, useState } from "react";
import type { ApiTask } from "./chat-client.ts";
import {
  chineseDate,
  compareTasks,
  isOverdue,
  pad,
  parseDateString,
  relativeDayLabel,
  toDateString,
} from "./task-dates.ts";

// 和图片一致，周一排在最左边。
const WEEKDAY_HEADERS = ["一", "二", "三", "四", "五", "六", "日"];
const MAX_BARS = 2;

function monthOf(year: number, month: number) {
  return { year, month };
}

/** 某个月的 42 个格子，周一起始，补上相邻月份的日期。 */
function monthCells(
  year: number,
  month: number,
): { date: string; day: number; outside: boolean }[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return {
      date: toDateString(date),
      day: date.getDate(),
      outside: date.getMonth() !== month,
    };
  });
}

export function TaskCalendar({
  tasks,
  onToggle,
}: {
  tasks: ApiTask[];
  onToggle: (task: ApiTask) => void;
}) {
  const today = toDateString(new Date());
  const [selected, setSelected] = useState(today);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return monthOf(now.getFullYear(), now.getMonth());
  });

  // 任务优先落在开始日期上；没有开始日期时按截止日期。
  const byDate = useMemo(() => {
    const map = new Map<string, ApiTask[]>();
    for (const task of [...tasks].sort(compareTasks)) {
      const date = task.startDate ?? task.dueDate;
      if (!date) continue;
      const list = map.get(date) ?? [];
      list.push(task);
      map.set(date, list);
    }
    return map;
  }, [tasks]);

  const cells = monthCells(cursor.year, cursor.month);
  const dayTasks = byDate.get(selected) ?? [];
  const openCount = dayTasks.filter((task) => !task.done).length;
  const undated = tasks.filter((task) => !task.dueDate && !task.startDate && !task.done).length;
  const selectedDate = parseDateString(selected);

  function moveMonth(offset: number) {
    const next = new Date(cursor.year, cursor.month + offset, 1);
    setCursor(monthOf(next.getFullYear(), next.getMonth()));
  }

  function backToToday() {
    const now = new Date();
    setCursor(monthOf(now.getFullYear(), now.getMonth()));
    setSelected(today);
  }

  return (
    <div className="calendar">
      <div className="calendar-head">
        <div className="calendar-title">
          <strong>
            {cursor.year}.{pad(cursor.month + 1)}
          </strong>
        </div>
        <div className="calendar-actions">
          <button className="calendar-today" onClick={backToToday}>
            今天
          </button>
          <button className="calendar-nav" aria-label="上个月" onClick={() => moveMonth(-1)}>
            ‹
          </button>
          <button className="calendar-nav" aria-label="下个月" onClick={() => moveMonth(1)}>
            ›
          </button>
        </div>
      </div>

      <div className="calendar-weekdays" aria-hidden="true">
        {WEEKDAY_HEADERS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div
        className="calendar-grid"
        role="grid"
        aria-label={`${cursor.year}年${cursor.month + 1}月`}
      >
        {cells.map((cell) => {
          const tasksOnDay = byDate.get(cell.date) ?? [];
          const open = tasksOnDay.filter((task) => !task.done).length;
          const classes = ["calendar-day"];
          if (cell.outside) classes.push("is-outside");
          if (cell.date === today) classes.push("is-today");
          if (cell.date === selected) classes.push("is-selected");
          return (
            <button
              key={cell.date}
              role="gridcell"
              className={classes.join(" ")}
              aria-pressed={cell.date === selected}
              aria-label={`${(parseDateString(cell.date)?.getMonth() ?? cursor.month) + 1}月${cell.day}日${
                open > 0 ? `，${open} 项待办` : tasksOnDay.length > 0 ? "，已完成" : ""
              }`}
              onClick={() => setSelected(cell.date)}
            >
              <span className="calendar-day-head">
                <span className="calendar-day-number">{cell.day}</span>
                {cell.date === today ? (
                  <span className="calendar-day-note is-today-note">今天</span>
                ) : (
                  <span className="calendar-day-note">
                    {open > 0 ? `${open} 项` : tasksOnDay.length > 0 ? "已完成" : ""}
                  </span>
                )}
              </span>
              <span className="calendar-bars">
                {tasksOnDay.slice(0, MAX_BARS).map((task) => (
                  <span
                    key={task.id}
                    className={`calendar-bar priority-${task.priority ?? "normal"}${task.done ? " done" : ""}`}
                    title={task.title}
                  >
                    {task.title}
                  </span>
                ))}
                {tasksOnDay.length > MAX_BARS && (
                  <span className="calendar-more">+{tasksOnDay.length - MAX_BARS}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="day-detail">
        <div className="day-detail-head">
          <strong>
            {relativeDayLabel(selected)}
            {selected === today && " · "}
            {chineseDate(selected)}
          </strong>
          <span className="day-chip">
            {openCount > 0 ? `${openCount} 项待办` : dayTasks.length > 0 ? "都已做完" : "无任务"}
          </span>
        </div>
        {dayTasks.length === 0 ? (
          <p className="panel-empty">
            {selectedDate ? "这一天没有安排任务。" : "日期无效。"}
            {undated > 0 && ` 另外有 ${undated} 项任务还没有日期。`}
          </p>
        ) : (
          <ul className="day-tasks">
            {dayTasks.map((task) => (
              <li key={task.id} className={task.done ? "done" : ""}>
                <button
                  className="day-dot"
                  aria-label={
                    task.done ? `把「${task.title}」重新打开` : `把「${task.title}」标记为完成`
                  }
                  aria-pressed={task.done}
                  onClick={() => onToggle(task)}
                />
                <div className="day-task-body">
                  <span className="day-task-title">{task.title}</span>
                  <span className="day-task-meta">
                    {[
                      task.dueTime ?? task.startTime ?? "全天",
                      task.done ? "已完成" : isOverdue(task) ? "已逾期" : "待完成",
                      task.subtasks?.length
                        ? `子任务 ${task.subtasks.filter((item) => item.done).length}/${task.subtasks.length}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
