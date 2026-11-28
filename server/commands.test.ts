/**
 * 命令层接口测试：这里不经过中文解析，也不经过模型，
 * 直接验证「谁对清单做了什么」这一层的契约。
 */
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "./commands.ts";
import { selectTasks } from "./selection.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

/** 2026-11-26 是周四，本周最后一天是 11-29（周日）。 */
const NOW = new Date(2026, 10, 26, 9, 0, 0);

let directory = "";
let store: TaskStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "xiaoming-commands-"));
  store = createJsonTaskStore(join(directory, "tasks.json"));
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function create(title: string, extra: { dueDate?: string; priority?: "high" } = {}) {
  return execute(store, { kind: "create", input: { title, ...extra } }, NOW);
}

describe("create", () => {
  test("创建后进入清单，并带出完整快照", () => {
    const result = create("买牛奶");
    assert.equal(result.status, "ok");
    assert.equal(result.changed, true);
    assert.equal(result.task?.title, "买牛奶");
    assert.equal(result.tasks.length, 1);
    assert.equal(result.duplicate, undefined);
  });

  test("同名未完成任务重复创建时仍创建，但把旧任务标为 duplicate", () => {
    const first = create("买牛奶");
    const second = create("买牛奶");
    assert.equal(second.status, "ok");
    assert.equal(second.tasks.length, 2);
    assert.equal(second.duplicate?.id, first.task?.id);
  });

  test("同名任务已完成后再次创建不算重复", () => {
    const first = create("买牛奶");
    execute(store, { kind: "setDone", hint: "买牛奶", done: true }, NOW);
    const again = create("买牛奶");
    assert.equal(again.duplicate, undefined);
    assert.equal(again.tasks.filter((task) => !task.done).length, 1);
    assert.ok(first.task);
  });
});

describe("list 范围", () => {
  test("今天、明天、本周、逾期、已完成、全部各自筛选正确", () => {
    create("今天交周报", { dueDate: "2026-11-26" });
    create("明天开会", { dueDate: "2026-11-27" });
    create("周日体检", { dueDate: "2026-11-29" });
    create("下周一复盘", { dueDate: "2026-11-30" });
    create("昨天交房租", { dueDate: "2026-11-25" });
    create("没有日期的杂事");
    const done = create("已经做完的事", { dueDate: "2026-11-26" });
    execute(store, { kind: "setDone", hint: "已经做完的事", done: true }, NOW);
    assert.ok(done.task);

    const titles = (scope: Parameters<typeof selectTasks>[1]) =>
      selectTasks(store.list(), scope, NOW).map((task) => task.title);

    assert.deepEqual(titles("today"), ["今天交周报", "已经做完的事"]);
    assert.deepEqual(titles("tomorrow"), ["明天开会"]);
    assert.deepEqual(titles("week"), ["今天交周报", "明天开会", "周日体检"]);
    assert.deepEqual(titles("overdue"), ["昨天交房租"]);
    assert.deepEqual(titles("done"), ["已经做完的事"]);
    assert.deepEqual(titles("open"), [
      "昨天交房租",
      "今天交周报",
      "明天开会",
      "周日体检",
      "下周一复盘",
      "没有日期的杂事",
    ]);
    assert.equal(titles("all").length, 7);
    assert.equal(titles("all").at(-1), "已经做完的事");
  });

  test("list 命令返回快照与筛选结果，且不改变数据", () => {
    create("买牛奶");
    const result = execute(store, { kind: "list", scope: "open" }, NOW);
    assert.equal(result.status, "ok");
    assert.equal(result.changed, false);
    assert.equal(result.scope, "open");
    assert.deepEqual(
      result.selection?.map((task) => task.title),
      ["买牛奶"],
    );
  });
});

describe("setDone / remove / rename / update", () => {
  test("完成与重新打开都是幂等的", () => {
    create("买牛奶");
    const done = execute(store, { kind: "setDone", hint: "牛奶", done: true }, NOW);
    assert.equal(done.status, "ok");
    assert.equal(done.task?.done, true);

    const again = execute(store, { kind: "setDone", hint: "牛奶", done: true }, NOW);
    assert.equal(again.status, "unchanged");
    assert.equal(again.changed, false);
    assert.equal(again.reason, "already-done");

    const reopened = execute(store, { kind: "setDone", hint: "牛奶", done: false }, NOW);
    assert.equal(reopened.status, "ok");
    assert.equal(reopened.task?.done, false);
  });

  test("删除后快照里不再有这条任务", () => {
    create("取快递");
    const removed = execute(store, { kind: "remove", hint: "快递" }, NOW);
    assert.equal(removed.status, "ok");
    assert.equal(removed.task?.title, "取快递");
    assert.equal(removed.tasks.length, 0);
  });

  test("重命名保留原任务 id 并记录旧标题", () => {
    const created = create("买牛奶");
    const renamed = execute(store, { kind: "rename", hint: "牛奶", title: "买两盒牛奶" }, NOW);
    assert.equal(renamed.status, "ok");
    assert.equal(renamed.task?.id, created.task?.id);
    assert.equal(renamed.task?.title, "买两盒牛奶");
    assert.equal(renamed.previousTitle, "买牛奶");
  });

  test("空 patch 视为 invalid，不动数据", () => {
    create("买牛奶");
    const result = execute(store, { kind: "update", hint: "牛奶", patch: {} }, NOW);
    assert.equal(result.status, "invalid");
    assert.equal(result.reason, "no-fields");
    assert.equal(store.list()[0]?.dueDate, undefined);
  });

  test("更新截止日期、优先级与工作量", () => {
    create("写方案");
    const result = execute(
      store,
      {
        kind: "update",
        hint: "方案",
        patch: { dueDate: "2026-11-28", priority: "high", effort: 2 },
      },
      NOW,
    );
    assert.equal(result.status, "ok");
    assert.equal(result.task?.dueDate, "2026-11-28");
    assert.equal(result.task?.priority, "high");
    assert.equal(result.task?.effort, 2);
  });

  test("找不到任务时返回 missing 并带上完整清单", () => {
    create("买牛奶");
    const result = execute(store, { kind: "remove", hint: "洗衣服" }, NOW);
    assert.equal(result.status, "missing");
    assert.equal(result.changed, false);
    assert.deepEqual(
      result.tasks.map((task) => task.title),
      ["买牛奶"],
    );
    assert.equal(result.hint, "洗衣服");
  });

  test("多条相似任务时返回 ambiguous 与候选，不修改数据", () => {
    create("买牛奶");
    create("回家买牛奶");
    const result = execute(store, { kind: "setDone", hint: "牛奶", done: true }, NOW);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.changed, false);
    assert.deepEqual(
      result.candidates?.map((task) => task.title),
      ["买牛奶", "回家买牛奶"],
    );
    assert.equal(store.list().filter((task) => task.done).length, 0);
  });
});

describe("subtask", () => {
  test("添加、完成、删除子任务，父任务始终存在", () => {
    create("写方案");

    const added = execute(
      store,
      { kind: "subtask", hint: "方案", action: "add", subtask: "写初稿" },
      NOW,
    );
    assert.equal(added.status, "ok");
    assert.deepEqual(
      added.subtasks?.map((item) => item.title),
      ["写初稿"],
    );

    const duplicated = execute(
      store,
      { kind: "subtask", hint: "方案", action: "add", subtask: "写初稿" },
      NOW,
    );
    assert.equal(duplicated.status, "unchanged");
    assert.equal(duplicated.reason, "duplicate-subtask");

    const completed = execute(
      store,
      { kind: "subtask", hint: "方案", action: "complete", subtask: "写初稿" },
      NOW,
    );
    assert.equal(completed.status, "ok");
    assert.equal(completed.subtask?.done, true);

    const removed = execute(
      store,
      { kind: "subtask", hint: "方案", action: "remove", subtask: "写初稿" },
      NOW,
    );
    assert.equal(removed.status, "ok");
    assert.deepEqual(removed.subtasks, []);
    assert.equal(removed.task?.title, "写方案");
    assert.equal(store.list().length, 1);
  });

  test("子任务不存在时返回 subtask-missing 和现有子任务", () => {
    create("写方案");
    execute(store, { kind: "subtask", hint: "方案", action: "add", subtask: "收集数据" }, NOW);
    const result = execute(
      store,
      { kind: "subtask", hint: "方案", action: "complete", subtask: "画图" },
      NOW,
    );
    assert.equal(result.status, "unchanged");
    assert.equal(result.reason, "subtask-missing");
    assert.deepEqual(
      result.subtasks?.map((item) => item.title),
      ["收集数据"],
    );
  });
});

describe("clearDone", () => {
  test("只清理已完成任务并返回数量", () => {
    create("买牛奶");
    create("取快递");
    execute(store, { kind: "setDone", hint: "牛奶", done: true }, NOW);

    const result = execute(store, { kind: "clearDone" }, NOW);
    assert.equal(result.status, "ok");
    assert.equal(result.cleared, 1);
    assert.deepEqual(
      result.tasks.map((task) => task.title),
      ["取快递"],
    );

    const empty = execute(store, { kind: "clearDone" }, NOW);
    assert.equal(empty.status, "unchanged");
    assert.equal(empty.reason, "empty-list");
  });
});
