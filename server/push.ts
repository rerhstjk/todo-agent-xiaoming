import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateVAPIDKeys, sendNotification, setVapidDetails } from "web-push";
import { z } from "zod";
import { taskReminderMoments, type ReminderKind } from "./reminders.ts";
import type { Task, TaskStore } from "./task-store.ts";

/** 提前 1 分钟就把提醒发出去，落后 10 分钟内补发；与前端轮询窗口保持一致。 */
export const PUSH_LOOKAHEAD_MS = 60 * 1000;
export const PUSH_GRACE_MS = 10 * 60 * 1000;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const keysSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
}

const recordSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  createdAt: z.string().min(1),
});

const recordListSchema = z.array(recordSchema);

function readJson(filename: string): unknown {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(filename: string, value: unknown): void {
  mkdirSync(dirname(filename), { recursive: true });
  const temp = `${filename}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, filename);
}

/** 优先用环境变量里的 VAPID 密钥，否则在数据目录自动生成一次。 */
export function loadOrCreateVapidKeys(filename: string): VapidKeys {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (publicKey && privateKey) return { publicKey, privateKey };
  if (existsSync(filename)) {
    const parsed = keysSchema.safeParse(readJson(filename));
    if (parsed.success) return parsed.data;
  }
  const keys = generateVAPIDKeys();
  writeJson(filename, keys);
  return keys;
}

/** 订阅落盘，进程重启后仍能推。 */
export class PushSubscriptionStore {
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  list(): PushSubscriptionRecord[] {
    const parsed = recordListSchema.safeParse(readJson(this.filename));
    return parsed.success ? parsed.data : [];
  }

  save(record: PushSubscriptionRecord): void {
    const rest = this.list().filter((item) => item.endpoint !== record.endpoint);
    writeJson(this.filename, [...rest, record]);
  }

  remove(endpoint: string): boolean {
    const all = this.list();
    const rest = all.filter((item) => item.endpoint !== endpoint);
    if (rest.length === all.length) return false;
    writeJson(this.filename, rest);
    return true;
  }

  clear(): void {
    writeJson(this.filename, []);
  }
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export type PushSender = (
  subscription: PushSubscriptionRecord,
  payload: PushPayload,
) => Promise<void>;

const webPushSender: PushSender = async (subscription, payload) => {
  await sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    },
    JSON.stringify(payload),
    { TTL: 300, urgency: "high", timeout: 8000 },
  );
};

export interface PushServiceOptions {
  subscriptions: PushSubscriptionStore;
  keys: VapidKeys;
  sender?: PushSender;
  subject?: string;
}

/** 订阅与推送的门面；测试里注入 sender 就不需要真实网络。 */
export class PushService {
  private readonly subscriptions: PushSubscriptionStore;
  private readonly sender: PushSender;
  readonly publicKey: string;

  constructor({ subscriptions, keys, sender = webPushSender, subject }: PushServiceOptions) {
    this.subscriptions = subscriptions;
    this.sender = sender;
    this.publicKey = keys.publicKey;
    setVapidDetails(
      subject ?? process.env.VAPID_SUBJECT ?? "mailto:xiaoming@example.com",
      keys.publicKey,
      keys.privateKey,
    );
  }

  subscribe(subscription: Pick<PushSubscriptionRecord, "endpoint" | "keys">): PushSubscriptionRecord {
    const record: PushSubscriptionRecord = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      createdAt: new Date().toISOString(),
    };
    this.subscriptions.save(record);
    return record;
  }

  unsubscribe(endpoint: string): boolean {
    return this.subscriptions.remove(endpoint);
  }

  count(): number {
    return this.subscriptions.list().length;
  }

  async send(payload: PushPayload): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const subscription of this.subscriptions.list()) {
      try {
        await this.sender(subscription, payload);
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode = (error as { statusCode?: number }).statusCode;
        // 订阅过期或被浏览器收回后，直接从存储里清掉。
        if (statusCode === 404 || statusCode === 410) this.subscriptions.remove(subscription.endpoint);
      }
    }
    return { sent, failed };
  }
}

export interface DuePushReminder {
  task: Task;
  kind: ReminderKind;
  at: number;
  label: string;
  key: string;
}

/** 纯函数：当前应该推送哪些提醒，方便单测。 */
export function duePushReminders(
  tasks: Task[],
  now: Date,
  alreadySent: (key: string) => boolean,
): DuePushReminder[] {
  const due: DuePushReminder[] = [];
  for (const task of tasks) {
    if (task.done) continue;
    for (const moment of taskReminderMoments(task)) {
      if (Number.isNaN(moment.at)) continue;
      const remaining = moment.at - now.getTime();
      if (remaining > PUSH_LOOKAHEAD_MS || remaining < -PUSH_GRACE_MS) continue;
      const key = `${task.id}:${moment.kind}:${moment.at}`;
      if (alreadySent(key)) continue;
      due.push({ task, kind: moment.kind, at: moment.at, label: moment.label, key });
    }
  }
  return due;
}

export interface PushSchedulerOptions {
  tasks: TaskStore;
  push: PushService;
  sentFile: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** Web Push 不可用时（没有订阅、或推送服务连不上）用本机通知兜底。 */
  notify?: (notification: { title: string; body: string }) => Promise<boolean>;
}

/** 定时扫描清单，把到点的提醒推给浏览器；服务端关掉就停了。 */
export class PushScheduler {
  private readonly sent = new Map<string, number>();
  private readonly tasks: TaskStore;
  private readonly push: PushService;
  private readonly sentFile: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly notify?: (notification: { title: string; body: string }) => Promise<boolean>;

  constructor({ tasks, push, sentFile, now = () => new Date(), log, notify }: PushSchedulerOptions) {
    this.tasks = tasks;
    this.push = push;
    this.sentFile = sentFile;
    this.now = now;
    this.notify = notify;
    this.log = log ?? ((message) => console.log(`[xiaoming] ${message}`));
    this.loadSent();
  }

  private loadSent(): void {
    const parsed = z.array(z.tuple([z.string(), z.number()])).safeParse(readJson(this.sentFile));
    if (!parsed.success) return;
    for (const [key, at] of parsed.data) this.sent.set(key, at);
  }

  private saveSent(): void {
    const cutoff = this.now().getTime() - 24 * 60 * 60 * 1000;
    for (const [key, at] of this.sent) if (at < cutoff) this.sent.delete(key);
    writeJson(this.sentFile, [...this.sent.entries()]);
  }

  async tick(now = this.now()): Promise<number> {
    const due = duePushReminders(this.tasks.list(), now, (key) => this.sent.has(key));
    if (due.length === 0) return 0;

    const hasSubscriptions = this.push.count() > 0;
    let delivered = 0;
    for (const reminder of due) {
      // 先记已发送，避免同一分钟内重复提醒。
      this.sent.set(reminder.key, now.getTime());
      const { task } = reminder;
      const title = reminder.kind === "custom" ? "任务提醒" : "任务快开始了";
      const body = `${task.title} · ${reminder.label}`;

      let sent = 0;
      if (hasSubscriptions) {
        const result = await this.push.send({ title, body, tag: reminder.key, url: "/" });
        sent = result.sent;
        if (result.failed > 0) this.log(`推送失败 ${result.failed} 条（${task.title}）`);
      }

      // 浏览器推送服务不可达（例如内网访问不了 FCM）时，退回到本机系统通知。
      if (sent === 0 && this.notify) {
        const ok = await this.notify({ title, body });
        if (!ok) this.log(`提醒发送失败，也没有可用的本机通知（${task.title}）`);
      }
      delivered += sent;
    }
    this.saveSent();
    return delivered;
  }

  start(intervalMs = 30_000): () => void {
    void this.tick();
    const timer = setInterval(() => void this.tick(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
