import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyTaskChanges,
  buildTask,
  parseTaskList,
  type NewTask,
  type Task,
  type TaskPatch,
  type TaskStore,
} from "./task-store.ts";

/**
 * SQLite 存储：整条任务以 JSON 存在 data 列里，对外仍然实现同一个 TaskStore 接口。
 * 用 node:sqlite 内置模块，不引入原生依赖；WAL + busy_timeout 让多个连接互相等待而不是直接失败。
 */
export function createSqliteTaskStore(filename: string): TaskStore {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL
    )
  `);

  const listStatement = db.prepare("SELECT data FROM tasks ORDER BY seq");
  const getStatement = db.prepare("SELECT data FROM tasks WHERE id = ?");
  const insertStatement = db.prepare("INSERT INTO tasks (id, data) VALUES (?, ?)");
  const updateStatement = db.prepare("UPDATE tasks SET data = ? WHERE id = ?");
  const deleteStatement = db.prepare("DELETE FROM tasks WHERE id = ?");
  const clearStatement = db.prepare("DELETE FROM tasks");

  function rowToTask(row: unknown): Task {
    const data = (row as { data: string }).data;
    return parseTaskList([JSON.parse(data)])[0] as Task;
  }

  function list(): Task[] {
    return listStatement.all().map(rowToTask);
  }

  // 被删掉的任务先留在内存里，供「撤销」恢复；不落盘，重启后就没有了。
  const deleted: Task[] = [];

  return {
    list,

    get(id) {
      const row = getStatement.get(id);
      return row ? rowToTask(row) : undefined;
    },

    create(input: string | NewTask) {
      const task = buildTask(input);
      insertStatement.run(task.id, JSON.stringify(task));
      return task;
    },

    update(id: string, changes: TaskPatch) {
      const row = getStatement.get(id);
      if (!row) return undefined;
      const task = rowToTask(row);
      applyTaskChanges(task, changes);
      updateStatement.run(JSON.stringify(task), id);
      return task;
    },

    remove(id) {
      const row = getStatement.get(id);
      if (!row) return false;
      deleted.push(structuredClone(rowToTask(row)));
      if (deleted.length > 20) deleted.shift();
      deleteStatement.run(id);
      return true;
    },

    restoreLast() {
      const task = deleted.pop();
      if (!task) return undefined;
      const existing = getStatement.get(task.id);
      const restored = existing ? { ...task, id: randomUUID() } : task;
      insertStatement.run(restored.id, JSON.stringify(restored));
      return restored;
    },

    snapshotAll() {
      return structuredClone(list());
    },

    restoreAll(tasks) {
      const parsed = parseTaskList(tasks);
      db.exec("BEGIN IMMEDIATE");
      try {
        clearStatement.run();
        for (const task of parsed) insertStatement.run(task.id, JSON.stringify(task));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** 首次启动时把旧的 data/tasks.json 导入空库，不删除原文件，方便回退。 */
export function migrateJsonIfNeeded(store: TaskStore, jsonFile: string): void {
  const databaseFile = jsonFile.replace(/tasks\.json$/, "tasks.db");
  if (store.list().length > 0) return;
  try {
    const tasks = parseTaskList(JSON.parse(readFileSync(jsonFile, "utf8")));
    if (tasks.length === 0) return;
    store.restoreAll?.(tasks);
    console.log(
      `[xiaoming] 已把 ${tasks.length} 条任务从 ${jsonFile} 迁移到 ${databaseFile}，原 JSON 文件保留未动。`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`[xiaoming] 读取旧 JSON 清单失败，跳过迁移：${(error as Error).message}`);
  }
}
