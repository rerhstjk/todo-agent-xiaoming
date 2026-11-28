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
  undoDelete,
  type ApiTask,
} from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { suggestions } from "./suggestions.ts";
import { useSpeechInput } from "./use-speech.ts";
import {
  reminderPermission,
  requestReminderPermission,
  useTaskReminders,
  type ReminderPermission,
} from "./use-reminders.ts";

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
  const [undo, setUndo] = useState<{ count: number; label: string } | null>(null);
  const [reminder, setReminder] = useState<ReminderPermission>(() => reminderPermission());
  const [reminderOn, setReminderOn] = useState(() => {
    const saved = window.localStorage.getItem("xiaoming.reminders");
    if (saved === "on") return reminderPermission() === "granted";
    if (saved === "off") return false;
    return reminderPermission() === "granted";
  });
  const undoTimer = useRef<number | undefined>(undefined);
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("xiaoming.panelWidth"));
    return Number.isFinite(saved) && saved >= 340 ? Math.min(720, saved) : 460;
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  // 语音输入前已经打好的文字，识别结果追加在它后面。
  const speechBase = useRef("");
  const [speechError, setSpeechError] = useState("");
  // 输入框里已有内容时，点提示词先让用户选择追加还是替换。
  const [pendingSuggestion, setPendingSuggestion] = useState<string | null>(null);
  const appendChoice = useRef<HTMLButtonElement>(null);

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

  function showUndo(count: number, label: string) {
    setUndo({ count, label });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
  }

  async function undoRemoved() {
    if (!undo) return;
    try {
      const restored = await undoDelete(undo.count);
      setUndo(null);
      notifyAgent(`已通知小明：恢复了 ${restored.length} 项任务`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "撤销失败。");
    } finally {
      void refreshTasks();
    }
  }

  useTaskReminders(tasks, reminderOn);

  async function toggleReminders() {
    if (reminder === "unsupported") return;

    if (reminderOn) {
      setReminderOn(false);
      window.localStorage.setItem("xiaoming.reminders", "off");
      setPanelNotice("已关闭浏览器提醒，任务不会再弹系统通知。");
      return;
    }

    if (reminder === "denied") {
      setPanelNotice("浏览器已经拒绝通知权限，可以在地址栏的站点设置里重新允许。");
      return;
    }

    if (reminder === "granted") {
      setReminderOn(true);
      window.localStorage.setItem("xiaoming.reminders", "on");
      new Notification("提醒已开启", { body: "任务快到期时，我会在这里提醒你。" });
      return;
    }

    const result = await requestReminderPermission();
    setReminder(result);
    if (result === "granted") {
      setReminderOn(true);
      window.localStorage.setItem("xiaoming.reminders", "on");
      new Notification("提醒已开启", { body: "任务快到期时，我会在这里提醒你。" });
    } else if (result === "denied") {
      setPanelNotice("浏览器拒绝了通知权限，可以在地址栏的站点设置里重新允许。");
    }
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

  async function runTurn(base: ChatMessage[], text: string) {
    const content = text.trim();
    if (!content) return;
    if (listening) stopSpeech();
    setSpeechError("");
    const outgoing: ChatMessage[] = [...base, { role: "user", content }];
    setMessages(outgoing);
    setPending(true);
    setError("");
    try {
      const answer = await requestReply(outgoing);
      setMessages([...outgoing, { role: "assistant", content: answer }]);
      // 对话可能增删了任务，回复后同步一次侧边清单。
      void refreshTasks();
    } catch (cause) {
      setMessages(base);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
    } finally {
      setPending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  async function send(text: string) {
    if (pending) return;
    const content = text.trim();
    if (!content) return;
    setDraft("");
    await runTurn(messages, content);
  }

  // 编辑历史里的一条用户消息：截断它之后的内容，重新请求回复。
  async function editMessage(index: number, text: string) {
    if (pending) return;
    await runTurn(messages.slice(0, index), text);
  }

  async function toggleTask(task: ApiTask) {
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? { ...item, done: !item.done } : item)),
    );
    try {
      await setTaskDone(task.id, !task.done);
      setTasksError("");
      if (!task.done && task.repeat) {
        notifyAgent(`已完成「${task.title}」，下一次已自动排好。`);
      } else {
        notifyAgent(`已通知小明：${task.done ? "重新打开" : "完成"}「${task.title}」`);
      }
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
      showUndo(1, `已删除「${task.title}」`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "删除任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  async function batchDone(items: ApiTask[]) {
    const open = items.filter((task) => !task.done);
    await Promise.allSettled(open.map((task) => setTaskDone(task.id, true)));
    notifyAgent(`已通知小明：完成 ${open.length} 项任务`);
    void refreshTasks();
  }

  async function batchDelete(items: ApiTask[]) {
    await Promise.allSettled(items.map((task) => deleteTask(task.id)));
    notifyAgent(`已通知小明：删除 ${items.length} 项任务`);
    showUndo(items.length, `已删除 ${items.length} 项任务`);
    void refreshTasks();
  }

  useEffect(() => {
    if (pendingSuggestion) appendChoice.current?.focus();
  }, [pendingSuggestion]);

  // 选择期间用户把输入框清空了，就不用再问追加还是替换。
  useEffect(() => {
    if (pendingSuggestion && !draft.trim()) insertSuggestion(pendingSuggestion, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, pendingSuggestion]);

  function insertSuggestion(text: string, mode: "append" | "replace") {
    setDraft(mode === "append" ? `${draft.trimEnd()}${text}` : text);
    setPendingSuggestion(null);
    requestAnimationFrame(() => {
      const field = input.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  function chooseSuggestion(text: string) {
    if (draft.trim()) {
      setPendingSuggestion(text);
      return;
    }
    insertSuggestion(text, "replace");
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
          <ChatHistory
            messages={messages}
            pending={pending}
            onEditMessage={(index, text) => void editMessage(index, text)}
          />
          <div className="compose">
            <div className="suggestions" aria-label="预设提示词">
              {suggestions.map((item) => (
                <button
                  key={item.text}
                  type="button"
                  className="suggestion"
                  title={`${item.text}（点一下填进输入框，可以再改）`}
                  disabled={pending}
                  onClick={() => chooseSuggestion(item.text)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {pendingSuggestion && (
              <div
                className="suggestion-choice"
                role="group"
                aria-label="提示词插入方式"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setPendingSuggestion(null);
                    input.current?.focus();
                  }
                }}
              >
                <span className="suggestion-choice-text">
                  输入框里已有内容，这句是追加还是替换？
                </span>
                <button
                  type="button"
                  ref={appendChoice}
                  disabled={pending}
                  onClick={() => insertSuggestion(pendingSuggestion, "append")}
                >
                  追加到后面
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => insertSuggestion(pendingSuggestion, "replace")}
                >
                  替换原有内容
                </button>
                <button
                  type="button"
                  className="suggestion-cancel"
                  disabled={pending}
                  onClick={() => {
                    setPendingSuggestion(null);
                    input.current?.focus();
                  }}
                >
                  取消
                </button>
              </div>
            )}
            {error && (
              <div className="error-row" role="alert">
                <p className="error">{error}</p>
                <button
                  type="button"
                  className="retry"
                  disabled={pending || !draft.trim()}
                  onClick={() => void send(draft)}
                >
                  重试
                </button>
              </div>
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
                  <svg
                    className="mic-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M12 3.5a3 3 0 0 0-3 3v5.5a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3Z"
                      fill="currentColor"
                    />
                    <path
                      d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
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
          undo={undo}
          onUndo={() => void undoRemoved()}
          onBatchDone={(items) => void batchDone(items)}
          onBatchDelete={(items) => void batchDelete(items)}
          reminder={reminder}
          reminderOn={reminderOn}
          onToggleReminders={() => void toggleReminders()}
        />
      </main>
    </div>
  );
}
