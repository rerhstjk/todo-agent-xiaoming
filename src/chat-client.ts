import type { ChatMessage } from "../shared/chat.ts";

export type ApiTask = {
  id: string;
  title: string;
  done: boolean;
  note?: string;
  dueDate?: string;
  dueTime?: string;
  priority?: "low" | "normal" | "high";
  effort?: "small" | "medium" | "large";
  subtasks?: { id: string; title: string; done: boolean }[];
};

export async function requestReply(messages: ChatMessage[]): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const body: unknown = await response.json();
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
