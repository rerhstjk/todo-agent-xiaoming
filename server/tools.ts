import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { execute } from "./commands.ts";
import { findDateText, parseDateString, toDateString } from "./dates.ts";
import { toolReply } from "./replies.ts";
import { taskScopes, type TaskScope } from "./selection.ts";
import {
  efforts,
  priorities,
  type Effort,
  type Priority,
  type TaskPatch,
  type TaskStore,
} from "./task-store.ts";

/** 交给模型的工具清单，参数描述直接写中文，减少模型猜字段的情况。 */
export const toolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "新建一条待办任务。用户说「记一下…」「提醒我…」「添加…」时调用。一句话里有多个任务时，每个任务各调用一次。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "任务标题，去掉语气词，例如「买牛奶」" },
          dueDate: {
            type: "string",
            description: "截止日期，格式 YYYY-MM-DD。用户没提到日期就不要传。",
          },
          priority: {
            type: "string",
            enum: [...priorities],
            description: "优先级：high 高、normal 中（默认）、low 低。",
          },
          effort: {
            type: "string",
            enum: [...efforts],
            description: "工作量：small 小、medium 中、large 大。用户没提到就不要传。",
          },
          note: { type: "string", description: "补充备注，可为空。" },
          subtasks: {
            type: "array",
            items: { type: "string" },
            description: "子任务标题列表，用户提到拆步骤时使用。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "查看任务清单。用户问「我有哪些任务」「还剩什么」「今天/明天有什么到期」「这周还有什么」时调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: {
            type: "string",
            enum: [...taskScopes],
            description:
              "all 全部、open 未完成、done 已完成、today 今天到期、tomorrow 明天到期、week 本周待处理、overdue 已逾期。",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "修改一条已有任务：标记完成/未完成、改标题、改截止日期、改优先级、改工作量、改备注。一次可以修改多个字段。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "要修改的任务标题或其中的关键词，例如「牛奶」" },
          newTitle: { type: "string", description: "新的任务标题，不改标题就不要传。" },
          done: { type: "boolean", description: "true 标记完成，false 重新打开。" },
          dueDate: {
            type: "string",
            description: "新的截止日期 YYYY-MM-DD；传空字符串表示清除截止日期；不修改就不要传。",
          },
          priority: {
            type: "string",
            enum: [...priorities, "none"],
            description: "新优先级；none 表示清除优先级。",
          },
          effort: {
            type: "string",
            enum: [...efforts, "none"],
            description: "新的工作量；none 表示清除工作量。",
          },
          note: { type: "string", description: "新的备注；传空字符串表示清除备注。" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "删除一条任务。用户说「删掉」「不要了」「去掉」时调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "要删除的任务标题或其中的关键词" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_subtasks",
      description: "给任务添加、完成或删除子任务。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "action", "subtask"],
        properties: {
          title: { type: "string", description: "父任务的标题或关键词" },
          action: {
            type: "string",
            enum: ["add", "complete", "remove"],
            description: "add 新增、complete 完成、remove 删除子任务。",
          },
          subtask: { type: "string", description: "子任务标题" },
        },
      },
    },
  },
];

const createArgs = z.object({
  title: z.string().trim().min(1).max(200),
  dueDate: z.string().optional(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
  subtasks: z.array(z.string()).max(20).optional(),
});

const listArgs = z.object({
  scope: z.enum(["all", "open", "done", "today", "tomorrow", "week", "overdue"]).optional(),
});

const updateArgs = z.object({
  title: z.string().trim().min(1),
  newTitle: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
  dueDate: z.string().optional(),
  priority: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const deleteArgs = z.object({
  title: z.string().trim().min(1),
});

const subtaskArgs = z.object({
  title: z.string().trim().min(1),
  action: z.enum(["add", "complete", "remove"]),
  subtask: z.string().trim().min(1).max(200),
});

export interface ToolOutcome {
  ok: boolean;
  /** 是否真的改动了清单。模型兜底时用它判断能否重跑规则引擎。 */
  changed: boolean;
  /** 给模型看的中文结果，可以直接作为回复依据。 */
  message: string;
  data?: unknown;
}

export function runTool(
  store: TaskStore,
  name: string,
  rawArgs: unknown,
  now = new Date(),
): ToolOutcome {
  try {
    switch (name) {
      case "create_task": {
        const args = createArgs.parse(rawArgs);
        const result = execute(
          store,
          {
            kind: "create",
            input: {
              title: args.title,
              dueDate: normalizeDueDate(args.dueDate, now),
              priority: parsePriority(args.priority) ?? undefined,
              effort: parseEffort(args.effort) ?? undefined,
              note: args.note?.trim() || undefined,
              subtasks: args.subtasks?.map((item) => item.trim()).filter(Boolean),
            },
          },
          now,
        );
        return toolReply(result, now);
      }
      case "list_tasks": {
        const args = listArgs.parse(rawArgs ?? {});
        const scope: TaskScope = args.scope ?? "all";
        return toolReply(execute(store, { kind: "list", scope }, now), now);
      }
      case "update_task": {
        const args = updateArgs.parse(rawArgs);
        const patch: TaskPatch = {};
        if (args.done !== undefined) patch.done = args.done;
        if (args.newTitle) patch.title = args.newTitle;

        if (args.dueDate !== undefined) {
          const value = args.dueDate.trim();
          if (!value) patch.dueDate = null;
          else {
            const dueDate = normalizeDueDate(value, now);
            if (!dueDate) {
              return {
                ok: false,
                changed: false,
                message: `无法识别日期「${args.dueDate}」，请用 YYYY-MM-DD 格式。`,
              };
            }
            patch.dueDate = dueDate;
          }
        }

        const priority = parsePriority(args.priority);
        if (priority !== undefined) patch.priority = priority;
        const effort = parseEffort(args.effort);
        if (effort !== undefined) patch.effort = effort;
        if (args.note !== undefined) patch.note = args.note.trim() || null;

        if (Object.keys(patch).length === 0) {
          return { ok: false, changed: false, message: "这次没有需要修改的字段。" };
        }
        return toolReply(execute(store, { kind: "update", hint: args.title, patch }, now), now);
      }
      case "delete_task": {
        const args = deleteArgs.parse(rawArgs);
        return toolReply(execute(store, { kind: "remove", hint: args.title }, now), now);
      }
      case "manage_subtasks": {
        const args = subtaskArgs.parse(rawArgs);
        return toolReply(
          execute(
            store,
            { kind: "subtask", hint: args.title, action: args.action, subtask: args.subtask },
            now,
          ),
          now,
        );
      }
      default:
        return {
          ok: false,
          changed: false,
          message: `未知工具「${name}」，请不要调用不存在的工具。`,
        };
    }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      message: error instanceof Error ? error.message : "工具执行失败，请稍后重试。",
    };
  }
}

function normalizeDueDate(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const date = parseDateString(trimmed);
  if (date) return toDateString(date);
  return findDateText(trimmed, now)?.value;
}

function parsePriority(value: string | undefined): Priority | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "clear" || normalized === "无")
    return null;
  if (["high", "高", "高优先级", "重要", "紧急"].includes(normalized)) return "high";
  if (["low", "低", "低优先级", "不急"].includes(normalized)) return "low";
  if (["normal", "medium", "中", "中优先级", "普通"].includes(normalized)) return "normal";
  return undefined;
}

function parseEffort(value: string | undefined): Effort | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "clear" || normalized === "无")
    return null;
  if (["small", "小", "小工作量"].includes(normalized)) return "small";
  if (["medium", "中", "中工作量"].includes(normalized)) return "medium";
  if (["large", "大", "大工作量"].includes(normalized)) return "large";
  return undefined;
}
