/**
 * 统一时区：任务日期、时刻和提醒都按这个时区解释。
 * 默认 Asia/Shanghai（部署在 UTC 机器上也不会错一天），可用 XIAOMING_TIMEZONE 覆盖。
 */
const requested = process.env.XIAOMING_TIMEZONE?.trim() || "Asia/Shanghai";

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZone = isValidTimeZone(requested) ? requested : "Asia/Shanghai";

// 让 Date 的本地方法跟随配置时区；日期解析、格式化、逾期判断都复用它。
process.env.TZ = timeZone;
