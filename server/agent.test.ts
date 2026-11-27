import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { answer, createReply } from "./agent.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { runTool } from "./tools.ts";

// 2026-11-26 是周四，固定时间让日期相关的断言稳定。
const NOW = new Date(2026, 10, 26, 9, 0, 0);
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xiaoming-test-"));
  tempDirs.push(dir);
  const store = createJsonTaskStore(join(dir, "tasks.json"));
  const reply = createReply(store, { mode: "rules", clock: () => NOW });
  const history: ChatMessage[] = [];
  const send = async (text: string): Promise<string> => {
    history.push({ role: "user", content: text });
    const response = await reply(history);
    history.push({ role: "assistant", content: response });
    return response;
  };
  return { dir, store, reply, history, send };
}

test("按 README 的验收对话完整走一遍", async () => {
  const { store, send } = fixture();

  await send("帮我记一下买牛奶");
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶"],
  );

  await send("再记一条取快递");
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶", "取快递"],
  );

  const listed = await send("我有哪些任务？");
  assert.match(listed, /买牛奶/);
  assert.match(listed, /取快递/);
  assert.match(listed, /○/);

  await send("牛奶买好了");
  assert.equal(store.list().find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(store.list().find((task) => task.title === "取快递")?.done, false);

  await send("取快递这条删掉吧");
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶"],
  );

  const remaining = await send("再给我看看清单");
  assert.match(remaining, /✓ 买牛奶/);
  assert.doesNotMatch(remaining, /取快递/);
});

test("任务写入 data/tasks.json，重新创建 store 后仍可查询", async () => {
  const { dir, store } = fixture();
  store.create({ title: "买牛奶", dueDate: "2026-11-27", priority: "high" });

  const reopened = createJsonTaskStore(join(dir, "tasks.json"));
  const [task] = reopened.list();
  assert.equal(task?.title, "买牛奶");
  assert.equal(task?.dueDate, "2026-11-27");
  assert.equal(task?.priority, "high");
});

test("创建任务时识别日期、时刻、优先级和工作量", async () => {
  const { store, send } = fixture();

  await send("提醒我明天下午三点交报告");
  const task = store.list()[0];
  assert.equal(task?.title, "交报告");
  assert.equal(task?.dueDate, "2026-11-27");

  await send("记一下高优先级写周报，工作量小");
  const weekly = store.list().find((item) => item.title === "写周报");
  assert.equal(weekly?.priority, "high");
  assert.equal(weekly?.effort, "small");
});

test("支持子任务：添加、完成，并在清单里显示进度", async () => {
  const { store, send } = fixture();

  await send("记一下交报告");
  await send("给交报告加一个子任务：整理数据");
  await send("给交报告加一个子任务：画图");

  const task = store.list()[0];
  assert.deepEqual(
    task?.subtasks?.map((item) => item.title),
    ["整理数据", "画图"],
  );

  await send("交报告的子任务整理数据完成了");
  assert.equal(store.list()[0]?.subtasks?.[0]?.done, true);

  const listed = await send("我有哪些任务");
  assert.match(listed, /子任务 1\/2/);
});

test("删除子任务只删子任务，不会误删父任务", async () => {
  const { store, send } = fixture();

  await send("记一下写方案");
  await send("给写方案加一个子任务：收集数据");
  await send("给写方案加一个子任务：写初稿");

  const removed = await send("把写方案的子任务写初稿删掉");
  assert.match(removed, /已删除子任务「写初稿」/);
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["写方案"],
  );
  assert.deepEqual(
    store.list()[0]?.subtasks?.map((item) => item.title),
    ["收集数据"],
  );

  const listed = await send("我有哪些任务");
  assert.match(listed, /子任务 0\/1/);

  const missing = await send("把写方案的子任务画图删掉");
  assert.match(missing, /没有找到子任务「画图」/);
  assert.match(missing, /现有的子任务：收集数据/);

  const unclear = await send("把子任务删掉");
  assert.match(unclear, /先不动清单/);
  assert.equal(store.list().length, 1);
});

test("有歧义时先追问，回复序号后继续完成", async () => {
  const { store, send } = fixture();

  await send("记一下买牛奶");
  await send("记一下回家买牛奶");

  const question = await send("牛奶好了");
  assert.match(question, /要完成哪一条/);
  assert.match(question, /1\. ○ 买牛奶/);
  assert.match(question, /2\. ○ 回家买牛奶/);

  await send("2");
  assert.equal(store.list().find((task) => task.title === "回家买牛奶")?.done, true);
  assert.equal(store.list().find((task) => task.title === "买牛奶")?.done, false);
});

test("修改截止日期与优先级", async () => {
  const { store, send } = fixture();

  await send("记一下交报告");
  await send("把交报告的截止日期改到后天");
  assert.equal(store.list()[0]?.dueDate, "2026-11-28");

  await send("把交报告设为高优先级");
  assert.equal(store.list()[0]?.priority, "high");
});

test("已完成的任务不会因为再次完成而重复处理", async () => {
  const { store, send } = fixture();

  await send("记一下买牛奶");
  await send("买牛奶买好了");
  const second = await send("买牛奶完成了");

  assert.match(second, /之前就已经完成了/);
  assert.equal(store.list()[0]?.done, true);
  assert.equal(store.list().length, 1);
});

test("删除不存在的任务时给出当前待办，不修改任何数据", async () => {
  const { store, send } = fixture();

  await send("记一下买牛奶");
  const reply = await send("删掉取快递");

  assert.match(reply, /没找到/);
  assert.equal(store.list().length, 1);
});

test("模型工具可以直接操作同一个 TaskStore", () => {
  const { store } = fixture();

  const created = runTool(store, "create_task", { title: "买牛奶", dueDate: "2026-11-27" }, NOW);
  assert.equal(created.ok, true);
  const id = store.list()[0]?.id;
  assert.ok(id);

  const done = runTool(store, "update_task", { title: "牛奶", done: true }, NOW);
  assert.equal(done.ok, true);
  assert.equal(store.list()[0]?.done, true);

  const listed = runTool(store, "list_tasks", { scope: "done" }, NOW);
  assert.equal(listed.ok, true);
  assert.match(listed.message, /✓ 买牛奶/);

  const removed = runTool(store, "delete_task", { title: "牛奶" }, NOW);
  assert.equal(removed.ok, true);
  assert.equal(store.list().length, 0);
});

test("工具管理子任务支持添加、完成、删除", () => {
  const { store } = fixture();
  runTool(store, "create_task", { title: "写方案" }, NOW);

  const added = runTool(
    store,
    "manage_subtasks",
    { title: "写方案", action: "add", subtask: "收集数据" },
    NOW,
  );
  assert.equal(added.ok, true);
  assert.equal(store.list()[0]?.subtasks?.length, 1);

  const completed = runTool(
    store,
    "manage_subtasks",
    { title: "写方案", action: "complete", subtask: "收集数据" },
    NOW,
  );
  assert.equal(completed.ok, true);
  assert.equal(store.list()[0]?.subtasks?.[0]?.done, true);

  const removed = runTool(
    store,
    "manage_subtasks",
    { title: "写方案", action: "remove", subtask: "收集数据" },
    NOW,
  );
  assert.equal(removed.ok, true);
  assert.deepEqual(store.list()[0]?.subtasks, []);
  assert.equal(store.list().length, 1);
});

test("工具遇到多条相似任务时返回候选而不是随便改", () => {
  const { store } = fixture();
  runTool(store, "create_task", { title: "买牛奶" }, NOW);
  runTool(store, "create_task", { title: "回家买牛奶" }, NOW);

  const outcome = runTool(store, "update_task", { title: "牛奶", done: true }, NOW);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /确认/);
  assert.deepEqual(
    (outcome.data as { candidates: { title: string }[] }).candidates.map((task) => task.title),
    ["买牛奶", "回家买牛奶"],
  );
  assert.equal(store.list().filter((task) => task.done).length, 0);
});

test("没有 API key 时 auto 模式自动使用规则引擎", async () => {
  const { store } = fixture();
  const original = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const text = await answer([{ role: "user", content: "记一下买牛奶" }], store, NOW, "auto");
    assert.match(text, /已记下「买牛奶」/);
    assert.equal(store.list().length, 1);
  } finally {
    if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
  }
});

type InjectedClient = NonNullable<Parameters<typeof answer>[4]>;

/** 一个按剧本返回的假模型，用来验证工具调用循环本身。 */
function scriptedClient(script: (round: number) => unknown): InjectedClient {
  let round = 0;
  return {
    chat: {
      completions: {
        async create() {
          round += 1;
          return script(round);
        },
      },
    },
  } as unknown as InjectedClient;
}

test("回答今天、明天和本周的任务", async () => {
  const { store, send } = fixture();

  await send("记一下今天下午三点交周报");
  await send("记一下明天上午开会");
  await send("记一下下周一复盘");
  await send("记一下昨天交房租");

  const today = await send("今天有哪些任务到期？");
  assert.match(today, /今天（11月26日 周四）/);
  assert.match(today, /交周报/);
  assert.match(today, /另有 1 项已经逾期/);

  const tomorrow = await send("明天有哪些任务？");
  assert.match(tomorrow, /明天（11月27日 周五）/);
  assert.match(tomorrow, /开会/);
  assert.doesNotMatch(tomorrow, /交周报/);

  const week = await send("这周还有什么要做的？");
  assert.match(week, /本周还有 2 项任务要处理/);
  assert.match(week, /交周报/);
  assert.match(week, /开会/);
  assert.doesNotMatch(week, /复盘/);

  const overdue = await send("哪些任务逾期了？");
  assert.match(overdue, /交房租/);
  assert.doesNotMatch(overdue, /交周报/);

  assert.equal(store.list().length, 4);
});

test("模型模式：执行工具调用，再转述工具返回的结果", async () => {
  const { store } = fixture();
  const client = scriptedClient((round) =>
    round === 1
      ? {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "create_task", arguments: '{"title":"买牛奶"}' },
                  },
                ],
              },
            },
          ],
        }
      : { choices: [{ message: { content: "已记下「买牛奶」，今天记得买。" } }] },
  );

  const text = await answer(
    [{ role: "user", content: "帮我记一下买牛奶" }],
    store,
    NOW,
    "llm",
    client,
  );

  assert.match(text, /已记下/);
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶"],
  );
});

test("模型中途报错时，已经执行的操作不会被规则引擎重复执行", async () => {
  const { store } = fixture();
  const client = scriptedClient((round) => {
    if (round === 1) {
      return {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "create_task", arguments: '{"title":"买牛奶"}' },
                },
              ],
            },
          },
        ],
      };
    }
    throw new Error("network down");
  });

  const text = await answer(
    [{ role: "user", content: "帮我记一下买牛奶" }],
    store,
    NOW,
    "llm",
    client,
  );

  assert.match(text, /已记下「买牛奶」/);
  assert.equal(store.list().length, 1);
});

test("「记一下」和下周一连在一起时，不会误判成下下周", async () => {
  const { store, send } = fixture();

  const reply = await send("帮我记一下下周一开周会");
  const task = store.list()[0];

  assert.equal(task?.title, "开周会");
  assert.equal(task?.dueDate, "2026-11-30");
  assert.match(reply, /下周一/);
});

test("「删掉所有已完成的任务」清理的是已完成，不会当成删除任务名", async () => {
  const { store, send } = fixture();

  await send("记一下买牛奶");
  await send("记一下取快递");
  await send("买牛奶完成了");
  const reply = await send("删掉所有已完成的任务");

  assert.match(reply, /已清理 1 项/);
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["取快递"],
  );
});
