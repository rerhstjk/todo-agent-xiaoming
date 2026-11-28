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

/** 前端多带一个快照 id：编辑这条消息时用来回滚清单。 */
type UiMessage = ChatMessage & { snapshotId?: string };
import {
  requestReply,
  restoreSnapshot,
  fetchTasks,
  setTaskDone,
  updateSubtasks,
  updateTaskFields,
  deleteTask,
  undoDelete,
  type ApiTask,
  type TaskEditFields,
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
  const [messages, setMessages] = useState<UiMessage[]>([]);
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

  useTaskReminders(tasks, reminderOn, (reminder) => {
    // 系统通知可能被专注模式或系统设置拦掉，页面里也给一条可见的提示。
    const what = reminder.kind === "due" ? "到时间了" : "快开始了";
    notifyAgent(`提醒：「${reminder.task.title}」${what}（${reminder.label}）。`);
  });

  function enableReminders() {
    setReminderOn(true);
    window.localStorage.setItem("xiaoming.reminders", "on");
    notifyAgent("已开启浏览器提醒：设了提醒的任务会在开始前 30 分钟提醒，页面里也会同步提示。");
    try {
      new Notification("提醒已开启", {
        body: "设了提醒的任务会在开始前 30 分钟提醒你。",
      });
    } catch {
      // 页面内提示已经给出，不影响后续轮询。
    }
  }

  async function toggleReminders() {
    // 用户可能刚在浏览器站点设置里改过权限，点击时重新读一次，避免状态过期。
    const current = reminderPermission();
    if (current !== reminder) setReminder(current);

    if (current === "unsupported") {
      notifyAgent("当前浏览器不支持系统通知，可以继续用页面里的清单。");
      return;
    }

    if (reminderOn) {
      setReminderOn(false);
      window.localStorage.setItem("xiaoming.reminders", "off");
      notifyAgent("已关闭浏览器提醒，任务不会再弹系统通知。");
      return;
    }

    if (current === "denied") {
      notifyAgent("浏览器已经拒绝通知权限，可以在地址栏的站点设置里重新允许。");
      return;
    }

    if (current === "granted") {
      enableReminders();
      return;
    }

    const result = await requestReminderPermission();
    setReminder(result);
    if (result === "granted") {
      enableReminders();
    } else if (result === "denied") {
      notifyAgent("浏览器拒绝了通知权限，可以在地址栏的站点设置里重新允许。");
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

  async function runTurn(base: UiMessage[], text: string) {
    const content = text.trim();
    if (!content) return;
    if (listening) stopSpeech();
    setSpeechError("");
    const outgoing: UiMessage[] = [
      ...base,
      { role: "user", content, at: new Date().toISOString() },
    ];
    setMessages(outgoing);
    setPending(true);
    setError("");
    try {
      const { reply: answer, snapshotId } = await requestReply(
        outgoing.map(({ role, content: text, at }) => ({
          role,
          content: text,
          ...(at ? { at } : {}),
        })),
      );
      const withSnapshot = outgoing.map((message, position) =>
        position === outgoing.length - 1 ? { ...message, snapshotId } : message,
      );
      setMessages([...withSnapshot, { role: "assistant", content: answer }]);
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

  // 编辑历史里的一条用户消息：先回滚这条消息发送前的清单，再截断重发。
  async function editMessage(index: number, text: string) {
    if (pending) return;
    const lastUserIndex = messages.reduce(
      (last, message, current) => (message.role === "user" ? current : last),
      -1,
    );
    if (index !== lastUserIndex) {
      setError("只能修改最新一轮的提问，更早的记录不再支持回改。");
      return;
    }
    const target = messages[index];
    if (!target || target.role !== "user") return;
    if (!target.snapshotId) {
      notifyAgent("这条消息没有可回滚的清单快照，本次只重放对话，清单不会回滚。");
    } else {
      try {
        const result = await restoreSnapshot(target.snapshotId);
        void refreshTasks();
        notifyAgent(`已回滚清单到这条消息发送前（${result.count} 项任务）。`);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? `无法回滚清单：${cause.message}`
            : "无法回滚清单，请刷新页面后重试。",
        );
        return;
      }
    }
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

  async function editTaskFields(task: ApiTask, fields: TaskEditFields) {
    try {
      await updateTaskFields(task.id, fields);
      setTasksError("");
      notifyAgent(`已更新「${fields.title ?? task.title}」`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "保存任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  async function addSubtask(task: ApiTask, title: string) {
    const subtasks = [...(task.subtasks ?? []), { id: crypto.randomUUID(), title, done: false }];
    try {
      await updateTaskFields(task.id, { subtasks });
      setTasksError("");
      notifyAgent(`已给「${task.title}」添加子任务「${title}」`);
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "添加子任务失败。");
    } finally {
      void refreshTasks();
    }
  }

  async function reorderTasks(ids: string[]) {
    try {
      await Promise.all(ids.map((id, index) => updateTaskFields(id, { position: index })));
      setTasksError("");
      notifyAgent("已保存手动排序");
    } catch (cause) {
      setTasksError(cause instanceof Error ? cause.message : "保存排序失败。");
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
            onQuickReply={(text) => void send(text)}
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
          onEdit={editTaskFields}
          onReorder={reorderTasks}
          onAddSubtask={addSubtask}
        />
      </main>
    </div>
  );
}
