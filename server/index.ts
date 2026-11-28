import { join } from "node:path";
import { createReply } from "./agent.ts";
import { createApp } from "./app.ts";
import { notifyLocal } from "./notify.ts";
import { loadOrCreateVapidKeys, PushScheduler, PushService, PushSubscriptionStore } from "./push.ts";
import { defaultTaskStore } from "./task-store.ts";

const tasks = defaultTaskStore();
const subscriptions = new PushSubscriptionStore(join("data", "push-subscriptions.json"));
const keys = loadOrCreateVapidKeys(join("data", "vapid.json"));
const push = new PushService({ subscriptions, keys });
const scheduler = new PushScheduler({
  tasks,
  push,
  sentFile: join("data", "push-sent.json"),
  notify: notifyLocal,
});
scheduler.start();

const app = createApp({ reply: createReply(tasks), tasks, push });
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
