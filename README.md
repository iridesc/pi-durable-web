# pi-durable-web

Pi Durable 核心概念的**原始呈现页面**：用一个 Node 进程打开一个 [Pi Durable](https://earendil.com/posts/pi-durable/) Harness（单份 SQLite 存储），通过 HTTP + SSE 把 durable 的四个核心概念直接可视化到浏览器：

| 概念 | 页面呈现 | durable 对应 |
|---|---|---|
| **conversation（会话）** | 会话树 + 转录面板 | 每个 conversation 的 entries |
| **task（任务）** | 任务图面板 | `harness.taskGraph()` 的 live 任务树 |
| **ownership（归属树）** | 会话树/任务图的缩进层级 | conversation 的 `owner` 边、task 的 `owner` 边 |
| **checkpoint（可恢复状态）** | 落盘 `data/session.sqlite` + live 状态机 | SQLite 持久化 + 任务状态机 |

参考 [pi-pocket](https://github.com/TannerMidd/pi-pocket) 的**服务端架构**（单进程打开 harness + committed-state 投影 + SSE），但前端是**零构建零框架**（原生 HTML/CSS/JS），只做"原始呈现"，不做产品化功能。

## 快速开始

要求 Node ≥ 24（原生跑 ESM，无构建步骤）。

```bash
npm install
npm start          # http://localhost:8787
```

- 无 `OPENAI_API_KEY`：用 **faux 脚本化模型**，离线可跑，启动即自动演示一段「root 派 delegate → 子会话调 echo → 返回」的对话
- 有 `OPENAI_API_KEY`：用真实 openai 模型，页面可直接对话

## 页面三面板

```
┌──────────────┬─────────────────────┬───────────────────────┐
│ 会话树        │ 转录                │ 任务图                 │
│ #1 · top-level│ pi.user / pi.system │ demo.checkout waiting  │
│  └ #13 owned │ pi.assistant 🛠call │  ├ demo.payment running│
│ #39 · top-…  │ pi.tool-result      │  ├ demo.payment running│
│              │                     │  └ demo.payment running│
└──────────────┴─────────────────────┴───────────────────────┘
```

- **会话树**：`owner` 边决定层级（顶层会话 vs 子会话），点选切换转录视图
- **转录**：conversation 的 entries 流（user / assistant / tool-call / tool-result），SSE 实时刷新
- **任务图**：`▶ 运行演示任务` 按钮触发一个 `checkout → payment×3` 慢任务，实时观察 live 任务树（task 状态机：`waiting on …` / `running`）；任务 terminal 后从图里消失（`taskGraph` 只含 live 任务）

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量快照（会话列表 + 转录 + 任务图） |
| GET | `/api/events` | SSE，300ms 快照变化推送 |
| POST | `/api/submit` | `{ conversationId, content }` 向会话 submit |
| POST | `/api/conversations` | 新建顶层会话（ownerless conversation） |
| POST | `/api/demo-task` | 触发 checkout/payment 慢任务演示 |

## 目录结构

```
src/server.mjs   # 打开 Harness + HTTP/SSE + 快照投影（参考 pi-pocket 的 app.ts/projection.ts）
web/index.html   # 三面板单页
web/app.js       # 渲染逻辑（原生 JS）
web/style.css
```

## 已知边界

- `taskGraph()` 只含 **live** 任务（pending/running/waiting/completing），terminal 任务消失 —— 这是 durable 的原生语义，本页如实呈现
- 单进程独占 storage：同一时刻只能有一个进程打开 `data/session.sqlite`
- Pi Durable 是 experimental，API 可能 breaking change（依赖已 pin 1.1.0）
