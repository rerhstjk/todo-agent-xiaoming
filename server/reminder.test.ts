import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiTask } from "../src/chat-client.ts";
import { dueReminders, reminderKey } from "../src/reminder-window.ts";
import { reminderPlan } from "../src/task-dates.ts";

const DATE = "2026-11-26";

function task(overrides: Partial<ApiTask> = {}): ApiTask {
  return { id: "t1", title: "开会", done: false, remind: true, ...overrides };
}

test("默认在开始前 30 分钟和截止前 10 分钟提醒", () => {
  const meeting = task({ startDate: DATE, startTime: "10:00", dueDate: DATE, dueTime: "12:00" });
  const plan = reminderPlan(meeting);
  assert.deepEqual(
    plan.map((entry) => entry.kind),
    ["start", "due"],
  );
  assert.equal(new Date(plan[0]!.at).getHours(), 9);
  assert.equal(new Date(plan[0]!.at).getMinutes(), 30);
  assert.equal(new Date(plan[1]!.at).getHours(), 11);
  assert.equal(new Date(plan[1]!.at).getMinutes(), 50);

  // 09:29:40 离「开始前 30 分钟」还有 20 秒，进入提醒队列。
  const now = new Date(2026, 10, 26, 9, 29, 40).getTime();
  const pending = dueReminders([meeting], now, () => false);
  assert.deepEqual(
    pending.map((entry) => entry.kind),
    ["start"],
  );
});

test("用户指定了提醒时刻就只按指定时刻提醒", () => {
  const meeting = task({
    startDate: DATE,
    startTime: "10:00",
    reminderAt: [`${DATE}T09:05`],
  });
  const plan = reminderPlan(meeting);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.kind, "custom");
  const now = new Date(2026, 10, 26, 9, 4, 40).getTime();
  assert.equal(dueReminders([meeting], now, () => false).length, 1);
  // 默认的开始前 30 分钟不再触发。
  const atStartWindow = new Date(2026, 10, 26, 9, 29, 40).getTime();
  assert.equal(dueReminders([meeting], atStartWindow, () => false).length, 0);
});

test("没有打开提醒的任务不会进入提醒队列", () => {
  const meeting = task({ startDate: DATE, startTime: "10:00", remind: false });
  const now = new Date(2026, 10, 26, 9, 29, 40).getTime();
  assert.deepEqual(
    dueReminders([meeting], now, () => false),
    [],
  );
});

test("同一个提醒时刻只提醒一次", () => {
  const meeting = task({ startDate: DATE, startTime: "10:00" });
  const at = new Date(2026, 10, 26, 9, 30).getTime();
  const key = reminderKey(meeting, at, "start");
  const now = new Date(2026, 10, 26, 9, 29, 40).getTime();
  assert.equal(dueReminders([meeting], now, (item) => item === key).length, 0);
});
