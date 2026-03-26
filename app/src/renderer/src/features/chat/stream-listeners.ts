import type { UserQuestionRequestData } from "../../../../shared/ipc-contracts";

export const THINKING_SEGMENT_SEPARATOR = "\n\n---THINKING_SEGMENT---\n\n";

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
  getAllThinkingBlocks: () => ExecBlock[];
  getActiveTextContainer: () => HTMLDivElement;
  dispose: () => void;
}

function settleThinkingBlockTitle(thinkingBlock: ExecBlock, titleText: string): void {
  const titleEl = thinkingBlock.block.querySelector(".exec-title");
  if (!titleEl) {
    return;
  }
  const chevron = titleEl.querySelector(".chevron");
  const icon = titleEl.querySelector(".tool-icon");
  const existingBadge = titleEl.querySelector(".status-badge");
  const chevronHtml = chevron ? chevron.outerHTML : "";
  const iconHtml = icon ? icon.outerHTML : "";
  const badgeHtml =
    existingBadge?.outerHTML ?? '<span class="status-badge status-ok">processed</span>';
  titleEl.innerHTML = `${chevronHtml}${iconHtml}${titleText}${badgeHtml}`;
}

function getSettledThinkingTitle(thinkingBlock: ExecBlock): string {
  const startedAtRaw = thinkingBlock.block.dataset.thinkingStartedAt;
  const startedAt = Number(startedAtRaw);
  if (Number.isFinite(startedAt)) {
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return `Thought for ${elapsed}s`;
  }
  return "Thought";
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
  const allThinkingBlocks: ExecBlock[] = input.existingThinkingBlock ? [input.existingThinkingBlock] : [];
  let planPreviewBlock: ExecBlock | null = null;
  let currentThinkingText = input.initialThinkingText ?? "";
  let currentSegmentThinkingText = input.initialThinkingText ?? "";
  let thinkingSegmentStartTime = Date.now();
  let needNewThinkingBlock = false;
  let activeTextContainer = input.textContainer;
  let segmentStart = 0;
  let thinkingInsertBefore: HTMLElement | null = null;
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

  const finalizeCurrentThinkingBlock = (): void => {
    if (!thinkingBlock) {
      return;
    }
    const elapsed = Math.max(0, Math.round((Date.now() - thinkingSegmentStartTime) / 1000));
    settleThinkingBlockTitle(thinkingBlock, `Thought for ${elapsed}s`);
    thinkingBlock.block.classList.remove("loading");
    thinkingBlock.block.classList.remove("expanded");
    if (thinkingBlock.output.textContent) {
      thinkingBlock.block.dataset.expandedContent = thinkingBlock.output.textContent;
    }
    currentThinkingText += THINKING_SEGMENT_SEPARATOR;
  };

  const removeThinkingListener = window.tuanzi.onThinking((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.state.currentTaskId = data.taskId;
    if (!thinkingBlock || needNewThinkingBlock) {
      if (thinkingBlock && needNewThinkingBlock) {
        finalizeCurrentThinkingBlock();
      }
      thinkingBlock = input.createExecBlock({
        type: "thinking",
        title: "Thinking...",
        loading: true
      });
      thinkingBlock.block.classList.add("expanded");
      allThinkingBlocks.push(thinkingBlock);
      currentSegmentThinkingText = "";
      thinkingSegmentStartTime = Date.now();
      thinkingBlock.block.dataset.thinkingStartedAt = String(thinkingSegmentStartTime);
      needNewThinkingBlock = false;
      if (thinkingInsertBefore) {
        input.contentEl.insertBefore(thinkingBlock.block, thinkingInsertBefore);
      } else {
        input.blocksContainer.appendChild(thinkingBlock.block);
      }
    }
    thinkingBlock.block.classList.add("loading");
    currentThinkingText += data.delta;
    currentSegmentThinkingText += data.delta;
    thinkingBlock.output.textContent = currentSegmentThinkingText;
    thinkingBlock.block.dataset.expandedContent = currentSegmentThinkingText;
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

    needNewThinkingBlock = true;

    segmentStart = input.state.currentStreamText.length;
    activeTextContainer = document.createElement("div");
    activeTextContainer.className = "markdown-text";
    input.contentEl.appendChild(activeTextContainer);
    thinkingInsertBefore = activeTextContainer;

    input.smartScrollToBottom();
  });

  const removeSubagentSnapshotListener = window.tuanzi.onSubagentSnapshot((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    input.updateSubagentSnapshots(input.contentEl, data.snapshots);
    input.smartScrollToBottom();
  });

  const removeUserQuestionListener = window.tuanzi.onUserQuestion((data) => {
    if (!isCurrentTask(data.taskId)) {
      return;
    }
    renderUserQuestionForm(data, input.contentEl, input.smartScrollToBottom);
  });

  return {
    getCurrentThinkingText: (): string => currentThinkingText,
    getThinkingBlock: () => thinkingBlock,
    getAllThinkingBlocks: () => allThinkingBlocks,
    getActiveTextContainer: () => activeTextContainer,
    dispose: (): void => {
      removePhaseListener();
      removeDeltaListener();
      removeThinkingListener();
      removePlanPreviewListener();
      removeLogListener();
      removeToolCallCompletedListener();
      removeSubagentSnapshotListener();
      removeUserQuestionListener();
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
  settleThinkingBlockTitle(thinkingBlock, getSettledThinkingTitle(thinkingBlock));
  thinkingBlock.block.classList.remove("loading");
  thinkingBlock.block.classList.remove("expanded");
}

export function finalizeAllThinkingBlocks(blocks: ExecBlock[]): void {
  for (const block of blocks) {
    finalizeThinkingBlock(block);
  }
}

function escapeFormHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderUserQuestionForm(
  data: UserQuestionRequestData,
  contentEl: HTMLDivElement,
  scrollToBottom: () => void
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "uq-form-wrapper";
  wrapper.dataset.requestId = data.requestId;

  let headerHtml = "";
  if (data.title) {
    headerHtml += `<div class="uq-title">${escapeFormHtml(data.title)}</div>`;
  }
  if (data.description) {
    headerHtml += `<div class="uq-description">${escapeFormHtml(data.description)}</div>`;
  }
  if (headerHtml) {
    const header = document.createElement("div");
    header.className = "uq-header";
    header.innerHTML = headerHtml;
    wrapper.appendChild(header);
  }

  const formState: Record<string, string | string[]> = {};

  for (const field of data.fields) {
    if (field.default_value !== undefined) {
      formState[field.id] = field.default_value;
    } else if (field.type === "multi_select") {
      formState[field.id] = [];
    } else {
      formState[field.id] = "";
    }

    const fieldEl = document.createElement("div");
    fieldEl.className = "uq-field";
    fieldEl.dataset.fieldId = field.id;

    const labelEl = document.createElement("div");
    labelEl.className = "uq-field-label";
    labelEl.textContent = field.question;
    if (field.required !== false) {
      const reqSpan = document.createElement("span");
      reqSpan.className = "uq-required";
      reqSpan.textContent = " *";
      labelEl.appendChild(reqSpan);
    }
    fieldEl.appendChild(labelEl);

    if (field.type === "single_select" && field.options) {
      const optionsContainer = document.createElement("div");
      optionsContainer.className = "uq-options";
      for (const opt of field.options) {
        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.className = "uq-option-btn";
        if (formState[field.id] === opt.value) {
          optBtn.classList.add("selected");
        }
        optBtn.dataset.value = opt.value;
        let optHtml = `<span class="uq-option-label">${escapeFormHtml(opt.label)}</span>`;
        if (opt.description) {
          optHtml += `<span class="uq-option-desc">${escapeFormHtml(opt.description)}</span>`;
        }
        optBtn.innerHTML = optHtml;
        optBtn.addEventListener("click", () => {
          formState[field.id] = opt.value;
          optionsContainer.querySelectorAll(".uq-option-btn").forEach((b) => b.classList.remove("selected"));
          optBtn.classList.add("selected");
        });
        optionsContainer.appendChild(optBtn);
      }
      fieldEl.appendChild(optionsContainer);
    } else if (field.type === "multi_select" && field.options) {
      const optionsContainer = document.createElement("div");
      optionsContainer.className = "uq-options uq-options-multi";
      const defaultArr = Array.isArray(field.default_value) ? field.default_value : [];
      for (const opt of field.options) {
        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.className = "uq-option-btn";
        if (defaultArr.includes(opt.value)) {
          optBtn.classList.add("selected");
        }
        optBtn.dataset.value = opt.value;
        let optHtml = `<span class="uq-option-label">${escapeFormHtml(opt.label)}</span>`;
        if (opt.description) {
          optHtml += `<span class="uq-option-desc">${escapeFormHtml(opt.description)}</span>`;
        }
        optBtn.innerHTML = optHtml;
        optBtn.addEventListener("click", () => {
          const current = (formState[field.id] as string[]) || [];
          const idx = current.indexOf(opt.value);
          if (idx >= 0) {
            current.splice(idx, 1);
            optBtn.classList.remove("selected");
          } else {
            current.push(opt.value);
            optBtn.classList.add("selected");
          }
          formState[field.id] = current;
        });
        optionsContainer.appendChild(optBtn);
      }
      fieldEl.appendChild(optionsContainer);
    } else {
      const textInput = document.createElement("textarea");
      textInput.className = "uq-text-input";
      textInput.placeholder = field.placeholder || "";
      textInput.rows = 2;
      if (typeof field.default_value === "string") {
        textInput.value = field.default_value;
      }
      textInput.addEventListener("input", () => {
        formState[field.id] = textInput.value;
      });
      fieldEl.appendChild(textInput);
    }

    wrapper.appendChild(fieldEl);
  }

  const actionsEl = document.createElement("div");
  actionsEl.className = "uq-actions";

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "uq-btn uq-btn-skip";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => {
    wrapper.classList.add("uq-submitted");
    disableForm(wrapper);
    showFormStatus(wrapper, "Skipped");
    window.tuanzi.answerUserQuestion({
      requestId: data.requestId,
      answers: {},
      skipped: true
    });
  });
  actionsEl.appendChild(skipBtn);

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "uq-btn uq-btn-submit";
  submitBtn.textContent = "Submit";
  submitBtn.addEventListener("click", () => {
    for (const field of data.fields) {
      if (field.required !== false) {
        const val = formState[field.id];
        if (!val || (Array.isArray(val) && val.length === 0)) {
          const fieldEl = wrapper.querySelector(`[data-field-id="${field.id}"]`);
          if (fieldEl) {
            fieldEl.classList.add("uq-field-error");
            setTimeout(() => fieldEl.classList.remove("uq-field-error"), 1500);
          }
          return;
        }
      }
    }
    wrapper.classList.add("uq-submitted");
    disableForm(wrapper);
    showFormStatus(wrapper, "Submitted");
    window.tuanzi.answerUserQuestion({
      requestId: data.requestId,
      answers: formState,
      skipped: false
    });
  });
  actionsEl.appendChild(submitBtn);

  wrapper.appendChild(actionsEl);
  contentEl.appendChild(wrapper);
  scrollToBottom();
}

function disableForm(wrapper: HTMLDivElement): void {
  wrapper.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.disabled = true;
  });
  wrapper.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((ta) => {
    ta.disabled = true;
  });
}

function showFormStatus(wrapper: HTMLDivElement, text: string): void {
  const existing = wrapper.querySelector(".uq-status");
  if (existing) {
    existing.textContent = text;
    return;
  }
  const statusEl = document.createElement("div");
  statusEl.className = "uq-status";
  statusEl.textContent = text;
  wrapper.appendChild(statusEl);
}
