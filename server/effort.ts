/** 任务预计用时（小时）。0.25 小时起，最大 100 小时，存储时按 15 分钟取整。 */
export const MAX_EFFORT_HOURS = 100;

const DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 旧数据里用的是 small/medium/large，读出来时折算成小时，避免历史任务显示成空。 */
const LEGACY_EFFORT: Record<string, number> = {
  small: 1,
  medium: 3,
  large: 6,
  小: 1,
  中: 3,
  大: 6,
};

function chineseNumber(raw: string): number | undefined {
  if (raw === "半") return 0.5;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.includes("十")) {
    const [tens, ones] = raw.split("十");
    const left = tens === "" ? 1 : DIGITS[tens];
    const right = ones === "" ? 0 : DIGITS[ones];
    if (left === undefined || right === undefined) return undefined;
    return left * 10 + right;
  }
  if (raw.length === 1) return DIGITS[raw];
  return undefined;
}

function validHours(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  if (value > MAX_EFFORT_HOURS) return undefined;
  return Math.round(value * 4) / 4;
}

/** 把存储值（数字、旧枚举、字符串）统一成小时数。 */
export function toEffortHours(value: unknown): number | undefined {
  if (typeof value === "number") return validHours(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (text in LEGACY_EFFORT) return LEGACY_EFFORT[text];
  return validHours(chineseNumber(text));
}

/** “半小时” / “1 小时” / “2.5 小时”。 */
export function formatEffort(hours: number): string {
  if (hours === 0.25) return "15 分钟";
  if (hours === 0.5) return "半小时";
  return `${hours} 小时`;
}

export interface EffortMatch {
  hours: number;
  /** 原文里匹配到的片段，用来从标题中删掉。 */
  matched: string;
}

const AMOUNT = "(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十]+|半)";
const HALF = new RegExp(`${AMOUNT}\\s*个?\\s*半\\s*(?:小时|钟头|h|hr|hrs)`, "i");
const PLAIN = new RegExp(`${AMOUNT}\\s*个?\\s*(?:小时|钟头|h|hr|hrs)`, "i");

/** 从“大概花两个小时”“预计 1.5 小时”里取出小时数。 */
export function findEffortHours(text: string): EffortMatch | undefined {
  const half = HALF.exec(text);
  if (half) {
    const base = chineseNumber(half[1]!);
    const hours = base === undefined ? undefined : validHours(base + 0.5);
    if (hours !== undefined) return { hours, matched: half[0] };
  }
  const plain = PLAIN.exec(text);
  if (plain) {
    const hours = validHours(chineseNumber(plain[1]!));
    if (hours !== undefined) return { hours, matched: plain[0] };
  }
  return undefined;
}

const DURATION_FILLER =
  /^(?:大概|大约|预计|估计|差不多|应该|可能|需要|要|花|用|耗时|得|就|是|约|差不多要)\s*/;

/**
 * 判断是不是在回答“这项大概要花多久”，例如“大概 2 小时”“半小时”“两个半小时左右”。
 * 必须是整句都在说时长，免得把“记一下明天 2 小时会议”当成回答。
 */
export function parseDurationAnswer(text: string): number | undefined {
  let value = text.trim();
  for (let index = 0; index < 4; index += 1) value = value.replace(DURATION_FILLER, "");
  value = value.replace(/[左右上下吧啊呀。.!！?？，,\s]+$/g, "");
  const match = findEffortHours(value);
  if (!match) return undefined;
  const rest = value.replace(match.matched, "").replace(/[左右上下吧啊呀。.!！?？，,\s]/g, "");
  return rest === "" ? match.hours : undefined;
}
