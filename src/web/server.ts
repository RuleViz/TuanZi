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
        return sendText(
          res,
          200,
          "application/javascript; charset=utf-8",
          buildJs()
        );
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
            `[web] chat done id=${entry.id} status=completed toolCalls=${result.toolCalls.length} durationMs=${durationMs}`
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
      assistant: entry.result?.summary ?? "",
      toolCalls: entry.result?.toolCalls
    }));
}

function buildHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>团子 · TuanZi</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="app-shell">
    <div id="history" class="history"></div>
    <form id="composer" class="composer">
      <div class="input-wrapper">
        <textarea id="message" rows="1" placeholder="和团子说点什么...Enter 发送，Shift+Enter 换行"></textarea>
        <button id="sendBtn" type="submit" class="send-btn" title="发送 (Enter)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
      <div class="actions">
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
  --ink: #cccccc;
  --muted: #888888;
  --bg: #1e1e1e;
  --hover: #2a2d2e;
  --border: #3c3c3c;
  --accent: #007acc;
  --user-bg: #252526;
  --step-border: #444444;
}

* { box-sizing: border-box; }
html, body { 
  margin: 0; padding: 0; height: 100vh; overflow: hidden;
  background: var(--bg); color: var(--ink); 
  font-family: 'Segoe UI', system-ui, sans-serif; 
  font-size: 13px; line-height: 1.6; 
}

.app-shell { 
  max-width: 900px; margin: 0 auto; padding: 20px 20px 0; 
  display: flex; flex-direction: column; height: 100vh;
}

.history { 
  flex: 1; display: flex; flex-direction: column; gap: 24px; 
  padding-bottom: 20px; overflow-y: auto; padding-right: 10px;
}

.history::-webkit-scrollbar { width: 8px; }
.history::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
.history::-webkit-scrollbar-track { background: transparent; }

.turn { display: flex; flex-direction: column; gap: 8px; }

.msg-user { 
  font-weight: 500; font-size: 14px; color: #ffffff; 
  display: flex; gap: 8px; align-items: flex-start; 
}
.msg-user::before { content: "👤"; font-size: 14px; margin-top: 1px; opacity: 0.7; }

.msg-assistant {
  margin-top: 4px;
  color: #eeeeee;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.steps { 
  display: flex; flex-direction: column; gap: 2px; 
  border-left: 1px solid var(--step-border); margin-left: 6px; padding: 2px 0 2px 14px; 
}

.step { 
  display: flex; align-items: flex-start; gap: 8px; color: var(--muted); 
  padding: 4px 6px; border-radius: 4px; line-height: 1.4;
}
.step:hover { background: var(--hover); }
.step-icon { font-size: 13px; margin-top: 1px; }

details.step-details { padding: 0; margin: 0; }
details.step-details > summary {
  list-style: none; display: flex; align-items: flex-start; gap: 8px; 
  color: var(--muted); padding: 4px 6px; border-radius: 4px; 
  cursor: pointer; user-select: none; line-height: 1.4;
}
details.step-details > summary::-webkit-details-marker { display: none; }
details.step-details > summary::before {
  content: "›"; font-size: 14px; line-height: 1.4; transition: transform 0.2s; 
  font-family: monospace; font-weight: bold; width: 12px; text-align: center;
}
details.step-details[open] > summary::before { transform: rotate(90deg); }
details.step-details > summary:hover { background: var(--hover); color: #aaaaaa; }

.step-content { 
  margin: 4px 0 8px 14px; font-size: 12px; color: #cccccc; 
  background: var(--user-bg); padding: 10px; border-radius: 4px; 
  border: 1px solid var(--border); overflow-x: auto;
}
.step-content pre { 
  margin: 0; white-space: pre-wrap; word-wrap: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; 
}

.composer {
  background: var(--bg); padding: 16px 0 24px; border-top: 1px solid var(--border);
}
.input-wrapper {
  position: relative;
  display: flex;
  align-items: flex-end;
}
.composer textarea {
  width: 100%; background: var(--user-bg); border: 1px solid var(--border); color: #fff;
  border-radius: 6px; padding: 12px 42px 12px 14px; font-family: inherit; font-size: 14px; 
  resize: none; outline: none; transition: border-color 0.2s; max-height: 200px;
  line-height: 1.5;
}
.composer textarea:focus { border-color: var(--accent); }
.send-btn {
  position: absolute; right: 8px; bottom: 8px;
  background: transparent; border: none; color: var(--muted);
  cursor: pointer; padding: 6px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.2s, background 0.2s;
}
.send-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
.send-btn:disabled { color: var(--border); cursor: not-allowed; background: transparent; }
.actions { display: flex; justify-content: flex-end; align-items: center; margin-top: 6px; }
.status { color: var(--muted); font-size: 12px; }
`;
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

function updateStatus(text) { if(statusEl) statusEl.textContent = text || ""; }

function setSending(sending) {
  state.sending = sending;
  if(messageEl) messageEl.disabled = sending;
  if(sendBtnEl) sendBtnEl.disabled = sending;
}

function rememberOpenDetails() {
  if(!historyEl) return;
  state.openDetails = new Set(
    Array.from(historyEl.querySelectorAll("details[data-key]"))
      .filter((node) => node.open && node.dataset && node.dataset.key)
      .map((node) => node.dataset.key)
  );
}

function buildRenderKey(history) {
  return JSON.stringify(
    history.map((entry) => [
      entry.id, entry.status, entry.completedAt || "",
      entry.result && entry.result.summary ? entry.result.summary : "",
      entry.result && Array.isArray(entry.result.toolCalls) ? entry.result.toolCalls.length : 0
    ])
  );
}

function createStep(icon, title, contentData, key) {
  if (!contentData) {
    const el = document.createElement("div");
    el.className = "step";
    el.innerHTML = '<span class="step-icon">' + icon + '</span> <span>' + title + '</span>';
    return el;
  }
  
  const details = document.createElement("details");
  details.className = "step-details";
  details.dataset.key = key;
  if (state.openDetails.has(key)) {
    details.open = true;
  }
  
  const summary = document.createElement("summary");
  summary.innerHTML = '<span class="step-icon">' + icon + '</span> <span>' + title + '</span>';
  details.appendChild(summary);
  
  const content = document.createElement("div");
  content.className = "step-content";
  const pre = document.createElement("pre");
  pre.textContent = typeof contentData === 'string' ? contentData : JSON.stringify(contentData, null, 2);
  content.appendChild(pre);
  
  details.appendChild(content);
  return details;
}

function getToolIcon(toolName) {
  const name = (toolName || '').toLowerCase();
  if (name.includes('view') || name.includes('read')) return '📄';
  if (name.includes('list') || name.includes('find') || name.includes('search')) return '📁';
  if (name.includes('run') || name.includes('cmd')) return '⌨️';
  if (name.includes('edit') || name.includes('replace') || name.includes('write')) return '📝';
  if (name.includes('browser') || name.includes('web')) return '🌐';
  return '🔧';
}

function getToolTitle(call) {
  const name = call.toolName || 'tool';
  let extra = '';
  let detail = '';
  
  if (name === 'view_file' || name === 'view_file_outline') {
    extra = call.args && call.args.AbsolutePath ? call.args.AbsolutePath.split(/[\\\\/]/).pop() : '';
  } else if (name === 'list_dir') {
    extra = call.args && call.args.DirectoryPath ? call.args.DirectoryPath.split(/[\\\\/]/).pop() : '';
  } else if (name === 'grep_search' || name === 'find_by_name') {
      extra = call.args && call.args.Query ? '"' + call.args.Query + '"' : '';
  } else if (name === 'run_command') {
    extra = call.args && call.args.CommandLine ? call.args.CommandLine : '';
  } else if (name === 'multi_replace_file_content' || name === 'replace_file_content' || name === 'write_to_file') {
    extra = call.args && call.args.TargetFile ? call.args.TargetFile.split(/[\\\\/]/).pop() : '';
    let additions = "";
    if (call.args && call.args.ReplacementChunks) additions = " (" + call.args.ReplacementChunks.length + " chunks)";
    detail = '<span style="color:var(--accent); margin-left:6px; font-size:12px;">' + additions + '</span>';
  } else {
    extra = JSON.stringify(call.args).substring(0, 30);
  }
  
  if (extra && extra.length > 50) {
    extra = extra.substring(0, 50) + '...';
  }
  
  const ok = call.result && call.result.ok;
  const statusStr = !ok && call.result ? '<span style="color:#d16969; margin-left:6px;">(错误)</span>' : '';
  const argsText = extra ? ' <b>' + extra + '</b>' : '';
  
  return (name + argsText + detail + statusStr).trim();
}

function renderHistory() {
  if(!historyEl) return;
  const nextKey = buildRenderKey(state.history);
  if (nextKey === state.lastRenderKey) return;
  state.lastRenderKey = nextKey;

  rememberOpenDetails();
  historyEl.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.style.color = "var(--muted)";
    empty.style.textAlign = "center";
    empty.style.marginTop = "40px";
    empty.textContent = "和团子开始对话...";
    historyEl.appendChild(empty);
    return;
  }

  for (const entry of state.history) {
    const turn = document.createElement("div");
    turn.className = "turn";

    const user = document.createElement("div");
    user.className = "msg-user";
    user.textContent = entry.userMessage;
    turn.appendChild(user);

    const steps = document.createElement("div");
    steps.className = "steps";

    if (entry.status === "error") {
      steps.appendChild(createStep("❌", "团子错误", entry.error || "未知错误", entry.id + ":error"));
    } else if (entry.status === "running") {
      steps.appendChild(createStep("⏳", "团子正在处理...", null, entry.id + ":running"));
    } else if (entry.result) {
      const toolCalls = Array.isArray(entry.result.toolCalls) ? entry.result.toolCalls : [];
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const icon = getToolIcon(call.toolName);
        const title = getToolTitle(call);
        
        let contentStr = "";
        if (call.args) contentStr += "--- 参数 (Args) ---\\\\n" + JSON.stringify(call.args, null, 2) + "\\\\n\\\\n";
        if (call.result) contentStr += "--- 结果 (Result) ---\\\\n" + JSON.stringify(call.result, null, 2);
        
        steps.appendChild(createStep(icon, title, contentStr, entry.id + ":tool:" + i));
      }

      if (entry.result.summary) {
        const assistantMsg = document.createElement("div");
        assistantMsg.className = "msg-assistant";
        assistantMsg.textContent = entry.result.summary || "";
        turn.appendChild(assistantMsg);
      }
    }
    
    turn.appendChild(steps);
    historyEl.appendChild(turn);
  }
}

async function refreshHistory() {
  const res = await fetch("/api/history");
  if (!res.ok) return;
  const data = await res.json();
  
  const prevLen = state.history.length;
  state.history = Array.isArray(data.history) ? data.history : [];
  
  const histDom = historyEl;
  if(!histDom) return;
  const wasAtBottom = (histDom.scrollHeight - histDom.scrollTop - histDom.clientHeight) < 60;
  
  renderHistory();
  if (data.running) updateStatus("团子处理中...");
  
  if (state.history.length > prevLen || wasAtBottom) {
    requestAnimationFrame(() => {
      histDom.scrollTop = histDom.scrollHeight;
    });
  }
}

async function sendMessage(message) {
  setSending(true);
  updateStatus("正在发送给团子...");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : "请求失败");
    
    state.lastRenderKey = "";
    await refreshHistory();
    updateStatus("团子已完成");
  } catch (err) {
    updateStatus("失败: " + String(err));
    console.error(err);
  } finally {
    setSending(false);
    setTimeout(() => { if(!state.sending) updateStatus(""); }, 3000);
  }
}

async function submitComposerMessage() {
  const message = messageEl ? messageEl.value.trim() : "";
  if (!message || state.sending) return;
  if(messageEl) {
    messageEl.value = "";
    messageEl.style.height = 'auto';
  }
  await sendMessage(message);
}

if(formEl) {
  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    submitComposerMessage();
  });
}

let isComposing = false;
if(messageEl) {
  messageEl.addEventListener("compositionstart", () => { isComposing = true; });
  messageEl.addEventListener("compositionend", () => { isComposing = false; });
  messageEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !isComposing) {
      event.preventDefault();
      submitComposerMessage();
    }
  });

  messageEl.addEventListener("input", function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });
}

(async function boot() {
  await refreshHistory();
  state.polling = setInterval(() => {
    refreshHistory().catch(() => {});
  }, 2500);
})();`;
}
