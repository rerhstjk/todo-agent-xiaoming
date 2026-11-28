import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSqliteTaskStore } from "./sqlite-task-store.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

let shared: TaskStore | undefined;

/**
 * 服务端共用一个任务存储实例，智能体与任务 API 必须读写同一份清单。
 * 默认仍是零依赖、可直接查看与备份的 data/tasks.json；
 * 设置 XIAOMING_STORE=sqlite 后改用 Node 内置 node:sqlite（首次启动自动迁移旧 JSON）。
 */
export function defaultTaskStore(): TaskStore {
  if (shared) return shared;
  const dataDir = process.env.XIAOMING_DATA_DIR?.trim() || join("data");
  if ((process.env.XIAOMING_STORE ?? "").trim().toLowerCase() === "sqlite") {
    mkdirSync(dataDir, { recursive: true });
    shared = createSqliteTaskStore(join(dataDir, "xiaoming.db"), {
      migrateFrom: join(dataDir, "tasks.json"),
    });
  } else {
    shared = createJsonTaskStore(join(dataDir, "tasks.json"));
  }
  return shared;
}
