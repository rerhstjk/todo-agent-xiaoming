import type { ChatMessage } from "../shared/chat.ts";
import {
  ACTIVITY_WINDOW_MS,
  defaultActivity,
  describeActivity,
  formatActivityTime,
} from "./activity.ts";
import { execute, type Command, type CommandResult, type NewTaskInput } from "./commands.ts";
import { findDateText, formatChineseDate, stripClockTime } from "./dates.ts";
import { chatReply, createBatchChat } from "./replies.ts";
import type { TaskScope } from "./selection.ts";
import { type Effort, type Priority, type TaskPatch, type TaskStore } from "./task-store.ts";

/**
 * 没配置 DEEPSEEK_API_KEY 时使用的规则引擎。它覆盖了题目验收对话里出现的说法，
 * 以及常见的“记一下 / 我有哪些任务 / 牛奶买好了 / 取快递删掉 / 今天到期”等表达，
 * 让项目在没有密钥的情况下也能完整演示，同时也作为模型调用失败时的兜底。
 */

type Action = "complete" | "reopen" | "delete";

type Intent =
  | { kind: "list"; scope: TaskScope }
  | { kind: "create"; title: string; dueDate?: string; priority?: Priority; effort?: Effort }
  | { kind: "action"; action: Action; hint: string }
  | { kind: "rename"; hint: string; title: string }
  | { kind: "update"; hint: string; dueDate?: string; priority?: Priority }
  | { kind: "subtask"; hint: string; action: "add" | "complete" | "remove"; subtask: string }
  | { kind: "subtaskUnclear" }
  | { kind: "clearDone" }
  | { kind: "activity" }
  | { kind: "greeting" }
  | { kind: "help" }
  | { kind: "empty" }
  | { kind: "unknown" };

const CREATE_WORDS =
  /(记一下|记一条|记一笔|记下|记个|记录|添加|新增|新建|加个|加一条|加一个|提醒我|别忘了|帮我记|待办事项)/;
const LIST_WORDS =
  /(有哪些|有什么|哪些|多少|几条|几个|看看|看一下|查看|列一下|列出|清单|列表|还剩|剩下|剩余|进度|情况|任务|待办)/;
const QUERY_WORDS = /(哪些|什么|多少|几个|几条|清单|列表|看看|查看|列出|还剩|剩下|进度|情况)/;
const COMPLETE_WORDS = /(完成|做完|干完|搞定|弄好|办完|办完|买好|好了|打勾|勾上|已办)/;
const REOPEN_WORDS = /(重新打开|重新开始|取消完成|恢复|还没做完|没完成|未完成|又要做|重新做)/;
const DELETE_WORDS = /(删掉|删除|删了|删去|去掉|移除|不要了|不做了)/;
const CLEAR_DONE_WORDS =
  /(删掉|删除|清空|清理|移除|去掉|清除)(掉)?(所有|全部)?(已经)?(已完成|完成的|做完的|搞定的)/;

/** 一句话里的多个动作：逗号/分号分隔，后一个分句以「并 / 然后 / 再」等开头。 */
const CLAUSE_SEPARATOR = /[，,；;]\s*/;
const CLAUSE_CONNECTOR = /^(?:并且|并|同时|然后|另外|还要|还需|顺便|以及|再|接着)\s*/;
/** “子任务：整理数据”“加子任务：准备材料”。 */
const SUBTASK_CLAUSE = /^(?:加|添加|新增|记)?\s*(?:一个|一条|个)?\s*子任务\s*[:：]\s*(.+)$/;

const CREATE_PREFIXES = [
  /^(请|麻烦你|麻烦|帮我|帮忙|给我|再|顺便|另外|然后|那个|这条|那条)/,
  /^(记一下|记一条|记一笔|记下来|记下|记个|记录一下|记录|添加一个任务|添加任务|添加一条|添加一个|添加|新增一个任务|新增|新建一个任务|新建|加一个任务|加一条|加一个|加个|提醒我一下|提醒我|提醒|别忘了|帮我记)/,
  /^(一下|一个|一条|一笔|个|条|项|任务|待办事项|待办)/,
];

const COMPLETE_VERBS = [
  "标记为已完成",
  "标记为完成",
  "标记为已办",
  "标记为未完成",
  "标记成已完成",
  "标记成完成",
  "标记",
  "已经完成了",
  "已经完成",
  "已完成了",
  "已完成",
  "做完了",
  "干完了",
  "搞定了",
  "弄好了",
  "办完了",
  "办好了",
  "写完了",
  "看完了",
  "买好了",
  "吃完了",
  "完成了",
  "做完",
  "干完",
  "搞定",
  "弄好",
  "办完",
  "办好",
  "写完",
  "看完",
  "买好",
  "吃完",
  "打勾",
  "勾上",
  "完成",
  "好了",
];

const DELETE_VERBS = ["删掉", "删除", "删了", "删去", "去掉", "移除", "不要了", "不做了"];
const REOPEN_VERBS = [
  "标记为未完成",
  "标记成未完成",
  "重新打开",
  "重新开始",
  "取消完成",
  "还没做完",
  "没完成",
  "未完成",
  "重新做",
  "恢复",
  "又要做",
];

const EFFORT_MAP: Record<string, Effort> = { 小: "small", 中: "medium", 大: "large" };
const ORDINALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function parseIntent(text: string, now = new Date()): Intent {
  const value = text.trim();
  if (!value) return { kind: "empty" };
  if (
    /^(你好|您好|hi|hello|嗨|哈喽|在吗|在么|早上好|中午好|下午好|晚上好)[\s!！。,.，?？~～]*$/i.test(
      value,
    )
  ) {
    return { kind: "greeting" };
  }
  if (/(你能做什么|你会什么|帮助|help|怎么用|使用说明)/i.test(value)) return { kind: "help" };

  // 「刚才删了什么」「面板上你改了什么」：问的是面板操作，不是要删除任务。
  if (
    /^(?:你|我)?\s*(?:刚才|刚刚)?\s*(?:在)?(?:清单|面板)?(?:上)?\s*(?:删(?:除|掉)?|改|修改|动|操作)了?(?:什么|哪些|啥)/.test(
      value,
    )
  ) {
    return { kind: "activity" };
  }

  if (CLEAR_DONE_WORDS.test(value)) return { kind: "clearDone" };

  const priorityUpdate =
    /^(?:把|将)?\s*(.+?)\s*(?:设成|设为|设置为|改成|改为|标记为|调整成|调整到)\s*(高优先级|中优先级|低优先级|高|中|低)\s*(?:优先级)?$/.exec(
      value,
    );
  if (priorityUpdate) {
    const value = priorityUpdate[2];
    const priority = value.startsWith("高") ? "high" : value.startsWith("低") ? "low" : "normal";
    const hint = extractHint(priorityUpdate[1], []);
    if (hint) return { kind: "update", hint, priority };
  }

  const dueUpdate =
    /^(?:把|将)?\s*(.+?)\s*(?:的)?\s*(?:截止(?:日期|时间)?|到期日|due)\s*(?:改到|改成|设为|设置成|推迟到|提前到|是)\s*(.+)$/i.exec(
      value,
    );
  if (dueUpdate) {
    const hint = extractHint(dueUpdate[1], []);
    const dueDate = findDateText(dueUpdate[2], now)?.value;
    if (hint && dueDate) return { kind: "update", hint, dueDate };
  }

  // 「再增加一条子任务，购买咖啡」「加个子任务：买咖啡」：没说加到哪条任务下，
  // 先用上下文里的上一条任务，解析层只把名字留空。
  const implicitSubtaskAdd =
    /^(?:再|还|另外|顺便)?\s*(?:给|帮|为)?\s*(?:增加|添加|新增|加|记)\s*(?:一个|一条|个)?\s*子任务\s*[:：,，]?\s*(.+)$/.exec(
      value,
    );
  if (implicitSubtaskAdd) {
    const subtask = cleanTitle(implicitSubtaskAdd[1]);
    if (subtask) return { kind: "subtask", hint: "", action: "add", subtask };
  }

  const subtaskAdd =
    /^(?:给|帮|为)?\s*(.+?)\s*(?:加|添加|新增|增加)\s*(?:一个|一条|个)?\s*子任务\s*[:：,，]?\s*(.+)$/.exec(
      value,
    );
  if (subtaskAdd) {
    const hint = extractHint(subtaskAdd[1], []);
    const subtask = cleanTitle(subtaskAdd[2]);
    if (hint && subtask) return { kind: "subtask", hint, action: "add", subtask };
  }

  const subtaskDone =
    /^(?:把|将)?\s*(.+?)\s*的\s*子任务\s*(.+?)\s*(?:完成了|做好了|搞定了|完成|做完|搞定|好了)$/.exec(
      value,
    );
  if (subtaskDone) {
    const hint = extractHint(subtaskDone[1], []);
    const subtask = cleanTitle(subtaskDone[2]);
    if (hint && subtask) return { kind: "subtask", hint, action: "complete", subtask };
  }

  const subtaskRemove =
    /^(?:把|将)?\s*(.+?)\s*的?\s*子任务\s*(.+?)\s*(?:删掉|删除|删了|删去|去掉|移除|不要了)$/.exec(
      value,
    ) ??
    /^(?:把|将)?\s*(?:删掉|删除|删了|删去|去掉|移除)\s*(.+?)\s*的?\s*子任务\s*(.+)$/.exec(value);
  if (subtaskRemove) {
    const hint = extractHint(subtaskRemove[1], []);
    const subtask = cleanTitle(subtaskRemove[2]);
    if (hint && subtask) return { kind: "subtask", hint, action: "remove", subtask };
  }

  // 提到子任务但没解析出具体动作、又带着删/完成类动词时，宁可追问，也不能作用到父任务上。
  if (
    value.includes("子任务") &&
    (DELETE_WORDS.test(value) || COMPLETE_WORDS.test(value) || REOPEN_WORDS.test(value))
  ) {
    return { kind: "subtaskUnclear" };
  }

  if (DELETE_WORDS.test(value)) {
    return { kind: "action", action: "delete", hint: extractHint(value, DELETE_VERBS) };
  }

  const rename = /^(?:把|将)?(.+?)(?:改成|改为|改名为|重命名为|改叫)(.+)$/.exec(value);
  if (rename) {
    const hint = extractHint(rename[1], []);
    const title = cleanTitle(rename[2]);
    const parsedDate = findDateText(title, now);
    if (hint && parsedDate && parsedDate.matched === title) {
      return { kind: "update", hint, dueDate: parsedDate.value };
    }
    if (hint && title) return { kind: "rename", hint, title };
  }

  if (CREATE_WORDS.test(value)) return createIntent(value, now);

  if (REOPEN_WORDS.test(value) && !QUERY_WORDS.test(value)) {
    return { kind: "action", action: "reopen", hint: extractHint(value, REOPEN_VERBS) };
  }

  if (COMPLETE_WORDS.test(value) && !QUERY_WORDS.test(value)) {
    return { kind: "action", action: "complete", hint: extractHint(value, COMPLETE_VERBS) };
  }

  if (LIST_WORDS.test(value)) return { kind: "list", scope: listScope(value) };

  return { kind: "unknown" };
}

function listScope(text: string): TaskScope {
  if (/(逾期|过期|超期)/.test(text)) return "overdue";
  const taskWords = /(到期|截止|该做|要做|交|安排|任务|待办|事情|干点啥)/;
  if (/(明天|明日)/.test(text) && taskWords.test(text)) return "tomorrow";
  if (/(今天|今日)/.test(text) && taskWords.test(text)) return "today";
  if (/(这周|本周|这个星期|这星期|这一周)/.test(text)) return "week";
  if (/(已完成|完成的|做完的|搞定的)/.test(text)) return "done";
  if (/(没完成|未完成|还没|没做|待办|要做|还要|剩下|剩余)/.test(text)) return "open";
  return "all";
}

/** “记一下……”里剔除语气词后剩下的任务标题。 */
function createIntent(text: string, now: Date): Intent {
  // 先削掉「帮我记一下」这类前缀，否则「记一下下周一开会」里的「一下下」
  // 会被日期解析误认成「下下周」。
  let value = stripCreatePrefixes(text);
  let dueDate: string | undefined;
  const parsed = findDateText(value, now);
  if (parsed) {
    dueDate = parsed.value;
    value = value.replace(parsed.matched, " ");
    value = value.replace(/^\s*[在于]\s*(?=为|给|和|跟|与|把|做|去|来)/, " ");
  }

  let priority: Priority | undefined;
  if (/(高优先级|很重要|重要|紧急|特急|加急|优先)/.test(value)) priority = "high";
  else if (/(低优先级|不急|不着急|随时)/.test(value)) priority = "low";
  value = value.replace(/高优先级|很重要|重要|紧急|特急|加急|优先|低优先级|不急|不着急|随时/g, " ");

  let effort: Effort | undefined;
  const effortMatch = /(?:工作量|耗时|难度)\s*[:：]?\s*(小|中|大)/.exec(value);
  if (effortMatch) {
    effort = EFFORT_MAP[effortMatch[1]];
    value = value.replace(effortMatch[0], " ");
  }

  value = stripCreatePrefixes(value);
  value = stripClockTime(value);
  value = cleanTitle(value);
  if (!value) return { kind: "empty" };

  return { kind: "create", title: value.slice(0, 200), dueDate, priority, effort };
}

function stripCreatePrefixes(value: string): string {
  let current = value;
  for (;;) {
    const before = current;
    for (const pattern of CREATE_PREFIXES) current = current.replace(pattern, " ").trimStart();
    if (current === before) return current;
  }
}

/** 去掉包裹的引号、标点和句末语气词。 */
function cleanTitle(value: string): string {
  return value
    .replace(/^[\s：:，,、。.！!？?"'“”‘’]+/, "")
    .replace(/[\s。！!？?，,；;、"'“”‘’]+$/, "")
    .replace(/(?:吧|啊|呀|哦|呢|啦|谢谢|多谢)+$/, "")
    .trim();
}

/** 从“牛奶买好了”“把买牛奶标记为已完成”里取出任务提示词。 */
function extractHint(text: string, verbs: string[]): string {
  let value = text;
  for (const verb of [...verbs].sort((a, b) => b.length - a.length)) {
    value = value.split(verb).join(" ");
  }
  value = value.replace(/(这个|那个|这条|那条|这些|那些|任务|待办|事项|这条任务|那条任务)/g, " ");
  value = value.replace(/^(请|麻烦你|麻烦|帮我|帮忙|给我|把|将|我|已经|都|再|顺便|给|帮|为)+/, " ");
  value = value.replace(/[的地得了吧啊呀哦呢啦]/g, " ");
  return cleanTitle(value.replace(/\s+/g, " "));
}

interface CreateClause {
  kind: "task" | "subtask";
  text: string;
}

/**
 * 把「提醒我明天开会，并在今天为明天的会议准备材料」这样的整句拆成两件事。
 * 只在后一个分句以「并 / 然后 / 再 / 同时 / 另外 / 顺便」开头，
 * 或者本身又是一条「记一下…」时才拆，避免把「周五开会，讨论预算」误拆成两条。
 */
function splitCreateClauses(text: string): CreateClause[] | undefined {
  const parts = text
    .split(CLAUSE_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;

  const clauses: CreateClause[] = [{ kind: "task", text: parts[0]! }];
  for (const raw of parts.slice(1)) {
    if (/^(或者|还是|或是)/.test(raw)) return undefined;
    const rest = raw.replace(CLAUSE_CONNECTOR, "").trim();
    const subtask = SUBTASK_CLAUSE.exec(rest);
    if (subtask) {
      const text = subtask[1]!.trim();
      if (text.length < 2) return undefined;
      clauses.push({ kind: "subtask", text });
      continue;
    }
    const linked = CLAUSE_CONNECTOR.test(raw) || CREATE_WORDS.test(raw);
    if (!linked || rest.length < 2) return undefined;
    clauses.push({ kind: "task", text: rest });
  }
  return clauses;
}

/** 依次执行拆出来的多个动作：建任务、给刚建的任务加子任务，再统一回复。 */
function runCreateClauses(store: TaskStore, clauses: CreateClause[], now: Date): string {
  const results: CommandResult[] = [];
  let previous: { id: string; title: string } | undefined;

  for (const clause of clauses) {
    if (clause.kind === "subtask") {
      if (!previous) continue;
      results.push(
        execute(
          store,
          {
            kind: "subtask",
            hint: previous.title,
            action: "add",
            subtask: clause.text,
            taskId: previous.id,
          },
          now,
        ),
      );
      continue;
    }

    const parsed = createIntent(clause.text, now);
    if (parsed.kind !== "create") continue;
    const input: NewTaskInput = {
      title: parsed.title,
      dueDate: parsed.dueDate,
      priority: parsed.priority,
      effort: parsed.effort,
    };
    const result = execute(store, { kind: "create", input }, now);
    results.push(result);
    if (result.task) previous = { id: result.task.id, title: result.task.title };
  }

  if (results.length === 0) {
    return "这句我没有拆出可用的任务，可以换成「记一下买牛奶」这样的说法。";
  }
  return createBatchChat(results, now);
}

/** 没说加到哪条任务时，优先用上一条回复里提到的任务；否则只有一条待办时就用它。 */
function contextTask(store: TaskStore, messages: ChatMessage[]): string | undefined {
  const previous =
    [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  const open = store.list().filter((task) => !task.done);
  if (open.length === 0) return undefined;

  const mentioned = open.filter((task) => previous.includes(task.title));
  // 上一条回复只提到一条任务时才用它；列出好几条说明用户还没指定，宁可追问。
  if (mentioned.length === 1) return mentioned[0]!.title;
  return open.length === 1 ? open[0]!.title : undefined;
}

export function ruleReply(store: TaskStore, messages: ChatMessage[], now = new Date()): string {
  const choice = followUpChoice(messages);
  if (choice) return chatReply(execute(store, choice, now), now);

  const text = messages.at(-1)?.content ?? "";

  // 先看是不是一句话里说了几件事。必须在 parseIntent 之前判断：
  // 「提醒我明天开会，并加子任务：准备材料」会被子任务正则整句命中，
  // 从而漏掉前半句的建任务动作。
  const clauses = splitCreateClauses(text);
  if (clauses && clauses.length > 1 && CREATE_WORDS.test(clauses[0]!.text)) {
    return runCreateClauses(store, clauses, now);
  }

  const intent = parseIntent(text, now);

  switch (intent.kind) {
    case "create": {
      return chatReply(
        execute(
          store,
          {
            kind: "create",
            input: {
              title: intent.title,
              dueDate: intent.dueDate,
              priority: intent.priority,
              effort: intent.effort,
            },
          },
          now,
        ),
        now,
      );
    }
    case "list":
      return chatReply(execute(store, { kind: "list", scope: intent.scope }, now), now);
    case "action": {
      const command: Command =
        intent.action === "delete"
          ? { kind: "remove", hint: intent.hint }
          : { kind: "setDone", hint: intent.hint, done: intent.action === "complete" };
      return chatReply(execute(store, command, now), now);
    }
    case "rename":
      return chatReply(
        execute(store, { kind: "rename", hint: intent.hint, title: intent.title }, now),
        now,
      );
    case "update": {
      const patch: TaskPatch = {};
      if (intent.dueDate) patch.dueDate = intent.dueDate;
      if (intent.priority) patch.priority = intent.priority;
      return chatReply(execute(store, { kind: "update", hint: intent.hint, patch }, now), now);
    }
    case "subtask": {
      const generic =
        !intent.hint ||
        /^(这条|那条|它|这个|那个|该任务|上面那条|刚才那条|任务|待办)$/.test(intent.hint);
      const hint = generic ? (contextTask(store, messages) ?? "") : intent.hint;
      if (!hint) {
        return "要加到哪条任务下？可以说「给开会加子任务：买咖啡」。";
      }
      return chatReply(
        execute(
          store,
          { kind: "subtask", hint, action: intent.action, subtask: intent.subtask },
          now,
        ),
        now,
      );
    }
    case "subtaskUnclear":
      return SUBTASK_UNCLEAR_TEXT;
    case "clearDone":
      return chatReply(execute(store, { kind: "clearDone" }, now), now);
    case "activity":
      return activityReply(now);
    case "greeting":
      return greeting(store, now);
    case "help":
      return HELP_TEXT;
    case "empty":
      return "要记什么呢？可以说「记一下买牛奶」。";
    case "unknown":
      return UNKNOWN_TEXT;
  }
}

/** 用户只回了一个序号时，从上一条追问里取出候选标题。 */
function followUpChoice(messages: ChatMessage[]): Command | undefined {
  const text = messages.at(-1)?.content.trim() ?? "";
  const match = /^(?:第)?\s*([1-9]|[一二三四五六七八九十])\s*(?:条|个|项|条任务)?$/.exec(text);
  if (!match) return undefined;

  const previous = messages.at(-2);
  if (!previous || previous.role !== "assistant") return undefined;

  const actionMatch = /要(完成|重新打开|删除)哪一条/.exec(previous.content);
  if (!actionMatch) return undefined;

  const options: string[] = [];
  for (const line of previous.content.split("\n")) {
    const option = /^\d+\.\s*[○✓]?\s*(.+?)\s*$/.exec(line);
    if (option) options.push(option[1]);
  }

  const index = /[1-9]/.test(match[1]) ? Number(match[1]) : (ORDINALS[match[1]] ?? 0);
  const title = options[index - 1];
  if (!title) return undefined;

  if (actionMatch[1] === "删除") return { kind: "remove", hint: title };
  return { kind: "setDone", hint: title, done: actionMatch[1] === "完成" };
}

function activityReply(now: Date): string {
  const entries = defaultActivity.list({
    limit: 8,
    sinceMs: ACTIVITY_WINDOW_MS,
    now: now.getTime(),
  });
  if (entries.length === 0) return "最近 30 分钟里，清单面板上没有新的操作。";
  const lines = entries.map(
    (entry) => `- ${formatActivityTime(entry.at)} ${describeActivity(entry)}`,
  );
  return ["最近在清单面板上的操作：", ...lines].join("\n");
}

function greeting(store: TaskStore, now: Date): string {
  const tasks = store.list();
  const open = tasks.filter((task) => !task.done).length;
  const status =
    tasks.length === 0
      ? "清单还是空的"
      : `清单里有 ${open} 项待办、${tasks.length - open} 项已完成`;
  return [
    `你好，我是小明，你的待办管家。今天是${formatChineseDate(now)}，${status}。`,
    "你可以说「记一下买牛奶」，也可以问「我有哪些任务」。",
  ].join("\n");
}

const HELP_TEXT = [
  "我可以帮你：",
  "· 记一下买牛奶 —— 新建任务，例如「提醒我明天下午交报告」",
  "· 我有哪些任务 —— 查看清单和完成状态",
  "· 牛奶买好了 —— 标记完成",
  "· 取快递删掉 —— 删除任务",
  "· 今天有哪些任务到期 —— 查看今天到期的任务",
  "· 把买牛奶改成买酸奶 —— 修改标题",
  "另外还支持高/低优先级、小/中/大工作量和子任务。",
].join("\n");

const UNKNOWN_TEXT = [
  "我还没太听懂这句话。你可以这样说：",
  "· 记一下买牛奶",
  "· 我有哪些任务",
  "· 牛奶买好了",
  "· 取快递删掉",
  "· 今天有哪些任务到期",
].join("\n");

const SUBTASK_UNCLEAR_TEXT = [
  "我这句没完全听懂，怕误操作到整条任务，先不动清单。",
  "子任务目前支持添加、完成、删除，可以这样说：",
  "· 给「写方案」加一个子任务：收集数据",
  "· 「写方案」的子任务「收集数据」完成了",
  "· 把「写方案」的子任务「收集数据」删掉",
].join("\n");
