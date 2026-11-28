import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { defaultActivity } from "./activity.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const store = createJsonTaskStore(filename);
  const app = createApp({
    tasks: store,
    async reply(messages) {
      conversations.push(messages);
      return "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function raw(method: string, path: string, body?: unknown) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function request(method: string, path: string, body?: unknown) {
    const response = await raw(method, path, body);
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, raw, conversations, filename, store };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("清单面板可以整组回写子任务的完成状态", async (t) => {
  const { request, filename } = await startTestApp(t);
  const task = {
    id: "a",
    title: "开会",
    done: false,
    subtasks: [
      { id: "s1", title: "准备材料", done: false },
      { id: "s2", title: "打印资料", done: true },
    ],
  };
  await writeFile(filename, JSON.stringify([task]));

  const patched = await request("PATCH", "/api/tasks/a", {
    subtasks: [
      { id: "s1", title: "准备材料", done: true },
      { id: "s2", title: "打印资料", done: true },
    ],
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [
    {
      ...task,
      subtasks: [
        { id: "s1", title: "准备材料", done: true },
        { id: "s2", title: "打印资料", done: true },
      ],
    },
  ]);

  const invalid = await request("PATCH", "/api/tasks/a", { subtasks: [{ id: "x" }] });
  assert.equal(invalid.status, 400);
});

test("清单面板的增删改会记录成面板操作，供智能体读取", async (t) => {
  defaultActivity.clear();
  t.after(() => defaultActivity.clear());
  const { request } = await startTestApp(t);

  const created = await request("POST", "/api/tasks", { title: "开会" });
  const id = created.body.id;
  await request("PATCH", `/api/tasks/${id}`, { done: true });
  await request("PATCH", `/api/tasks/${id}`, { done: false });
  await request("DELETE", `/api/tasks/${id}`);

  assert.deepEqual(
    defaultActivity.list().map((entry) => [entry.kind, entry.title]),
    [
      ["created", "开会"],
      ["completed", "开会"],
      ["reopened", "开会"],
      ["deleted", "开会"],
    ],
  );
});

test("删除或修改不存在的任务时不会记成面板操作", async (t) => {
  defaultActivity.clear();
  t.after(() => defaultActivity.clear());
  const { request } = await startTestApp(t);

  await request("DELETE", "/api/tasks/missing");
  await request("PATCH", "/api/tasks/missing", { done: true });

  assert.deepEqual(defaultActivity.list(), []);
});

test("删除后可以从撤销接口恢复完整任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";

  const created = await request("POST", collection, { title: "开会" });
  const task = created.body as { id: string };
  await request("PATCH", collection + "/" + task.id, {
    subtasks: [{ id: "s1", title: "准备材料", done: true }],
  });
  assert.equal((await request("DELETE", collection + "/" + task.id)).status, 204);
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const undone = await request("POST", collection + "/undo", { count: 1 });
  assert.equal(undone.status, 201);
  const [restored] = undone.body as {
    id: string;
    title: string;
    done: boolean;
    subtasks: { id: string; title: string; done: boolean }[];
  }[];
  assert.equal(restored?.id, task.id);
  assert.equal(restored?.title, "开会");
  assert.deepEqual(restored?.subtasks, [{ id: "s1", title: "准备材料", done: true }]);

  // 再撤销一次已经没有记录了。
  assert.deepEqual(await request("POST", collection + "/undo", {}), {
    status: 404,
    body: { error: "没有可以撤销的删除。" },
  });
});

test("在面板上标记完成重复任务时，也会自动生成下一次", async (t) => {
  const { request, store } = await startTestApp(t);
  const task = await store.create({
    title: "写日报",
    dueDate: "2026-11-28",
    dueTime: "18:00",
    repeat: "daily",
    tags: ["工作"],
    effort: 0.5,
  });

  assert.equal((await request("PATCH", `/api/tasks/${task.id}`, { done: true })).status, 200);

  const list = await store.list();
  assert.equal(list.length, 2);
  const completed = list.find((item) => item.id === task.id);
  const next = list.find((item) => item.id !== task.id);
  assert.equal(completed?.done, true);
  assert.equal(next?.done, false);
  assert.equal(next?.dueDate, "2026-11-29");
  assert.equal(next?.dueTime, "18:00");
  assert.equal(next?.repeat, "daily");
  assert.deepEqual(next?.tags, ["工作"]);
  assert.equal(next?.effort, 0.5);

  // 重复点完成不会无限生成。
  await request("PATCH", `/api/tasks/${task.id}`, { done: true });
  assert.equal((await store.list()).length, 2);
});

test("编辑对话时可以回滚到那一轮对话之前的清单", async (t) => {
  const { request, raw } = await startTestApp(t);

  // 聊天接口在开始处理之前拍下快照，并通过响应头告诉前端。
  const chat = await raw("POST", "/api/chat", {
    messages: [{ role: "user", content: "帮我记一下买牛奶" }],
  });
  const snapshotId = chat.headers.get("x-task-snapshot");
  assert.ok(snapshotId);

  // 这一轮后续又改了清单，编辑历史消息时应该整体回滚。
  await request("POST", "/api/tasks", { title: "买牛奶" });
  await request("POST", "/api/tasks", { title: "取快递" });
  assert.equal((await request("GET", "/api/tasks")).body.length, 2);

  assert.deepEqual(await request("POST", `/api/snapshots/${snapshotId}/restore`), {
    status: 200,
    body: { restored: true, count: 0 },
  });
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);

  assert.deepEqual(await request("POST", "/api/snapshots/missing/restore"), {
    status: 404,
    body: { error: "找不到这个对话快照，可能已经过期。" },
  });
});

test("清单面板可以设置开始时间和提醒", async (t) => {
  const { request, filename } = await startTestApp(t);
  const store = createJsonTaskStore(filename);
  const task = store.create({ title: "开会" });

  const patched = await request("PATCH", `/api/tasks/${task.id}`, {
    startDate: "2026-11-28",
    startTime: "15:30",
    remind: true,
    reminderAt: ["2026-11-28T15:21"],
  });

  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body, {
    ...task,
    startDate: "2026-11-28",
    startTime: "15:30",
    remind: true,
    reminderAt: ["2026-11-28T15:21"],
  });

  const invalid = await request("PATCH", `/api/tasks/${task.id}`, { startDate: "11-28" });
  assert.equal(invalid.status, 400);
});

test("清单面板可以保存备注与手动排序序号", async (t) => {
  const { request } = await startTestApp(t);
  const first = await request("POST", "/api/tasks", { title: "第一项" });
  const second = await request("POST", "/api/tasks", { title: "第二项" });

  const patched = await request("PATCH", `/api/tasks/${first.body.id}`, {
    note: "先做这个",
    position: 2,
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.note, "先做这个");
  assert.equal(patched.body.position, 2);

  const moved = await request("PATCH", `/api/tasks/${second.body.id}`, { position: 1 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.position, 1);
});

test("没有开始时间和工作量的任务也能保存备注，空字段可以用 null 清空", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", { title: "买牛奶" });

  // 面板内联编辑会把这些空字段一起发过来；服务端必须接受 null，否则整次保存都会 400。
  const noted = await request("PATCH", `/api/tasks/${created.body.id}`, {
    title: "买牛奶",
    startDate: null,
    startTime: null,
    priority: "normal",
    effort: null,
    note: "顺手买鸡蛋",
  });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.note, "顺手买鸡蛋");

  const cleared = await request("PATCH", `/api/tasks/${created.body.id}`, {
    note: null,
    startDate: null,
    startTime: null,
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.note, undefined);
  assert.equal(cleared.body.startDate, undefined);
});
