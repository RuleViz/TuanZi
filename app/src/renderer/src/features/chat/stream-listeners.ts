export interface StreamUiState {
  isSending: boolean;
  isStopping: boolean;
  currentTaskId: string;
  currentRenderedToolCalls: number;
  currentStreamText: string;
}

export interface ExecBlock {
  block: HTMLDivElement;
  output: HTMLPreElement;
}

export interface StreamingListeners {
  getCurrentThinkingText: () => string;
  getThinkingBlock: () => ExecBlock | null;
  getActiveTextContainer: () => HTMLDivElement;
  dispose: () => void;
}

export function beginStreamingUi(input: {
  state: StreamUiState;
  taskId: string;
  inputBox: HTMLDivElement;
  sendBtn: HTMLButtonElement;
  attachImageBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  planModeBtn: HTMLButtonElement;
  sendingIndicator: HTMLDivElement;
}): void {
  input.state.isSending = true;
  input.state.isStopping = false;
  input.state.currentTaskId = input.taskId;
  input.inputBox.classList.add("disabled");
  input.sendBtn.disabled = true;
  input.attachImageBtn.disabled = true;
  input.sendBtn.style.display = "none";
  input.stopBtn.style.display = "flex";
  input.planModeBtn.disabled = true;
  input.sendingIndicator.classList.add("visible");
}

export function endStreamingUi(input: {
  state: StreamUiState;
  inputBox: HTMLDivElement;
  sendBtn: HTMLButtonElement;
  attachImageBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  planModeBtn: HTMLButtonElement;
  sendingIndicator: HTMLDivElement;
  inputTextarea: HTMLTextAreaElement;
  smartScrollToBottom: () => void;
}): void {
  input.state.isSending = false;
  input.state.isStopping = false;
  input.state.currentTaskId = "";
  input.state.currentRenderedToolCalls = 0;
  input.inputBox.classList.remove("disabled");
  input.sendBtn.disabled = false;
  input.attachImageBtn.disabled = false;
  input.sendBtn.style.display = "flex";
  input.stopBtn.style.display = "none";
  input.planModeBtn.disabled = false;
  input.sendingIndicator.classList.remove("visible");
  input.smartScrollToBottom();
  input.inputTextarea.focus();
}

export function buildStreamingListeners(input: {
  state: StreamUiState;
  taskId: string;
  contentEl: HTMLDivElement;
  blocksContainer: HTMLDivElement;
  textContainer: HTMLDivElement;
  initialThinkingText?: string;
  existingThinkingBlock?: ExecBlock | null;
  renderMarkdownHtml: (text: string) => string;
  smartScrollToBottom: () => void;
  createExecBlock: (opts: {
    type: "thinking" | "command" | "tool";
    title: string;
    loading?: boolean;
    content?: string;
    expanded?: boolean;
  }) => ExecBlock;
  appendCompletedToolCall: (
    contentEl: HTMLDivElement,
    toolCall: {
      id?: string;
      toolName: string;
      args: Record<string, unknown>;
      result: { ok: boolean; data?: unknown; error?: string };
      timestamp: string;
    }
  ) => void;
  getOrCreateToolCallsContainer: (parentEl: HTMLDivElement) => HTMLDivElement;
  addToolCallRow: (container: HTMLDivElement, toolName: string, status: "loading" | "done" | "failed", toolCallId?: string) => HTMLDivElement;
  updateSubagentSnapshots: (parentEl: HTMLDivElement, snapshots: import("../../../../shared/ipc-contracts").SubagentSnapshotData[]) => void;
}): StreamingListeners {
  let thinkingBlock = input.existingThinkingBlock ?? null;
  let planPreviewBlock: ExecBlock | null = null;
  let currentThinkingText = input.initialThinkingText ?? "";
  let activeTextContainer = input.textContainer;
  let segmentStart = 0;
  const completedBeforeStartCounts = new Map<string, number>();

  const isCurrentTask = (taskId: string): boolean => taskId === input.taskId;
  const normalizeToolName = (toolName: string): string => toolName.trim().toLowerCase();
  const findLoadingRows = (): HTMLDivElement[] => {
    const container = input.contentEl.querySelector(".tool-calls-container");
    if (!container) {
      return [];
    }
    return Array.from(container.querySelectorAll<HTMLDivElement>(".tool-call-row.status-loading"));
  };
  const getBufferKey = (toolName: string, toolCallId?: string): string => {
    const normalizedToolName = normalizeToolName(toolName);
    const normalizedId = typeof toolCallId === "string" ? toolCallId.trim() : "";
    return normalizedId || normalizedToolName;
  };
  const hasLoadingRow = (toolName: string, toolCallId?: string): boolean => {
    const normalizedToolName = normalizeToolName(toolName);
    const normalizedId = typeof toolCallId === "string" ? toolCallId.trim() : "";
    return findLoadingRows().some((row) =>
      normalizedId ? row.dataset.toolCallId === normalizedId : row.dataset.toolName === normalizedToolName
    );
  };
  const bufferCompletedBeforeStart = (toolName: string, toolCallId?: string): void => {
    const key = getBufferKey(toolName, toolCallId);
    if (!key) {
      return;
    }
    const current = completedBeforeStartCounts.get(key) ?? 0;
    completedBeforeStartCounts.set(key, current + 1);
  };
  const consumeBufferedCompleted = (toolName: string, toolCallId?: string): boolean => {
    const key = getBufferKey(toolName, toolCallId);
    const current = completedBeforeStartCounts.get(key) ?? 0;
    if (current <= 0) {
      return false;
    }
    if (current === 1) {
      completedBeforeStartCounts.delete(key);
    } else {
      completedBeforeStartCounts.set(key, current - 1);
    }
    return true;
  };

  const removePhaseListener = window.tuanzi.onPhase((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
  });

  const removeDeltaListener = window.tuanzi.onDelta((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
    input.state.currentStreamText += data.delta;
    const segmentText = input.state.currentStreamText.substring(segmentStart);
    activeTextContainer.innerHTML = input.renderMarkdownHtml(segmentText);
    input.smartScrollToBottom();
  });

  const removeThinkingListener = window.tuanzi.onThinking((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
    if (!thinkingBlock) {
      thinkingBlock = input.createExecBlock({
        type: "thinking",
        title: "Thought Process",
        loading: true
      });
      thinkingBlock.block.classList.add("expanded");
      input.blocksContainer.appendChild(thinkingBlock.block);
    }
    thinkingBlock.block.classList.add("loading");
    currentThinkingText += data.delta;
    thinkingBlock.output.textContent = currentThinkingText;
    thinkingBlock.block.dataset.expandedContent = currentThinkingText;
    input.smartScrollToBottom();
  });

  const removePlanPreviewListener = window.tuanzi.onPlanPreview((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
    if (!planPreviewBlock) {
      planPreviewBlock = input.createExecBlock({
        type: "tool",
        title: "Plan Draft"
      });
      planPreviewBlock.block.classList.add("expanded");
      input.blocksContainer.appendChild(planPreviewBlock.block);
    }
    planPreviewBlock.output.textContent = data.preview;
    input.smartScrollToBottom();
  });

  const removeLogListener = window.tuanzi.onLog((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
    if (data.message.startsWith("[tool] start ")) {
      const raw = data.message.replace("[tool] start ", "");
      const toolName = raw.split(" ")[0];
      const toolCallId = raw.match(/\bid=([^\s]+)/)?.[1] ?? "";
      const normalizedToolName = normalizeToolName(toolName);
      if (!normalizedToolName) {
        return;
      }
      if (consumeBufferedCompleted(normalizedToolName, toolCallId)) {
        return;
      }
      const tcContainer = input.getOrCreateToolCallsContainer(input.contentEl);
      input.addToolCallRow(tcContainer, normalizedToolName, "loading", toolCallId || undefined);
      input.smartScrollToBottom();
    }
  });

  const removeToolCallCompletedListener = window.tuanzi.onToolCallCompleted((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
    const normalizedToolName = normalizeToolName(data.toolCall.toolName);
    const matchedLoading = hasLoadingRow(normalizedToolName, data.toolCall.id);
    input.appendCompletedToolCall(input.contentEl, data.toolCall);
    if (!matchedLoading) {
      bufferCompletedBeforeStart(normalizedToolName, data.toolCall.id);
    }
    input.state.currentRenderedToolCalls += 1;

    segmentStart = input.state.currentStreamText.length;
    activeTextContainer = document.createElement("div");
    activeTextContainer.className = "markdown-text";
    input.contentEl.appendChild(activeTextContainer);

    input.smartScrollToBottom();
  });

  const removeSubagentSnapshotListener = window.tuanzi.onSubagentSnapshot((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.updateSubagentSnapshots(input.contentEl, data.snapshots);
    input.smartScrollToBottom();
  });

  return {
    getCurrentThinkingText: (): string => currentThinkingText,
    getThinkingBlock: () => thinkingBlock,
    getActiveTextContainer: () => activeTextContainer,
    dispose: (): void => {
      removePhaseListener();
      removeDeltaListener();
      removeThinkingListener();
      removePlanPreviewListener();
      removeLogListener();
      removeToolCallCompletedListener();
      removeSubagentSnapshotListener();
    }
  };
}

export function finalizeThinkingBlock(thinkingBlock: ExecBlock | null): void {
  if (!thinkingBlock) {
    return;
  }
  if (thinkingBlock.output.textContent) {
    thinkingBlock.block.dataset.expandedContent = thinkingBlock.output.textContent;
  }
  thinkingBlock.block.classList.remove("loading");
  thinkingBlock.block.classList.remove("expanded");
  const title = thinkingBlock.block.querySelector(".exec-title");
  const existingBadge = title?.querySelector(".status-badge");
  if (!existingBadge && title) {
    const badge = document.createElement("span");
    badge.className = "status-badge status-ok";
    badge.textContent = "processed";
    title.appendChild(badge);
  }
}
