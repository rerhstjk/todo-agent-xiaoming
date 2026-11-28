import { randomUUID } from "node:crypto";
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

const importTaskSchema = z.looseObject({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  done: z.boolean().optional(),
});
const importSchema = z.object({
  tasks: z.array(importTaskSchema).min(1).max(1000),
  mode: z.enum(["merge", "replace"]).optional(),
});

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore, activity: ActivityLog = defaultActivity) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  // 导出整份清单（含扩展字段），方便备份或迁移。
  router.get("/export", (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="xiaoming-tasks.json"');
    res.json({ version: 1, exportedAt: new Date().toISOString(), tasks: tasks.list() });
  });

  // 导入清单：默认合并，同 id 冲突时换新 id；mode=replace 会用文件覆盖整份清单。
  router.post("/import", (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "导入格式不正确：需要 { tasks: [...] }，每条任务至少有标题。" });
    }
    if (!tasks.restoreAll) {
      return res.status(501).json({ error: "当前存储不支持导入。" });
    }

    const existing = tasks.list();
    const used = new Set(existing.map((task) => task.id));
    const incoming = parsed.data.tasks.map((item) => {
      const { id, title, done, ...rest } = item;
      const key = typeof id === "string" && id.length > 0 && !used.has(id) ? id : randomUUID();
      used.add(key);
      return { ...rest, id: key, title, done: done === true } as Task;
    });
    const mode = parsed.data.mode ?? "merge";
    tasks.restoreAll(mode === "replace" ? incoming : [...existing, ...incoming]);
    res.status(201).json({ imported: incoming.length, total: tasks.list().length, mode });
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
