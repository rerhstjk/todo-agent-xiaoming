import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import { parseChatTasks, type ChatTaskRow } from "./task-message.ts";

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
  onEditMessage: (index: number, text: string) => void;
}

export function ChatHistory({ messages, pending, onEditMessage }: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  // 只有最新一轮的提问可以改；改更早的内容会连带回滚好几轮操作，容易让人误以为任务丢了。
  const lastUserIndex = messages.reduce(
    (last, message, index) => (message.role === "user" ? index : last),
    -1,
  );
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages, pending]);

  // 新一轮对话开始后，原来的编辑位置可能已经失效。
  useEffect(() => {
    if (pending) setEditing(null);
  }, [pending]);

  function startEditing(index: number, content: string) {
    setEditing(index);
    setDraft(content);
  }

  function commit(event: FormEvent) {
    event.preventDefault();
    if (editing === null) return;
    const text = draft.trim();
    if (!text) return;
    onEditMessage(editing, text);
    setEditing(null);
  }

  return (
    <div className="scroll" ref={viewport}>
      {messages.length === 0 ? (
        <section className="welcome">
          <img src="/logo.png" alt="" />
          <h1>小明智能体</h1>
          <p>用中文说就行：记任务、报进度、问今天或本周的安排。</p>
        </section>
      ) : (
        <div className="thread" role="log" aria-label="对话记录" aria-live="polite">
          {messages.map((message, index) => (
            <div key={index} className={`message ${message.role}`}>
              <small>{message.role === "user" ? "你" : "小明智能体"}</small>
              {editing === index ? (
                <form className="message-edit" onSubmit={commit}>
                  <textarea
                    value={draft}
                    autoFocus
                    aria-label="编辑消息内容"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(null);
                      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <footer className="message-edit-actions">
                    <button type="button" onClick={() => setEditing(null)}>
                      取消
                    </button>
                    <button type="submit" className="primary" disabled={!draft.trim()}>
                      保存并重新发送
                    </button>
                  </footer>
                  <p className="message-edit-hint">
                    发送后会先回滚清单到这条消息之前，再重新生成回复。
                  </p>
                </form>
              ) : (
                <>
                  {message.role === "assistant" ? (
                    <AssistantContent content={message.content} />
                  ) : (
                    <div>{message.content}</div>
                  )}
                  {index === lastUserIndex && !pending && (
                    <button
                      type="button"
                      className="edit-message"
                      aria-label="编辑这条消息"
                      title="编辑后从这里重新发送"
                      onClick={() => startEditing(index, message.content)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path
                          d="M4 20h4.5L20 8.5a2.1 2.1 0 0 0-3-3L5.5 17 4 20Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M14.5 6.5l3 3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        />
                      </svg>
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
          {pending && <p role="status">正在回复…</p>}
        </div>
      )}
    </div>
  );
}

function AssistantContent({ content }: { content: string }) {
  const parsed = parseChatTasks(content);
  if (!parsed) return <div>{content}</div>;

  return (
    <div className="chat-tasks-block">
      {parsed.intro.map((line, index) => (
        <p key={`intro-${index}`} className="chat-tasks-intro">
          {line}
        </p>
      ))}
      <div className="chat-tasks" role="list">
        {parsed.rows.map((row, index) => (
          <ChatTaskItem key={`task-${index}`} row={row} />
        ))}
      </div>
      {parsed.outro.map((line, index) => (
        <p key={`outro-${index}`} className="chat-tasks-outro">
          {line}
        </p>
      ))}
    </div>
  );
}

function ChatTaskItem({ row }: { row: ChatTaskRow }) {
  return (
    <div className={`chat-task ${row.mark === "✓" ? "done" : "open"}`} role="listitem">
      {row.number && <span className="chat-task-number">{row.number}</span>}
      <span className="chat-task-mark" aria-label={row.mark === "✓" ? "已完成" : "待办"}>
        {row.mark}
      </span>
      <div className="chat-task-body">
        <span className="chat-task-title">{row.title}</span>
        <span className="chat-task-meta">
          {row.mark === "✓" ? "已完成" : "待办"}
          {row.details ? ` · ${row.details}` : ""}
        </span>
        {row.subtasks.map((subtask, index) => (
          <span
            key={`sub-${index}`}
            className={`chat-task-sub ${subtask.mark === "✓" ? "done" : ""}`}
          >
            <span className="chat-task-sub-mark">{subtask.mark}</span>
            {subtask.title}
          </span>
        ))}
      </div>
    </div>
  );
}
