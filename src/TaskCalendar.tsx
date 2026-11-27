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

const WEEKDAY_HEADERS = ["日", "一", "二", "三", "四", "五", "六"];

interface DayCell {
  /** 不在本月的空白格没有 date。 */
  date?: string;
  day?: number;
}

/** 一个月按周日开头的网格，前后补空格。 */
function monthCells(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: DayCell[] = [];
  for (let index = 0; index < first.getDay(); index += 1) cells.push({});
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ date: `${year}-${pad(month + 1)}-${pad(day)}`, day });
  }
  return cells;
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
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  // 同一天的任务按时刻排，有时刻的在前。
  const byDate = useMemo(() => {
    const map = new Map<string, ApiTask[]>();
    for (const task of [...tasks].sort(compareTasks)) {
      if (!task.dueDate) continue;
      const list = map.get(task.dueDate) ?? [];
      list.push(task);
      map.set(task.dueDate, list);
    }
    return map;
  }, [tasks]);

  const cells = monthCells(cursor.year, cursor.month);
  const dayTasks = byDate.get(selected) ?? [];
  const openCount = dayTasks.filter((task) => !task.done).length;
  const undated = tasks.filter((task) => !task.dueDate && !task.done).length;
  const selectedDate = parseDateString(selected);

  function moveMonth(offset: number) {
    const next = new Date(cursor.year, cursor.month + offset, 1);
    setCursor({ year: next.getFullYear(), month: next.getMonth() });
  }

  function backToToday() {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setSelected(today);
  }

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="calendar-nav" aria-label="上个月" onClick={() => moveMonth(-1)}>
          ‹
        </button>
        <div className="calendar-title">
          <strong>{cursor.month + 1}月</strong>
          <span>{cursor.year}</span>
        </div>
        <button className="calendar-nav" aria-label="下个月" onClick={() => moveMonth(1)}>
          ›
        </button>
      </div>
      {(cursor.year !== new Date().getFullYear() || cursor.month !== new Date().getMonth()) && (
        <button className="calendar-today-link" onClick={backToToday}>
          回到今天
        </button>
      )}

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
        {cells.map((cell, index) => {
          if (!cell.date) return <span key={`blank-${index}`} className="calendar-blank" />;
          const date = cell.date;
          const tasksOnDay = byDate.get(date) ?? [];
          const open = tasksOnDay.filter((task) => !task.done).length;
          const classes = ["calendar-day"];
          if (date === today) classes.push("is-today");
          if (date === selected) classes.push("is-selected");
          if (tasksOnDay.length > 0) classes.push("has-tasks");
          return (
            <button
              key={date}
              role="gridcell"
              className={classes.join(" ")}
              aria-pressed={date === selected}
              aria-label={`${(parseDateString(date)?.getMonth() ?? cursor.month) + 1}月${cell.day}日${
                open > 0 ? `，${open} 项待办` : tasksOnDay.length > 0 ? "，已完成" : ""
              }`}
              onClick={() => setSelected(date)}
            >
              <span className="calendar-day-number">{cell.day}</span>
              {open > 0 ? (
                <span className="calendar-badge">{open}</span>
              ) : tasksOnDay.length > 0 ? (
                <span className="calendar-dot" />
              ) : null}
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
            {undated > 0 && ` 另外有 ${undated} 项任务还没有截止日期。`}
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
                      task.dueTime ?? "全天",
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
