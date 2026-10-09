// pi-durable-web server：打开一个 Pi Durable Harness，用 HTTP + SSE 把核心概念
// （conversation 会话 / task 任务 / ownership 归属树 / checkpoint 落盘）原始呈现给页面。
// 模型：无 OPENAI_API_KEY 时用 faux 脚本化（离线可跑），有则用真实 openai。
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, defineTask, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const rootDir = dirname(fileURLToPath(import.meta.url)); // src/
const webDir = join(rootDir, "..", "web");
const dataDir = join(rootDir, "..", "data");
const PORT = Number(process.env.PORT ?? 8787);

// ─── 工具：delegate（子会话）+ echo（普通工具）─────────────────────────────
// delegate 创建一个 owned conversation（子会话），用于呈现 ownership 层级；
// echo 让子会话再调一次工具，呈现 tool task。
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

// ─── 慢任务演示（checkout → payment），用于展示任务图 live 树 ──────────────
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
  // 脚本化 4 轮：root 派 delegate → child 调 echo → child 回答 → root 总结
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("delegate", { task: "say hello" }, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("echo", { text: "hi" }, { id: "call-2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("hello from child")]),
    fauxAssistantMessage([fauxText("child said: hello from child")]),
  ]);
} else {
  models.setProvider(openaiProvider());
}

// ─── Harness + SQLite 落盘 ────────────────────────────────────────────────
await mkdir(dataDir, { recursive: true });
const storage = await openNodeSqliteStorage(join(dataDir, "session.sqlite"));
const registry = createRegistry();
registry.install(Subagent);
registry.install(DemoTasks);
const harness = await Harness.open(storage, { models, registry }, context);

// ─── 快照：枚举会话 + 每个会话的转录 + 任务图 ──────────────────────────────
async function snapshot() {
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  const conversations = [];
  for (const rec of records) {
    const conv = await harness.conversation(rec.id, context);
    if (conv === undefined) continue;
    const view = await conv.viewState(context);
    conversations.push({
      id: String(rec.id),
      owner: rec.owner ?? null, // { conversationId, taskId } = 子会话的父边
      parent: rec.parent ?? null, // fork 来源
      entries: view.value.entries.map((e) => ({ id: String(e.id), kind: e.kind, model: e.model ?? null })),
    });
  }
  const graph = await harness.taskGraph(context);
  return { model, conversations, taskGraph: graph.value };
}

// ─── demo：空库首次启动时触发一段脚本化对话，打开页面即有数据可看 ──────────
async function seedDemo() {
  const root = await harness.root(context, { agent: { model } });
  const view = await root.viewState(context);
  if (view.value.entries.length > 0) return;
  await root.submit({ type: "input", content: "delegate a task to a subagent" }, context);
}
await seedDemo();

// ─── HTTP + SSE ────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function serveStatic(pathname, res) {
  try {
    const file = join(webDir, pathname === "/" ? "index.html" : pathname);
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function startSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/app.js" || pathname === "/style.css")) {
    return serveStatic(pathname, res);
  }
  if (req.method === "GET" && pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(await snapshot()));
  }
  if (req.method === "GET" && pathname === "/api/events") {
    // 每 300ms 快照一次，变化才推（简单可靠，足够"原始呈现"）
    startSse(res);
    let last = "";
    const timer = setInterval(async () => {
      try {
        const snap = await snapshot();
        const json = JSON.stringify(snap);
        if (json !== last) {
          last = json;
          res.write(`data: ${json}\n\n`);
        }
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`);
      }
    }, 300);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (req.method === "POST" && pathname === "/api/submit") {
    const body = await readBody(req);
    const conv = await harness.conversation(String(body.conversationId ?? ""), context);
    if (conv === undefined) {
      res.writeHead(404);
      return res.end("conversation not found");
    }
    await conv.submit({ type: "input", content: String(body.content ?? "") }, context);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "POST" && pathname === "/api/conversations") {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id: String(conv.id) }));
  }
  if (req.method === "POST" && pathname === "/api/demo-task") {
    const root = await harness.root(context);
    await root.commit(
      (tx) => tx.createTask(Checkout, { cards: ["a", "b", "c"] }, { ownership: { kind: "conversation" } }),
      context,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pi-durable-web 已启动: http://localhost:${PORT}`);
  console.log(`模型: ${useFaux ? "faux（脚本化，离线演示）" : "openai（真实）"}`);
  console.log(`存储: ${join(dataDir, "session.sqlite")}`);
});
