import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { ConversationMemoryTurn, OrchestrationResult } from "../agents/orchestrator";
import { loadRuntimeConfig } from "../config";
import type { ApprovalMode } from "../core/approval-gate";
import { createOrchestrator, createToolRuntime } from "../runtime";

export interface WebServerOptions {
  workspaceRoot: string;
  approvalMode: ApprovalMode;
  host: string;
  port: number;
}

export interface ChatHistoryEntry {
  id: string;
  createdAt: string;
  completedAt?: string;
  userMessage: string;
  status: "running" | "completed" | "error";
  error?: string;
  result?: OrchestrationResult;
}

export async function startWebServer(options: WebServerOptions): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot: options.workspaceRoot,
    approvalMode: options.approvalMode
  });
  const toolRuntime = createToolRuntime(runtimeConfig);
  const orchestrator = createOrchestrator(runtimeConfig, toolRuntime);

  const history: ChatHistoryEntry[] = [];
  let inFlight = false;

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && (url === "/" || url === "/index.html")) {
        return sendText(res, 200, "text/html; charset=utf-8", buildHtml());
      }
      if (method === "GET" && url === "/styles.css") {
        return sendText(res, 200, "text/css; charset=utf-8", buildCss());
      }
      if (method === "GET" && url === "/app.js") {
        return sendText(res, 200, "application/javascript; charset=utf-8", buildJs());
      }
      if (method === "GET" && url === "/api/history") {
        return sendJson(res, 200, {
          running: inFlight,
          history
        });
      }
      if (method === "POST" && url === "/api/chat") {
        if (inFlight) {
          return sendJson(res, 429, {
            ok: false,
            error: "Another request is still running. Please wait."
          });
        }

        const payload = (await readJsonBody(req)) as { message?: string };
        const userMessage = typeof payload.message === "string" ? payload.message.trim() : "";
        if (!userMessage) {
          return sendJson(res, 400, {
            ok: false,
            error: "message is required."
          });
        }

        const entry: ChatHistoryEntry = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          userMessage,
          status: "running"
        };
        history.push(entry);
        trimHistory(history, 60);
        inFlight = true;

        const startedAt = Date.now();
        console.log(`[web] chat start id=${entry.id} message=${shortText(userMessage, 120)}`);

        try {
          const memoryTurns = buildMemoryTurns(history, entry.id);
          const result = await orchestrator.run({
            task: userMessage,
            memoryTurns
          });
          entry.status = "completed";
          entry.result = result;
          entry.completedAt = new Date().toISOString();

          const durationMs = Date.now() - startedAt;
          console.log(
            `[web] chat done id=${entry.id} status=completed mode=${result.mode} toolCalls=${result.toolCalls.length} durationMs=${durationMs}`
          );

          return sendJson(res, 200, { ok: true, entry });
        } catch (error) {
          entry.status = "error";
          entry.error = error instanceof Error ? error.message : String(error);
          entry.completedAt = new Date().toISOString();

          const durationMs = Date.now() - startedAt;
          console.error(`[web] chat done id=${entry.id} status=error durationMs=${durationMs} error=${entry.error}`);

          return sendJson(res, 500, { ok: false, entry });
        } finally {
          inFlight = false;
        }
      }

      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const url = `http://${options.host}:${options.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

function sendText(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.end(body);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  sendText(res, statusCode, "application/json; charset=utf-8", JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bufferChunk.length;
    if (size > 1_000_000) {
      throw new Error("Request body too large.");
    }
    chunks.push(bufferChunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawText = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!rawText) {
    return {};
  }

  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Body must be JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function trimHistory(history: ChatHistoryEntry[], maxItems: number): void {
  if (history.length <= maxItems) {
    return;
  }
  history.splice(0, history.length - maxItems);
}

function shortText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}...`;
}

function buildMemoryTurns(history: ChatHistoryEntry[], currentEntryId: string): ConversationMemoryTurn[] {
  return history
    .filter((entry) => entry.id !== currentEntryId)
    .filter((entry) => entry.status === "completed" && entry.result)
    .slice(-10)
    .map((entry) => ({
      user: entry.userMessage,
      assistant: entry.result?.coder.summary ?? ""
    }));
}

function buildHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MyCoderAgent Web</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="bg-shape"></div>
  <main class="app-shell">
    <header class="topbar">
      <h1>MyCoderAgent</h1>
      <p>Plan -> Search -> Code</p>
    </header>
    <section id="history" class="history"></section>
    <form id="composer" class="composer">
      <textarea id="message" rows="3" placeholder="输入你的需求，例如：修复某个函数并运行测试"></textarea>
      <div class="actions">
        <button id="sendBtn" type="submit">发送任务</button>
        <span id="statusText" class="status"></span>
      </div>
    </form>
  </main>
  <script src="/app.js"></script>
</body>
</html>`;
}

function buildCss(): string {
  return `:root {
  --bg-0: #f2efe8;
  --bg-1: #e4ddd0;
  --paper: #fffdf8;
  --ink: #1d2a2f;
  --muted: #59666d;
  --line: #d8d0c1;
  --accent: #0b7285;
  --accent-soft: #ddf3f7;
  --warn: #9a3412;
  --ok: #166534;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body {
  font-family: "IBM Plex Sans", "Source Han Sans SC", "PingFang SC", sans-serif;
  color: var(--ink);
  background: radial-gradient(circle at 10% 10%, var(--bg-1) 0%, var(--bg-0) 45%, #efe7da 100%);
}

.bg-shape {
  position: fixed;
  inset: -20vmax;
  background:
    radial-gradient(circle at 18% 24%, rgba(11,114,133,0.15), transparent 32%),
    radial-gradient(circle at 82% 0%, rgba(182,97,40,0.18), transparent 30%),
    radial-gradient(circle at 80% 76%, rgba(22,101,52,0.12), transparent 28%);
  z-index: -1;
}

.app-shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 18px 14px 22px;
}

.topbar {
  background: linear-gradient(100deg, #13333a, #0b7285);
  color: #f4fbfd;
  border-radius: 16px;
  padding: 14px 18px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.12);
}

.topbar h1 {
  margin: 0;
  font-size: 1.1rem;
  letter-spacing: 0.2px;
}

.topbar p {
  margin: 4px 0 0;
  opacity: 0.9;
  font-size: 0.92rem;
}

.history {
  margin-top: 14px;
  display: grid;
  gap: 12px;
}

.turn-card {
  border: 1px solid var(--line);
  background: linear-gradient(180deg, #fffdfa, var(--paper));
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 8px 24px rgba(37, 32, 22, 0.08);
}

.msg {
  padding: 10px 12px;
  border-radius: 10px;
  margin-bottom: 8px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user {
  border: 1px solid #cfd8dc;
  background: #f6fbfc;
}

.msg.assistant {
  border: 1px solid #e5ddcb;
  background: #fffbf1;
}

.meta {
  color: var(--muted);
  font-size: 0.82rem;
  margin-bottom: 8px;
}

.status-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 0.76rem;
  margin-left: 6px;
  border: 1px solid;
}

.status-badge.running { color: #0b7285; border-color: #88d1dc; background: #e8f8fb; }
.status-badge.completed { color: var(--ok); border-color: #9de0b3; background: #edfff3; }
.status-badge.error { color: var(--warn); border-color: #f3b69c; background: #fff1eb; }

details {
  border: 1px dashed #d5cbb7;
  border-radius: 10px;
  padding: 8px 10px;
  margin-top: 8px;
  background: #fffaf0;
}

summary {
  cursor: pointer;
  font-weight: 600;
}

pre {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.82rem;
  background: #f7f3ea;
  border: 1px solid #e7dcc8;
  border-radius: 8px;
  padding: 8px;
}

.composer {
  margin-top: 14px;
  background: #ffffffd9;
  border: 1px solid #d9cdb8;
  border-radius: 14px;
  padding: 12px;
  backdrop-filter: blur(4px);
}

.composer textarea {
  width: 100%;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid #c8d3d7;
  padding: 10px 11px;
  font: inherit;
  background: #f9fcfd;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  gap: 12px;
}

button {
  border: 0;
  border-radius: 10px;
  background: linear-gradient(90deg, #0b7285, #0f9db8);
  color: #fff;
  padding: 9px 16px;
  font: inherit;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.status {
  font-size: 0.84rem;
  color: var(--muted);
}

@media (max-width: 720px) {
  .app-shell { padding: 12px 10px 16px; }
  .turn-card { padding: 10px; }
  .topbar h1 { font-size: 1rem; }
}`;
}

function buildJs(): string {
  return `const state = {
  history: [],
  sending: false,
  polling: null,
  openDetails: new Set(),
  lastRenderKey: ""
};

const historyEl = document.getElementById("history");
const formEl = document.getElementById("composer");
const messageEl = document.getElementById("message");
const sendBtnEl = document.getElementById("sendBtn");
const statusEl = document.getElementById("statusText");

function updateStatus(text) {
  statusEl.textContent = text || "";
}

function setSending(sending) {
  state.sending = sending;
  sendBtnEl.disabled = sending;
}

function pretty(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function makePre(data) {
  const pre = document.createElement("pre");
  pre.textContent = pretty(data);
  return pre;
}

function createDetails(key, title, data) {
  const details = document.createElement("details");
  details.dataset.key = key;
  if (state.openDetails.has(key)) {
    details.open = true;
  }

  const summary = document.createElement("summary");
  summary.textContent = title;
  details.appendChild(summary);
  details.appendChild(makePre(data));
  return details;
}

function rememberOpenDetails() {
  state.openDetails = new Set(
    Array.from(historyEl.querySelectorAll("details[data-key]"))
      .filter((node) => node.open && node.dataset && node.dataset.key)
      .map((node) => node.dataset.key)
  );
}

function buildRenderKey(history) {
  return JSON.stringify(
    history.map((entry) => [
      entry.id,
      entry.status,
      entry.completedAt || "",
      entry.result && entry.result.mode ? entry.result.mode : "",
      entry.result && Array.isArray(entry.result.toolCalls) ? entry.result.toolCalls.length : 0
    ])
  );
}

function renderHistory() {
  const nextKey = buildRenderKey(state.history);
  if (nextKey === state.lastRenderKey) {
    return;
  }
  state.lastRenderKey = nextKey;

  rememberOpenDetails();
  historyEl.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "turn-card";
    empty.textContent = "还没有历史记录，先发送一个任务。";
    historyEl.appendChild(empty);
    return;
  }

  for (const entry of [...state.history].reverse()) {
    const card = document.createElement("article");
    card.className = "turn-card";

    const meta = document.createElement("div");
    meta.className = "meta";
    const badge = document.createElement("span");
    badge.className = "status-badge " + entry.status;
    badge.textContent = entry.status;
    const modeLabel = entry.result && entry.result.mode ? " / " + entry.result.mode : "";
    meta.textContent = new Date(entry.createdAt).toLocaleString() + modeLabel;
    meta.appendChild(badge);
    card.appendChild(meta);

    const user = document.createElement("div");
    user.className = "msg user";
    user.textContent = "User: " + entry.userMessage;
    card.appendChild(user);

    const assistant = document.createElement("div");
    assistant.className = "msg assistant";
    if (entry.status === "error") {
      assistant.textContent = "Agent Error: " + (entry.error || "unknown error");
    } else if (entry.status === "running") {
      assistant.textContent = "Agent 正在执行中...";
    } else {
      const summary = entry.result && entry.result.coder ? entry.result.coder.summary : "(no summary)";
      assistant.textContent = "Agent: " + summary;
    }
    card.appendChild(assistant);

    if (entry.result) {
      card.appendChild(createDetails(entry.id + ":plan", "Plan", entry.result.plan));
      card.appendChild(createDetails(entry.id + ":search", "Search", entry.result.search));
      card.appendChild(createDetails(entry.id + ":coder", "Coder", entry.result.coder));

      const toolCalls = Array.isArray(entry.result.toolCalls) ? entry.result.toolCalls : [];
      const toolWrapKey = entry.id + ":toolCalls";
      const toolWrap = document.createElement("details");
      toolWrap.dataset.key = toolWrapKey;
      if (state.openDetails.has(toolWrapKey)) {
        toolWrap.open = true;
      }

      const toolSummary = document.createElement("summary");
      toolSummary.textContent = "Tool Calls (" + toolCalls.length + ")";
      toolWrap.appendChild(toolSummary);

      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = toolCalls[index];
        const key = entry.id + ":tool:" + index;
        const toolDetail = document.createElement("details");
        toolDetail.dataset.key = key;
        if (state.openDetails.has(key)) {
          toolDetail.open = true;
        }

        const tSummary = document.createElement("summary");
        const okText = call.result && call.result.ok ? "ok" : "error";
        tSummary.textContent = call.toolName + " [" + okText + "]";
        toolDetail.appendChild(tSummary);

        const argsTitle = document.createElement("div");
        argsTitle.textContent = "args";
        toolDetail.appendChild(argsTitle);
        toolDetail.appendChild(makePre(call.args || {}));

        const resultTitle = document.createElement("div");
        resultTitle.style.marginTop = "8px";
        resultTitle.textContent = "result";
        toolDetail.appendChild(resultTitle);
        toolDetail.appendChild(makePre(call.result || {}));

        toolWrap.appendChild(toolDetail);
      }
      card.appendChild(toolWrap);
    }

    historyEl.appendChild(card);
  }
}

async function refreshHistory() {
  const res = await fetch("/api/history");
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data && data.error ? data.error : "Failed to load history");
  }
  state.history = Array.isArray(data.history) ? data.history : [];
  renderHistory();
  updateStatus(data.running ? "有任务正在执行..." : "");
}

async function sendMessage(message) {
  setSending(true);
  updateStatus("任务执行中...");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data && data.error ? data.error : "request failed");
    }
    state.lastRenderKey = "";
    await refreshHistory();
    updateStatus("任务已完成");
  } catch (err) {
    updateStatus("请求失败: " + (err && err.message ? err.message : String(err)));
  } finally {
    setSending(false);
    setTimeout(() => updateStatus(""), 2400);
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageEl.value.trim();
  if (!message || state.sending) return;
  messageEl.value = "";
  await sendMessage(message);
});

(async function boot() {
  await refreshHistory();
  state.polling = setInterval(() => {
    refreshHistory().catch(() => {});
  }, 2500);
})();`;
}
