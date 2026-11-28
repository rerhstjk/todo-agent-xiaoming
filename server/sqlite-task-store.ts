import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

export interface SqliteTaskStoreOptions {
  /** 首次打开且数据库为空时，从这份 JSON 清单迁移旧数据。 */
  migrateFrom?: string;
}

interface Row {
  payload: string;
}

/**
 * 可选的任务存储后端：用 Node.js 内置的 node:sqlite 落盘。
 * 单条任务整包存 JSON（payload），同时冗余 done / 开始日期两列，
 * 这样既能保持 Task 的宽松字段，又能用 SQL 做基本排序与统计。
 * 默认后端仍是 data/tasks.json；设置 XIAOMING_STORE=sqlite 即可切换。
 */
export function createSqliteTaskStore(
  filename: string,
  options: SqliteTaskStoreOptions = {},
): TaskStore {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      done INTEGER NOT NULL DEFAULT 0,
      start_date TEXT,
      payload TEXT NOT NULL
    );
  `);

  const selectAll = db.prepare("SELECT payload FROM tasks ORDER BY rowid");
  const selectOne = db.prepare("SELECT payload FROM tasks WHERE id = ?");
  const insertRow = db.prepare(
    "INSERT INTO tasks (id, done, start_date, payload) VALUES (?, ?, ?, ?)",
  );
  const deleteAll = db.prepare("DELETE FROM tasks");

  function toRow(task: Task): [string, number, string | null, string] {
    return [task.id, task.done ? 1 : 0, task.startDate ?? null, JSON.stringify(task)];
  }

  function insert(task: Task): void {
    insertRow.run(...toRow(task));
  }

  function saveAll(tasks: Task[]): void {
    db.exec("BEGIN");
    try {
      deleteAll.run();
      for (const task of tasks) insert(task);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function count(): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  if (count() === 0 && options.migrateFrom && existsSync(options.migrateFrom)) {
    try {
      const legacy = parseTaskList(JSON.parse(readFileSync(options.migrateFrom, "utf8")));
      if (legacy.length > 0) saveAll(legacy);
    } catch {
      // 旧 JSON 损坏时不阻塞启动，服务仍然可以从空清单开始。
    }
  }

  // 与 JSON 后端一致：撤销只保存在进程内存里，最多 20 条，重启后清空。
  const deleted: Task[] = [];

  return {
    list() {
      return (selectAll.all() as unknown as Row[]).map((row) => JSON.parse(row.payload) as Task);
    },

    get(id) {
      const row = selectOne.get(id) as Row | undefined;
      return row ? (JSON.parse(row.payload) as Task) : undefined;
    },

    create(input: string | NewTask) {
      const task = buildTask(input);
      insert(task);
      return task;
    },

    update(id: string, changes: TaskPatch) {
      const task = this.get(id);
      if (!task) return undefined;
      applyTaskChanges(task, changes);
      db.prepare("UPDATE tasks SET done = ?, start_date = ?, payload = ? WHERE id = ?").run(
        task.done ? 1 : 0,
        task.startDate ?? null,
        JSON.stringify(task),
        id,
      );
      return task;
    },

    remove(id: string) {
      const task = this.get(id);
      if (!task) return false;
      deleted.push(structuredClone(task));
      if (deleted.length > 20) deleted.shift();
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      return true;
    },

    restoreLast() {
      const task = deleted.pop();
      if (!task) return undefined;
      const restored = this.get(task.id) ? { ...task, id: randomUUID() } : task;
      insert(restored);
      return restored;
    },

    snapshotAll() {
      return structuredClone(this.list());
    },

    restoreAll(tasks) {
      saveAll(parseTaskList(tasks));
    },
  };
}
