export type TaskMark = "○" | "✓";

export interface ChatTaskRow {
  /** 追问候选里的序号（1、2…），普通清单没有。 */
  number?: string;
  mark: TaskMark;
  title: string;
  /** 括号里的补充信息，例如「开始 明天 15:00 · 高优先级」。 */
  details?: string;
  subtasks: { mark: TaskMark; title: string }[];
}

export interface ParsedChatTasks {
  intro: string[];
  rows: ChatTaskRow[];
  outro: string[];
}

const DETAIL_KEYS = "开始|已过时间|高优先级|中优先级|低优先级|预计|每天|每周|每月|标签|子任务|备注";
const DETAIL_PATTERN = new RegExp(`^(.*?)（((?:${DETAIL_KEYS})[^（）]*)）$`);

/**
 * 把小明的清单回复拆成结构化行，聊天里就能用卡片展示，而不是一大段纯文本。
 * 不是清单的消息返回 null。
 */
export function parseChatTasks(content: string): ParsedChatTasks | null {
  const intro: string[] = [];
  const rows: ChatTaskRow[] = [];
  const outro: string[] = [];
  let current: ChatTaskRow | null = null;

  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    const sub = line.match(/^[\u3000\s]+([○✓])\s+(.+)$/);
    if (sub && current) {
      current.subtasks.push({ mark: sub[1] as TaskMark, title: sub[2]!.trim() });
      continue;
    }

    const row = line.match(/^(?:(\d+)\.\s*)?([○✓])\s+(.+)$/);
    if (row) {
      let title = row[3]!.trim();
      let details: string | undefined;
      const matched = title.match(DETAIL_PATTERN);
      if (matched) {
        title = matched[1]!.trim();
        details = matched[2]!.trim();
      }
      current = {
        ...(row[1] ? { number: row[1] } : {}),
        mark: row[2] as TaskMark,
        title,
        ...(details ? { details } : {}),
        subtasks: [],
      };
      rows.push(current);
      continue;
    }

    if (!line.trim()) continue;
    if (rows.length === 0) intro.push(line);
    else outro.push(line);
  }

  if (rows.length === 0) return null;
  return { intro, rows, outro };
}
