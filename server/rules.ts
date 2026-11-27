import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../shared/chat.ts";
import { findDateText, formatChineseDate, relativeDayLabel, stripClockTime } from "./dates.ts";
import {
  EFFORT_LABELS,
  buildTaskListReply,
  formatTaskList,
  pendingSummary,
  type TaskListScope,
} from "./format.ts";
import { normalizeForMatch, resolveTask } from "./matching.ts";
import {
  taskSubtasks,
  type Effort,
  type Priority,
  type Task,
  type TaskPatch,
  type TaskStore,
} from "./task-store.ts";

/**
 * 没配置 DEEPSEEK_API_KEY 时使用的规则引擎。它覆盖了题目验收对话里出现的说法，
 * 以及常见的“记一下 / 我有哪些任务 / 牛奶买好了 / 取快递删掉 / 今天到期”等表达，
 * 让项目在没有密钥的情况下也能完整演示，同时也作为模型调用失败时的兜底。
 */

type Action = "complete" | "reopen" | "delete";

type Intent =
  | { kind: "list"; scope: TaskListScope }
  | { kind: "create"; title: string; dueDate?: string; priority?: Priority; effort?: Effort }
  | { kind: "action"; action: Action; hint: string }
  | { kind: "rename"; hint: string; title: string }
  | { kind: "update"; hint: string; dueDate?: string; priority?: Priority }
  | { kind: "subtask"; hint: string; action: "add" | "complete" | "remove"; subtask: string }
  | { kind: "subtaskUnclear" }
  | { kind: "clearDone" }
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

function listScope(text: string): TaskListScope {
  if (/(逾期|过期|超期)/.test(text)) return "overdue";
  if (/(今天|今日)/.test(text) && /(到期|截止|该做|要做|交)/.test(text)) return "today";
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
  value = value.replace(/^(请|麻烦你|麻烦|帮我|帮忙|给我|把|将|我|已经|都|再|顺便)+/, " ");
  value = value.replace(/[的地得了吧啊呀哦呢啦]/g, " ");
  return cleanTitle(value.replace(/\s+/g, " "));
}

export function ruleReply(store: TaskStore, messages: ChatMessage[], now = new Date()): string {
  const choice = followUpChoice(messages);
  if (choice) return runAction(store, choice.action, choice.title, now);

  const text = messages.at(-1)?.content ?? "";
  const intent = parseIntent(text, now);

  switch (intent.kind) {
    case "create":
      return createTask(store, intent, now);
    case "list":
      return listTasks(store, intent.scope, now);
    case "action":
      return runAction(store, intent.action, intent.hint, now);
    case "rename":
      return renameTask(store, intent.hint, intent.title, now);
    case "update":
      return updateTask(store, intent.hint, intent, now);
    case "subtask":
      return updateSubtask(store, intent.hint, intent.action, intent.subtask, now);
    case "subtaskUnclear":
      return SUBTASK_UNCLEAR_TEXT;
    case "clearDone":
      return clearDone(store);
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

function createTask(
  store: TaskStore,
  intent: Extract<Intent, { kind: "create" }>,
  now: Date,
): string {
  const duplicate = store
    .list()
    .find(
      (task) => !task.done && normalizeForMatch(task.title) === normalizeForMatch(intent.title),
    );

  const task = store.create({
    title: intent.title,
    dueDate: intent.dueDate,
    priority: intent.priority,
    effort: intent.effort,
  });

  const details: string[] = [];
  if (intent.dueDate) details.push(`截止 ${relativeDayLabel(intent.dueDate, now)}`);
  if (intent.priority === "high") details.push("高优先级");
  if (intent.priority === "low") details.push("低优先级");
  if (intent.effort) details.push(`工作量${EFFORT_LABELS[intent.effort]}`);
  const suffix = details.length > 0 ? `（${details.join(" · ")}）` : "";

  const all = store.list();
  const open = all.filter((item) => !item.done);
  const pending =
    open.length === 1 && open[0]?.id === task.id ? "清单里现在有 1 项待办。" : pendingSummary(all);
  const lines = [`已记下「${task.title}」${suffix}。`, pending];
  if (duplicate) {
    lines.push(
      `清单里本来就有一条同名的未完成任务「${duplicate.title}」，需要的话可以删掉其中一条。`,
    );
  }
  return lines.join("\n");
}

function runAction(store: TaskStore, action: Action, hint: string, now: Date): string {
  const tasks = store.list();
  const resolution = resolveTask(tasks, hint);

  if (resolution.kind === "missing") return missingTask(tasks, hint, action, now);
  if (resolution.kind === "ambiguous") return askWhichTask(resolution.candidates, action);

  const { task } = resolution;
  if (action === "complete") {
    if (task.done) return `「${task.title}」之前就已经完成了。\n${pendingSummary(tasks)}`;
    store.update(task.id, { done: true });
    return `已把「${task.title}」标记为已完成。\n${pendingSummary(store.list())}`;
  }

  if (action === "reopen") {
    if (!task.done) return `「${task.title}」本来就没有完成，不用重新打开。`;
    store.update(task.id, { done: false });
    return `已把「${task.title}」重新标记为待办。\n${pendingSummary(store.list())}`;
  }

  store.remove(task.id);
  return `已删除「${task.title}」。\n${pendingSummary(store.list())}`;
}

function renameTask(store: TaskStore, hint: string, title: string, now: Date): string {
  const resolution = resolveTask(store.list(), hint);
  if (resolution.kind === "missing") return missingTask(store.list(), hint, "complete", now);
  if (resolution.kind === "ambiguous") return askWhichTask(resolution.candidates, "complete");

  const { task } = resolution;
  const updated = store.update(task.id, { title });
  return updated
    ? `已把「${task.title}」改成「${updated.title}」。\n${pendingSummary(store.list())}`
    : `「${task.title}」已经不在清单里了。`;
}

function updateTask(
  store: TaskStore,
  hint: string,
  intent: Extract<Intent, { kind: "update" }>,
  now: Date,
): string {
  const resolution = resolveTask(store.list(), hint);
  if (resolution.kind === "missing") return missingTask(store.list(), hint, "complete", now);
  if (resolution.kind === "ambiguous") return askWhichTask(resolution.candidates, "complete");

  const { task } = resolution;
  const changes: TaskPatch = {};
  if (intent.dueDate) changes.dueDate = intent.dueDate;
  if (intent.priority) changes.priority = intent.priority;

  const updated = store.update(task.id, changes);
  if (!updated) return `「${task.title}」已经不在清单里了。`;

  if (intent.dueDate) {
    return `已把「${task.title}」的截止日期改成${relativeDayLabel(intent.dueDate, now)}（${intent.dueDate}）。`;
  }
  return `已把「${task.title}」设为${intent.priority === "high" ? "高优先级" : intent.priority === "low" ? "低优先级" : "中优先级"}。`;
}

function updateSubtask(
  store: TaskStore,
  hint: string,
  action: "add" | "complete" | "remove",
  subtaskTitle: string,
  now: Date,
): string {
  const resolution = resolveTask(store.list(), hint);
  if (resolution.kind === "missing") {
    if (!hint) return "要操作哪一条任务的子任务？把任务名说得更完整一些就行。";
    return missingTask(store.list(), hint, "complete", now);
  }
  if (resolution.kind === "ambiguous") {
    // 子任务操作不能像整条任务那样用序号追问，避免用户回「1」时误删整条任务。
    const options = resolution.candidates.map(
      (task, index) => `${index + 1}. ${task.done ? "✓" : "○"} ${task.title}`,
    );
    return [
      `有 ${resolution.candidates.length} 条任务都可能是指你说的那条，子任务操作要作用在哪一条上？`,
      ...options,
      "请把任务名说得更完整一些。",
    ].join("\n");
  }

  const { task } = resolution;
  const subtasks = taskSubtasks(task);
  const normalized = normalizeForMatch(subtaskTitle);
  const existing = subtasks.find((item) => normalizeForMatch(item.title) === normalized);

  if (action === "add") {
    if (existing) return `「${task.title}」下已经有子任务「${existing.title}」了。`;
    const next = [...subtasks, { id: randomUUID(), title: subtaskTitle, done: false }];
    store.update(task.id, { subtasks: next });
    return `已给「${task.title}」添加子任务「${subtaskTitle}」（进度 ${next.filter((item) => item.done).length}/${next.length}）。\n${pendingSummary(store.list())}`;
  }

  if (!existing) {
    const listed =
      subtasks.length > 0 ? `现有的子任务：${subtasks.map((item) => item.title).join("、")}。` : "";
    return `「${task.title}」下没有找到子任务「${subtaskTitle}」。${listed}`;
  }

  if (action === "remove") {
    const next = subtasks.filter((item) => item.id !== existing.id);
    store.update(task.id, { subtasks: next });
    if (next.length === 0) {
      return `已删除子任务「${existing.title}」，「${task.title}」下已经没有子任务了。\n${pendingSummary(store.list())}`;
    }
    return `已删除子任务「${existing.title}」（「${task.title}」进度 ${next.filter((item) => item.done).length}/${next.length}）。\n${pendingSummary(store.list())}`;
  }

  if (existing.done) return `子任务「${existing.title}」之前就完成了。`;

  const next = subtasks.map((item) => (item.id === existing.id ? { ...item, done: true } : item));
  store.update(task.id, { subtasks: next });
  return `已完成子任务「${existing.title}」（「${task.title}」进度 ${next.filter((item) => item.done).length}/${next.length}）。\n${pendingSummary(store.list())}`;
}

function clearDone(store: TaskStore): string {
  const done = store.list().filter((task) => task.done);
  if (done.length === 0) return "清单里没有已完成的任务，不用清理。";

  for (const task of done) store.remove(task.id);
  return `已清理 ${done.length} 项已完成的任务。\n${pendingSummary(store.list())}`;
}

function listTasks(store: TaskStore, scope: TaskListScope, now: Date): string {
  return buildTaskListReply(store.list(), scope, now);
}

function missingTask(tasks: Task[], hint: string, action: Action, now: Date): string {
  const verb = action === "delete" ? "删除" : action === "reopen" ? "重新打开" : "完成";
  if (!hint) return `要${verb}哪一条任务？告诉我任务名就行。`;

  const head = `没找到和「${hint}」对应的任务。`;
  if (tasks.length === 0) return `${head}清单还是空的，先说「记一下买牛奶」添加一条吧。`;

  const open = tasks.filter((task) => !task.done);
  const visible = open.length > 0 ? open : tasks;
  const heading = open.length > 0 ? "当前待办：" : "当前清单：";
  return [head, formatTaskList(visible, { heading, now })].join("\n");
}

/** 追问时给出带序号的候选，用户回「1」「第二条」都能继续。 */
function askWhichTask(candidates: Task[], action: Action): string {
  const verb = action === "delete" ? "要删除" : action === "reopen" ? "要重新打开" : "要完成";
  const options = candidates.map(
    (task, index) => `${index + 1}. ${task.done ? "✓" : "○"} ${task.title}`,
  );
  return [
    `有 ${candidates.length} 条任务都可能是指你说的那条，${verb}哪一条？`,
    ...options,
    "回复序号或更完整的标题都可以。",
  ].join("\n");
}

/** 用户只回了一个序号时，从上一条追问里取出候选标题。 */
function followUpChoice(messages: ChatMessage[]): { action: Action; title: string } | undefined {
  const text = messages.at(-1)?.content.trim() ?? "";
  const match = /^(?:第)?\s*([1-9]|[一二三四五六七八九十])\s*(?:条|个|项|条任务)?$/.exec(text);
  if (!match) return undefined;

  const previous = messages.at(-2);
  if (!previous || previous.role !== "assistant") return undefined;

  const actionMatch = /要(完成|重新打开|删除)哪一条/.exec(previous.content);
  if (!actionMatch) return undefined;
  const action: Action =
    actionMatch[1] === "完成" ? "complete" : actionMatch[1] === "删除" ? "delete" : "reopen";

  const options: string[] = [];
  for (const line of previous.content.split("\n")) {
    const option = /^\d+\.\s*[○✓]?\s*(.+?)\s*$/.exec(line);
    if (option) options.push(option[1]);
  }

  const index = /[1-9]/.test(match[1]) ? Number(match[1]) : (ORDINALS[match[1]] ?? 0);
  const title = options[index - 1];
  return title ? { action, title } : undefined;
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
