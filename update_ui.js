const fs = require('fs');

const path = 'src/web/server.ts';
let code = fs.readFileSync(path, 'utf8');

const html = `function buildHtml(): string {
  return \`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MyCoderAgent</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="app-shell">
    <div id="history" class="history"></div>
    <form id="composer" class="composer">
      <div class="input-wrapper">
        <textarea id="message" rows="1" placeholder="在这里输入需求...回车发送"></textarea>
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
</html>\`;
}`;

const css = `function buildCss(): string {
  return \`:root {
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

.steps { 
  display: flex; flex-direction: column; gap: 2px; 
  border-left: 1px solid var(--step-border); margin-left: 6px; padding-left: 14px; 
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
.actions { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
.status { color: var(--muted); font-size: 12px; }
\`;
}`;

const js = `function buildJs(): string {
  return \`const state = {
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
      entry.result && entry.result.mode ? entry.result.mode : "",
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
    empty.textContent = "发送需求以开始...";
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
      steps.appendChild(createStep("❌", "Agent 错误", entry.error || "未知错误", entry.id + ":error"));
    } else if (entry.status === "running") {
      steps.appendChild(createStep("⏳", "正在处理...", null, entry.id + ":running"));
    } else if (entry.result) {
      if (entry.result.plan && Object.keys(entry.result.plan).length > 0) {
        steps.appendChild(createStep("🧠", "> 思考过程 (Plan)", entry.result.plan, entry.id + ":plan"));
      }

      const toolCalls = Array.isArray(entry.result.toolCalls) ? entry.result.toolCalls : [];
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const icon = getToolIcon(call.toolName);
        const title = getToolTitle(call);
        
        let contentStr = "";
        if (call.args) contentStr += "--- 参数 (Args) ---\\n" + JSON.stringify(call.args, null, 2) + "\\n\\n";
        if (call.result) contentStr += "--- 结果 (Result) ---\\n" + JSON.stringify(call.result, null, 2);
        
        steps.appendChild(createStep(icon, title, contentStr, entry.id + ":tool:" + i));
      }

      const coder = entry.result.coder;
      if (coder && Object.keys(coder).length > 0) {
        let title = "已完成";
        if (coder.summary) title = coder.summary;
        steps.appendChild(createStep("💬", "> " + title, coder, entry.id + ":coder"));
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
  if (data.running) updateStatus("运行中...");
  
  if (state.history.length > prevLen || wasAtBottom) {
    requestAnimationFrame(() => {
      histDom.scrollTop = histDom.scrollHeight;
    });
  }
}

async function sendMessage(message) {
  setSending(true);
  updateStatus("发送请求...");
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
    updateStatus("任务已同步完成");
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
})();\`;
}`;

const htmlStart = code.indexOf('function buildHtml(): string {');
const preamble = code.substring(0, htmlStart);
fs.writeFileSync(path, preamble + html + '\n' + css + '\n' + js + '\n');
console.log("Cleanup and fix completed.");
