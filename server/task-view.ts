import { taskSubtasks, type Effort, type Priority, type Subtask, type Task } from "./task-store.ts";

/** 对外（模型工具 / 前端 / API 响应）展示的任务形状。 */
export interface PublicTask {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  note?: string;
  subtasks?: Subtask[];
}

export function toPublicTask(task: Task): PublicTask {
  const result: PublicTask = { id: task.id, title: task.title, done: task.done };
  if (typeof task.dueDate === "string" && task.dueDate) result.dueDate = task.dueDate;
  if (task.priority) result.priority = task.priority;
  if (task.effort) result.effort = task.effort;
  if (task.note) result.note = task.note;
  const subtasks = taskSubtasks(task);
  if (subtasks.length > 0) result.subtasks = subtasks;
  return result;
}
