import { createReply } from "./agent.ts";
import { createApp } from "./app.ts";
import { defaultTaskStore } from "./task-store.ts";

const tasks = defaultTaskStore();
const app = createApp({ reply: createReply(tasks), tasks });
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
