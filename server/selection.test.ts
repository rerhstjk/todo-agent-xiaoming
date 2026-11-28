import assert from "node:assert/strict";
import { test } from "node:test";
import { sortByDue } from "./selection.ts";
import type { Task } from "./task-store.ts";

function task(overrides: Partial<Task> & { title: string }): Task {
  return { id: overrides.title, done: false, ...overrides };
}

test("默认排序按开始时间先后，没有开始时间时用截止时间", () => {
  const late = task({ title: "十点开会", startDate: "2026-11-27", startTime: "10:00" });
  const early = task({ title: "九点开会", startDate: "2026-11-27", startTime: "09:00" });
  const dueOnly = task({ title: "八点交报告", dueDate: "2026-11-27", dueTime: "08:00" });
  const undated = task({ title: "没定时间" });

  const sorted = sortByDue([late, early, dueOnly, undated]);

  assert.deepEqual(
    sorted.map((item) => item.title),
    ["八点交报告", "九点开会", "十点开会", "没定时间"],
  );
});

test("开始时间相同时高优先级排在前面，没有时间的任务也按优先级排", () => {
  const low = task({
    title: "低优先级",
    startDate: "2026-11-27",
    startTime: "09:00",
    priority: "low",
  });
  const high = task({
    title: "高优先级",
    startDate: "2026-11-27",
    startTime: "09:00",
    priority: "high",
  });
  const normal = task({
    title: "普通",
    startDate: "2026-11-27",
    startTime: "09:00",
    priority: "normal",
  });
  const undatedLow = task({ title: "无时间低", priority: "low" });
  const undatedHigh = task({ title: "无时间高", priority: "high" });

  const sorted = sortByDue([low, undatedLow, normal, undatedHigh, high]);

  assert.deepEqual(
    sorted.map((item) => item.title),
    ["高优先级", "普通", "低优先级", "无时间高", "无时间低"],
  );
});
