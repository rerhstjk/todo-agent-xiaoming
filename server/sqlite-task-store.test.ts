import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createSqliteTaskStore } from "./sqlite-task-store.ts";

const dir = mkdtempSync(join(tmpdir(), "xiaoming-sqlite-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let file = "";
beforeEach(() => {
  file = join(dir, `test-${Date.now()}-${Math.random()}.db`);
});

describe("SQLite 任务存储", () => {
  it("创建、更新、删除与撤销的行为和 JSON 后端一致", () => {
    const store = createSqliteTaskStore(file);
    const task = store.create({
      title: "开会",
      startDate: "2026-11-29",
      startTime: "15:00",
      priority: "high",
      effort: 2,
      tags: ["工作"],
      note: "带上电脑",
    });
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.get(task.id)?.tags, ["工作"]);

    const updated = store.update(task.id, { note: "改到三号会议室", position: 3 });
    assert.equal(updated?.note, "改到三号会议室");
    assert.equal(updated?.position, 3);

    const cleared = store.update(task.id, { note: null, startTime: null });
    assert.equal(cleared?.note, undefined);
    assert.equal(cleared?.startTime, undefined);

    assert.equal(store.remove(task.id), true);
    assert.equal(store.list().length, 0);
    const restored = store.restoreLast?.();
    assert.equal(restored?.id, task.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.restoreLast?.(), undefined);
  });

  it("重启后数据仍在，快照能整份恢复", () => {
    const store = createSqliteTaskStore(file);
    store.create("买牛奶");
    store.create("取快递");
    const snapshot = store.snapshotAll?.() ?? [];
    store.create("写周报");
    assert.equal(store.list().length, 3);

    const reopened = createSqliteTaskStore(file);
    assert.deepEqual(
      reopened.list().map((task) => task.title),
      ["买牛奶", "取快递", "写周报"],
    );

    reopened.restoreAll?.(snapshot);
    assert.deepEqual(
      reopened.list().map((task) => task.title),
      ["买牛奶", "取快递"],
    );
  });

  it("首次打开时可以把旧的 tasks.json 迁移进来", () => {
    const legacy = join(dir, "legacy.json");
    writeFileSync(
      legacy,
      JSON.stringify([
        { id: "a", title: "开会", done: false, startDate: "2026-11-29", tags: ["工作"] },
        { id: "b", title: "买牛奶", done: true },
      ]),
    );
    const store = createSqliteTaskStore(join(dir, "migrated.db"), { migrateFrom: legacy });
    assert.deepEqual(
      store.list().map((task) => task.title),
      ["开会", "买牛奶"],
    );
    assert.equal(store.get("a")?.startDate, "2026-11-29");
  });
});
