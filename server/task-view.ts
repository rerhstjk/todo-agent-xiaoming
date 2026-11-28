import type { Repeat } from "./recurrence.ts";
import {
  taskRepeat,
  taskSubtasks,
  taskTags,
  type Priority,
  type Subtask,
  type Task,
} from "./task-store.ts";

/** 对外（模型工具 / 前端 / API 响应）展示的任务形状。 */
export interface PublicTask {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  dueTime?: string;
  priority?: Priority;
  /** 预计用时（小时）。 */
  effort?: number;
  note?: string;
  tags?: string[];
  repeat?: Repeat;
  subtasks?: Subtask[];
}

export function toPublicTask(task: Task): PublicTask {
  const result: PublicTask = { id: task.id, title: task.title, done: task.done };
  if (typeof task.dueDate === "string" && task.dueDate) result.dueDate = task.dueDate;
  if (typeof task.dueTime === "string" && task.dueTime) result.dueTime = task.dueTime;
  if (task.priority) result.priority = task.priority;
  if (typeof task.effort === "number") result.effort = task.effort;
  if (task.note) result.note = task.note;
  const tags = taskTags(task);
  if (tags.length > 0) result.tags = tags;
  const repeat = taskRepeat(task);
  if (repeat) result.repeat = repeat;
  const subtasks = taskSubtasks(task);
  if (subtasks.length > 0) result.subtasks = subtasks;
  return result;
}
