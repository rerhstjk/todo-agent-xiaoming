/**
 * 无密钥演示：直接调用规则引擎跑一遍 README 里的验收对话和几个扩展场景。
 * 使用临时清单文件，不会改动 data/tasks.json。
 *
 * 运行：npm run demo
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { createReply } from "./agent.ts";
import { execute } from "./commands.ts";
import { chatReply } from "./replies.ts";
import { createJsonTaskStore } from "./task-store.ts";

const directory = mkdtempSync(join(tmpdir(), "xiaoming-demo-"));
const store = createJsonTaskStore(join(directory, "tasks.json"));
const now = new Date();
const reply = createReply(store, { mode: "rules", clock: () => now });

const history: ChatMessage[] = [];

async function say(text: string): Promise<void> {
  history.push({ role: "user", content: text });
  const answer = await reply(history);
  history.push({ role: "assistant", content: answer });
  console.log(`你：${text}`);
  console.log(`小明：${answer.replaceAll("\n", "\n　　　")}\n`);
}

try {
  console.log("── README 验收对话 ──\n");
  await say("帮我记一下买牛奶");
  await say("再记一条取快递");
  await say("我有哪些任务？");
  await say("牛奶买好了");
  await say("取快递这条删掉吧");
  await say("再给我看看清单");

  console.log("── 扩展场景：日期、优先级、子任务 ──\n");
  await say("提醒我明天下午三点交报告");
  await say("把交报告设为高优先级");
  await say("给交报告加一个子任务：整理数据");
  await say("交报告的子任务整理数据完成了");
  await say("今天有哪些任务到期？");
  await say("这周还有什么要做的？");
  await say("明天有哪些任务？");

  console.log("── 最终清单（data 里实际保存的内容）──\n");
  console.log(chatReply(execute(store, { kind: "list", scope: "all" }, now), now));
  console.log(`\n清单文件：${join(directory, "tasks.json")}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
