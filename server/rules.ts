import type { ChatMessage } from "../shared/chat.ts";
import {
  ACTIVITY_WINDOW_MS,
  defaultActivity,
  describeActivity,
  formatActivityTime,
} from "./activity.ts";
import { execute, type Command, type CommandResult, type NewTaskInput } from "./commands.ts";
import {
  addDays,
  findClockTime,
  findDateText,
  findRelativeMoment,
  formatChineseDate,
  startOfDay,
  toClockString,
  toDateString,
  toNumber,
} from "./dates.ts";
import { chatReply, createBatchChat } from "./replies.ts";
import type { TaskScope } from "./selection.ts";
import { findEffortHours, parseDurationAnswer } from "./effort.ts";
import type { Repeat } from "./recurrence.ts";
import { formatReminderPlan } from "./reminders.ts";
import {
  normalizeTags,
  taskEffortHours,
  type Priority,
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
  | { kind: "list"; scope: TaskScope }
  | {
      kind: "create";
      title: string;
      startDate?: string;
      startTime?: string;
      priority?: Priority;
      effort?: number;
      tags?: string[];
      repeat?: Repeat;
      remind?: boolean;
      reminderAt?: string[];
    }
  | { kind: "reminder"; hint: string; enabled: boolean }
  | { kind: "reminderToggle" }
  | { kind: "action"; action: Action; hint: string }
  | { kind: "rename"; hint: string; title: string }
  | { kind: "update"; hint: string; startDate?: string; priority?: Priority; effort?: number }
  | { kind: "duration"; hours: number }
  | { kind: "subtask"; hint: string; action: "add" | "complete" | "remove"; subtask: string }
  | { kind: "subtaskUnclear" }
  | { kind: "clearDone" }
  | { kind: "activity" }
  | { kind: "undo" }
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

/** 旧说法「工作量小/中/大」折算成小时，继续兼容。 */
const LEGACY_EFFORT_HOURS: Record<string, number> = { 小: 1, 中: 3, 大: 6 };
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
    /^(?:你|我)?\s*(?:刚才|刚刚)?\s*(?:在)?(?:清单|面板)?(?:上)?\s*(?:删(?:除|掉)?|改|修改|动|操作|做|干)了?(?:什么|哪些|啥)/.test(
      value,
    )
  ) {
    return { kind: "activity" };
  }

  if (CLEAR_DONE_WORDS.test(value)) return { kind: "clearDone" };

  // 「撤销刚才的删除」「撤回」：恢复最近删掉的任务，不是重新打开。
  if (
    /^(?:撤销|撤回)(?:刚才|刚刚)?(?:的)?(?:删除|删掉)?[。！!]?$/.test(value) ||
    /^恢复(?:刚才|刚刚)(?:删除|删掉)(?:的|了)?[。！!]?$/.test(value) ||
    /^undo$/i.test(value)
  ) {
    return { kind: "undo" };
  }

  // 「大概 2 小时」：在回答上一条任务大概要花多久。
  const duration = parseDurationAnswer(value);
  if (duration !== undefined) return { kind: "duration", hours: duration };

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
    /^(?:把|将)?\s*(.+?)\s*(?:的)?\s*(?:开始(?:日期|时间)?|截止(?:日期|时间)?|到期日|due)\s*(?:改到|改成|设为|设置成|推迟到|提前到|是)\s*(.+)$/i.exec(
      value,
    );
  if (dueUpdate) {
    const hint = extractHint(dueUpdate[1], []);
    const dueDate = findDateText(dueUpdate[2], now)?.value;
    if (hint && dueDate) return { kind: "update", hint, startDate: dueDate };
  }

  // 「把开会的工作量改成 2 小时」「给开会记 2 小时」：改预计用时。
  const effortUpdate =
    /^(?:把|将|给|帮|为)?\s*(.+?)\s*(?:的)?\s*(?:工作量|预计用时|预计耗时|耗时|用时)\s*(?:改成|改为|设为|设置为|记为|记成|记|是|为)?\s*(.+)$/i.exec(
      value,
    );
  if (effortUpdate) {
    const hint = extractHint(effortUpdate[1], []);
    const found = findEffortHours(effortUpdate[2]);
    if (hint && found) return { kind: "update", hint, effort: found.hours };
  }

  const effortAssign = /^(?:给|帮|为)\s*(.+?)\s*(?:记|记一下|记录|记成|设成|设为)\s*(.+)$/.exec(
    value,
  );
  if (effortAssign) {
    const hint = extractHint(effortAssign[1], []);
    const found = findEffortHours(effortAssign[2]);
    if (hint && found) return { kind: "update", hint, effort: found.hours };
  }

  // 「给开会设个提醒」「关闭开会的提醒」：针对某条任务开关提醒。
  const reminderSet =
    /^(?:给|帮|为)?\s*(.+?)\s*(?:设|设置|开|打开|加)(?:一个|个)?\s*(?:提醒|闹钟)$/.exec(value);
  if (reminderSet) {
    const hint = extractHint(reminderSet[1]!, []);
    if (hint) return { kind: "reminder", hint, enabled: true };
  }
  const reminderOff =
    /^(?:取消|关闭|关掉|撤销|不用)\s*(?:给)?\s*(.+?)\s*(?:的)?\s*(?:提醒|闹钟)$/.exec(value) ??
    /^(?:把|将)?\s*(.+?)\s*的?\s*(?:提醒|闹钟)\s*(?:取消|关掉|关闭|去掉|不用了?)$/.exec(value);
  if (reminderOff) {
    const hint = extractHint(reminderOff[1]!, []);
    if (hint) return { kind: "reminder", hint, enabled: false };
  }
  if (/^(?:帮我)?(?:开启|打开|关闭|关掉)(?:浏览器)?提醒$/.test(value)) {
    return { kind: "reminderToggle" };
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
      return { kind: "update", hint, startDate: parsedDate.value };
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

  // 没写「记一下」但带了具体时刻或开始时间，通常是随口交代一件要做的事，
  // 例如「今晚5点去拿快递」「从明天开始整理资料」。确认不是查询后再当成新建任务。
  if (findClockTime(value) || findStartAt(value, now) || findRelativeMoment(value, now))
    return createIntent(value, now);

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
  const tagged = extractTags(text);
  let value = tagged.text;
  const tags = tagged.tags;

  // 相对时间要在剥离「一个」「提醒我」之前解析，否则「一个半小时后」会被
  // 前缀规则吃掉「一个」，只剩「半小时后」。
  const relative = findRelativeMoment(value, now);
  if (relative) value = value.replace(relative.matched, " ");

  value = stripCreatePrefixes(value);

  // 重复周期：每天 / 每周一 / 每月 15 号。只削掉「每」，留下「周一」「15 号」
  // 之类的写法给日期解析器处理。
  let repeat: Repeat | undefined;
  let monthlyDay: number | undefined;
  if (/每天|每日/.test(value)) {
    repeat = "daily";
    value = value.replace(/每天|每日/g, " ");
  } else if (/每(?:周|星期|礼拜)[一二三四五六日天]/.test(value)) {
    repeat = "weekly";
    value = value.replace(/每(?=(?:周|星期|礼拜)[一二三四五六日天])/, "");
  } else if (/每(?:周|星期|礼拜)/.test(value)) {
    repeat = "weekly";
    value = value.replace(/每(?:周|星期|礼拜)/g, " ");
  } else if (/每月/.test(value)) {
    repeat = "monthly";
    const matched = /每月\s*(\d{1,2})\s*[号日]/.exec(value);
    if (matched) monthlyDay = Number(matched[1]);
    value = value.replace(/每月\s*(?:\d{1,2}\s*[号日])?/g, " ");
  }
  // 提醒习惯：
  // - 「提醒我 5 点开会」里的时间记到开始时间，而不是截止时间；
  // - 「提前 10 分钟提醒我」是自定义提醒时刻，按开始（或截止）往前算。
  const reminderLead =
    /^\s*(?:请|麻烦)?\s*(?:到时|记得|别忘了?)?\s*提醒我/.test(text) ||
    /^\s*(?:\d+|[一二三四五六七八九十两]+|半)\s*(?:分钟|分|小时|钟头|天|周)\s*(?:后|以后)\s*提醒我/.test(
      text,
    );
  const reminderBefore = parseReminderBefore(value);
  if (reminderBefore) value = value.replace(reminderBefore.matched, " ");

  // 开始时间：「从明天开始」「明天下午三点开始」「9 点开始」。
  // 必须放在截止日期之前解析，否则「明天」会被当成截止日期。
  const start = findStartAt(value, now);
  let startDate = start?.startDate;
  let startTime = start?.startTime;
  if (start) value = value.replace(start.matched, " ");

  let momentDate: string | undefined;
  let momentTime: string | undefined;

  // 「三分钟后」「半小时后」这类相对时间直接按当前时刻往后算，不用反问用户。
  if (relative) {
    momentDate = relative.dueDate;
    momentTime = relative.dueTime;
  }

  // 先找具体时刻（下午三点 / 今晚5点 / 17:30），再找日期。
  // 时刻里的“今晚/明晚”本身带天数信息，后面没有日期时用它兜底。
  const clock = momentDate ? undefined : findClockTime(value);
  if (clock) {
    momentTime = clock.value;
    value = value.replace(clock.matched, " ");
  }

  const parsed = momentDate ? undefined : findDateText(value, now);
  if (parsed) {
    momentDate = parsed.value;
    value = value.replace(parsed.matched, " ");
    value = value.replace(/^\s*[在于]\s*(?=为|给|和|跟|与|把|做|去|来)/, " ");
  } else if (clock) {
    // 只说“今晚5点”就按今天；只说“5点”则在时刻已过时顺延到明天。
    const offset = clock.day === "tomorrow" ? 1 : clock.day === "today" ? 0 : undefined;
    if (offset !== undefined) {
      momentDate = toDateString(addDays(startOfDay(now), offset));
    } else {
      const [hour, minute] = clock.value.split(":").map(Number);
      const today = startOfDay(now);
      const candidate = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        hour ?? 0,
        minute ?? 0,
      );
      momentDate = toDateString(candidate.getTime() <= now.getTime() ? addDays(today, 1) : today);
    }
  }

  // 「每月 15 号」没有完整日期，按今天之后最近的 15 号算。
  if (monthlyDay !== undefined && !momentDate) {
    const today = startOfDay(now);
    const year = today.getFullYear();
    const month = today.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    let candidate = new Date(year, month, Math.min(monthlyDay, days));
    if (candidate.getTime() < today.getTime()) {
      const nextDays = new Date(year, month + 2, 0).getDate();
      candidate = new Date(year, month + 1, Math.min(monthlyDay, nextDays));
    }
    momentDate = toDateString(candidate);
  }

  if (reminderLead) {
    if (!startDate) {
      startDate = momentDate;
      startTime = momentTime;
    }
  } else if (reminderBefore && /会前|开始前/.test(reminderBefore.matched)) {
    // 「会前 20 分钟提醒」说明这个时刻是开会时间，也就是任务的开始时间。
    startDate = startDate ?? momentDate;
    startTime = startTime ?? momentTime;
  } else if (momentDate && !startDate) {
    startDate = momentDate;
    startTime = momentTime;
  }

  let remind: boolean | undefined;
  let reminderAt: string[] | undefined;
  if (reminderBefore) {
    // 清单只有一个时间轴（开始时间），「提前 / 会前 / 截止前」都以它为准。
    const date = startDate ?? momentDate;
    const time = startTime ?? momentTime ?? "09:00";
    if (date) {
      reminderAt = [shiftMoment(date, time, -reminderBefore.minutes)];
      remind = true;
    }
  }

  let priority: Priority | undefined;
  if (/(高优先级|很重要|重要|紧急|特急|加急|优先)/.test(value)) priority = "high";
  else if (/(低优先级|不急|不着急|随时)/.test(value)) priority = "low";
  value = value.replace(/高优先级|很重要|重要|紧急|特急|加急|优先|低优先级|不急|不着急|随时/g, " ");

  let effort: number | undefined;
  const legacyEffort = /(?:工作量|耗时|难度)\s*[:：]?\s*(小|中|大)(?![时半分])/.exec(value);
  if (legacyEffort) {
    effort = LEGACY_EFFORT_HOURS[legacyEffort[1]!];
    value = value.replace(legacyEffort[0], " ");
  } else {
    const effortMatch = findEffortHours(value);
    if (effortMatch) {
      effort = effortMatch.hours;
      value = value.replace(effortMatch.matched, " ");
      // “预计开 2 小时”“大概花半小时”里的动词不属于标题，顺手清掉残留。
      value = value.replace(/(?:预计|大概|大约|估计|耗时|用时|需要)\s*(?:开|花|用|要)?\s*/g, " ");
      value = value.replace(
        /[，,、\s]*(?:预计|大概|大约|估计|耗时|用时|需要|花|要)\s*(?=[，,、\s。]|$)/g,
        " ",
      );
    }
  }

  value = stripCreatePrefixes(value);
  value = value.replace(/^\s*我\s+/, " ");
  value = value.replace(/[，,、]\s*(?=[，,、]|$)/g, " ");
  value = value.replace(/\s+/g, " ");
  value = cleanTitle(value);
  if (!value) return { kind: "empty" };

  return {
    kind: "create",
    title: value.slice(0, 200),
    startDate,
    startTime,
    priority,
    effort,
    tags: tags.length > 0 ? tags : undefined,
    repeat,
    remind,
    reminderAt,
  };
}

/** 「提前 10 分钟提醒我」：算出相对开始（或截止）提前多久提醒。 */
function parseReminderBefore(
  text: string,
): { minutes: number; anchor: "start" | "due"; matched: string } | undefined {
  const match =
    /(提前|会前|开始前|截止前|到期前)\s*(\d{1,3}|[一二三四五六七八九十两]+|半)\s*(分钟|分|小时|钟头|天)\s*(?:提醒我?|给我?提醒|提醒)?/.exec(
      text,
    );
  if (!match) return undefined;
  const amount = match[2] === "半" ? 0.5 : toNumber(match[2]);
  if (!amount) return undefined;
  const unit = match[3]!;
  const minutes =
    unit === "天" ? amount * 1440 : unit === "小时" || unit === "钟头" ? amount * 60 : amount;
  if (minutes <= 0 || minutes > 30 * 1440) return undefined;
  return {
    minutes,
    anchor: /截止|到期/.test(match[1]!) ? "due" : "start",
    matched: match[0],
  };
}

/** 把日期 + 时刻往前/往后挪几分钟，返回 YYYY-MM-DDTHH:mm。 */
function shiftMoment(date: string, time: string, minutes: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const shifted = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  shifted.setMinutes(shifted.getMinutes() + minutes);
  return `${toDateString(shifted)}T${toClockString(shifted)}`;
}

const START_PATTERN = new RegExp(
  "(?:从|自)?\\s*(今天|明天|后天|大后天|(?:下下|下)?周[一二三四五六日天])?\\s*" +
    "(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\\s*" +
    "(\\d{1,2}|[一二三四五六七八九十两]+)?\\s*(?:点|时|[:：])?\\s*(半|\\d{1,2})?\\s*(?:开始|起)",
);

/** 从「从明天下午三点开始写报告」里取开始日期/时刻，并返回要剥离的原文。 */
function findStartAt(
  text: string,
  now: Date,
): { startDate?: string; startTime?: string; matched: string } | undefined {
  const match = START_PATTERN.exec(text);
  if (!match) return undefined;
  const [, dateToken, period, hour, minute] = match;
  if (!dateToken && !period && !hour) return undefined;

  let startDate = dateToken ? findDateText(dateToken, now)?.value : undefined;
  let startTime: string | undefined;

  if (hour) {
    const clockText = `${period ?? ""}${hour}点${minute ?? ""}`;
    const clock = findClockTime(clockText);
    startTime = clock?.value;
    if (startTime && !startDate) {
      const today = startOfDay(now);
      if (clock?.day === "tomorrow") startDate = toDateString(addDays(today, 1));
      else if (clock?.day === "today") startDate = toDateString(today);
      else {
        const [hourNumber, minuteNumber] = startTime.split(":").map(Number);
        const candidate = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
          hourNumber ?? 0,
          minuteNumber ?? 0,
        );
        startDate = toDateString(candidate.getTime() <= now.getTime() ? addDays(today, 1) : today);
      }
    }
  }

  return { startDate, startTime, matched: match[0] };
}

/** 从「记一下买牛奶 #生活 #采购」「标签：生活、采购」里取出标签并从标题剥离。 */
function extractTags(text: string): { text: string; tags: string[] } {
  let value = text;
  const tags: string[] = [];
  value = value.replace(/#([^\s#，,。；;、]+)/g, (_match, tag: string) => {
    tags.push(tag);
    return " ";
  });
  const labeled = /(?:标签|tag)[：:]\s*([^，,。；;]+)/i.exec(value);
  if (labeled) {
    for (const part of labeled[1]!.split(/[、，,\s]+/)) tags.push(part);
    value = value.replace(labeled[0], " ");
  }
  return { text: value, tags: normalizeTags(tags) };
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
    // 「提醒我明天开会，提前 10 分钟提醒我」里的后半句是提醒设置，不是新任务。
    if (/^(提前|会前|开始前|截止前|到期前|提醒时间)/.test(rest)) return undefined;
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
      startDate: parsed.startDate,
      startTime: parsed.startTime,
      priority: parsed.priority,
      effort: parsed.effort,
      tags: parsed.tags,
      repeat: parsed.repeat,
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

  const answered = reminderFollowUp(store, messages);
  if (answered) return answered;

  const scheduled = scheduleFollowUp(store, messages, now);
  if (scheduled) return scheduled;

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
              startDate: intent.startDate,
              startTime: intent.startTime,
              priority: intent.priority,
              effort: intent.effort,
              tags: intent.tags,
              repeat: intent.repeat,
              remind: intent.remind,
              reminderAt: intent.reminderAt,
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
      if (intent.startDate) patch.startDate = intent.startDate;
      if (intent.priority) patch.priority = intent.priority;
      if (intent.effort !== undefined) patch.effort = intent.effort;
      return chatReply(execute(store, { kind: "update", hint: intent.hint, patch }, now), now);
    }
    case "duration": {
      // 回答“大概 2 小时”时只认上一条回复里明确提到的那条任务，不靠“只有一条待办”来猜。
      const previous =
        [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
      const mentioned = store.list().filter((task) => !task.done && previous.includes(task.title));
      const title = mentioned.length === 1 ? mentioned[0]!.title : undefined;
      if (!title) return "要给哪条任务记预计用时？可以说「给开会记 2 小时」。";
      return chatReply(
        execute(store, { kind: "update", hint: title, patch: { effort: intent.hours } }, now),
        now,
      );
    }
    case "reminder": {
      const result = execute(
        store,
        { kind: "update", hint: intent.hint, patch: { remind: intent.enabled } },
        now,
      );
      if (result.status !== "ok" || !result.task) return chatReply(result, now);
      const task = result.task;
      if (intent.enabled && !task.startDate && !task.dueDate) {
        store.update(task.id, { remind: false });
        return `「${task.title}」还没有开始或截止时间；先说个时间，我就能帮你设提醒。`;
      }
      if (intent.enabled) {
        return `好，已给「${task.title}」打开提醒：${formatReminderPlan(task)}。`;
      }
      return `好，已关闭「${task.title}」的提醒。`;
    }
    case "reminderToggle":
      return "浏览器提醒在清单右上角的「开启提醒」按钮里开关；要提醒某条任务，可以说「给开会设提醒」。";
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
    case "undo":
      return chatReply(execute(store, { kind: "undo" }, now), now);
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

/** 上一条回复问过「要不要设提醒」时，处理用户回的「要 / 不用」。 */
/** 上一条回复问「什么时候要做」时，把「今天 / 明天下午三点 / 暂不设置」这类简短回答补成开始时间。 */
function scheduleFollowUp(
  store: TaskStore,
  messages: ChatMessage[],
  now: Date,
): string | undefined {
  const previous =
    [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  if (!/什么时候要做|什么时候完成|还没(?:有)?安排时间/.test(previous)) return undefined;

  const text = messages.at(-1)?.content.trim() ?? "";
  if (!text) return undefined;

  if (/^(?:暂不设置|先不设置|不设置|不用设置|不用了|跳过|算了)[吧了啊呀!！。]?$/.test(text)) {
    const title = contextTask(store, messages);
    const task = title
      ? store.list().find((item) => item.title === title && !item.done)
      : undefined;
    const base = "好，先不安排时间。以后想补可以说「拿快递 明天下午 3 点」。";
    return task && taskEffortHours(task) === undefined
      ? `${base}\n「${task.title}」大概要花多久？回「大概 2 小时」，我就帮你记进工作量。`
      : base;
  }

  // 「今天有哪些任务到期？」是在提问，不能当成时间回答。
  if (LIST_WORDS.test(text) || CREATE_WORDS.test(text) || QUERY_WORDS.test(text)) return undefined;

  const title = contextTask(store, messages);
  if (!title) return undefined;

  const date = findDateText(text, now);
  const clock = findClockTime(text);
  if (!date && !clock) return undefined;

  const patch: TaskPatch = {};
  if (date) patch.startDate = date.value;
  if (clock) {
    patch.startTime = clock.value;
    if (!date) {
      const tomorrow = toDateString(addDays(startOfDay(now), 1));
      if (clock.day === "tomorrow") patch.startDate = tomorrow;
      else if (clock.day === "today") patch.startDate = toDateString(now);
      else patch.startDate = clock.value > toClockString(now) ? toDateString(now) : tomorrow;
    }
  }

  const result = execute(store, { kind: "update", hint: title, patch }, now);
  const reply = chatReply(result, now);
  const task = result.task;
  if (!task) return reply;
  if (task.remind !== true && task.startDate) {
    return `${reply}\n要不要给「${task.title}」设个提醒？默认开始前 30 分钟，回「要」或「不用」。`;
  }
  if (taskEffortHours(task) === undefined) {
    return `${reply}\n「${task.title}」大概要花多久？回「大概 2 小时」，我就帮你记进工作量。`;
  }
  return reply;
}

function reminderFollowUp(store: TaskStore, messages: ChatMessage[]): string | undefined {
  const previous =
    [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  if (!previous.includes("设个提醒")) return undefined;
  const title = /已记下「(.+?)」/.exec(previous)?.[1];
  if (!title) return undefined;
  const task = store.list().find((item) => item.title === title && !item.done);
  if (!task) return undefined;

  const text = messages.at(-1)?.content.trim() ?? "";
  if (/^(?:要|需要|好|好的|行|可以|设|设置|开|开启|打开)[吧了啊呀!！。]?$/.test(text)) {
    if (!task.startDate && !task.dueDate) {
      return `「${task.title}」还没有开始或截止时间；先说个时间，我就能帮你设提醒。`;
    }
    const updated = store.update(task.id, { remind: true }) ?? task;
    const opened = `好，已给「${task.title}」打开提醒：${formatReminderPlan(updated)}。`;
    return taskEffortHours(updated) === undefined
      ? `${opened}\n「${task.title}」大概要花多久？回「大概 2 小时」，我就帮你记进工作量。`
      : opened;
  }
  if (/^(?:不用|不要|不需要|不用了|算了|免了|不了)[吧了啊呀!！。]?$/.test(text)) {
    const skipped = "好，这项不设提醒。";
    return taskEffortHours(task) === undefined
      ? `${skipped}\n「${task.title}」大概要花多久？回「大概 2 小时」，我就帮你记进工作量。`
      : skipped;
  }
  return undefined;
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
  "· 记一下买牛奶 —— 新建任务，例如「记一下明天下午交报告」",
  "· 提醒我明天下午三点开会 —— 时间记为开始时间，之后再问你要不要设提醒",
  "· 我有哪些任务 —— 查看清单和完成状态",
  "· 牛奶买好了 —— 标记完成",
  "· 取快递删掉 —— 删除任务",
  "· 今天有哪些任务到期 —— 查看今天到期的任务",
  "· 把买牛奶改成买酸奶 —— 修改标题",
  "· 提醒我每周一开会 —— 重复任务（每天/每周/每月）",
  "· 记一下买牛奶 #生活 —— 给任务加标签",
  "· 撤销 —— 恢复刚刚删掉的任务",
  "· 给开会设提醒 / 取消开会的提醒 —— 打开或关闭单个任务的提醒",
  "另外还支持高/低优先级、预计用时（小时）和子任务。",
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
