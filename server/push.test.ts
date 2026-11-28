import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { generateVAPIDKeys } from "web-push";
import { createApp } from "./app.ts";
import {
  duePushReminders,
  PushScheduler,
  PushService,
  PushSubscriptionStore,
  type PushPayload,
} from "./push.ts";
import { createJsonTaskStore, type Task } from "./task-store.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xiaoming-push-"));
  dirs.push(dir);
  return dir;
}

const keys = generateVAPIDKeys();

function task(overrides: Partial<Task> & { id: string }): Task {
  return { title: "开会", done: false, ...overrides };
}

test("只推送当前窗口内的提醒，已完成或已推送的不重复推送", () => {
  const now = new Date(2026, 10, 28, 14, 30, 0);
  const soon = task({ id: "a", remind: true, startDate: "2026-11-28", startTime: "15:00" });
  const far = task({ id: "b", remind: true, startDate: "2026-11-28", startTime: "18:00" });
  const done = task({
    id: "c",
    remind: true,
    done: true,
    startDate: "2026-11-28",
    startTime: "15:00",
  });

  const due = duePushReminders([soon, far, done], now, () => false);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.task.id, "a");
  assert.equal(due[0]?.kind, "start");
  assert.match(due[0]?.key ?? "", /^a:start:/);

  assert.equal(duePushReminders([soon], now, () => true).length, 0);

  const late = new Date(2026, 10, 28, 15, 0, 0);
  assert.equal(duePushReminders([soon], late, () => false).length, 0);
});

test("推送失败会清理过期订阅", async () => {
  const store = new PushSubscriptionStore(join(tempDir(), "subs.json"));
  const sentPayloads: PushPayload[] = [];
  const service = new PushService({
    subscriptions: store,
    keys,
    sender: async (subscription, payload) => {
      if (subscription.endpoint.endsWith("/gone")) {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
      sentPayloads.push(payload);
    },
  });

  service.subscribe({ endpoint: "https://push.example/ok", keys: { p256dh: "p", auth: "a" } });
  service.subscribe({ endpoint: "https://push.example/gone", keys: { p256dh: "p", auth: "a" } });
  assert.equal(service.count(), 2);

  const result = await service.send({ title: "提醒", body: "开会", tag: "t" });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.equal(sentPayloads.length, 1);
  assert.equal(service.count(), 1);
});

test("调度器按照提醒时刻推送，并在重启后不重复", async () => {
  const dir = tempDir();
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  tasks.create({ title: "开会", remind: true, startDate: "2026-11-28", startTime: "15:00" });

  const payloads: PushPayload[] = [];
  const push = {
    count: () => 1,
    send: async (payload: PushPayload) => {
      payloads.push(payload);
      return { sent: 1, failed: 0 };
    },
  } as unknown as PushService;
  const now = () => new Date(2026, 10, 28, 14, 30, 0);
  const sentFile = join(dir, "push-sent.json");

  const scheduler = new PushScheduler({ tasks, push, sentFile, now, log: () => undefined });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(payloads.length, 1);
  assert.equal(await scheduler.tick(), 0);

  const restarted = new PushScheduler({ tasks, push, sentFile, now, log: () => undefined });
  assert.equal(await restarted.tick(), 0);
  assert.equal(payloads.length, 1);
});

test("推送订阅接口保存订阅并能发送测试通知", async () => {
  const dir = tempDir();
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  const sent: PushPayload[] = [];
  const push = new PushService({
    subscriptions: new PushSubscriptionStore(join(dir, "subs.json")),
    keys,
    sender: async (_subscription, payload) => {
      sent.push(payload);
    },
  });
  const app = createApp({ reply: async () => "好", tasks, push });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const config = await fetch(`${base}/api/push/config`).then((response) => response.json());
    assert.equal(config.publicKey, keys.publicKey);
    assert.equal(config.subscriptions, 0);

    const subscribed = await fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://push.example/1",
        keys: { p256dh: "p", auth: "a" },
      }),
    });
    assert.equal(subscribed.status, 201);

    const tested = await fetch(`${base}/api/push/test`, { method: "POST" });
    assert.equal(tested.status, 201);
    assert.deepEqual(await tested.json(), { sent: 1, failed: 0 });
    assert.equal(sent.length, 1);

    const unsubscribed = await fetch(`${base}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/1" }),
    });
    assert.deepEqual(await unsubscribed.json(), { ok: true, removed: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("没有推送订阅时改用本机系统通知兜底，且同一条提醒只发一次", async () => {
  const dir = tempDir();
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  tasks.create({ title: "开会", remind: true, startDate: "2026-11-28", startTime: "15:00" });

  const notes: { title: string; body: string }[] = [];
  const push = {
    count: () => 0,
    send: async () => ({ sent: 0, failed: 0 }),
  } as unknown as PushService;
  const now = () => new Date(2026, 10, 28, 14, 30, 0);
  const scheduler = new PushScheduler({
    tasks,
    push,
    sentFile: join(dir, "push-sent.json"),
    now,
    log: () => undefined,
    notify: async (notification) => {
      notes.push(notification);
      return true;
    },
  });

  assert.equal(await scheduler.tick(), 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0]?.body ?? "", /开会/);
  assert.equal(await scheduler.tick(), 0);
  assert.equal(notes.length, 1);
});

test("推送服务连不上时退回本机通知，推送成功时不重复发本机通知", async () => {
  const dir = tempDir();
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  const now = () => new Date(2026, 10, 28, 14, 30, 0);
  const notes: { title: string; body: string }[] = [];
  const notify = async (notification: { title: string; body: string }) => {
    notes.push(notification);
    return true;
  };

  tasks.create({ title: "开会", remind: true, startDate: "2026-11-28", startTime: "15:00" });
  const failing = {
    count: () => 1,
    send: async () => ({ sent: 0, failed: 1 }),
  } as unknown as PushService;
  await new PushScheduler({
    tasks,
    push: failing,
    sentFile: join(dir, "failing-sent.json"),
    now,
    log: () => undefined,
    notify,
  }).tick();
  assert.equal(notes.length, 1);

  notes.length = 0;
  tasks.create({ title: "评审", remind: true, startDate: "2026-11-28", startTime: "15:00" });
  const working = {
    count: () => 1,
    send: async () => ({ sent: 1, failed: 0 }),
  } as unknown as PushService;
  await new PushScheduler({
    tasks,
    push: working,
    sentFile: join(dir, "working-sent.json"),
    now,
    log: () => undefined,
    notify,
  }).tick();
  assert.equal(notes.length, 0);
});
