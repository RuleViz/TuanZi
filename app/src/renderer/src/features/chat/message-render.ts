import type { ConversationToolCall, PendingChatImage } from "../../app/state";
import type { SubagentSnapshotData } from "../../../../shared/ipc-contracts";

interface ExecBlockOptions {
  type: "tool" | "command" | "thinking";
  title: string;
  statusOk?: boolean;
  statusText?: string;
  loading?: boolean;
  collapsedPreview?: boolean;
}

type ToolCall = ConversationToolCall;

interface MessageRendererDeps {
  chatArea: HTMLDivElement;
  welcomeState: HTMLDivElement;
  escapeHtml: (text: string) => string;
  formatByteSize: (bytes: number) => string;
  renderMarkdownHtml: (text: string) => string;
  scrollToBottom: () => void;
}

export interface MessageRenderer {
  addUserMessage: (text: string, image?: PendingChatImage | null, undoCallback?: (() => void) | null) => void;
  addAssistantMessage: (text: string, thinking?: string, toolCalls?: ToolCall[]) => void;
  createAssistantSurface: () => {
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
  };
  createExecBlock: (opts: ExecBlockOptions) => { block: HTMLDivElement; output: HTMLPreElement };
  renderToolCalls: (container: HTMLDivElement, toolCalls: ToolCall[]) => void;
  appendCompletedToolCall: (contentEl: HTMLDivElement, toolCall: ToolCall) => void;
  getOrCreateToolCallsContainer: (parentEl: HTMLDivElement) => HTMLDivElement;
  addToolCallRow: (container: HTMLDivElement, toolName: string, status: "loading" | "done" | "failed", toolCallId?: string) => HTMLDivElement;
  updateToolCallRow: (row: HTMLDivElement, status: "done" | "failed", detail?: string) => void;
  showSubagentModal: (snapshot: SubagentSnapshotData) => void;
  updateSubagentSnapshots: (parentEl: HTMLDivElement, snapshots: SubagentSnapshotData[]) => void;
}

export function formatToolArgsText(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "[unserializable]";
  }
}

export function formatToolResultText(result: { ok: boolean; data?: unknown; error?: string }): string {
  if (!result.ok) {
    return `Error: ${result.error || "Unknown error"}`;
  }
  if (result.data === undefined) {
    return "ok";
  }

  const extractMcpText = (value: unknown): string | null => {
    const blocks = (() => {
      if (Array.isArray(value)) {
        return value;
      }
      if (!value || typeof value !== "object") {
        return null;
      }
      const record = value as Record<string, unknown>;
      return Array.isArray(record.content) ? record.content : null;
    })();
    if (!blocks || blocks.length === 0) {
      return null;
    }

    const chunks: string[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (text) {
        chunks.push(text);
        continue;
      }
      if (record.json !== undefined) {
        try {
          const json = JSON.stringify(record.json, null, 2);
          if (json && json !== "{}") {
            chunks.push(json);
          }
        } catch {
          // ignore invalid json value
        }
      }
    }

    return chunks.length === 0 ? null : chunks.join("\n\n");
  };

  const mcpText = extractMcpText(result.data);
  if (mcpText) {
    return mcpText;
  }

  try {
    return JSON.stringify(result.data, null, 2);
  } catch {
    return "[unserializable]";
  }
}

export function buildExecTextPreview(text: string, maxLines = 8): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length <= maxLines) {
    return { text: normalized, truncated: false };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true
  };
}

export function buildExecContentState(
  text: string
): { collapsedText: string; expandedText: string } {
  return {
    collapsedText: "",
    expandedText: text
  };
}

export function computeExecOutputText(input: {
  isExpanded: boolean;
  currentText?: string;
  collapsedContent?: string;
  expandedContent?: string;
}): string {
  const hasCachedContent = input.collapsedContent !== undefined || input.expandedContent !== undefined;
  if (!hasCachedContent) {
    return input.currentText ?? "";
  }
  return input.isExpanded ? (input.expandedContent ?? "") : (input.collapsedContent ?? "");
}

export function createMessageRenderer(input: MessageRendererDeps): MessageRenderer {
  const createAssistantMessage = (): HTMLDivElement => {
    const messageEl = document.createElement("div");
    messageEl.className = "message assistant";
    const contentEl = document.createElement("div");
    contentEl.className = "msg-content";
    messageEl.appendChild(contentEl);
    input.chatArea.appendChild(messageEl);
    return contentEl;
  };

  const createExecBlock = (opts: ExecBlockOptions): { block: HTMLDivElement; output: HTMLPreElement } => {
    const block = document.createElement("div");
    block.className = "exec-block" + (opts.loading ? " loading" : "");
    block.dataset.execType = opts.type;

    let statusHtml = "";
    if (opts.statusText !== undefined) {
      const cls = opts.statusOk ? "status-ok" : "status-err";
      statusHtml = `<span class="status-badge ${cls}">${input.escapeHtml(opts.statusText)}</span>`;
    }

    const iconSvg =
      opts.type === "command"
        ? `<svg class="tool-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 9a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3A.5.5 0 0 1 6 9zM.146 2.854a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L3.793 6.5.146 2.854z"/></svg>`
        : opts.type === "thinking"
          ? `<svg class="tool-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M9.5 2a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h2z"/><path d="M14.5 2a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h2z"/></svg>`
          : `<svg class="tool-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 0L0 1l2.313 2.313-1.96 1.96A.5.5 0 0 0 .5 6h5a.5.5 0 0 0 .5-.5v-5a.5.5 0 0 0-.854-.354l-1.96 1.96L1 0zm9.5 5h5a.5.5 0 0 0 .354-.854l-1.96-1.96L16 0l-1-1-2.313 2.313-1.96-1.96A.5.5 0 0 0 10 .5v5a.5.5 0 0 0 .5.5zM6 10.5v5a.5.5 0 0 0 .854.354l1.96-1.96L11 16l1-1-2.313-2.313 1.96-1.96A.5.5 0 0 0 11.5 10h-5a.5.5 0 0 0-.5.5zm-5 0v-5a.5.5 0 0 0-.854-.354l.44.44L.146 6.146a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L1.207 6.5H5.5A.5.5 0 0 0 6 6V1a.5.5 0 0 0-.854-.354L3.793 2.293.146 6.146z"/></svg>`;

    block.innerHTML = `
      <div class="exec-title">
        <span class="chevron">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </span>
        ${iconSvg}
        ${input.escapeHtml(opts.title)}
        ${statusHtml}
      </div>
      <div class="exec-output"><pre></pre></div>
    `;

    const titleEl = block.querySelector(".exec-title") as HTMLDivElement;
    const output = block.querySelector(".exec-output pre") as HTMLPreElement;
    titleEl.addEventListener("click", () => {
      block.classList.toggle("expanded");
      syncExecPreview(block, output);
    });

    return { block, output };
  };

  const addUserMessage = (text: string, image?: PendingChatImage | null, undoCallback?: (() => void) | null): void => {
    input.welcomeState.style.display = "none";

    const messageEl = document.createElement("div");
    messageEl.className = "message user";

    if (undoCallback) {
      const undoBtn = document.createElement("button");
      undoBtn.className = "msg-undo-btn";
      undoBtn.title = "Undo to this turn";
      undoBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
      undoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        undoCallback();
      });
      messageEl.appendChild(undoBtn);
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    if (image) {
      const imageEl = document.createElement("img");
      imageEl.className = "msg-user-image";
      imageEl.src = image.dataUrl;
      imageEl.alt = image.name;
      bubble.appendChild(imageEl);

      const metaEl = document.createElement("div");
      metaEl.className = "msg-user-image-meta";
      metaEl.textContent = `${image.name} 路 ${input.formatByteSize(image.sizeBytes)}`;
      bubble.appendChild(metaEl);
    }

    if (text) {
      const textEl = document.createElement("div");
      textEl.textContent = text;
      bubble.appendChild(textEl);
    }

    messageEl.appendChild(bubble);
    input.chatArea.appendChild(messageEl);
    input.scrollToBottom();
  };

  const addAssistantMessage = (text: string, thinking?: string, toolCalls?: ToolCall[]): void => {
    const contentEl = createAssistantMessage();

    if (thinking) {
      const blocksContainer = document.createElement("div");
      blocksContainer.className = "blocks-container";
      contentEl.appendChild(blocksContainer);

      const { block, output } = createExecBlock({
        type: "thinking",
        title: "Thought Process",
        statusOk: true,
        statusText: "processed"
      });
      output.textContent = thinking;
      blocksContainer.appendChild(block);
    }

    if (toolCalls && toolCalls.length > 0) {
      renderToolCalls(contentEl, toolCalls);
    }

    const textContainer = document.createElement("div");
    textContainer.className = "markdown-text";
    textContainer.innerHTML = input.renderMarkdownHtml(text);
    contentEl.appendChild(textContainer);

    input.scrollToBottom();
  };

  const getOrCreateToolCallsContainer = (parentEl: HTMLDivElement): HTMLDivElement => {
    let container = parentEl.querySelector<HTMLDivElement>(".tool-calls-container");
    if (container) {
      return container;
    }
    container = document.createElement("div");
    container.className = "tool-calls-container collapsed";
    container.innerHTML = `
      <div class="tool-calls-header">
        <span class="tool-calls-chevron">
          <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </span>
        <span class="tool-calls-summary">0 个工具调用</span>
      </div>
      <div class="tool-calls-list"></div>
    `;
    const header = container.querySelector(".tool-calls-header") as HTMLDivElement;
    header.addEventListener("click", () => {
      container!.classList.toggle("collapsed");
    });
    parentEl.appendChild(container);
    return container;
  };

  const updateContainerSummary = (container: HTMLDivElement): void => {
    const list = container.querySelector(".tool-calls-list");
    const count = list ? list.children.length : 0;
    const summary = container.querySelector(".tool-calls-summary");
    if (summary) {
      summary.textContent = `${count} 个工具调用`;
    }
  };

  const addToolCallRow = (
    container: HTMLDivElement,
    toolName: string,
    status: "loading" | "done" | "failed",
    toolCallId?: string
  ): HTMLDivElement => {
    const list = container.querySelector(".tool-calls-list") as HTMLDivElement;
    const row = document.createElement("div");
    row.className = `tool-call-row status-${status}`;
    row.dataset.toolName = toolName.trim().toLowerCase();
    if (toolCallId) {
      row.dataset.toolCallId = toolCallId;
    }
    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-call-name";
    nameSpan.textContent = toolName.trim().toLowerCase();
    row.appendChild(nameSpan);
    if (status === "loading") {
      const dot = document.createElement("span");
      dot.className = "tool-call-loading-dot";
      row.appendChild(dot);
    } else {
      const badge = document.createElement("span");
      badge.className = `tool-call-status ${status === "done" ? "status-ok" : "status-err"}`;
      badge.textContent = status;
      row.appendChild(badge);
    }
    list.appendChild(row);
    updateContainerSummary(container);
    return row;
  };

  const updateToolCallRow = (row: HTMLDivElement, status: "done" | "failed", _detail?: string): void => {
    row.className = `tool-call-row status-${status}`;
    const dot = row.querySelector(".tool-call-loading-dot");
    if (dot) {
      dot.remove();
    }
    let badge = row.querySelector(".tool-call-status");
    if (!badge) {
      badge = document.createElement("span");
      row.appendChild(badge);
    }
    badge.className = `tool-call-status ${status === "done" ? "status-ok" : "status-err"}`;
    badge.textContent = status;
  };

  const renderToolCalls = (container: HTMLDivElement, toolCalls: ToolCall[]): void => {
    const tcContainer = getOrCreateToolCallsContainer(container);
    for (const call of toolCalls) {
      const status = call.result.ok ? "done" : "failed";
      const row = addToolCallRow(tcContainer, call.toolName, status, typeof call.id === "string" ? call.id : undefined);
      const outputContent = call.toolName === "bash"
        ? `$ ${typeof call.args.command === "string" ? call.args.command : "command"}\n\n${formatToolResultText(call.result)}`
        : `Args:\n${formatToolArgsText(call.args)}\n\nResult:\n${formatToolResultText(call.result)}`;
      row.dataset.detail = outputContent;
      row.title = outputContent.substring(0, 200);
      row.addEventListener("click", () => {
        const modal = document.getElementById("tool-detail-modal");
        if (modal) {
          const modalBody = modal.querySelector(".subagent-modal-body") as HTMLDivElement;
          modalBody.innerHTML = `<pre class="tool-detail-pre">${input.escapeHtml(outputContent)}</pre>`;
          const modalTitle = modal.querySelector(".subagent-modal-title") as HTMLDivElement;
          modalTitle.textContent = call.toolName;
          modal.classList.add("visible");
        }
      });
    }
  };

  const showSubagentModal = (snapshot: SubagentSnapshotData): void => {
    let modal = document.getElementById("subagent-modal") as HTMLDivElement | null;
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "subagent-modal";
      modal.className = "subagent-modal-overlay";
      modal.innerHTML = `
        <div class="subagent-modal-content">
          <div class="subagent-modal-header">
            <span class="subagent-modal-title"></span>
            <button class="subagent-modal-close">&times;</button>
          </div>
          <div class="subagent-modal-body"></div>
        </div>
      `;
      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          modal!.classList.remove("visible");
        }
      });
      modal.querySelector(".subagent-modal-close")!.addEventListener("click", () => {
        modal!.classList.remove("visible");
      });
      document.body.appendChild(modal);
    }
    const titleEl = modal.querySelector(".subagent-modal-title") as HTMLSpanElement;
    titleEl.textContent = `Subagent: ${snapshot.task.substring(0, 80)}`;
    const bodyEl = modal.querySelector(".subagent-modal-body") as HTMLDivElement;
    const statusLabel = snapshot.status;
    const toolCallsHtml = snapshot.toolCalls.length > 0
      ? snapshot.toolCalls.map((tc) =>
        `<div class="subagent-tc-row">
          <span class="subagent-tc-name">${input.escapeHtml(tc.name)}</span>
          <span class="subagent-tc-status ${tc.result.ok ? "status-ok" : "status-err"}">${tc.result.ok ? "done" : "failed"}</span>
        </div>`
      ).join("")
      : `<div class="subagent-tc-empty">暂无工具调用</div>`;
    bodyEl.innerHTML = `
      <div class="subagent-detail-section">
        <div class="subagent-detail-row"><strong>Status:</strong> <span class="subagent-status-badge status-${statusLabel}">${statusLabel}</span></div>
        <div class="subagent-detail-row"><strong>Task:</strong> ${input.escapeHtml(snapshot.task)}</div>
        ${snapshot.summary ? `<div class="subagent-detail-row"><strong>Summary:</strong> ${input.escapeHtml(snapshot.summary)}</div>` : ""}
        ${snapshot.error ? `<div class="subagent-detail-row subagent-error"><strong>Error:</strong> ${input.escapeHtml(snapshot.error)}</div>` : ""}
      </div>
      <div class="subagent-detail-section">
        <div class="subagent-detail-label">Tool Calls (${snapshot.toolCalls.length})</div>
        ${toolCallsHtml}
      </div>
    `;
    modal.classList.add("visible");
  };

  const updateSubagentSnapshots = (parentEl: HTMLDivElement, snapshots: SubagentSnapshotData[]): void => {
    let subagentArea = parentEl.querySelector<HTMLDivElement>(".subagent-entries");
    if (!subagentArea) {
      subagentArea = document.createElement("div");
      subagentArea.className = "subagent-entries";
      parentEl.appendChild(subagentArea);
    }
    for (const snap of snapshots) {
      let entry = subagentArea.querySelector<HTMLDivElement>(`.subagent-entry[data-subagent-id="${snap.id}"]`);
      if (!entry) {
        entry = document.createElement("div");
        entry.className = "subagent-entry";
        entry.dataset.subagentId = snap.id;
        entry.addEventListener("click", () => showSubagentModal(snap));
        subagentArea.appendChild(entry);
      } else {
        const oldClickHandler = entry.onclick;
        if (oldClickHandler) {
          entry.removeEventListener("click", oldClickHandler as EventListener);
        }
        entry.onclick = () => showSubagentModal(snap);
      }
      const statusCls = snap.status === "completed" ? "status-ok" : snap.status === "running" ? "status-running" : snap.status === "failed" ? "status-err" : "";
      entry.innerHTML = `
        <span class="subagent-entry-icon">🤖</span>
        <span class="subagent-entry-task">${input.escapeHtml(snap.task.substring(0, 60))}</span>
        <span class="subagent-entry-status ${statusCls}">${snap.status}</span>
        <span class="subagent-entry-tc-count">${snap.toolCalls.length} calls</span>
      `;
    }
  };

  const createAssistantSurface = (): {
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
  } => {
    const contentEl = createAssistantMessage();
    const blocksContainer = document.createElement("div");
    blocksContainer.className = "blocks-container";
    contentEl.appendChild(blocksContainer);

    const textContainer = document.createElement("div");
    textContainer.className = "markdown-text";
    contentEl.appendChild(textContainer);

    return { contentEl, blocksContainer, textContainer };
  };

  const appendCompletedToolCall = (contentEl: HTMLDivElement, toolCall: ToolCall): void => {
    const toolCallId = typeof toolCall.id === "string" ? toolCall.id : "";
    const normalizedToolName = toolCall.toolName.trim().toLowerCase();
    const tcContainer = getOrCreateToolCallsContainer(contentEl);
    const list = tcContainer.querySelector(".tool-calls-list") as HTMLDivElement;
    const loadingRows = Array.from(list.querySelectorAll<HTMLDivElement>(".tool-call-row.status-loading"));
    const matchedRow =
      (toolCallId
        ? loadingRows.find((row) => row.dataset.toolCallId === toolCallId)
        : null) ??
      loadingRows.find((row) => row.dataset.toolName === normalizedToolName) ??
      null;
    if (matchedRow) {
      const status = toolCall.result.ok ? "done" : "failed";
      updateToolCallRow(matchedRow, status);
      const outputContent = toolCall.toolName === "bash"
        ? `$ ${typeof toolCall.args.command === "string" ? toolCall.args.command : "command"}\n\n${formatToolResultText(toolCall.result)}`
        : `Args:\n${formatToolArgsText(toolCall.args)}\n\nResult:\n${formatToolResultText(toolCall.result)}`;
      matchedRow.dataset.detail = outputContent;
      matchedRow.title = outputContent.substring(0, 200);
      matchedRow.addEventListener("click", () => {
        const modal = document.getElementById("tool-detail-modal");
        if (modal) {
          const modalBody = modal.querySelector(".subagent-modal-body") as HTMLDivElement;
          modalBody.innerHTML = `<pre class="tool-detail-pre">${input.escapeHtml(outputContent)}</pre>`;
          const modalTitle = modal.querySelector(".subagent-modal-title") as HTMLDivElement;
          modalTitle.textContent = toolCall.toolName;
          modal.classList.add("visible");
        }
      });
    } else {
      renderToolCalls(contentEl, [toolCall]);
    }
  };

  return {
    addUserMessage,
    addAssistantMessage,
    createAssistantSurface,
    createExecBlock,
    renderToolCalls,
    appendCompletedToolCall,
    getOrCreateToolCallsContainer,
    addToolCallRow,
    updateToolCallRow,
    showSubagentModal,
    updateSubagentSnapshots
  };
}

function syncExecPreview(block: HTMLDivElement, output: HTMLPreElement): void {
  output.textContent = computeExecOutputText({
    isExpanded: block.classList.contains("expanded"),
    currentText: output.textContent ?? "",
    collapsedContent: block.dataset.collapsedContent,
    expandedContent: block.dataset.expandedContent
  });
}
