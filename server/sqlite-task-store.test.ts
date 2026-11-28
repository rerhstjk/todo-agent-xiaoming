import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createDefaultTaskStore } from "./default-store.ts";
import { createSqliteTaskStore, migrateJsonIfNeeded } from "./sqlite-task-store.ts";

const directories: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xiaoming-sqlite-"));
  directories.push(dir);
  return { dir, file: join(dir, "tasks.db") };
}

after(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

test("SQLite 存储支持增删改查，顺序与扩展字段都保留", () => {
  const { file } = fixture();
  const store = createSqliteTaskStore(file);

  const first = store.create({ title: "买牛奶", tags: ["生活"], effort: 0.5 });
  const second = store.create("取快递");
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶", "取快递"],
  );

  store.update(second.id, { done: true, note: "下班顺路", priority: "high" });
  const updated = store.get(second.id);
  assert.equal(updated?.done, true);
  assert.equal(updated?.note, "下班顺路");
  assert.equal(updated?.priority, "high");
  assert.equal(store.get(first.id)?.tags?.[0], "生活");

  assert.equal(store.remove(first.id), true);
  assert.equal(store.remove(first.id), false);
  assert.deepEqual(
    store.list().map((task) => task.id),
    [second.id],
  );
});

test("SQLite 的撤销会恢复原 id 与字段，同 id 已存在时换新 id", () => {
  const { file } = fixture();
  const store = createSqliteTaskStore(file);

  const task = store.create({ title: "开会", startDate: "2026-11-29", startTime: "15:00" });
  store.remove(task.id);
  const restored = store.restoreLast?.();
  assert.equal(restored?.id, task.id);
  assert.equal(restored?.startTime, "15:00");

  store.remove(restored!.id);
  store.restoreAll?.([{ ...restored!, id: restored!.id }]);
  const collision = store.restoreLast?.();
  assert.notEqual(collision?.id, restored?.id);
  assert.equal(store.list().length, 2);
});

test("SQLite 快照可以整体覆盖，顺序保持不变", () => {
  const { file } = fixture();
  const store = createSqliteTaskStore(file);
  store.create("A");
  store.create("B");
  const snapshot = store.snapshotAll?.() ?? [];

  store.remove(store.list()[0]!.id);
  store.create("C");
  store.restoreAll?.(snapshot);

  assert.deepEqual(
    store.list().map((task) => task.title),
    ["A", "B"],
  );
});

test("两个连接同时写同一数据库不会互相覆盖", () => {
  const { file } = fixture();
  const left = createSqliteTaskStore(file);
  const right = createSqliteTaskStore(file);

  for (let index = 0; index < 20; index += 1) {
    left.create({ title: `左 ${index}` });
    right.create({ title: `右 ${index}` });
  }

  assert.equal(left.list().length, 40);
  assert.equal(right.list().length, 40);
  assert.equal(new Set(left.list().map((task) => task.id)).size, 40);
});

test("首次切到 SQLite 会导入旧的 tasks.json，且不会重复导入", () => {
  const { dir, file } = fixture();
  const jsonFile = join(dir, "tasks.json");
  writeFileSync(
    jsonFile,
    JSON.stringify([
      { id: "a", title: "买牛奶", done: false, priority: "high", tags: ["生活"] },
      { id: "b", title: "取快递", done: true },
    ]),
  );

  const store = createSqliteTaskStore(file);
  migrateJsonIfNeeded(store, jsonFile);
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0]?.tags?.[0], "生活");

  // 第二次启动数据库已有数据，不应重复导入。
  const again = createSqliteTaskStore(file);
  migrateJsonIfNeeded(again, jsonFile);
  assert.equal(again.list().length, 2);
});

test("清空 SQLite 清单后重启，不会把旧 tasks.json 再次导回来", () => {
  const { dir } = fixture();
  writeFileSync(
    join(dir, "tasks.json"),
    JSON.stringify([{ id: "old", title: "旧任务", done: false }]),
  );

  const store = createDefaultTaskStore(dir);
  assert.equal(store.list().length, 1);
  store.remove(store.list()[0]!.id);
  assert.equal(store.list().length, 0);

  const restarted = createDefaultTaskStore(dir);
  assert.equal(restarted.list().length, 0);
});

test("默认存储是 SQLite，可用 XIAOMING_STORE=json 退回 JSON", () => {
  const { dir } = fixture();
  const sqlite = createDefaultTaskStore(dir);
  sqlite.create("写周报");
  const reopened = createDefaultTaskStore(dir);
  assert.equal(reopened.list().length, 1);

  const previous = process.env.XIAOMING_STORE;
  process.env.XIAOMING_STORE = "json";
  try {
    const json = createDefaultTaskStore(dir);
    assert.equal(json.list().length, 0);
    json.create("独立文件");
    assert.equal(json.list().length, 1);
  } finally {
    if (previous === undefined) delete process.env.XIAOMING_STORE;
    else process.env.XIAOMING_STORE = previous;
  }
});
