import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ChatMessage } from "../shared/chat.ts";
import {
  defaultActivity,
  describeActivity,
  formatActivityTime,
  ACTIVITY_WINDOW_MS,
} from "./activity.ts";
import { formatChineseDate, toClockString } from "./dates.ts";
import { pendingSummary } from "./format.ts";
import { getModelClient, model } from "./model.ts";
import { ruleReply } from "./rules.ts";
import { defaultTaskStore, type TaskStore } from "./task-store.ts";
import { runTool, toolSchemas } from "./tools.ts";

export type { ChatMessage } from "../shared/chat.ts";

/**
 * 「小明」的实现分两层：
 * 1. 配了 DEEPSEEK_API_KEY 时，用 DeepSeek 的 tool calling 理解自然语言；
 * 2. 没配密钥、或模型调用失败时，退回 rules.ts 里的确定性规则引擎。
 * 两层共用同一个 TaskStore，因此任务始终保存在 data/tasks.json 里。
 */

export type AgentMode = "auto" | "rules" | "llm";

const MAX_TOOL_ROUNDS = 6;

const MODEL_TOOLS: ChatCompletionTool[] = toolSchemas;

function resolveMode(): AgentMode {
  const raw = (process.env.XIAOMING_MODE ?? "auto").toLowerCase();
  if (raw === "rules" || raw === "llm") return raw;
  return "auto";
}

/**
 * 生成一轮回复。前端每次会把完整对话历史发过来，这里只取最近 20 条，
 * 避免上下文无限增长。
 */
type ModelClient = ReturnType<typeof getModelClient>;

export async function answer(
  messages: ChatMessage[],
  store: TaskStore,
  now = new Date(),
  mode: AgentMode = resolveMode(),
  client?: ModelClient,
): Promise<string> {
  if (mode === "rules" || (mode === "auto" && !process.env.DEEPSEEK_API_KEY)) {
    return ruleReply(store, messages, now);
  }

  try {
    return await askModel(messages, store, now, client);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[xiaoming] 模型调用失败，改用规则引擎兜底：${reason}`);
    return ruleReply(store, messages, now);
  }
}

async function askModel(
  messages: ChatMessage[],
  store: TaskStore,
  now: Date,
  injected?: ModelClient,
): Promise<string> {
  const client = injected ?? getModelClient();
  const applied: string[] = [];

  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(now) },
    ...messages.slice(-20).map((message): ChatCompletionMessageParam => ({
      role: message.role,
      content: withSendTime(message),
    })),
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const completion = await client.chat.completions.create({
        model,
        messages: conversation,
        tools: MODEL_TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 800,
      });

      const message = completion.choices[0]?.message;
      if (!message) throw new Error("模型没有返回内容");

      conversation.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.tool_calls,
      });

      if (!message.tool_calls || message.tool_calls.length === 0) {
        const content = (message.content ?? "").trim();
        if (content) return content;
        if (applied.length > 0) return summarizeApplied(applied, store);
        throw new Error("模型返回了空内容");
      }

      for (const call of message.tool_calls) {
        if (call.type !== "function") continue;
        const args = parseArguments(call.function.arguments);
        const outcome = runTool(store, call.function.name, args, now);
        if (outcome.changed) applied.push(outcome.message);
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(outcome),
        });
      }
    }

    // 轮次用尽时，已经执行的操作要如实汇报，不能假装没发生。
    if (applied.length > 0) return summarizeApplied(applied, store);
    throw new Error("工具调用轮次用尽");
  } catch (error) {
    if (applied.length > 0) return summarizeApplied(applied, store);
    throw error;
  }
}

/**
 * 在用户消息前标上发送时刻。模型看到「两分钟后」时，必须相对这条消息的时间换算，
 * 而不是相对「现在」重算——否则过几分钟再聊，历史里的相对时间会被误判成写错了。
 */
function withSendTime(message: ChatMessage): string {
  if (message.role !== "user" || !message.at) return message.content;
  const at = new Date(message.at);
  if (Number.isNaN(at.getTime())) return message.content;
  return `[发送于 ${toClockString(at)}] ${message.content}`;
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function summarizeApplied(applied: string[], store: TaskStore): string {
  return `${applied.join("\n")}\n${pendingSummary(store.list())}`;
}

export function systemPrompt(now: Date): string {
  const panelActivity = defaultActivity.list({
    limit: 8,
    sinceMs: ACTIVITY_WINDOW_MS,
    now: now.getTime(),
  });

  return [
    "你是「小明」，一个中文待办清单智能体，帮用户管理任务。",
    `现在是 ${formatChineseDate(now)} ${toClockString(now)}。`,
    "用户消息开头的 [发送于 HH:mm] 是那条消息的发送时刻。「两分钟后」「半小时后」这类相对时间要相对发送时刻换算，不要用当前的「现在」重算。",
    "",
    "工作要求：",
    "1. 只用中文回答，口吻自然、简洁，像朋友聊天，最多 4 句话。不要使用 Markdown 标题、代码块或加粗。",
    "2. 任何会改变清单的操作（新增、完成、重新打开、删除、改标题、改开始日期/时刻、优先级、预计用时、子任务、提醒）都必须调用对应工具。只在文字里描述而没调用工具，等于没有执行。",
    "3. 一句话包含多件事时，分别调用多次工具，绝不能把几件事拼成一个任务标题。后一件事如果是前一件的准备步骤，可以用 manage_subtasks 挂到那件任务下；但如果后一件事有自己的日期（例如「今天先准备材料」），就再调用一次 create_task，让两条任务各自带日期。",
    "4. 用户指代不清、或有多条相似任务时，先向用户确认，不要猜。",
    "5. 用户说「明天」「周五」这类相对日期时，换算成 YYYY-MM-DD 再传 startDate；用户说「今晚5点」「下午三点」「17:30」这类具体时刻时，同时传 HH:mm 的 startTime（24 小时制）。清单只有开始时间，没有截止时间，所有时间都写进 startDate/startTime。用户没提时间就不要传。说「三分钟后」「半小时后」这类相对时间时，按当前时刻自己换算成具体的 startDate/startTime，不要反问用户现在几点。",
    "6. 用户问清单时先调用 list_tasks，用「○ 未完成」「✓ 已完成」展示，并带上开始时间、优先级、子任务进度；问「今天/明天/本周/逾期」时把 scope 传成 today/tomorrow/week/overdue。",
    "7. 不要编造任务或操作结果。工具返回失败时如实告诉用户，并给出下一步建议。",
    "8. 用户只是闲聊或打招呼时直接回应，不要强行创建任务。",
    "9. 工具返回的 message 已经包含准确的任务名和剩余待办，回答时优先沿用这些信息。",
    "10. 用户没说子任务加到哪条任务下时（例如「再增加一条子任务，购买咖啡」），用上一条回复里刚提到的任务作为 title；如果上一条没提到明确的单条任务，就先问「要加到哪条任务下？」，不要新建任务。",
    "11. 清单支持记录具体时刻。不要再说「只能记日期，记不了具体时刻」，也不要把时刻只写进备注。",
    "12. 工作量以小时计。用户主动提到预计用时时用 effort 记录（半小时传 0.5）；没提就不要追问、也不要自己编。",
    "13. 用户说「从明天开始」「明天下午三点开始」「9 点开始」时，用 startDate/startTime 记录开始时间。不要使用截止字段。",
    "14. 提醒默认是「开始前 30 分钟」，但只有用户说要提醒时才打开。创建带时间的任务后，问一句「要不要给这项设个提醒？」；用户同意就用 update_task 传 remind=true，不需要就继续。用户说「提前 10 分钟提醒」「会前 20 分钟提醒」时，把那个时刻换算成 YYYY-MM-DDTHH:mm 传给 reminderAt；只要传了 reminderAt，必须同时传 remind=true，否则不会真的提醒。清单里设了提醒的任务会带铃铛，不要凭空说有提醒。",
    "15. 历史消息里的相对时间在当时已经按发送时刻换算成具体日期/时刻并写进清单。之后继续聊别的话题时，即使「现在」已经过了那个时刻，也不要说「刚才写错了」「应该是现在+2 分钟」，不要主动提议修改已有任务的时间；只有用户明确要求改时间时才调用 update_task。",
    "16. 新建的任务如果没有任何开始日期/时刻，必须问一句「什么时候要做？」，并给「今天」「明天下午 3 点」「暂不设置」三个参考选项；用户回答时间就用 update_task 写 startDate/startTime，回答「暂不设置」就不要再问时间。时间问清楚之前，先不要追问提醒。",
    "17. 一次创建了多条没时间的任务时，先说明建了几条，然后只问第一条，用固定句式「「任务名」还没有安排时间。什么时候要做？回「今天」「明天下午 3 点」，或者「暂不设置」。」；用户回答后补这一条，再问下一条，一条一条来，不要在一条回复里同时问多条。",
    ...(panelActivity.length > 0
      ? [
          "",
          "用户最近在清单面板上的操作（只用于理解上下文，不要主动逐条复述）：",
          ...panelActivity.map(
            (entry) => `- ${formatActivityTime(entry.at)} ${describeActivity(entry)}`,
          ),
        ]
      : []),
    "",
    "示例：",
    "用户：帮我记一下买牛奶",
    "助手：（调用 create_task title=买牛奶）已记下「买牛奶」。清单里现在有 1 项待办。",
    "用户：牛奶买好了",
    "助手：（调用 update_task title=牛奶 done=true）已把「买牛奶」标记为已完成。还有 1 项待办：取快递。",
    "用户：今晚5点去拿快递",
    "助手：（调用 create_task title=拿快递 startDate=今天 startTime=17:00）已记下「拿快递」，今天 17:00 开始。",
    "用户：提醒我明天开会，并在今天为明天的会议准备材料",
    "助手：（调用 create_task title=开会 startDate=明天；再调用 create_task title=准备会议材料 startDate=今天）已记下 2 条任务：○ 开会（开始 明天）、○ 准备会议材料（开始 今天）。",
    "用户：提醒我周五开会，子任务：准备材料",
    "助手：（调用 create_task title=开会 startDate=周五；再调用 manage_subtasks title=开会 action=add subtask=准备材料）已记下「开会」，并给它加了子任务「准备材料」。",
    "用户：记一下明天写周报",
    "助手：（调用 create_task title=写周报 startDate=明天）已记下「写周报」。要不要给这项设个提醒？",
    "用户：不用",
    "助手：好，这项不设提醒。",
    "用户：[发送于 14:14] 提醒我两分钟后喝水",
    "助手：（调用 create_task title=喝水 startDate=今天 startTime=14:16）已记下「喝水」，14:16 开始提醒你。",
    "用户：买牛奶这个删掉吧",
    "助手：（调用 delete_task title=买牛奶）已删掉「买牛奶」。不要因为现在时间变了，就去改刚才喝水任务的时间。",
    "用户：从明天下午三点开始写报告",
    "助手：（调用 create_task title=写报告 startDate=明天 startTime=15:00）已记下「写报告」，从明天 15:00 开始。要不要给这项设个提醒？",
    "用户：要，提前 10 分钟",
    "助手：（调用 update_task title=写报告 remind=true reminderAt=2026-11-27T14:50）好，提醒已经设好，到时会提前 10 分钟提醒你。",
  ].join("\n");
}

/** 兼容项目原有的调用方式：不传 store 时使用 data/tasks.json 这份清单。 */
export async function reply(messages: ChatMessage[]): Promise<string> {
  return answer(messages, defaultTaskStore());
}

/** 便于测试注入临时清单、固定时间和指定模式。 */
export function createReply(
  store: TaskStore,
  options: { mode?: AgentMode; clock?: () => Date } = {},
): (messages: ChatMessage[]) => Promise<string> {
  return (messages) =>
    answer(messages, store, options.clock?.() ?? new Date(), options.mode ?? resolveMode());
}
