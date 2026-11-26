import type { Task } from "./task-store.ts";

const NOISE_WORDS = [
  "这条",
  "那条",
  "这个",
  "那个",
  "这些",
  "那些",
  "这件事",
  "事情",
  "任务",
  "待办",
  "事项",
  "一下",
];

const EDGE_WORDS = ["我", "的", "了", "吧", "啊", "呀", "哦", "呢", "啦"];

/** 只保留用于比较的中文/字母片段，去掉标点、语气词和“这条任务”一类的指代。 */
export function normalizeForMatch(text: string): string {
  let value = text.toLowerCase();
  value = value.replace(/[\s，。！？、,.!?;；:："'“”‘’()（）【】《》<>~～·…—\-_/\\]+/g, "");
  value = value.replaceAll("[", "").replaceAll("]", "");
  for (const word of NOISE_WORDS) value = value.replaceAll(word, "");
  for (const word of EDGE_WORDS) value = value.replaceAll(word, "");
  return value;
}

export const MATCH_THRESHOLD = 55;

function diceCoefficient(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string) => {
    const set = new Set<string>();
    if (value.length <= 2) {
      for (const character of value) set.add(character);
      return set;
    }
    for (let index = 0; index < value.length - 1; index += 1)
      set.add(value.slice(index, index + 2));
    return set;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let shared = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared += 1;
  return (2 * shared) / (leftGrams.size + rightGrams.size);
}

function scoreTitle(title: string, hint: string): number {
  const normalized = normalizeForMatch(title);
  if (!normalized) return 0;
  if (normalized === hint) return 120;
  // 标题包含关键词：越接近关键词，得分越高。
  if (normalized.includes(hint)) return 100 - Math.min(15, normalized.length - hint.length);
  if (hint.includes(normalized)) return 92 - Math.min(15, hint.length - normalized.length);
  const similarity = diceCoefficient(normalized, hint);
  return similarity >= 0.5 ? Math.round(40 + similarity * 40) : 0;
}

export interface RankedTask {
  task: Task;
  score: number;
}

export function rankTasks(tasks: Task[], hintText: string): RankedTask[] {
  const hint = normalizeForMatch(hintText);
  if (!hint) return [];
  return tasks
    .map((task) => ({ task, score: scoreTitle(task.title, hint) }))
    .filter((ranked) => ranked.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score || Number(a.task.done) - Number(b.task.done));
}

export type Resolution =
  | { kind: "found"; task: Task; score: number }
  | { kind: "ambiguous"; candidates: Task[] }
  | { kind: "missing" };

/**
 * 把“牛奶”“买牛奶那个”这类口语提示解析成具体任务。
 * 完全同名的任务有多条时也算歧义，交给调用方追问用户。
 */
export function resolveTask(tasks: Task[], hintText: string): Resolution {
  const ranked = rankTasks(tasks, hintText);
  const best = ranked[0];
  if (!best) return { kind: "missing" };

  const second = ranked[1];
  const isAmbiguous =
    second !== undefined &&
    (best.score >= 120 ? second.score >= 120 : second.score >= best.score - 12);

  if (isAmbiguous) {
    return { kind: "ambiguous", candidates: ranked.slice(0, 3).map((ranked) => ranked.task) };
  }
  return { kind: "found", task: best.task, score: best.score };
}
