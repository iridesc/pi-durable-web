// pi-durable-web 可复用服务端核心：
//   1. snapshot()        —— 枚举会话 + 每个会话转录 + 任务图（committed-state 投影）
//   2. createWebServer() —— HTTP + SSE + 静态页面 + 基础 API（submit / 新建会话）
// 不含任何 demo 工具/模型逻辑，供 pi-box 的 pi-boxd 直接 import。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWebDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/** 枚举所有 conversation + 各自的转录（entries）+ 任务图（live）。 */
export async function snapshot(harness, context) {
  const { items: records } = await harness.commit((tx) => tx.scanConversations({}, 1000, undefined), context);
  const conversations = [];
  for (const rec of records) {
    const conv = await harness.conversation(rec.id, context);
    if (conv === undefined) continue;
    const view = await conv.viewState(context);
    conversations.push({
      id: String(rec.id),
      owner: rec.owner ?? null, // 子会话的父边 { conversationId, taskId }
      parent: rec.parent ?? null, // fork 来源
      entries: view.value.entries.map((e) => ({ id: String(e.id), kind: e.kind, model: e.model ?? null })),
    });
  }
  const graph = await harness.taskGraph(context);
  return { conversations, taskGraph: graph.value };
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

/**
 * @param {object} opts
 * @param {object} opts.harness              Pi Durable Harness
 * @param {object} opts.context              chord Context
 * @param {() => Promise<object>} opts.getSnapshot    完整快照（可在 snapshot() 基础上加自有字段）
 * @param {() => Promise<object>} [opts.createConversation] 新建会话；默认 ownerless、不覆盖 agent
 * @param {Record<string, {method: string, handler: (req,res)=>Promise<void>}>} [opts.extraRoutes] 额外 API
 * @param {string} [opts.webDir]             静态页面目录；默认 pi-durable-web 自带 web/
 */
export function createWebServer({ harness, context, getSnapshot, createConversation, extraRoutes = {}, webDir = defaultWebDir }) {
  const newConversation =
    createConversation ?? (() => harness.createConversation({ ownership: { kind: "ownerless" } }, context));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // 静态页面
    if (req.method === "GET" && (pathname === "/" || pathname === "/app.js" || pathname === "/style.css")) {
      try {
        const file = join(webDir, pathname === "/" ? "index.html" : pathname);
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
        return res.end(body);
      } catch {
        res.writeHead(404);
        return res.end("not found");
      }
    }

    // 快照
    if (req.method === "GET" && pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(await getSnapshot()));
    }

    // SSE：300ms 快照一次，变化才推
    if (req.method === "GET" && pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      let last = "";
      const timer = setInterval(async () => {
        try {
          const snap = await getSnapshot();
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

    // submit
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

    // 新建会话
    if (req.method === "POST" && pathname === "/api/conversations") {
      const conv = await newConversation();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: String(conv.id) }));
    }

    // 额外路由
    const extra = extraRoutes[pathname];
    if (extra !== undefined && extra.method === req.method) {
      return extra.handler(req, res);
    }

    res.writeHead(404);
    res.end("not found");
  });
}
