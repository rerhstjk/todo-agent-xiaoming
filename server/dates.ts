/**
 * 日期工具。整份清单只记录“日期”（YYYY-MM-DD），不记录具体时刻，
 * 因此这里全部按服务器本地时区的日历日计算，避免跨时区把“今天”算错。
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateString(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return undefined;
  // 防止 2 月 30 日一类的输入被 Date 自动进位。
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return undefined;
  return date;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** 两个日期相差的自然日，正数表示 a 晚于 b。 */
export function dayDiff(a: Date | string, b: Date | string): number {
  const left = typeof a === "string" ? parseDateString(a) : startOfDay(a);
  const right = typeof b === "string" ? parseDateString(b) : startOfDay(b);
  if (!left || !right) return 0;
  const utc = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(left) - utc(right)) / 86_400_000);
}

export function weekdayName(date: Date): string {
  return WEEKDAYS[date.getDay()] ?? "";
}

export function formatChineseDate(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${weekdayName(date)}）`;
}

/** 简短版：“11月26日 周四”，用于已经说了“今天”的句子。 */
export function formatShortChineseDate(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdayName(date)}`;
}

export interface ParsedDate {
  /** 归一化后的日期，YYYY-MM-DD。 */
  value: string;
  /** 原文中命中的片段，便于从标题里剔除。 */
  matched: string;
}

const WEEKDAY_OFFSET: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

/**
 * 从一段中文里找出第一个日期表达。
 * 支持：今天/明天/后天、周X、下周X、N天后、N月N日、YYYY-MM-DD。
 * 不含时间点（小明只管理到“哪一天”）。
 */
export function findDateText(text: string, now = new Date()): ParsedDate | undefined {
  const absolute = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/.exec(text);
  if (absolute) {
    const date = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]));
    if (date.getMonth() === Number(absolute[2]) - 1 && date.getDate() === Number(absolute[3])) {
      return { value: toDateString(date), matched: absolute[0] };
    }
  }

  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = now.getFullYear();
      let date = new Date(year, month - 1, day);
      if (date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
      // 说“3月5日”时如果已经过去，指的是明年。
      if (dayDiff(date, now) < 0) {
        year += 1;
        date = new Date(year, month - 1, day);
      }
      return { value: toDateString(date), matched: monthDay[0] };
    }
  }

  const relative = /(大后天|昨天|前天|后天|明天|明日|今天|今日)/.exec(text);
  if (relative) {
    const offsets: Record<string, number> = {
      大后天: 3,
      昨天: -1,
      前天: -2,
      后天: 2,
      明天: 1,
      明日: 1,
      今天: 0,
      今日: 0,
    };
    return { value: toDateString(addDays(now, offsets[relative[0]] ?? 0)), matched: relative[0] };
  }

  const weekday = /(下下|下|本|这)?\s*个?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (weekday) {
    const prefix = weekday[1] ?? "";
    const offset = WEEKDAY_OFFSET[weekday[2]] ?? 0;
    const current = now.getDay() === 0 ? 7 : now.getDay();
    let delta = offset - current;
    if (prefix === "下") delta += 7;
    else if (prefix === "下下") delta += 14;
    else if (delta < 0) delta += 7;
    return { value: toDateString(addDays(now, delta)), matched: weekday[0] };
  }

  const inDays = /(\d{1,3})\s*天\s*(?:之?后|以后|内)/.exec(text);
  if (inDays) {
    return { value: toDateString(addDays(now, Number(inDays[1]))), matched: inDays[0] };
  }

  return undefined;
}

const CLOCK =
  /^(?:上午|早上|中午|下午|傍晚|晚上|夜里|凌晨|明早|今晚)?\s*(?:\d{1,2}|[一二三四五六七八九十两]{1,3})\s*(?:点|时|[:：])\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})?\s*分?(?:半)?\s*/;

/** 去掉标题开头的“下午三点”一类的时刻描述。 */
export function stripClockTime(text: string): string {
  return text.replace(CLOCK, "").trim();
}

/** 把日期显示成“今天 / 明天 / 周五 / 3月5日”这类自然语言。 */
export function relativeDayLabel(value: string, now = new Date()): string {
  const date = parseDateString(value);
  if (!date) return value;
  const days = dayDiff(date, now);
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  if (days === 2) return "后天";
  if (days === -1) return "昨天";
  if (days === 3) return "大后天";
  const sameYear = date.getFullYear() === now.getFullYear();
  if (Math.abs(days) <= 6) {
    const label = weekdayName(date);
    // 同一周内说“周五”就够；跨周时说清楚“下周一”，避免和本周混淆。
    const weekStart = (value: Date) => addDays(startOfDay(value), -((value.getDay() + 6) % 7));
    if (days > 0 && weekStart(date).getTime() > weekStart(now).getTime()) return `下${label}`;
    if (days < 0 && weekStart(date).getTime() < weekStart(now).getTime()) return `上${label}`;
    return label;
  }
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
