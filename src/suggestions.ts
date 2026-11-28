export interface Suggestion {
  /** 胶囊上显示的几个字。 */
  label: string;
  /** 实际发给小明的整句话。 */
  text: string;
}

/**
 * 输入框上方的预设提示词。都写成能独立成立的句子，
 * 不依赖清单里已经有哪些任务。
 */
export const suggestions: Suggestion[] = [
  { label: "看看清单", text: "我有哪些任务？" },
  { label: "今天到期", text: "今天有哪些任务到期？" },
  { label: "本周安排", text: "这周还有什么要做的？" },
  { label: "记一件事", text: "记一下我明天下午三点开会，会前20分钟提醒我，预计开2个小时" },
  { label: "加子任务", text: "提醒我下周一准备汇报，子任务：整理数据" },
  { label: "定时任务", text: "提醒我每天下午 6 点写日报" },
];

/** 欢迎页用前几条即可，避免一屏塞太满。 */
