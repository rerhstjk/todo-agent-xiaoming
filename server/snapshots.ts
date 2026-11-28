import { randomUUID } from "node:crypto";
import type { Task, TaskStore } from "./task-store.ts";

/** 对话历史越长，可回滚的点越多；限制数量避免内存无限增长。 */
const MAX_SNAPSHOTS = 100;

/**
 * 每轮对话开始前给整份清单拍一张快照，编辑历史消息时恢复到那一刻。
 * 只存在进程内存里：重启后旧对话本来就没了，快照也一起失效。
 */
export class TaskSnapshots {
  private entries = new Map<string, Task[]>();

  capture(store: TaskStore): string | undefined {
    if (!store.snapshotAll) return undefined;
    const id = randomUUID();
    this.entries.set(id, store.snapshotAll());
    if (this.entries.size > MAX_SNAPSHOTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    return id;
  }

  restore(store: TaskStore, id: string): boolean {
    const snapshot = this.entries.get(id);
    if (!snapshot || !store.restoreAll) return false;
    store.restoreAll(snapshot.map((task) => structuredClone(task)));
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const defaultSnapshots = new TaskSnapshots();
