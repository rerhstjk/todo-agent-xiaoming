import { Router } from "express";
import { z } from "zod";
import { defaultActivity, type ActivityLog } from "./activity.ts";
import type { TaskStore } from "./task-store.ts";

const createTaskSchema = z.strictObject({ title: z.string().trim().min(1).max(200) });
const subtaskSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  done: z.boolean(),
});
const updateTaskSchema = createTaskSchema
  .partial()
  .extend({
    done: z.boolean().optional(),
    // 前端清单面板勾选子任务时，整组子任务一起回写。
    subtasks: z.array(subtaskSchema).max(50).optional(),
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
      return res.status(400).json({ error: "请提供有效的 title、done 或 subtasks 字段。" });
    }

    const before = tasks.get(req.params.id);
    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);

    // 面板能改的只有标题、完成状态和子任务；其余字段由对话写入，不走这里。
    const kind =
      input.data.done === true && before?.done !== true
        ? "completed"
        : input.data.done === false && before?.done !== false
          ? "reopened"
          : "updated";
    activity.record({ kind, title: updated.title });
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    if (task) activity.record({ kind: "deleted", title: task.title });
    res.sendStatus(204);
  });

  return router;
}
