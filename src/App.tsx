import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChatMessage } from "../shared/chat.ts";
import {
  requestReply,
  fetchTasks,
  setTaskDone,
  updateSubtasks,
  deleteTask,
  type ApiTask,
} from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { useSpeechInput } from "./use-speech.ts";

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
  const [panelNotice, setPanelNotice] = useState("");
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("xiaoming.panelWidth"));
    return Number.isFinite(saved) && saved >= 340 ? Math.min(720, saved) : 460;
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  // 语音输入前已经打好的文字，识别结果追加在它后面。
  const speechBase = useRef("");
  const [speechError, setSpeechError] = useState("");

  const {
    supported: speechSupported,
    listening,
    start: startSpeech,
    stop: stopSpeech,
  } = useSpeechInput(
    ({ text, final }) => {
      if (final) speechBase.current = `${speechBase.current}${text}`.trim();
      setDraft(final ? speechBase.current : `${speechBase.current}${text}`.trim());
    },
    (message) => setSpeechError(message),
  );

  // 面板操作会写入服务端的面板操作记录，小明下一轮就能看到；
  // 这里顺手给用户一个「已经同步」的反馈。
  function notifyAgent(message: string) {
    setPanelNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setPanelNotice(""), 4000);
  }

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

  useEffect(() => {
    window.localStorage.setItem("xiaoming.panelWidth", String(panelWidth));
  }, [panelWidth]);

  // 拖动分隔条调整侧边栏宽度：面板在右侧，鼠标往左拖面板变宽。
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    function move(moveEvent: PointerEvent) {
      setPanelWidth(Math.min(720, Math.max(340, startWidth - (moveEvent.clientX - startX))));
    }
    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    if (listening) stopSpeech();
    setSpeechError("");
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
      notifyAgent(`已通知小明：${task.done ? "重新打开" : "完成"}「${task.title}」`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "更新任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  async function toggleSubtask(task: ApiTask, subtaskId: string) {
    const subtasks = (task.subtasks ?? []).map((item) =>
      item.id === subtaskId ? { ...item, done: !item.done } : item,
    );
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? { ...item, subtasks } : item)),
    );
    try {
      await updateSubtasks(task.id, subtasks);
      setTasksError("");
      notifyAgent(`已通知小明：更新了「${task.title}」的子任务`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "更新子任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  async function removeTask(task: ApiTask) {
    setTasks((current) => current.filter((item) => item.id !== task.id));
    try {
      await deleteTask(task.id);
      setTasksError("");
      notifyAgent(`已通知小明：删除「${task.title}」`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "删除任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  function toggleSpeech() {
    setSpeechError("");
    if (listening) {
      stopSpeech();
      return;
    }
    speechBase.current = draft.trim() ? `${draft.trim()} ` : "";
    startSpeech();
  }

  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" />
        <strong>TokeNow</strong>
        <span>小明智能体</span>
      </header>
      <main style={{ "--panel-width": `${panelWidth}px` } as CSSProperties}>
        <section className="chat">
          <ChatHistory messages={messages} pending={pending} onSelectPrompt={send} />
          <div className="compose">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {speechError && (
              <p className="error" role="alert">
                {speechError}
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
              {speechSupported && (
                <button
                  type="button"
                  className={`mic${listening ? " listening" : ""}`}
                  aria-label={listening ? "停止语音输入" : "开始语音输入"}
                  aria-pressed={listening}
                  title={listening ? "正在听，点一下停止" : "用中文说一句，自动填进输入框"}
                  disabled={pending}
                  onClick={toggleSpeech}
                >
                  {listening ? "●" : "🎤"}
                </button>
              )}
              <button className="send" disabled={pending || !draft.trim()} aria-label="发送消息">
                ↑
              </button>
            </form>
            <small>
              Enter 发送 · Shift + Enter 换行
              {speechSupported && " · 点麦克风用中文说话"}
            </small>
          </div>
        </section>
        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整待办清单宽度"
          onPointerDown={startResize}
        />
        <TaskPanel
          tasks={tasks}
          loading={tasksLoading}
          error={tasksError}
          onToggle={toggleTask}
          onToggleSubtask={toggleSubtask}
          onDelete={removeTask}
          onRefresh={refreshTasks}
          notice={panelNotice}
        />
      </main>
    </div>
  );
}
