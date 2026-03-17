import type { ExecBlock, StreamingListeners, StreamUiState } from "./stream-listeners";
import type { ChatSession, PendingChatImage } from "../../app/state";

export interface SendMessageDeps {
  state: StreamUiState & {
    pendingImage: PendingChatImage | null;
    isThinking: boolean;
  };
  inputTextarea: HTMLTextAreaElement;
  beginStreamingUi: (taskId: string) => void;
  endStreamingUi: () => void;
  autoResizeTextarea: () => void;
  clearPendingImage: () => void;
  closeSlashCommandMenu: () => void;
  executeSlashCommand: (text: string) => Promise<boolean>;
  showError: (msg: string) => void;
  addUserMessage: (text: string, image?: PendingChatImage | null, undoCallback?: (() => void) | null) => void;
  createAssistantSurface: () => {
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
  };
  scrollToBottom: () => void;
  buildStreamingListeners: (input: {
    taskId: string;
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
  }) => StreamingListeners;
  finalizeThinkingBlock: (thinkingBlock: ExecBlock | null) => void;
  getActiveAgent: () => { id: string } | null;
  ensureActiveSession: () => ChatSession;
  renderToolCalls: (
    contentEl: HTMLDivElement,
    toolCalls: Array<{
      toolName: string;
      args: Record<string, unknown>;
      result: { ok: boolean; data?: unknown; error?: string };
      timestamp: string;
    }>
  ) => void;
  renderMarkdownHtml: (text: string) => string;
  syncInterruptedTurn: (
    session: ChatSession,
    input: { user: string; assistant: string; thinking?: string; interrupted: boolean }
  ) => void;
  truncateTitleFromInput: (input: string) => string;
  touchActiveSession: () => void;
  persistSessions: () => void;
  renderSessionList: () => void;
  onUndoTurn?: (turnIndex: number) => void;
  defaultSessionTitle: string;
  escapeHtml: (text: string) => string;
}

export async function sendMessage(input: SendMessageDeps): Promise<void> {
  const text = input.inputTextarea.value.trim();
  const pendingImage = input.state.pendingImage ? { ...input.state.pendingImage } : null;
  const hasImage = Boolean(pendingImage);
  if ((!text && !hasImage) || input.state.isSending) {
    return;
  }

  if (text.startsWith("/")) {
    if (hasImage) {
      input.showError("Slash commands do not support image attachments");
      return;
    }
    const handled = await input.executeSlashCommand(text);
    if (handled) {
      input.inputTextarea.value = "";
      input.autoResizeTextarea();
      input.closeSlashCommandMenu();
    }
    return;
  }

  const active = input.ensureActiveSession();
  if (!active.workspace) {
    input.showError("Please select a workspace first");
    return;
  }

  const modelMessage = text || "请根据我上传的图片进行分析并回答。";
  const userHistoryText = hasImage
    ? text
      ? `[图片] ${pendingImage!.name}\n${text}`
      : `[图片] ${pendingImage!.name}`
    : text;

  const newTaskId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const turnIndex = active.history.length;
  const undoCallback = input.onUndoTurn ? () => input.onUndoTurn!(turnIndex) : null;

  input.state.currentStreamText = "";
  input.state.currentRenderedToolCalls = 0;
  input.beginStreamingUi(newTaskId);
  input.inputTextarea.value = "";
  input.autoResizeTextarea();
  input.clearPendingImage();

  input.addUserMessage(text, pendingImage, undoCallback);
  const surface = input.createAssistantSurface();
  input.scrollToBottom();

  const listeners = input.buildStreamingListeners({
    taskId: newTaskId,
    contentEl: surface.contentEl,
    blocksContainer: surface.blocksContainer,
    textContainer: surface.textContainer
  });

  try {
    const activeAgent = input.getActiveAgent();
    const result = await window.tuanzi.sendMessage({
      taskId: newTaskId,
      sessionId: active.id,
      message: modelMessage,
      ...(pendingImage
        ? {
            images: [
              {
                name: pendingImage.name,
                mimeType: pendingImage.mimeType,
                dataUrl: pendingImage.dataUrl
              }
            ]
          }
        : {}),
      workspace: active.workspace,
      agentId: activeAgent?.id ?? null,
      thinking: input.state.isThinking
    });

    listeners.dispose();
    input.finalizeThinkingBlock(listeners.getThinkingBlock());

    if (result.ok) {
      const loadingBlocks = surface.contentEl.querySelectorAll(".exec-block.loading");
      loadingBlocks.forEach((block) => block.remove());

      const activeText = listeners.getActiveTextContainer();
      if (!input.state.currentStreamText && result.summary) {
        activeText.innerHTML = input.renderMarkdownHtml(result.summary);
      }

      if (result.toolCalls && result.toolCalls.length > input.state.currentRenderedToolCalls) {
        input.renderToolCalls(surface.contentEl, result.toolCalls.slice(input.state.currentRenderedToolCalls));
      }

      const allTextContainers = surface.contentEl.querySelectorAll(".markdown-text");
      allTextContainers.forEach((tc) => {
        if (!tc.innerHTML.trim()) {
          tc.remove();
        }
      });

      const assistantText = input.state.currentStreamText || result.summary || "";
      input.syncInterruptedTurn(active, {
        user: userHistoryText,
        assistant: assistantText,
        thinking: listeners.getCurrentThinkingText() || undefined,
        interrupted: false
      });

      if (active.history.length === 1 && (!active.title || active.title === input.defaultSessionTitle)) {
        active.title = input.truncateTitleFromInput(text || userHistoryText);
      }

      input.touchActiveSession();
      input.persistSessions();
      input.renderSessionList();
    } else if (result.interrupted && result.resumeSnapshot) {
      input.syncInterruptedTurn(active, {
        user: userHistoryText,
        assistant: result.resumeSnapshot.streamedText,
        thinking: result.resumeSnapshot.streamedThinking || undefined,
        interrupted: true
      });
      input.touchActiveSession();
      input.persistSessions();
      input.renderSessionList();
    } else {
      const activeText = listeners.getActiveTextContainer();
      activeText.innerHTML = `<p style="color: var(--status-err);">${input.escapeHtml(result.error || "Execution failed")}</p>`;
    }
  } catch (error) {
    listeners.dispose();
    const msg = error instanceof Error ? error.message : String(error);
    const activeText = listeners.getActiveTextContainer();
    activeText.innerHTML = `<p style="color: var(--status-err);">${input.escapeHtml(msg)}</p>`;
  } finally {
    input.endStreamingUi();
  }
}

