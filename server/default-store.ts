import { existsSync } from "node:fs";
import { join } from "node:path";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";
import { createSqliteTaskStore, migrateJsonIfNeeded } from "./sqlite-task-store.ts";

/**
 * 默认用 SQLite（node:sqlite，无额外依赖）；设置 XIAOMING_STORE=json 可退回 JSON 文件。
 * 首次切到 SQLite 且数据库为空时，会把旧的 data/tasks.json 自动导入，原文件保留。
 */
export function createDefaultTaskStore(dir = "data"): TaskStore {
  if ((process.env.XIAOMING_STORE ?? "sqlite").toLowerCase() === "json") {
    return createJsonTaskStore(join(dir, "tasks.json"));
  }
  const databaseFile = join(dir, "tasks.db");
  const freshDatabase = !existsSync(databaseFile);
  const store = createSqliteTaskStore(databaseFile);
  // 只在数据库文件第一次创建时迁移，避免用户清空清单后重启又把旧 JSON 导回来。
  if (freshDatabase) migrateJsonIfNeeded(store, join(dir, "tasks.json"));
  return store;
}

let shared: TaskStore | undefined;

/** 服务端共用一个实例，智能体与任务 API 必须读写同一份清单。 */
export function defaultTaskStore(): TaskStore {
  shared ??= createDefaultTaskStore();
  return shared;
}
