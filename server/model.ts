import OpenAI from "openai";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  const configured = Number(process.env.DEEPSEEK_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) && configured > 0 ? configured : 20_000;
  // 单次请求最多等 20 秒、失败自动重试 1 次；超时后 agent 会退回规则引擎。
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com", timeout, maxRetries: 1 });
}
