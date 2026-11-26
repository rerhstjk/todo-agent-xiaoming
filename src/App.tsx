import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import { requestReply, fetchTasks, setTaskDone, deleteTask, type ApiTask } from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  const refreshTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      setTasks(await fetchTasks());
      setTasksError("");
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "读取清单失败。");
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(outgoing);
    setDraft("");
    setPending(true);
    setError("");
    try {
      const answer = await requestReply(outgoing);
      setMessages([...outgoing, { role: "assistant", content: answer }]);
      // 对话可能增删了任务，回复后同步一次侧边清单。
      void refreshTasks();
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
    } finally {
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  async function toggleTask(task: ApiTask) {
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? { ...item, done: !item.done } : item)),
    );
    try {
      await setTaskDone(task.id, !task.done);
      setTasksError("");
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "更新任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  async function removeTask(task: ApiTask) {
    setTasks((current) => current.filter((item) => item.id !== task.id));
    try {
      await deleteTask(task.id);
      setTasksError("");
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "删除任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" />
        <strong>TokeNow</strong>
        <span>小明智能体</span>
      </header>
      <main>
        <section className="chat">
          <ChatHistory messages={messages} pending={pending} onSelectPrompt={send} />
          <div className="compose">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                aria-label="消息"
                ref={input}
                placeholder="输入消息…"
                rows={2}
                value={draft}
                readOnly={pending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isSendShortcut(event)) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button className="send" disabled={pending || !draft.trim()} aria-label="发送消息">
                ↑
              </button>
            </form>
            <small>Enter 发送 · Shift + Enter 换行</small>
          </div>
        </section>
        <TaskPanel
          tasks={tasks}
          loading={tasksLoading}
          error={tasksError}
          onToggle={toggleTask}
          onDelete={removeTask}
          onRefresh={refreshTasks}
        />
      </main>
    </div>
  );
}
