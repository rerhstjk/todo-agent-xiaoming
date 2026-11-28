import type { ChatMessage } from "../shared/chat.ts";

export type ApiTask = {
  id: string;
  title: string;
  done: boolean;
  note?: string;
  dueDate?: string;
  dueTime?: string;
  priority?: "low" | "normal" | "high";
  /** 预计用时（小时）；旧数据里可能是 small/medium/large。 */
  effort?: number | string;
  tags?: string[];
  repeat?: "daily" | "weekly" | "monthly";
  subtasks?: { id: string; title: string; done: boolean }[];
};

const REPLY_TIMEOUT_MS = 60_000;

export async function requestReply(messages: ChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REPLY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new Error("等了 60 秒还没回复（模型可能超时），输入已保留，可以点重试。");
    }
    throw new Error("网络连接中断，输入已保留，可以点重试。");
  } finally {
    window.clearTimeout(timer);
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null) {
    if (response.ok && "reply" in body && typeof body.reply === "string") return body.reply;
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      throw new Error(body.error);
    }
    throw new Error("任务清单暂时不可用。");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchTasks(): Promise<ApiTask[]> {
  return request<ApiTask[]>("/api/tasks");
}

export function setTaskDone(id: string, done: boolean): Promise<ApiTask> {
  return request<ApiTask>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
}

/** 前端勾选子任务时整组回写，返回值是服务端更新后的任务。 */
export function updateSubtasks(
  id: string,
  subtasks: NonNullable<ApiTask["subtasks"]>,
): Promise<ApiTask> {
  return request<ApiTask>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subtasks }),
  });
}

export function deleteTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 撤销删除；count 用于批量删除后一次恢复多条。 */
export function undoDelete(count = 1): Promise<ApiTask[]> {
  return request<ApiTask[]>("/api/tasks/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
}
