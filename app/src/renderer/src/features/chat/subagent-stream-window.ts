import type { SubagentSnapshotData, SubagentStreamDelta } from "../../../../shared/ipc-contracts";

export interface SubagentWindowState {
  id: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  thinkingText: string;
  outputText: string;
  toolCalls: Array<{
    id: string;
    name: string;
    status: "loading" | "done" | "failed";
    args?: Record<string, unknown>;
    result?: { ok: boolean; data?: unknown; error?: string };
  }>;
  expanded: boolean;
}

interface SubagentWindowDeps {
  escapeHtml: (text: string) => string;
  renderMarkdownHtml: (text: string) => string;
  scrollToBottom: () => void;
}

const COLLAPSED_HEIGHT = 180;

export class SubagentStreamWindowManager {
  private readonly windows = new Map<string, SubagentWindowState>();
  private readonly elements = new Map<string, HTMLDivElement>();
  private readonly deps: SubagentWindowDeps;

  constructor(deps: SubagentWindowDeps) {
    this.deps = deps;
  }

  getOrCreateWindow(subagentId: string, task: string): SubagentWindowState {
    let state = this.windows.get(subagentId);
    if (!state) {
      state = {
        id: subagentId,
        task,
        status: "running",
        thinkingText: "",
        outputText: "",
        toolCalls: [],
        expanded: false
      };
      this.windows.set(subagentId, state);
    }
    return state;
  }

  handleStreamDelta(delta: SubagentStreamDelta & { subagentId: string }): void {
    const state = this.windows.get(delta.subagentId);
    if (!state) {
      return;
    }

    switch (delta.type) {
      case "thinking":
        state.thinkingText += delta.delta ?? "";
        break;
      case "text":
        state.outputText += delta.delta ?? "";
        break;
      case "tool_start":
        state.toolCalls.push({
          id: delta.toolCallId ?? "",
          name: delta.toolName ?? "",
          status: "loading",
          args: delta.args
        });
        break;
      case "tool_end": {
        const tc = state.toolCalls.find((c) => c.id === delta.toolCallId);
        if (tc) {
          tc.status = delta.result?.ok ? "done" : "failed";
          tc.result = delta.result;
        }
        break;
      }
    }

    this.renderWindow(delta.subagentId);
  }

  updateFromSnapshot(snapshot: SubagentSnapshotData): void {
    let state = this.windows.get(snapshot.id);
    if (!state) {
      state = this.getOrCreateWindow(snapshot.id, snapshot.task);
    }
    state.status = snapshot.status;
    state.task = snapshot.task;

    if (snapshot.result) {
      if (snapshot.result.fullTextPreview && !state.outputText) {
        state.outputText = snapshot.result.fullTextPreview;
      }
      if (snapshot.result.toolCallPreview) {
        for (const tc of snapshot.result.toolCallPreview) {
          const existing = state.toolCalls.find((c) => c.id === tc.id);
          if (!existing) {
            state.toolCalls.push({
              id: tc.id,
              name: tc.name,
              status: tc.result.ok ? "done" : "failed",
              args: tc.args,
              result: tc.result
            });
          }
        }
      }
    }

    this.renderWindow(snapshot.id);
  }

  createWindowElement(parentEl: HTMLDivElement, subagentId: string, task: string): HTMLDivElement {
    let windowEl = this.elements.get(subagentId);
    if (windowEl) {
      return windowEl;
    }

    this.getOrCreateWindow(subagentId, task);

    windowEl = document.createElement("div");
    windowEl.className = "subagent-stream-window";
    windowEl.dataset.subagentId = subagentId;
    windowEl.innerHTML = `
      <div class="subagent-window-header">
        <span class="subagent-window-icon">🤖</span>
        <span class="subagent-window-title">${this.deps.escapeHtml(task.substring(0, 60))}</span>
        <span class="subagent-window-status status-running">running</span>
        <button class="subagent-window-toggle" title="展开/折叠">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>
      <div class="subagent-window-body" style="max-height: ${COLLAPSED_HEIGHT}px;">
        <div class="subagent-window-content">
          <div class="subagent-thinking-area"></div>
          <div class="subagent-tools-area"></div>
          <div class="subagent-output-area"></div>
        </div>
      </div>
    `;

    const toggleBtn = windowEl.querySelector(".subagent-window-toggle") as HTMLButtonElement;
    toggleBtn.addEventListener("click", () => {
      this.toggleExpand(subagentId);
    });

    const header = windowEl.querySelector(".subagent-window-header") as HTMLDivElement;
    header.addEventListener("click", (e) => {
      if (e.target !== toggleBtn && !toggleBtn.contains(e.target as Node)) {
        this.toggleExpand(subagentId);
      }
    });

    this.elements.set(subagentId, windowEl);
    parentEl.appendChild(windowEl);

    return windowEl;
  }

  private toggleExpand(subagentId: string): void {
    const state = this.windows.get(subagentId);
    const windowEl = this.elements.get(subagentId);
    if (!state || !windowEl) {
      return;
    }

    state.expanded = !state.expanded;
    windowEl.classList.toggle("expanded", state.expanded);

    const body = windowEl.querySelector(".subagent-window-body") as HTMLDivElement;
    if (state.expanded) {
      body.style.maxHeight = "none";
    } else {
      body.style.maxHeight = `${COLLAPSED_HEIGHT}px`;
    }

    const toggleBtn = windowEl.querySelector(".subagent-window-toggle") as HTMLButtonElement;
    toggleBtn.classList.toggle("rotated", state.expanded);
  }

  private renderWindow(subagentId: string): void {
    const state = this.windows.get(subagentId);
    const windowEl = this.elements.get(subagentId);
    if (!state || !windowEl) {
      return;
    }

    const statusEl = windowEl.querySelector(".subagent-window-status") as HTMLSpanElement;
    statusEl.className = `subagent-window-status status-${state.status}`;
    statusEl.textContent = state.status;

    const thinkingArea = windowEl.querySelector(".subagent-thinking-area") as HTMLDivElement;
    if (state.thinkingText) {
      thinkingArea.innerHTML = `
        <div class="subagent-thinking-block">
          <div class="subagent-thinking-header">💭 Thinking</div>
          <pre class="subagent-thinking-content">${this.deps.escapeHtml(state.thinkingText)}</pre>
        </div>
      `;
    } else {
      thinkingArea.innerHTML = "";
    }

    const toolsArea = windowEl.querySelector(".subagent-tools-area") as HTMLDivElement;
    if (state.toolCalls.length > 0) {
      const toolsHtml = state.toolCalls.map((tc) => {
        const statusClass = tc.status === "loading" ? "status-loading" : tc.status === "done" ? "status-ok" : "status-err";
        const statusIcon = tc.status === "loading" ? "⏳" : tc.status === "done" ? "✓" : "✗";
        return `
          <div class="subagent-tool-row ${statusClass}">
            <span class="subagent-tool-name">${this.deps.escapeHtml(tc.name)}</span>
            <span class="subagent-tool-status">${statusIcon}</span>
          </div>
        `;
      }).join("");
      toolsArea.innerHTML = `
        <div class="subagent-tools-block">
          <div class="subagent-tools-header">🔧 Tools (${state.toolCalls.length})</div>
          ${toolsHtml}
        </div>
      `;
    } else {
      toolsArea.innerHTML = "";
    }

    const outputArea = windowEl.querySelector(".subagent-output-area") as HTMLDivElement;
    if (state.outputText) {
      outputArea.innerHTML = `
        <div class="subagent-output-block">
          <div class="subagent-output-content">${this.deps.renderMarkdownHtml(state.outputText)}</div>
        </div>
      `;
    } else {
      outputArea.innerHTML = "";
    }

    const body = windowEl.querySelector(".subagent-window-body") as HTMLDivElement;
    if (!state.expanded) {
      body.scrollTop = body.scrollHeight;
    }

    this.deps.scrollToBottom();
  }

  getWindowElement(subagentId: string): HTMLDivElement | null {
    return this.elements.get(subagentId) ?? null;
  }

  dispose(): void {
    this.windows.clear();
    this.elements.clear();
  }
}
