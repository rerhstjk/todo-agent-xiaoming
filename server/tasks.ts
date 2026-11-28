import { Router } from "express";
import { z } from "zod";
import { defaultActivity, type ActivityLog } from "./activity.ts";
import { createNextOccurrence } from "./commands.ts";
import type { Task, TaskStore } from "./task-store.ts";

const createTaskSchema = z.strictObject({ title: z.string().trim().min(1).max(200) });
const subtaskSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  done: z.boolean(),
});
const reminderMoment = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/);
const dateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockValue = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const updateTaskSchema = createTaskSchema
  .partial()
  .extend({
    done: z.boolean().optional(),
    // 前端清单面板勾选子任务时，整组子任务一起回写。
    subtasks: z.array(subtaskSchema).max(50).optional(),
    // 开始时间与提醒：面板和测试脚本都可以直接写这两个字段。
    startDate: dateValue.nullable().optional(),
    startTime: clockValue.nullable().optional(),
    priority: z.enum(["low", "normal", "high"]).nullable().optional(),
    effort: z.number().min(0).max(100).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(20)).max(10).nullable().optional(),
    repeat: z.enum(["daily", "weekly", "monthly"]).nullable().optional(),
    // 提醒开关与自定义提醒时刻（含逐个任务的小铃铛）。
    remind: z.boolean().nullable().optional(),
    reminderAt: z.array(reminderMoment).max(5).nullable().optional(),
    // 面板内联编辑：备注与手动排序序号；传 null 表示清空。
    note: z.string().max(2000).nullable().optional(),
    position: z.number().int().min(0).max(100_000).nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

/** createdAt 只用于服务端把同批任务分组，不暴露在 HTTP 契约里。 */
function wireTask(task: Task) {
  const { createdAt: _createdAt, ...rest } = task;
  return rest;
}

export function taskRouter(tasks: TaskStore, activity: ActivityLog = defaultActivity) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list().map(wireTask));
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供 1 至 200 个字符的任务标题。" });
    }
    const created = tasks.create(input.data.title);
    activity.record({ kind: "created", title: created.title });
    // 对外保持最小任务结构；createdAt 只用于服务端把同批任务分组。
    res.status(201).json(wireTask(created));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({
        error: "请提供有效的 title、done、subtasks、开始时间、优先级、标签、备注、排序或提醒字段。",
      });
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
    res.json(wireTask(updated));
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
    res.status(201).json(restored.map(wireTask));
  });

  return router;
}
