# 实现说明

这份文档说明「小明」是怎么实现的、怎么运行和验证、以及做了哪些取舍。
任务要求见 [README.md](README.md)；对照表格里的验收对话已经写成自动化测试。

## 运行

```sh
npm ci
npm run dev          # 打开 http://127.0.0.1:3000
```

- 不配置密钥也能完整使用：会走规则引擎，所有任务操作、日期/优先级/子任务都可用，`npm test` 也不依赖网络。
- 想接入模型时，把 `.env.example` 复制为 `.env`，填入 `DEEPSEEK_API_KEY` 后重启。此时优先走 DeepSeek 的 tool calling；模型报错会退回规则引擎。
- 也可以强制指定模式：`XIAOMING_MODE=rules npm run dev` 或 `XIAOMING_MODE=llm npm run dev`。

## 验证

```sh
npm test             # 40 个测试：命令层、README 验收对话、扩展功能、API、模型工具循环
npm run demo         # 不开服务、不花模型费用，直接在终端跑一遍验收对话和扩展场景
npm run typecheck
npm run build
```

`server/agent.test.ts` 里第一条测试就是 README 的验收对话，逐句断言清单状态；
`server/commands.test.ts` 直接测命令层的契约（不经过中文解析，也不经过模型）；
`server/app.test.ts` 是项目原有的 API 测试，未做修改。

也可以手动验证：`npm run dev` 后打开页面，按 README 的表格逐句发送；
右侧「待办清单」面板会实时显示任务，勾选和删除按钮走同一份 `data/tasks.json`。
刷新页面或重启服务后清单仍在。

## 架构

```
src/App.tsx ──POST /api/chat──▶ server/app.ts ──▶ server/agent.ts
                                     │            ├─ 有密钥：DeepSeek tool calling ─┐
                                     │            └─ 无密钥/失败：rules.ts          │
                                     │                                            ▼
src/TaskPanel.tsx ──/api/tasks──▶ server/tasks.ts ──▶ server/task-store.ts    server/commands.ts
                                                        data/tasks.json              ▲
                                                                                     │
                              rules.ts / tools.ts ──解析成 Command──────────────┘
                                       └── 共享 replies.ts / selection.ts / format.ts
```

关键设计：**规则引擎和模型工具都只是「命令层」的两个适配器**。

- `server/commands.ts`：领域层。定义 `Command`（create / list / setDone / remove / rename /
  update / subtask / clearDone）与 `CommandResult`（ok / unchanged / missing / ambiguous /
  invalid + 完整清单快照）。任务定位、歧义判断、幂等、子任务增删、重复检测都只在这里
  实现一次，返回结果而不是直接拼文案。
- `server/rules.ts` / `server/tools.ts`：协议适配器。前者把中文解析成 `Command`，后者把
  模型 tool call 的参数解析成 `Command`；两者都调用 `execute()`，不各自操作存储。
  新增一种说法或一个工具，不会改变领域规则。
  规则引擎还会把「提醒我明天开会，并在今天为明天的会议准备材料」这类用「，并 / 然后 /
  再 / 同时」连接的多件事拆成多条任务，各自解析日期；明确说「子任务：…」时挂到刚建的任务下，
  子任务按任务 id 关联，同名任务也不会挂错。
- `server/replies.ts`：渲染层。同一份 `CommandResult` 有两种输出：`chatReply()` 给用户看，
  `toolReply()` 给模型看（消息 + 结构化 data）。文案只写一遍，两个入口不会漂移。
- `server/selection.ts`：查看范围。`all` / `open` / `done` / `today` / `tomorrow` / `week` /
  `overdue` 的筛选规则集中在此，对话、工具、前端共用同一套语义。
- `server/task-view.ts`：对外暴露的任务视图（`PublicTask`），把内部 `Task` 与 API/模型
  返回的字段分开，避免内部字段泄漏到接口。
- `server/agent.ts`：入口。保留原有的 `reply(messages)` 导出（隐藏测试可直接调用），
  新增 `createReply(store, { mode, clock })` 便于测试注入临时清单和固定时间。
  两种模式共用同一个 `TaskStore`，所以聊天和 HTTP API 读写的是同一份清单。
- `server/tools.ts`：5 个工具（`create_task` / `list_tasks` / `update_task` /
  `delete_task` / `manage_subtasks`），参数用 zod 校验，然后转成 `Command`。
- `server/matching.ts`：任务名匹配。精确 > 包含 > 二元组 Dice 相似度，
  多条同样相似时返回候选、先追问，不猜。
- `server/dates.ts`：中文相对日期（今天/明天/后天/大后天/昨天/前天/周X/下周X/N天后/
  M月D日/YYYY-MM-DD）、校验真实存在的日期、去掉「下午三点」这类时间词。
- `server/format.ts`：文本格式化。`○ 未完成` / `✓ 已完成`，带截止日期、逾期标记、
  优先级、工作量、子任务进度。
- `server/task-store.ts`：JSON 持久化。用 `z.looseObject` 读取，未知字段原样保留
  （项目原有测试要求 `priority: 1` 这种扩展字段不能在更新时丢失）；
  写文件用临时文件 + rename，避免写到一半损坏；JSON 损坏时给出可操作的错误。

## 数据模型

任务在原有 `{ id, title, done }` 之外可按需带：

| 字段       | 说明                                       |
| ---------- | ------------------------------------------ |
| `dueDate`  | `YYYY-MM-DD`                               |
| `priority` | `low` / `normal` / `high`                  |
| `effort`   | `small` / `medium` / `large`               |
| `subtasks` | `{ id, title, done }[]`                    |
| `note`     | 备注（目前未在对话里暴露，预留给后续扩展） |

HTTP API（`server/openapi.yaml`）保持原契约不变，只接受 `title` / `done`；
扩展字段由智能体直接通过 `TaskStore` 写入。这样既不影响原有测试和文档，
又让对话能管理更丰富的任务。

## 边界情况

- 任务名不明确（「牛奶好了」同时像「买牛奶」和「回家买牛奶」）：列出候选并追问，
  回复「2」继续，不会改错任务。
- 对已完成的再完成一次：提示之前就完成了，不重复写。
- 删/改不存在的任务：列出现有待办，数据不变。
- 「明天下午三点交报告」：标题是「交报告」，截止是明天，时间词不进标题。
- 非法日期（2 月 30 日、2026-13-01）：不写入，提示用户换个日期。
- 只发「1」但没有追问上下文：给出可用说法示例。
- 模型调用失败：若本轮还没改数据，退回规则引擎；若已经改过，直接汇报已执行结果，
  避免同一条指令被执行两次。
- 对话超过 20 条只取最近 20 条传给模型，控制上下文和费用。
- `tasks.json` 损坏：接口返回明确错误，不静默清空用户数据。
- 补记过去的事（「昨天交房租」）：截止日期落在昨天，会直接出现在逾期列表里。
- 一句话说两件事（「提醒我明天开会，并在今天准备材料」）：拆成两条任务，截止日期分别是
  明天和今天，不会把后半句拼进第一条的标题；「子任务：准备材料」则挂到刚建的任务下。
- 提到子任务但解析不出动作（「把子任务删掉」）：只追问，绝不落到父任务的删除。

## 已知限制 / 后续可做

- 单用户、无鉴权，任务文件是进程内同步读写；多实例部署需要换数据库和锁。
- 规则引擎覆盖常见说法，也支持用「，并 / 然后 / 再」连接的多件事；更绕的嵌套从句仍以模型模式为准。
- 子任务支持添加、完成、删除，暂不支持改名和调整顺序；面板只显示进度，逐条勾选需要对话。
- 前端面板可以勾选、删除，并按今天/本周/逾期筛选；改截止日期/优先级目前通过对话完成。
- 时间范围支持今天/明天/本周/逾期，还没有「指定某一天」「下周」这类更细的筛选。
- 模型模式只做了离线单元测试（假模型），真实 DeepSeek 调用需要在 `.env` 配置密钥后手动验证。
