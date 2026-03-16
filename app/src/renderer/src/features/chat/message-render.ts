import type { PendingChatImage } from "../../app/state";

interface ExecBlockOptions {
  type: "tool" | "command" | "thinking";
  title: string;
  statusOk?: boolean;
  statusText?: string;
  loading?: boolean;
}

interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
  timestamp: string;
}

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
  addAssistantMessage: (text: string, thinking?: string) => void;
  createAssistantSurface: () => {
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
  };
  createExecBlock: (opts: ExecBlockOptions) => { block: HTMLDivElement; output: HTMLPreElement };
  renderToolCalls: (container: HTMLDivElement, toolCalls: ToolCall[]) => void;
  appendCompletedToolCall: (contentEl: HTMLDivElement, toolCall: ToolCall) => void;
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
    titleEl.addEventListener("click", () => {
      block.classList.toggle("expanded");
    });

    const output = block.querySelector(".exec-output pre") as HTMLPreElement;
    return { block, output };
  };

  const formatArgs = (args: Record<string, unknown>): string => {
    try {
      const str = JSON.stringify(args, null, 2);
      return str.length > 800 ? str.substring(0, 800) + "..." : str;
    } catch {
      return "[unserializable]";
    }
  };

  const formatResult = (result: { ok: boolean; data?: unknown; error?: string }): string => {
    if (!result.ok) {
      return `Error: ${result.error || "Unknown error"}`;
    }
    if (result.data === undefined) {
      return "ok";
    }

    // MCP tool responses often use { content: [{ type: "text", text: "..." }] }.
    // Prefer rendering the text blocks directly so search results are not hidden by generic JSON formatting.
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

      if (chunks.length === 0) {
        return null;
      }
      const merged = chunks.join("\n\n");
      return merged.length > 1200 ? `${merged.substring(0, 1200)}\n...(truncated)` : merged;
    };

    const mcpText = extractMcpText(result.data);
    if (mcpText) {
      return mcpText;
    }

    try {
      const str = JSON.stringify(result.data, null, 2);
      return str.length > 1200 ? str.substring(0, 1200) + "\n...(truncated)" : str;
    } catch {
      return "[unserializable]";
    }
  };

  const addUserMessage = (text: string, image?: PendingChatImage | null, undoCallback?: (() => void) | null): void => {
    input.welcomeState.style.display = "none";

    const messageEl = document.createElement("div");
    messageEl.className = "message user";

    // Undo button container (appears before the bubble)
    if (undoCallback) {
      const undoBtn = document.createElement("button");
      undoBtn.className = "msg-undo-btn";
      undoBtn.title = "撤回到此轮之前";
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
      metaEl.textContent = `${image.name} · ${input.formatByteSize(image.sizeBytes)}`;
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

  const addAssistantMessage = (text: string, thinking?: string): void => {
    const contentEl = createAssistantMessage();

    if (thinking) {
      const blocksContainer = document.createElement("div");
      blocksContainer.className = "blocks-container";
      contentEl.appendChild(blocksContainer);

      const { block, output } = createExecBlock({
        type: "thinking",
        title: "Thought Process",
        statusOk: true,
        statusText: "✓ processed"
      });
      output.textContent = thinking;
      blocksContainer.appendChild(block);
    }

    const textContainer = document.createElement("div");
    textContainer.className = "markdown-text";
    textContainer.innerHTML = input.renderMarkdownHtml(text);
    contentEl.appendChild(textContainer);

    input.scrollToBottom();
  };

  const renderToolCalls = (container: HTMLDivElement, toolCalls: ToolCall[]): void => {
    for (const call of toolCalls) {
      const isCommand = call.toolName === "run_command";
      const statusOk = call.result.ok;

      let title: string;
      let outputContent: string;

      if (isCommand) {
        const cmd = typeof call.args.command === "string" ? call.args.command : "command";
        title = "Executed command";
        outputContent = `<span class="code-in">$ ${input.escapeHtml(cmd)}</span>

<span class="code-out">${input.escapeHtml(formatResult(call.result))}</span>`;
      } else {
        title = `Tool Call: ${call.toolName}`;
        outputContent = `<span class="code-dim">{</span>
<span class="code-in">${input.escapeHtml(formatArgs(call.args))}</span>
<span class="code-dim">}</span>

<span class="code-out">-> ${input.escapeHtml(formatResult(call.result))}</span>`;
      }

      const statusText = statusOk ? "done" : "failed";
      const { block, output } = createExecBlock({
        type: isCommand ? "command" : "tool",
        title,
        statusOk,
        statusText
      });

      output.innerHTML = outputContent;
      container.appendChild(block);
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
    const loadingBlock = contentEl.querySelector(
      ".exec-block.loading[data-exec-type=\"tool\"], .exec-block.loading[data-exec-type=\"command\"]"
    );
    if (loadingBlock) {
      loadingBlock.remove();
    }
    renderToolCalls(contentEl, [toolCall]);
  };

  return {
    addUserMessage,
    addAssistantMessage,
    createAssistantSurface,
    createExecBlock,
    renderToolCalls,
    appendCompletedToolCall
  };
}
