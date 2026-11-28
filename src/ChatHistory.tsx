import { useEffect, useRef } from "react";
import type { ChatMessage } from "../shared/chat.ts";

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
}

export function ChatHistory({ messages, pending }: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages, pending]);

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
              <div>{message.content}</div>
            </div>
          ))}
          {pending && <p role="status">正在回复…</p>}
        </div>
      )}
    </div>
  );
}
