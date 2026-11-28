import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatMessage } from "../shared/chat.ts";
import { defaultActivity } from "./activity.ts";
import { answer, createReply, systemPrompt } from "./agent.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { toPublicTask } from "./task-view.ts";
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
  store.create({ title: "买牛奶", startDate: "2026-11-27", priority: "high" });

  const reopened = createJsonTaskStore(join(dir, "tasks.json"));
  const [task] = reopened.list();
  assert.equal(task?.title, "买牛奶");
  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.priority, "high");
});

test("创建任务时识别日期、时刻、优先级和工作量", async () => {
  const { store, send } = fixture();

  await send("提醒我明天下午三点交报告");
  const task = store.list()[0];
  assert.equal(task?.title, "交报告");
  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.startTime, "15:00");
  assert.equal(task?.dueDate, undefined);

  await send("记一下高优先级写周报，工作量小");
  const weekly = store.list().find((item) => item.title === "写周报");
  assert.equal(weekly?.priority, "high");
  assert.equal(weekly?.effort, 1);
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

test("修改开始日期与优先级", async () => {
  const { store, send } = fixture();

  await send("记一下交报告");
  await send("把交报告的开始日期改到后天");
  assert.equal(store.list()[0]?.startDate, "2026-11-28");

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
  assert.equal(task?.startDate, "2026-11-30");
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

test("一句话里的两件事会拆成两条任务，各自的日期都保留", async () => {
  const { store, send } = fixture();

  const reply = await send("提醒我明天开会，并在今天为明天的会议准备材料");

  assert.equal(store.list().length, 2);
  const meeting = store.list().find((task) => task.title === "开会");
  assert.equal(meeting?.startDate, "2026-11-27");
  const prepare = store.list().find((task) => task.title.includes("准备材料"));
  assert.equal(prepare?.startDate, "2026-11-26");
  assert.match(reply, /已记下 2 条任务/);
  assert.doesNotMatch(reply, /开会，并在今天/);
});

test("「子任务：…」会把后一件事挂到刚建的任务下", async () => {
  const { store, send } = fixture();

  const reply = await send("提醒我周五开会，子任务：准备材料");

  assert.equal(store.list().length, 1);
  const task = store.list()[0]!;
  assert.equal(task.title, "开会");
  assert.deepEqual(
    (task.subtasks ?? []).map((subtask) => subtask.title),
    ["准备材料"],
  );
  assert.match(reply, /并给「开会」加了子任务「准备材料」/);
});

test("清单回复会列出每个子任务的标题和完成状态", async () => {
  const { send } = fixture();

  await send("提醒我周五开会，子任务：准备材料");
  await send("记一下取快递");
  const listed = await send("我有哪些任务？");

  assert.match(listed, /○ 开会/);
  assert.match(listed, /○ 准备材料/);
});

test("没有连接词的分句不会误拆成两条任务", async () => {
  const { store, send } = fixture();

  await send("记一下周五开会，讨论预算");

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.title, "开会，讨论预算");
});

test("没点名是哪条任务时，子任务挂到上一条提到的任务下", async () => {
  const { store, send } = fixture();

  await send("提醒我周五开会，子任务：准备材料");
  const reply = await send("再增加一条子任务，购买咖啡");

  assert.match(reply, /已给「开会」添加子任务「购买咖啡」/);
  assert.equal(store.list().length, 1);
  assert.deepEqual(
    store.list()[0]?.subtasks?.map((subtask) => subtask.title),
    ["准备材料", "购买咖啡"],
  );
});

test("上下文不明确时不乱建任务，先追问加到哪条任务下", async () => {
  const { store, send } = fixture();

  const empty = await send("加个子任务：买咖啡");
  assert.match(empty, /要加到哪条任务下/);
  assert.equal(store.list().length, 0);

  await send("记一下开会");
  await send("记一下取快递");
  const ambiguous = await send("加个子任务：买咖啡");
  assert.match(ambiguous, /要加到哪条任务下/);
  assert.equal(store.list().length, 2);
});

test("能回答刚才在面板上做了什么", async () => {
  defaultActivity.clear();
  const { send } = fixture();
  defaultActivity.record({ kind: "deleted", title: "会议室预定" });
  defaultActivity.record({ kind: "completed", title: "买牛奶" });

  const reply = await send("刚才删了什么？");

  assert.match(reply, /删除了「会议室预定」/);
  assert.match(reply, /完成了「买牛奶」/);
  defaultActivity.clear();
});

test("「刚才在面板上做了什么」也能识别", async () => {
  defaultActivity.clear();
  const { send } = fixture();
  defaultActivity.record({ kind: "created", title: "写周报" });

  const reply = await send("刚才在面板上做了什么？");

  assert.match(reply, /新建了「写周报」/);
  defaultActivity.clear();
});

test("面板删掉的任务再被提起时，说明是面板删除而不是凭空消失", async () => {
  defaultActivity.clear();
  const { send } = fixture();
  defaultActivity.record({ kind: "deleted", title: "开会" });

  const reply = await send("把开会删掉");

  assert.match(reply, /刚刚已经从清单里删掉了/);
  defaultActivity.clear();
});

test("模型提示词里会带上最近的面板操作", () => {
  defaultActivity.clear();
  defaultActivity.record({ kind: "deleted", title: "开会" }, NOW.getTime() + 1000);

  assert.match(systemPrompt(NOW), /删除了「开会」/);
  defaultActivity.clear();
});

test("记具体时刻时会保存 HH:mm，并从标题里去掉", async () => {
  const { store, send } = fixture();

  const reply = await send("今晚5点去拿快递");
  const task = store.list()[0];

  assert.equal(task?.title, "去拿快递");
  assert.equal(task?.startDate, "2026-11-26");
  assert.equal(task?.startTime, "17:00");
  assert.match(reply, /17:00/);
});

test("可以记录开始时间，且不会混成截止时间", async () => {
  const { store, send } = fixture();

  const reply = await send("从明天下午三点开始写报告");
  const task = store.list()[0];

  assert.equal(task?.title, "写报告");
  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.startTime, "15:00");
  assert.equal(task?.dueDate, undefined);
  assert.match(reply, /开始 明天 15:00/);

  await send("从周一开始复习");
  const review = store.list().find((item) => item.title === "复习");
  assert.equal(review?.startDate, "2026-11-30");
});

test("旧的截止参数会落到开始时间上", async () => {
  const { store } = fixture();

  const created = runTool(
    store,
    "create_task",
    {
      title: "准备汇报",
      startDate: "2026-11-27",
      startTime: "09:00",
      dueDate: "2026-11-30",
    },
    NOW,
  );
  assert.equal(created.ok, true);
  const task = store.list()[0];
  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.startTime, "09:00");
  assert.equal(task?.dueDate, undefined);

  const updated = runTool(store, "update_task", { title: "准备汇报", startTime: "10:30" }, NOW);
  assert.equal(updated.ok, true);
  assert.equal(store.list()[0]?.startTime, "10:30");
});

test("中文时刻会换算成 24 小时制", async () => {
  const { store, send } = fixture();

  await send("明天上午10点半开会");
  await send("下午三点交报告");

  const [meeting, report] = store.list();
  assert.equal(meeting?.title, "开会");
  assert.equal(meeting?.startDate, "2026-11-27");
  assert.equal(meeting?.startTime, "10:30");
  assert.equal(report?.title, "交报告");
  assert.equal(report?.startDate, "2026-11-26");
  assert.equal(report?.startTime, "15:00");
});

test("只说时刻且今天已经过了时，顺延到明天", async () => {
  const { store, send } = fixture();

  await send("5点去拿快递");
  const task = store.list()[0];

  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.startTime, "05:00");
});

test("清单回复带开始时刻，且不再加感叹号标记", async () => {
  const { store, send } = fixture();

  await send("今晚5点拿快递");
  await send("记一下下周一复盘");

  const list = await send("看看我的待办");
  const lines = list.split("\n");
  const urgent = lines.find((line) => line.includes("拿快递"));
  const later = lines.find((line) => line.includes("复盘"));

  assert.match(urgent ?? "", /^○ 拿快递/);
  assert.match(later ?? "", /^○ 复盘/);
  assert.doesNotMatch(list, /!/);
  assert.equal(store.list().length, 2);
});

test("模型工具写具体时刻时落到开始时间", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xiaoming-tool-"));
  tempDirs.push(dir);
  const store = createJsonTaskStore(join(dir, "tasks.json"));

  const created = runTool(
    store,
    "create_task",
    {
      title: "拿快递",
      dueDate: "2026-11-26",
      dueTime: "17:00",
    },
    NOW,
  );
  assert.equal(created.ok, true);
  assert.equal(store.list()[0]?.startTime, "17:00");

  const updated = runTool(store, "update_task", { title: "拿快递", dueTime: "18:30" }, NOW);
  assert.equal(updated.ok, true);
  assert.equal(store.list()[0]?.startTime, "18:30");

  runTool(store, "update_task", { title: "拿快递", startDate: "" }, NOW);
  assert.equal(store.list()[0]?.startDate, undefined);
  assert.equal(store.list()[0]?.startTime, undefined);
});

test("没提预计用时时不再追问，只问提醒", async () => {
  const { store, send } = fixture();

  const created = await send("记一下明天写周报");
  assert.match(created, /要不要给「写周报」设个提醒/);
  assert.doesNotMatch(created, /大概要花多久/);
  assert.equal(store.list()[0]?.effort, undefined);

  const noReminder = await send("不用");
  assert.doesNotMatch(noReminder, /大概要花多久/);
  assert.equal(store.list()[0]?.effort, undefined);
});

test("创建时说的“预计半小时”记成 0.5 小时，且不留在标题里", async () => {
  const { store, send } = fixture();

  await send("晚上8点买牛奶，预计半小时");
  const task = store.list()[0];
  assert.equal(task?.title, "买牛奶");
  assert.equal(task?.effort, 0.5);
  assert.equal(task?.startTime, "20:00");
});

test("可以直接修改任务的工作量", async () => {
  const { store, send } = fixture();
  store.create({ title: "写周报", effort: 2 });

  const reply = await send("把写周报的工作量改成 3 小时");
  assert.match(reply, /3 小时/);
  assert.equal(store.list()[0]?.effort, 3);
});

test("工具支持按小时读写工作量", () => {
  const { store } = fixture();
  runTool(store, "create_task", { title: "整理资料", effort: 1.5 }, NOW);
  assert.equal(store.list()[0]?.effort, 1.5);

  const updated = runTool(store, "update_task", { title: "整理资料", effort: 0 }, NOW);
  assert.equal(updated.ok, true);
  assert.equal(store.list()[0]?.effort, undefined);
});

test("没有任务上下文时，回答小时数会先问是哪条任务", async () => {
  const { store, send } = fixture();
  store.create({ title: "写周报" });

  const reply = await send("大概 2 小时");
  assert.match(reply, /要给哪条任务记预计用时/);
  assert.equal(store.list()[0]?.effort, undefined);
});

test("标签会从标题里剥离，并出现在清单回复中", async () => {
  const { store, send } = fixture();
  const reply = await send("记一下买牛奶 #生活 #采购，预计半小时");
  assert.match(reply, /已记下「买牛奶」/);
  const task = store.list()[0];
  assert.equal(task?.title, "买牛奶");
  assert.deepEqual(task?.tags, ["生活", "采购"]);
  assert.equal(task?.effort, 0.5);

  const list = await send("我有哪些任务？");
  assert.match(list, /标签 生活、采购/);
});

test("每天重复的任务完成后会自动排好下一次", async () => {
  const { store, send } = fixture();
  const reply = await send("提醒我每天下午6点写日报");
  assert.match(reply, /已记下「写日报」/);
  const task = store.list()[0];
  assert.equal(task?.repeat, "daily");
  assert.equal(task?.startTime, "18:00");
  assert.equal(task?.startDate, "2026-11-26");

  const done = await send("写日报完成了");
  assert.match(done, /下一次/);
  const tasks = store.list();
  assert.equal(tasks.length, 2);
  const next = tasks.find((item) => !item.done);
  assert.equal(next?.title, "写日报");
  assert.equal(next?.startDate, "2026-11-27");
  assert.equal(next?.startTime, "18:00");
  assert.equal(next?.repeat, "daily");
});

test("每周一和每月 15 号都能解析成具体日期", async () => {
  const { store, send } = fixture();
  await send("提醒我每周一开会");
  const weekly = store.list().find((task) => task.title === "开会");
  assert.equal(weekly?.repeat, "weekly");
  assert.equal(weekly?.startDate, "2026-11-30");

  await send("提醒我每月15号交房租");
  const monthly = store.list().find((task) => task.title === "交房租");
  assert.equal(monthly?.repeat, "monthly");
  assert.equal(monthly?.startDate, "2026-12-15");
});

test("删除后可以用「撤销」恢复", async () => {
  const { store, send } = fixture();
  await send("提醒我明天开会");
  await send("开会删掉");
  assert.equal(store.list().length, 0);

  const reply = await send("撤销");
  assert.match(reply, /已恢复「开会」/);
  assert.equal(store.list().length, 1);
});

test("没有可撤销的删除时会明确说明", async () => {
  const { send } = fixture();
  const reply = await send("撤销");
  assert.match(reply, /没有可以撤销的删除/);
});

test("模型超时抛错时退回规则引擎", async () => {
  const { store } = fixture();
  const client = scriptedClient(() => {
    throw new Error("Request timed out");
  });
  const reply = await answer(
    [{ role: "user", content: "记一下买牛奶" }],
    store,
    NOW,
    "llm",
    client,
  );
  assert.match(reply, /已记下「买牛奶」/);
  assert.equal(store.list()[0]?.title, "买牛奶");
});

test("模型工具也能撤销最近一次删除", () => {
  const { store } = fixture();
  store.create({ title: "开会" });
  const removed = runTool(store, "delete_task", { title: "开会" }, NOW);
  assert.equal(removed.ok, true);

  const undone = runTool(store, "undo_delete", {}, NOW);
  assert.match(undone.message, /已恢复「开会」/);
  assert.equal(store.list().length, 1);
});

test("三分钟后、半小时后这类相对时间直接换算，不用反问用户", async () => {
  const { store, send } = fixture();

  await send("提醒我三分钟后开会，高优先级");
  const meeting = store.list()[0];
  assert.equal(meeting?.title, "开会");
  assert.equal(meeting?.startDate, "2026-11-26");
  assert.equal(meeting?.startTime, "09:03");
  assert.equal(meeting?.priority, "high");

  await send("半小时后提醒我喝水");
  assert.equal(store.list()[1]?.startTime, "09:30");

  await send("一个半小时后打电话");
  assert.equal(store.list()[2]?.startTime, "10:30");

  await send("两小时后睡觉");
  assert.equal(store.list()[3]?.startTime, "11:00");

  await send("三天后交报告");
  assert.equal(store.list()[4]?.startDate, "2026-11-29");
  assert.equal(store.list()[4]?.startTime, undefined);
});

test("创建带时间的任务时会问要不要提醒，回「要」后打开", async () => {
  const { store, send } = fixture();

  const reply = await send("记一下明天上午10点开会");
  assert.match(reply, /要不要给「开会」设个提醒/);
  assert.equal(store.list()[0]?.remind, undefined);

  const yes = await send("要");
  assert.match(yes, /打开提醒/);
  assert.equal(store.list()[0]?.remind, true);

  const list = await send("我有哪些任务？");
  assert.match(list, /开会/);
});

test("回「不用」时不设提醒", async () => {
  const { store, send } = fixture();

  await send("记一下明天上午10点开会");
  const no = await send("不用");
  assert.match(no, /不设提醒/);
  assert.equal(store.list()[0]?.remind, undefined);
});

test("「提前 10 分钟提醒」按用户指定的时刻提醒", async () => {
  const { store, send } = fixture();

  const reply = await send("提醒我明天下午3点开会，提前10分钟提醒我");
  assert.doesNotMatch(reply, /要不要给/);
  const task = store.list()[0];
  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.startTime, "15:00");
  assert.equal(task?.remind, true);
  assert.deepEqual(task?.reminderAt, ["2026-11-27T14:50"]);
});

test("也可以直接说「给开会设提醒」", async () => {
  const { store, send } = fixture();

  await send("记一下明天上午10点开会");
  const reply = await send("给开会设提醒");
  assert.match(reply, /打开提醒/);
  assert.equal(store.list()[0]?.remind, true);
});

test("历史消息带发送时刻，模型不会用当前时间重算相对时间", async () => {
  const { store } = fixture();
  let seen: ChatCompletionMessageParam[] = [];
  const client = {
    chat: {
      completions: {
        async create(args: { messages: ChatCompletionMessageParam[] }) {
          seen = args.messages;
          return { choices: [{ message: { content: "好" } }] };
        },
      },
    },
  } as unknown as InjectedClient;

  await answer(
    [
      {
        role: "user",
        content: "提醒我两分钟后喝水",
        at: new Date(2026, 10, 26, 9, 14).toISOString(),
      },
    ],
    store,
    new Date(2026, 10, 26, 9, 26),
    "llm",
    client,
  );

  const system = seen.find((message) => message.role === "system");
  assert.ok(system && typeof system.content === "string");
  assert.match(system.content, /发送时刻/);
  assert.match(system.content, /不要主动提议修改/);

  const user = seen.find((message) => message.role === "user");
  assert.ok(user && typeof user.content === "string");
  assert.match(user.content, /^\[发送于 09:14\] 提醒我两分钟后喝水$/);
});

test("预设的「记一件事」句子能一次解析开始时间、会前提醒和预计用时", async () => {
  const { store, send } = fixture();

  const reply = await send("记一下我明天下午三点开会，会前20分钟提醒我，预计开2个小时");

  assert.match(reply, /已记下「开会」/);
  assert.match(reply, /提醒已经设好：11月27日 14:40/);
  assert.match(reply, /预计 2 小时/);

  const [task] = store.list();
  assert.ok(task);
  assert.equal(task.title, "开会");
  assert.equal(task.startDate, "2026-11-27");
  assert.equal(task.startTime, "15:00");
  assert.equal(task.dueDate, undefined);
  assert.equal(task.remind, true);
  assert.deepEqual(task.reminderAt, ["2026-11-27T14:40"]);
  assert.equal(task.effort, 2);
});

test("过了开始时刻的任务会归入逾期，不用等到第二天", async () => {
  const { store, send } = fixture();

  await send("今天早上8点开会");
  const task = store.list()[0];
  assert.equal(task?.startDate, "2026-11-26");
  assert.equal(task?.startTime, "08:00");

  const reply = await send("哪些任务逾期了？");
  assert.match(reply, /开会/);
});

test("工具只传 reminderAt 时也会打开提醒，并出现在任务数据里", () => {
  const { store } = fixture();

  const outcome = runTool(
    store,
    "create_task",
    {
      title: "开会",
      startDate: "2026-11-28",
      startTime: "15:30",
      reminderAt: ["2026-11-28T15:21"],
    },
    NOW,
  );

  assert.equal(outcome.ok, true);
  const task = store.list()[0];
  assert.equal(task?.remind, true);
  assert.deepEqual(task?.reminderAt, ["2026-11-28T15:21"]);

  const publicTask = toPublicTask(task!);
  assert.equal(publicTask.remind, true);
  assert.deepEqual(publicTask.reminderAt, ["2026-11-28T15:21"]);
});

test("新建任务没时间时先问什么时候做，并把简短回答补成开始时间", async () => {
  const { store, send } = fixture();

  const created = await send("记一下拿快递");
  assert.match(created, /什么时候要做/);
  assert.match(created, /暂不设置/);
  assert.doesNotMatch(created, /大概要花多久/);

  const scheduled = await send("明天下午三点");
  assert.match(scheduled, /安排在明天 15:00/);
  const task = store.list()[0];
  assert.equal(task?.startDate, "2026-11-27");
  assert.equal(task?.startTime, "15:00");
});

test("一句话列了多件事时会拆成多条任务，并逐条问时间", async () => {
  const { store, send } = fixture();

  const created = await send("提醒我买牛奶，拿快递");
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶", "拿快递"],
  );
  assert.match(created, /已记下 2 条任务/);
  assert.match(created, /「买牛奶」还没有安排时间/);
  assert.match(created, /还有 1 条任务/);

  const first = await send("今天");
  assert.match(first, /买牛奶/);
  assert.match(first, /「拿快递」还没有安排时间/);

  const second = await send("明天下午三点");
  assert.match(second, /安排在明天 15:00/);
  const [milk, pickup] = store.list();
  assert.equal(milk?.startDate, "2026-11-26");
  assert.equal(pickup?.startDate, "2026-11-27");
  assert.equal(pickup?.startTime, "15:00");
});

test("快捷回复里选具体日期和时刻也能解析", async () => {
  const { store, send } = fixture();

  await send("记一下拿快递");
  const scheduled = await send("2026-11-28 15:00");
  assert.match(scheduled, /15:00/);
  const task = store.list()[0];
  assert.equal(task?.startDate, "2026-11-28");
  assert.equal(task?.startTime, "15:00");
});

test("回答暂不设置时保留无时间任务，提问也不会被误当成时间", async () => {
  const { store, send } = fixture();

  await send("记一下拿快递");
  const skipped = await send("暂不设置");
  assert.match(skipped, /先不安排时间/);
  assert.equal(store.list()[0]?.startDate, undefined);

  await send("记一下买牛奶");
  const listed = await send("今天有哪些任务到期？");
  assert.match(listed, /今天/);
  assert.equal(store.list().find((task) => task.title === "买牛奶")?.startDate, undefined);
});
