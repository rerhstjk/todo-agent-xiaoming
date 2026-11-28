import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import type { PushService } from "./push.ts";
import { defaultSnapshots, type TaskSnapshots } from "./snapshots.ts";
import type { TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";

interface AppDependencies {
  reply(messages: ChatMessage[]): Promise<string>;
  tasks: TaskStore;
  snapshots?: TaskSnapshots;
  push?: PushService;
}

const pushSubscribeSchema = z.object({
  endpoint: z.string().trim().min(1).max(2000),
  keys: z.object({
    p256dh: z.string().trim().min(1).max(400),
    auth: z.string().trim().min(1).max(400),
  }),
});

const pushUnsubscribeSchema = z.object({ endpoint: z.string().trim().min(1).max(2000) });

export function createApp({
  reply,
  tasks,
  snapshots = defaultSnapshots,
  push,
}: AppDependencies) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }
    // 记下这轮对话开始前的清单，供「编辑历史消息」回滚。
    const snapshotId = snapshots.capture(tasks);
    if (snapshotId) res.setHeader("X-Task-Snapshot", snapshotId);

    const answer = await reply(input.data.messages);
    res.json({ reply: answer });
  });

  app.post("/api/snapshots/:id/restore", (req, res) => {
    if (!snapshots.restore(tasks, req.params.id)) {
      return res.status(404).json({ error: "找不到这个对话快照，可能已经过期。" });
    }
    res.json({ restored: true, count: tasks.list().length });
  });

  app.get("/api/push/config", (_req, res) => {
    if (!push) return res.status(503).json({ error: "后台提醒没有启用。" });
    res.json({ publicKey: push.publicKey, subscriptions: push.count() });
  });

  app.post("/api/push/subscribe", (req, res) => {
    if (!push) return res.status(503).json({ error: "后台提醒没有启用。" });
    const input = pushSubscribeSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的浏览器推送订阅。" });
    }
    push.subscribe(input.data);
    res.status(201).json({ ok: true, subscriptions: push.count() });
  });

  app.post("/api/push/unsubscribe", (req, res) => {
    if (!push) return res.status(503).json({ error: "后台提醒没有启用。" });
    const input = pushUnsubscribeSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供要取消的订阅地址。" });
    }
    res.json({ ok: true, removed: push.unsubscribe(input.data.endpoint) });
  });

  app.post("/api/push/test", async (_req, res) => {
    if (!push) return res.status(503).json({ error: "后台提醒没有启用。" });
    if (push.count() === 0) {
      return res.status(404).json({ error: "还没有浏览器订阅后台提醒。" });
    }
    const result = await push.send({
      title: "后台提醒已连通",
      body: "关掉页面后，到点也会收到这条系统通知。",
      tag: "xiaoming-test",
    });
    res.status(201).json(result);
  });

  app.use("/api/tasks", taskRouter(tasks));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
  app.use(handleApiError);

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
