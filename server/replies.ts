import { formatEffort } from "./effort.ts";
import { defaultActivity } from "./activity.ts";
import { addDays, formatShortChineseDate, relativeDayLabel } from "./dates.ts";
import {
  PRIORITY_LABELS,
  formatTaskBlock,
  formatTaskList,
  pendingSummary,
  taskDetails,
} from "./format.ts";
import { formatReminderPlan } from "./reminders.ts";
import { overdueTasks } from "./selection.ts";
import type { Task } from "./task-store.ts";
import { toPublicTask } from "./task-view.ts";
import type { CommandResult } from "./commands.ts";

/**
 * 把 CommandResult 渲染成用户能看到的中文。
 * 规则引擎和模型工具共用同一套领域结果，但面对两种读者：
 * chat 直接说给用户听，tool 是给模型看的结果（消息 + 结构化 data）。
 */
export interface ToolReply {
  ok: boolean;
  changed: boolean;
  message: string;
  data?: unknown;
}

export function chatReply(result: CommandResult, now = new Date()): string {
  if (result.status === "missing") return missingChat(result, now);
  if (result.status === "ambiguous") return ambiguousChat(result);

  switch (result.command.kind) {
    case "create":
      return createChat(result, now);
    case "list":
      return listText(result, now);
    case "setDone":
      return doneChat(result, now);
    case "remove":
      return removeChat(result);
    case "rename":
      return renameChat(result);
    case "update":
      return updateChat(result, now);
    case "subtask":
      return subtaskChat(result);
    case "clearDone":
      return clearDoneChat(result);
    case "undo":
      return undoChat(result);
  }
}

export function toolReply(result: CommandResult, now = new Date()): ToolReply {
  if (result.status === "missing") return missingTool(result, now);
  if (result.status === "ambiguous") return ambiguousTool(result);

  switch (result.command.kind) {
    case "create":
      return { ...ok(result), ...createTool(result, now) };
    case "list":
      return {
        ok: true,
        changed: false,
        message: listText(result, now),
        data: result.tasks.map(toPublicTask),
      };
    case "setDone":
      return doneTool(result, now);
    case "remove":
      return removeTool(result);
    case "rename":
      return {
        ok: result.status === "ok",
        changed: result.changed,
        message:
          result.status === "ok"
            ? `已把「${result.previousTitle ?? result.task?.title}」改成「${result.task?.title}」。${pendingSummary(result.tasks)}`
            : "这条任务已经不在清单里了。",
        data: result.task ? toPublicTask(result.task) : undefined,
      };
    case "update":
      return updateTool(result);
    case "subtask":
      return subtaskTool(result);
    case "clearDone":
      return {
        ok: result.status === "ok",
        changed: result.changed,
        message: clearDoneChat(result),
      };
    case "undo":
      return undoTool(result);
  }
}

function ok(result: CommandResult): { ok: boolean; changed: boolean } {
  return { ok: result.status === "ok", changed: result.changed };
}

/** 有时间安排、又没打开提醒时，问一句要不要设提醒。 */
function reminderAsk(task: Task): string | undefined {
  if (task.remind === true) return undefined;
  if (!task.startDate && !task.dueDate) return undefined;
  return `要不要给「${task.title}」设个提醒？默认开始前 30 分钟，回「要」或「不用」。`;
}

function createChat(result: CommandResult, now: Date): string {
  const task = result.task;
  if (!task) return "创建任务失败，请稍后再试。";

  const lines = [
    `已记下「${task.title}」${taskDetails(task, now)}。`,
    pendingLine(result.tasks, task),
  ];
  const askReminder = reminderAsk(task);
  if (!task.startDate && !task.dueDate) {
    // 先补时间，再问提醒和用时：一次只问一件事，用户更容易回答。
    lines.push(
      `「${task.title}」还没有安排时间。什么时候要做？回「今天」「明天下午 3 点」，或者「暂不设置」。`,
    );
  } else if (task.remind === true) {
    lines.push(`提醒已经设好：${formatReminderPlan(task)}。`);
  } else if (askReminder) {
    lines.push(askReminder);
  }
  if (result.duplicate) {
    lines.push(
      `清单里本来就有一条同名的未完成任务「${result.duplicate.title}」，需要的话可以删掉其中一条。`,
    );
  }
  return lines.join("\n");
}

function createTool(result: CommandResult, now: Date): { message: string; data?: unknown } {
  const task = result.task;
  const suffix = task ? taskDetails(task, now) : "";
  const lines = [`已记下「${task?.title ?? ""}」${suffix}。${pendingSummary(result.tasks)}`];
  if (task) {
    const askReminder = reminderAsk(task);
    if (askReminder) lines.push(askReminder);
  }
  if (result.duplicate) {
    lines.push(`清单里本来就有一条同名的未完成任务「${result.duplicate.title}」。`);
  }
  return { message: lines.join(" "), data: task ? toPublicTask(task) : undefined };
}

/** 一句话拆成多个动作时的汇总回复（新增若干任务，或给刚建的任务加子任务）。 */
export function createBatchChat(results: CommandResult[], now = new Date()): string {
  const created = results.flatMap((result) =>
    result.command.kind === "create" && result.task ? [result.task] : [],
  );
  const tasks = results.at(-1)?.tasks ?? [];
  const lines: string[] = [];

  if (created.length === 1) {
    const task = created[0]!;
    lines.push(`已记下「${task.title}」${taskDetails(task, now)}。`);
  } else if (created.length > 1) {
    lines.push(
      `已记下 ${created.length} 条任务：`,
      ...created.flatMap((task) => formatTaskBlock(task, now).split("\n")),
    );
  }
  if (created.length > 0) lines.push(pendingSummary(tasks));

  const missingTime = created.filter((task) => !task.startDate && !task.dueDate);
  const needsReminder = created.filter((task) => reminderAsk(task) !== undefined);
  if (missingTime.length > 0) {
    lines.push(
      `「${missingTime[0]!.title}」还没有安排时间。什么时候要做？回「今天」「明天下午 3 点」，或者「暂不设置」。`,
    );
    if (missingTime.length > 1) {
      lines.push(`另外还有 ${missingTime.length - 1} 条任务要安排时间，我们一条一条来。`);
    }
  } else if (needsReminder.length > 0) {
    lines.push(`要不要给这些任务设提醒？可以说「给开会设提醒」，不需要就回「不用」。`);
  }

  const addedSubtasks = results.filter(
    (result) =>
      result.command.kind === "subtask" &&
      result.command.action === "add" &&
      result.status === "ok",
  );
  for (const result of addedSubtasks) {
    const parent = result.task?.title ?? "";
    const name = result.subtask?.title ?? "";
    if (parent && name) lines.push(`并给「${parent}」加了子任务「${name}」。`);
  }

  const failedSubtasks = results.filter(
    (result) =>
      result.command.kind === "subtask" &&
      result.command.action === "add" &&
      result.status !== "ok",
  );
  for (const result of failedSubtasks) {
    const name = result.command.kind === "subtask" ? result.command.subtask : "";
    if (result.status === "ambiguous") {
      lines.push(
        `子任务「${name}」没有加进去：清单里有多条「${result.hint ?? ""}」，说清楚是哪一条我再补上。`,
      );
    } else {
      lines.push(`子任务「${name}」没有加进去，稍后再说一次任务名试试。`);
    }
  }

  if (lines.length === 0) return "这次没有记下可用的任务，可以换成「记一下买牛奶」这样的说法。";
  if (results.some((result) => result.duplicate)) {
    lines.push("其中有的和清单里已有的未完成任务同名，需要的话可以删掉重复的。");
  }
  return lines.join("\n");
}

function pendingLine(tasks: Task[], created: Task): string {
  const open = tasks.filter((task) => !task.done);
  if (open.length === 1 && open[0]?.id === created.id) return "清单里现在有 1 项待办。";
  return pendingSummary(tasks);
}

function listText(result: CommandResult, now: Date): string {
  const all = result.tasks;
  if (all.length === 0) {
    return "清单还是空的。跟我说「记一下买牛奶」就能添加第一条任务。";
  }

  const scope = result.scope ?? "all";
  const selection = result.selection ?? [];
  const overdue = overdueTasks(all, now);
  const overdueNames = overdue.map((task) => `「${task.title}」`).join("、");
  const overdueNote =
    overdue.length > 0 ? `另有 ${overdue.length} 项已经逾期：${overdueNames}。` : "";

  switch (scope) {
    case "today":
      if (selection.length === 0) {
        return `今天（${formatShortChineseDate(now)}）没有到点的任务。${overdueNote}`;
      }
      return [
        formatTaskList(selection, {
          heading: `今天（${formatShortChineseDate(now)}）有 ${selection.length} 项任务开始：`,
          now,
        }),
        ...(overdue.length > 0 ? [overdueNote] : []),
      ].join("\n");

    case "tomorrow": {
      const tomorrow = addDays(now, 1);
      if (selection.length === 0) {
        return `明天（${formatShortChineseDate(tomorrow)}）没有到点的任务。${overdueNote}`;
      }
      return formatTaskList(selection, {
        heading: `明天（${formatShortChineseDate(tomorrow)}）有 ${selection.length} 项任务开始：`,
        now,
      });
    }

    case "week":
      if (selection.length === 0) {
        return "本周剩下的时间没有到点的任务，可以放松一下。";
      }
      return formatTaskList(selection, {
        heading: `本周还有 ${selection.length} 项任务要处理：`,
        now,
      });

    case "overdue":
      return overdue.length > 0
        ? formatTaskList(overdue, { heading: `有 ${overdue.length} 项任务已经逾期：`, now })
        : "没有逾期的任务，节奏保持得不错。";

    case "open":
      return selection.length > 0
        ? formatTaskList(selection, { heading: `还有 ${selection.length} 项待办：`, now })
        : "清单里没有待办了，全部完成。";

    case "done":
      return selection.length > 0
        ? formatTaskList(selection, { heading: `已完成 ${selection.length} 项：`, now })
        : "还没有已完成的任务。";

    default: {
      const lines = [formatTaskList(selection, { now })];
      if (overdue.length > 0) lines.push(`注意：其中 ${overdue.length} 项已经逾期。`);
      return lines.join("\n");
    }
  }
}

function doneChat(result: CommandResult, now: Date): string {
  const task = result.task;
  if (!task) return "没有找到这条任务。";

  if (result.status === "unchanged") {
    if (result.reason === "already-done") {
      return `「${task.title}」之前就已经完成了。\n${pendingSummary(result.tasks)}`;
    }
    return `「${task.title}」本来就没有完成，不用重新打开。`;
  }

  if (result.command.kind === "setDone" && result.command.done) {
    return `已把「${task.title}」标记为已完成。${nextRepeatLine(result, now)}\n${pendingSummary(result.tasks)}`;
  }
  return `已把「${task.title}」重新标记为待办。\n${pendingSummary(result.tasks)}`;
}

function doneTool(result: CommandResult, now: Date): ToolReply {
  const task = result.task;
  if (!task) return { ok: false, changed: false, message: "没有找到这条任务。" };

  let message: string;
  if (result.status === "unchanged") {
    message =
      result.reason === "already-done"
        ? `「${task.title}」之前就已经完成了。`
        : `「${task.title}」本来就没有完成，不用重新打开。`;
  } else if (result.command.kind === "setDone" && result.command.done) {
    message = `已把「${task.title}」标记为已完成。${nextRepeatLine(result, now)}`;
  } else {
    message = `已把「${task.title}」重新标记为待办。`;
  }

  return {
    ok: result.status === "ok",
    changed: result.changed,
    message: `${message}${pendingSummary(result.tasks)}`,
    data: toPublicTask(task),
  };
}

/** 重复任务完成后，告诉用户下一次排到了哪天。 */
function nextRepeatLine(result: CommandResult, now: Date): string {
  const due = result.nextTask?.dueDate;
  if (!due) return "";
  return `下一次已排到${relativeDayLabel(due, now)}（${due}）。`;
}

function undoChat(result: CommandResult): string {
  if (result.status === "unchanged" || !result.task) return "没有可以撤销的删除。";
  return `已恢复「${result.task.title}」。\n${pendingSummary(result.tasks)}`;
}

function undoTool(result: CommandResult): ToolReply {
  if (result.status === "unchanged" || !result.task) {
    return { ok: false, changed: false, message: "没有可以撤销的删除。" };
  }
  return {
    ok: true,
    changed: true,
    message: `已恢复「${result.task.title}」。${pendingSummary(result.tasks)}`,
    data: toPublicTask(result.task),
  };
}

function removeChat(result: CommandResult): string {
  const task = result.task;
  if (!task) return "没有找到这条任务。";
  return `已删除「${task.title}」。\n${pendingSummary(result.tasks)}`;
}

function removeTool(result: CommandResult): ToolReply {
  const task = result.task;
  if (!task) return { ok: false, changed: false, message: "没有找到这条任务。" };
  return {
    ok: true,
    changed: true,
    message: `已删除「${task.title}」。${pendingSummary(result.tasks)}`,
    data: { id: task.id, title: task.title },
  };
}

function renameChat(result: CommandResult): string {
  const task = result.task;
  if (!task) return "没有找到这条任务。";
  return `已把「${result.previousTitle ?? task.title}」改成「${task.title}」。\n${pendingSummary(result.tasks)}`;
}

function updateChat(result: CommandResult, now: Date): string {
  const task = result.task;
  if (!task) return "没有找到这条任务。";
  if (result.status === "invalid") return "这次没有需要修改的字段。";

  const patch = result.command.kind === "update" ? result.command.patch : {};
  if (patch.startDate) {
    if (patch.startTime && task.startDate) {
      return `已把「${task.title}」安排在${relativeDayLabel(task.startDate, now)} ${task.startTime}。`;
    }
    return `已把「${task.title}」的开始日期改成${relativeDayLabel(patch.startDate, now)}（${patch.startDate}）。`;
  }
  if (patch.startDate === null) return `已清除「${task.title}」的开始日期。`;
  if (patch.priority) {
    return `已把「${task.title}」设为${PRIORITY_LABELS[patch.priority]}。`;
  }
  if (patch.effort !== undefined && patch.effort !== null) {
    return `已把「${task.title}」的预计用时设为 ${formatEffort(patch.effort)}。`;
  }
  return `已更新「${task.title}」。\n${pendingSummary(result.tasks)}`;
}

function updateTool(result: CommandResult): ToolReply {
  const task = result.task;
  if (!task) return { ok: false, changed: false, message: "没有找到这条任务。" };
  if (result.status === "invalid") {
    return { ok: false, changed: false, message: "这次没有需要修改的字段。" };
  }

  const patch = result.command.kind === "update" ? result.command.patch : {};
  let message: string;
  if (patch.done !== undefined) {
    message = patch.done
      ? `已把「${task.title}」标记为已完成。`
      : `已把「${task.title}」重新标记为待办。`;
  } else {
    message = `已更新「${task.title}」。`;
  }

  return {
    ok: true,
    changed: result.changed,
    message: `${message}${pendingSummary(result.tasks)}`,
    data: toPublicTask(task),
  };
}

function subtaskChat(result: CommandResult): string {
  const task = result.task;
  if (!task) return "没有找到这条任务。";
  if (result.command.kind !== "subtask") return "这次没有需要修改的子任务。";

  const subtask = result.subtask;
  if (result.status === "unchanged") {
    switch (result.reason) {
      case "duplicate-subtask":
        return `「${task.title}」下已经有子任务「${subtask?.title ?? result.command.subtask}」了。`;
      case "subtask-missing": {
        const titles = (result.subtasks ?? []).map((item) => item.title).join("、");
        const listed = titles ? `现有的子任务：${titles}。` : "";
        return `「${task.title}」下没有找到子任务「${result.command.subtask}」。${listed}`;
      }
      default:
        return `子任务「${subtask?.title ?? result.command.subtask}」之前就完成了。`;
    }
  }

  const progress = subtaskProgress(result);
  if (result.command.action === "add") {
    return `已给「${task.title}」添加子任务「${subtask?.title ?? result.command.subtask}」（进度 ${progress}）。\n${pendingSummary(result.tasks)}`;
  }
  if (result.command.action === "complete") {
    return `已完成子任务「${subtask?.title ?? result.command.subtask}」（「${task.title}」进度 ${progress}）。\n${pendingSummary(result.tasks)}`;
  }
  if ((result.subtasks ?? []).length === 0) {
    return `已删除子任务「${subtask?.title ?? result.command.subtask}」，「${task.title}」下已经没有子任务了。\n${pendingSummary(result.tasks)}`;
  }
  return `已删除子任务「${subtask?.title ?? result.command.subtask}」（「${task.title}」进度 ${progress}）。\n${pendingSummary(result.tasks)}`;
}

function subtaskTool(result: CommandResult): ToolReply {
  const task = result.task;
  if (!task) return { ok: false, changed: false, message: "没有找到这条任务。" };
  if (result.command.kind !== "subtask") {
    return { ok: false, changed: false, message: "这次没有需要修改的子任务。" };
  }

  const subtask = result.subtask;
  const name = subtask?.title ?? result.command.subtask;

  if (result.status === "unchanged") {
    let message: string;
    switch (result.reason) {
      case "duplicate-subtask":
        message = `「${task.title}」下已经有子任务「${name}」了。`;
        break;
      case "subtask-missing":
        message = `「${task.title}」下没有子任务「${name}」。`;
        break;
      default:
        message = `子任务「${name}」之前就完成了。`;
    }
    return { ok: false, changed: false, message };
  }

  const progress = subtaskProgress(result);
  let message: string;
  if (result.command.action === "add") {
    message = `已给「${task.title}」添加子任务「${name}」。`;
  } else if (result.command.action === "complete") {
    message = `已完成子任务「${name}」（「${task.title}」进度 ${progress}）。`;
  } else {
    message = `已删除子任务「${name}」。`;
  }

  return {
    ok: true,
    changed: true,
    message: `${message}${pendingSummary(result.tasks)}`,
    data: toPublicTask(task),
  };
}

function subtaskProgress(result: CommandResult): string {
  const subtasks = result.subtasks ?? [];
  const done = subtasks.filter((item) => item.done).length;
  return `${done}/${subtasks.length}`;
}

function clearDoneChat(result: CommandResult): string {
  if (result.status === "unchanged") return "清单里没有已完成的任务，不用清理。";
  return `已清理 ${result.cleared ?? 0} 项已完成的任务。\n${pendingSummary(result.tasks)}`;
}

function missingChat(result: CommandResult, now: Date): string {
  const command = result.command;
  const hint = result.hint ?? "";
  const verb = missingVerb(result);

  if (!hint) {
    if (command.kind === "subtask") {
      return "要操作哪一条任务的子任务？把任务名说得更完整一些就行。";
    }
    return `要${verb}哪一条任务？告诉我任务名就行。`;
  }

  const deleted = defaultActivity.recentlyDeleted(hint, now.getTime());
  if (deleted) {
    return `「${deleted}」刚刚已经从清单里删掉了（清单面板操作），要重新记一条吗？`;
  }

  const head = `没找到和「${hint}」对应的任务。`;
  if (result.tasks.length === 0) {
    return `${head}清单还是空的，先说「记一下买牛奶」添加一条吧。`;
  }

  const open = result.tasks.filter((task) => !task.done);
  const visible = open.length > 0 ? open : result.tasks;
  const heading = open.length > 0 ? "当前待办：" : "当前清单：";
  return [head, formatTaskList(visible, { heading, now })].join("\n");
}

function missingTool(result: CommandResult, now: Date): ToolReply {
  const hint = result.hint ?? "";
  const head = `没找到和「${hint}」对应的任务。请向用户确认任务名称。`;
  if (result.tasks.length === 0) {
    return {
      ok: false,
      changed: false,
      message: `${head}\n清单还是空的。`,
      data: { tasks: [] },
    };
  }

  const open = result.tasks.filter((task) => !task.done);
  const visible = open.length > 0 ? open : result.tasks;
  const list = formatTaskList(visible, {
    heading: open.length > 0 ? "当前待办：" : "当前清单：",
    limit: 10,
    now,
  });
  return {
    ok: false,
    changed: false,
    message: `${head}\n${list}`,
    data: { tasks: result.tasks.map(toPublicTask) },
  };
}

function ambiguousChat(result: CommandResult): string {
  const candidates = result.candidates ?? [];
  const options = candidates.map(
    (task, index) => `${index + 1}. ${task.done ? "✓" : "○"} ${task.title}`,
  );

  if (result.command.kind === "subtask") {
    return [
      `有 ${candidates.length} 条任务都可能是指你说的那条，子任务操作要作用在哪一条上？`,
      ...options,
      "请把任务名说得更完整一些。",
    ].join("\n");
  }

  return [
    `有 ${candidates.length} 条任务都可能是指你说的那条，要${missingVerb(result)}哪一条？`,
    ...options,
    "回复序号或更完整的标题都可以。",
  ].join("\n");
}

function ambiguousTool(result: CommandResult): ToolReply {
  const candidates = result.candidates ?? [];
  return {
    ok: false,
    changed: false,
    message: `有多条任务都可能匹配，不能直接修改，请先向用户确认是哪一条：${candidates
      .map((task) => `「${task.title}」`)
      .join("、")}。`,
    data: { candidates: candidates.map(toPublicTask) },
  };
}

/** 追问用语：“要 完成 / 重新打开 / 删除 哪一条”。 */
function missingVerb(result: CommandResult): string {
  const command = result.command;
  if (command.kind === "remove") return "删除";
  if (command.kind === "setDone") return command.done ? "完成" : "重新打开";
  if (command.kind === "subtask") return "操作";
  return "处理";
}
