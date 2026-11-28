import { Router } from "express";
import { z } from "zod";
import { defaultActivity, type ActivityLog } from "./activity.ts";
import { createNextOccurrence } from "./commands.ts";
import type { TaskStore } from "./task-store.ts";

const createTaskSchema = z.strictObject({ title: z.string().trim().min(1).max(200) });
const subtaskSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  done: z.boolean(),
});
const reminderMoment = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/);
const updateTaskSchema = createTaskSchema
  .partial()
  .extend({
    done: z.boolean().optional(),
    // 前端清单面板勾选子任务时，整组子任务一起回写。
    subtasks: z.array(subtaskSchema).max(50).optional(),
    // 提醒开关与自定义提醒时刻（含逐个任务的小铃铛）。
    remind: z.boolean().optional(),
    reminderAt: z.array(reminderMoment).max(5).optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore, activity: ActivityLog = defaultActivity) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供 1 至 200 个字符的任务标题。" });
    }
    const created = tasks.create(input.data.title);
    activity.record({ kind: "created", title: created.title });
    res.status(201).json(created);
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: "请提供有效的 title、done、subtasks、remind 或 reminderAt 字段。" });
    }

    const before = tasks.get(req.params.id);
    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);

    // 面板能改的只有标题、完成状态和子任务；其余字段由对话写入，不走这里。
    const completed = input.data.done === true && before?.done !== true;
    const kind = completed
      ? "completed"
      : input.data.done === false && before?.done !== false
        ? "reopened"
        : "updated";
    activity.record({ kind, title: updated.title });

    // 面板点完成和对话里说完成要产生同样的结果：重复任务自动排下一次。
    if (completed) {
      const next = createNextOccurrence(tasks, updated);
      if (next) activity.record({ kind: "created", title: next.title });
    }
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    if (task) activity.record({ kind: "deleted", title: task.title });
    res.sendStatus(204);
  });

  // 撤销删除：把最近删掉的一批任务原样恢复（含子任务、标签、时刻等扩展字段）。
  router.post("/undo", (req, res) => {
    const parsed = z
      .object({ count: z.number().int().min(1).max(20).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "count 必须是 1 到 20 之间的整数。" });
    }
    const count = parsed.data.count ?? 1;
    const restored = [];
    for (let index = 0; index < count; index += 1) {
      const task = tasks.restoreLast?.();
      if (!task) break;
      restored.push(task);
      activity.record({ kind: "restored", title: task.title });
    }
    if (restored.length === 0) {
      return res.status(404).json({ error: "没有可以撤销的删除。" });
    }
    res.status(201).json(restored);
  });

  return router;
}
