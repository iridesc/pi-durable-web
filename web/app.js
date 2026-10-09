// pi-durable-web 前端：连 /api/state 拿快照、/api/events 走 SSE 实时刷新，
// 把 conversation（会话树）/ task（任务图）/ ownership（缩进层级）原始渲染出来。
let state = null;
let selectedId = null;

async function refresh() {
  const res = await fetch("/api/state");
  state = await res.json();
  if (!selectedId && state.conversations.length > 0) selectedId = state.conversations[0].id;
  render();
}

function render() {
  renderStatus();
  renderConversationTree();
  renderEntries();
  renderTaskGraph();
}

function renderStatus() {
  const m = state.model;
  document.getElementById("status-bar").textContent =
    `模型 ${m.provider}/${m.modelId} · 会话 ${state.conversations.length} · live 任务 ${Object.keys(state.taskGraph.tasks).length} · 落盘 data/session.sqlite`;
}

// ─── 会话树（ownership 层级）───────────────────────────────────────────────
function renderConversationTree() {
  const nodes = new Map(state.conversations.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const n of nodes.values()) {
    const pid = n.owner ? String(n.owner.conversationId) : null;
    if (pid && nodes.has(pid)) nodes.get(pid).children.push(n);
    else roots.push(n);
  }
  const el = document.getElementById("conversation-tree");
  el.innerHTML = "";
  const renderNode = (n, depth) => {
    const div = document.createElement("div");
    div.className = "conv-node" + (n.id === selectedId ? " selected" : "");
    div.style.paddingLeft = (depth * 16 + 8) + "px";
    div.textContent = `#${n.id} · ${n.entries.length} entries`;
    const tag = document.createElement("span");
    tag.className = "conv-tag";
    tag.textContent = n.owner ? `owned (task #${n.owner.taskId})` : "top-level";
    div.appendChild(tag);
    div.onclick = () => { selectedId = n.id; render(); };
    el.appendChild(div);
    n.children.forEach((c) => renderNode(c, depth + 1));
  };
  roots.forEach((r) => renderNode(r, 0));
}

// ─── 转录（entries）────────────────────────────────────────────────────────
function messageText(msg) {
  if (!msg || !msg.content) return "";
  return msg.content
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "toolCall") return `🛠 ${c.name}(${JSON.stringify(c.arguments ?? {})})`;
      return `[${c.type}]`;
    })
    .join("\n");
}

function renderEntries() {
  const conv = state.conversations.find((c) => c.id === selectedId);
  const el = document.getElementById("entries");
  el.innerHTML = "";
  if (!conv) { el.textContent = "（无会话）"; return; }
  const title = document.createElement("div");
  title.className = "entries-title";
  title.textContent = `会话 #${conv.id} 的转录（${conv.entries.length} 条）`;
  el.appendChild(title);
  for (const e of conv.entries) {
    const div = document.createElement("div");
    div.className = "entry entry-" + e.kind.replace(/\./g, "-");
    const kind = document.createElement("div");
    kind.className = "entry-kind";
    kind.textContent = e.kind;
    div.appendChild(kind);
    for (const msg of e.model ?? []) {
      const p = document.createElement("div");
      p.className = "entry-msg entry-role-" + msg.role;
      p.textContent = messageText(msg);
      div.appendChild(p);
    }
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

// ─── 任务图（task 状态机）──────────────────────────────────────────────────
function renderTaskGraph() {
  const tasks = Object.values(state.taskGraph.tasks);
  const el = document.getElementById("task-graph");
  el.innerHTML = "";
  const renderNode = (node, depth) => {
    const div = document.createElement("div");
    div.className = "task-node";
    div.style.paddingLeft = (depth * 16 + 8) + "px";
    const st = node.state;
    const status = st.status === "waiting" ? `waiting on ${st.on.join(",")}` : st.status;
    div.innerHTML =
      `<span class="task-kind">${node.kind}</span> #${node.id} ` +
      `<span class="task-status">[${status}${node.background ? " · background" : ""}]</span>`;
    el.appendChild(div);
    for (const child of tasks.filter((t) => String(t.owner) === String(node.id))) renderNode(child, depth + 1);
  };
  for (const node of tasks.filter((t) => t.owner === undefined || t.owner === null)) renderNode(node, 0);
  if (tasks.length === 0) el.textContent = "（无 live 任务）";
}

// ─── 交互 ──────────────────────────────────────────────────────────────────
document.getElementById("submit-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("submit-input");
  const content = input.value.trim();
  if (!content || !selectedId) return;
  input.value = "";
  await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: selectedId, content }),
  });
};

document.getElementById("new-conv").onclick = async () => {
  const res = await fetch("/api/conversations", { method: "POST" });
  const { id } = await res.json();
  selectedId = String(id);
  refresh();
};

document.getElementById("demo-task").onclick = async () => {
  await fetch("/api/demo-task", { method: "POST" });
};

// ─── SSE 实时刷新 ──────────────────────────────────────────────────────────
const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  state = JSON.parse(ev.data);
  render();
};

refresh();
