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
  const app = createApp({
    tasks: createJsonTaskStore(filename),
    async reply(messages) {
      conversations.push(messages);
      return "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
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
