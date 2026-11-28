import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiTask } from "../src/chat-client.ts";
import { dueReminders, reminderKey } from "../src/reminder-window.ts";
import { toDateString } from "../src/task-dates.ts";

const now = new Date(2026, 10, 26, 9, 0, 0);

function task(overrides: Partial<ApiTask> = {}): ApiTask {
  return { id: "t1", title: "开会", done: false, ...overrides };
}

test("临近截止的任务会进入提醒队列", () => {
  const soon = task({
    id: "soon",
    dueDate: toDateString(new Date(2026, 10, 26)),
    dueTime: "09:20",
  });
  const later = task({
    id: "later",
    dueDate: toDateString(new Date(2026, 10, 26)),
    dueTime: "12:00",
  });
  const done = task({ id: "done", done: true, dueDate: toDateString(new Date(2026, 10, 26)) });
  const pending = dueReminders([soon, later, done], now.getTime(), () => false);
  assert.deepEqual(
    pending.map((item) => item.task.id),
    ["soon"],
  );
});

test("刚过截止时间的任务补一次提醒，太早偏过去的不再打扰", () => {
  const justOverdue = task({
    id: "overdue",
    dueDate: toDateString(new Date(2026, 10, 26)),
    dueTime: "08:55",
  });
  const longOverdue = task({
    id: "old",
    dueDate: toDateString(new Date(2026, 10, 26)),
    dueTime: "08:00",
  });
  const pending = dueReminders([justOverdue, longOverdue], now.getTime(), () => false);
  assert.deepEqual(
    pending.map((item) => item.task.id),
    ["overdue"],
  );
});

test("同一个任务同一截止时刻只提醒一次", () => {
  const soon = task({
    id: "soon",
    dueDate: toDateString(new Date(2026, 10, 26)),
    dueTime: "09:20",
  });
  const at = new Date(2026, 10, 26, 9, 20).getTime();
  const key = reminderKey(soon, at);
  const pending = dueReminders([soon], now.getTime(), (item) => item === key);
  assert.equal(pending.length, 0);
});
