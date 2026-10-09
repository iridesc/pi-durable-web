// pi-durable-web demo 入口：定义演示工具/模型/慢任务，用 core 起 HTTP 服务。
// 模型：无 OPENAI_API_KEY 时用 faux 脚本化（离线可跑），有则用真实 openai。
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, defineTask, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { createWebServer, snapshot } from "./core.mjs";

const context = BACKGROUND_CONTEXT;
const rootDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(rootDir, "..", "data");
const PORT = Number(process.env.PORT ?? 8787);

// ─── 工具：delegate（子会话）+ echo ────────────────────────────────────────
const Subagent = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "delegate",
      description: "Delegate a task to a subagent (creates an owned conversation)",
      parameters: Type.Object({ task: Type.String() }),
      replay: "safe",
      execute: async (args, api, ctx) => {
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== undefined) return existing.id;
          return (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id;
        }, ctx);
        await api.details({ conversationId: child }, ctx);
        const handle = await api.conversation(child, ctx);
        const request = { type: "input", content: args.task, requestId: `delegate:${api.taskId}` };
        const settled = await (await handle.submit(request, ctx)).wait(ctx);
        if (settled.status !== "done") throw new Error(`subagent failed: ${settled.status}`);
        return { content: [{ type: "text", text: "delegated" }], details: { conversationId: child } };
      },
    }),
    defineTool({
      name: "echo",
      description: "Echo back text",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (args) => ({ content: [{ type: "text", text: `echo: ${args.text}` }] }),
    }),
  ],
});

// ─── 慢任务演示（checkout → payment），展示任务图 live 树 ──────────────────
const Payment = defineTask({
  name: "demo.payment",
  version: 1,
  initial: () => ({ phase: "charge", at: Date.now() + 3000 }),
  phases: {
    charge: async (task, runtime, ctx) => {
      await runtime.sleep(task.state.checkpoint.at, ctx);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: { card: task.input.card } } }),
        ctx,
      );
    },
  },
});

const Checkout = defineTask({
  name: "demo.checkout",
  version: 1,
  initial: () => ({ phase: "pay" }),
  phases: {
    pay: async (task, runtime, ctx) => {
      await runtime.commit(async (tx) => {
        const payments = [];
        for (const card of task.input.cards) {
          payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
        }
        return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "allSettled" };
      }, ctx);
    },
    decide: async (task, runtime, ctx) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.payments, ctx);
      const summary = outcomes.map((o) => o.status).join(",");
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: `payments=${summary}` } }),
        ctx,
      );
    },
  },
});
const DemoTasks = defineExtension({ name: "demo-tasks", tasks: [Payment, Checkout] });

// ─── 模型 ──────────────────────────────────────────────────────────────────
const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
const useFaux = process.env.OPENAI_API_KEY === undefined;
if (useFaux) {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  model = { provider: "faux", modelId: "faux-1" };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("delegate", { task: "say hello" }, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("echo", { text: "hi" }, { id: "call-2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("hello from child")]),
    fauxAssistantMessage([fauxText("child said: hello from child")]),
  ]);
} else {
  models.setProvider(openaiProvider());
}

// ─── Harness + SQLite ──────────────────────────────────────────────────────
await mkdir(dataDir, { recursive: true });
const storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
const registry = createRegistry();
registry.install(Subagent);
registry.install(DemoTasks);
const harness = await Harness.open(storage, { models, registry }, context);

// ─── demo：空库首次启动触发一段脚本化对话 ──────────────────────────────────
async function seedDemo() {
  const root = await harness.root(context, { agent: { model } });
  const view = await root.viewState(context);
  if (view.value.entries.length > 0) return;
  await root.submit({ type: "input", content: "delegate a task to a subagent" }, context);
}
await seedDemo();

// ─── 起服务 ────────────────────────────────────────────────────────────────
const server = createWebServer({
  harness,
  context,
  getSnapshot: async () => ({ ...(await snapshot(harness, context)), model }),
  createConversation: () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context),
  extraRoutes: {
    "/api/demo-task": {
      method: "POST",
      handler: async (_req, res) => {
        const root = await harness.root(context);
        await root.commit(
          (tx) => tx.createTask(Checkout, { cards: ["a", "b", "c"] }, { ownership: { kind: "conversation" } }),
          context,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    },
  },
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-durable-web 已启动: http://localhost:${PORT}`);
  console.log(`模型: ${useFaux ? "faux（脚本化，离线演示）" : "openai（真实）"}`);
  console.log(`存储: ${join(dataDir, "session.sqlite")}`);
});
