import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ChatMessage } from "../shared/chat.ts";
import { formatChineseDate } from "./dates.ts";
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
      content: message.content,
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

function systemPrompt(now: Date): string {
  return [
    "你是「小明」，一个中文待办清单智能体，帮用户管理任务。",
    `今天是 ${formatChineseDate(now)}。`,
    "",
    "工作要求：",
    "1. 只用中文回答，口吻自然、简洁，像朋友聊天，最多 4 句话。不要使用 Markdown 标题、代码块或加粗。",
    "2. 任何会改变清单的操作（新增、完成、重新打开、删除、改标题、改截止日期、优先级、工作量、子任务）都必须调用对应工具。只在文字里描述而没调用工具，等于没有执行。",
    "3. 一句话包含多件事时，分别调用多次工具，绝不能把几件事拼成一个任务标题。后一件事如果是前一件的准备步骤，可以用 manage_subtasks 挂到那件任务下；但如果后一件事有自己的日期（例如「今天先准备材料」），就再调用一次 create_task，让两条任务各自带日期。",
    "4. 用户指代不清、或有多条相似任务时，先向用户确认，不要猜。",
    "5. 用户说「明天」「周五」这类相对时间时，换算成 YYYY-MM-DD 再传 dueDate；用户没提日期就不要传。",
    "6. 用户问清单时先调用 list_tasks，用「○ 未完成」「✓ 已完成」展示，并带上截止日期、优先级、子任务进度；问「今天/明天/本周/逾期」时把 scope 传成 today/tomorrow/week/overdue。",
    "7. 不要编造任务或操作结果。工具返回失败时如实告诉用户，并给出下一步建议。",
    "8. 用户只是闲聊或打招呼时直接回应，不要强行创建任务。",
    "9. 工具返回的 message 已经包含准确的任务名和剩余待办，回答时优先沿用这些信息。",
    "10. 用户没说子任务加到哪条任务下时（例如「再增加一条子任务，购买咖啡」），用上一条回复里刚提到的任务作为 title；如果上一条没提到明确的单条任务，就先问「要加到哪条任务下？」，不要新建任务。",
    "",
    "示例：",
    "用户：帮我记一下买牛奶",
    "助手：（调用 create_task title=买牛奶）已记下「买牛奶」。清单里现在有 1 项待办。",
    "用户：牛奶买好了",
    "助手：（调用 update_task title=牛奶 done=true）已把「买牛奶」标记为已完成。还有 1 项待办：取快递。",
    "用户：提醒我明天开会，并在今天为明天的会议准备材料",
    "助手：（调用 create_task title=开会 dueDate=明天；再调用 create_task title=准备会议材料 dueDate=今天）已记下 2 条任务：○ 开会（截止 明天）、○ 准备会议材料（今天到期）。",
    "用户：提醒我周五开会，子任务：准备材料",
    "助手：（调用 create_task title=开会 dueDate=周五；再调用 manage_subtasks title=开会 action=add subtask=准备材料）已记下「开会」，并给它加了子任务「准备材料」。",
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
