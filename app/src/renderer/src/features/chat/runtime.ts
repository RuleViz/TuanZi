import type { ChatSession, PendingChatImage } from "../../app/state";
import {
  buildStreamingListeners as buildStreamingListenersFeature,
  beginStreamingUi as beginStreamingUiFeature,
  endStreamingUi as endStreamingUiFeature,
  finalizeThinkingBlock as finalizeThinkingBlockFeature,
  type ExecBlock,
  type StreamUiState
} from "./stream-listeners";
import { sendMessage as sendMessageFeature } from "./send-message";

interface ChatRuntimeState extends StreamUiState {
  pendingImage: PendingChatImage | null;
  isThinking: boolean;
  planModeEnabled: boolean;
}

interface ChatRuntimeDeps {
  state: ChatRuntimeState;
  inputTextarea: HTMLTextAreaElement;
  inputBox: HTMLDivElement;
  sendBtn: HTMLButtonElement;
  attachImageBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  thinkingBtn: HTMLButtonElement;
  planModeBtn: HTMLButtonElement;
  sendingIndicator: HTMLDivElement;
  autoResizeTextarea: () => void;
  clearPendingImage: () => void;
  closeSlashCommandMenu: () => void;
  executeSlashCommand: (text: string) => Promise<boolean>;
  showError: (message: string) => void;
  addUserMessage: (text: string, image?: PendingChatImage | null, undoCallback?: (() => void) | null) => void;
  createAssistantSurface: () => {
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
  };
  scrollToBottom: () => void;
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
  smartScrollToBottom: () => void;
  createExecBlock: (opts: {
    type: "tool" | "command" | "thinking";
    title: string;
    statusOk?: boolean;
    statusText?: string;
    loading?: boolean;
  }) => { block: HTMLDivElement; output: HTMLPreElement };
  appendCompletedToolCall: (
    contentEl: HTMLDivElement,
    toolCall: {
      toolName: string;
      args: Record<string, unknown>;
      result: { ok: boolean; data?: unknown; error?: string };
      timestamp: string;
    }
  ) => void;
  resetSessionWorkbench: (sessionId: string) => void;
}

export interface ChatRuntime {
  sendMessage: () => Promise<void>;
}

export function createChatRuntime(input: ChatRuntimeDeps): ChatRuntime {
  const beginStreamingUi = (taskId: string): void => {
    beginStreamingUiFeature({
      state: input.state,
      taskId,
      inputBox: input.inputBox,
      sendBtn: input.sendBtn,
      attachImageBtn: input.attachImageBtn,
      stopBtn: input.stopBtn,
      thinkingBtn: input.thinkingBtn,
      planModeBtn: input.planModeBtn,
      sendingIndicator: input.sendingIndicator
    });
  };

  const endStreamingUi = (): void => {
    endStreamingUiFeature({
      state: input.state,
      inputBox: input.inputBox,
      sendBtn: input.sendBtn,
      attachImageBtn: input.attachImageBtn,
      stopBtn: input.stopBtn,
      thinkingBtn: input.thinkingBtn,
      planModeBtn: input.planModeBtn,
      sendingIndicator: input.sendingIndicator,
      inputTextarea: input.inputTextarea,
      smartScrollToBottom: input.smartScrollToBottom
    });
  };

  const buildStreamingListeners = (payload: {
    taskId: string;
    contentEl: HTMLDivElement;
    blocksContainer: HTMLDivElement;
    textContainer: HTMLDivElement;
    initialThinkingText?: string;
    existingThinkingBlock?: ExecBlock | null;
  }) => {
    return buildStreamingListenersFeature({
      state: input.state,
      ...payload,
      renderMarkdownHtml: input.renderMarkdownHtml,
      smartScrollToBottom: input.smartScrollToBottom,
      createExecBlock: input.createExecBlock,
      appendCompletedToolCall: input.appendCompletedToolCall
    });
  };

  const finalizeThinkingBlock = (thinkingBlock: ExecBlock | null): void => {
    finalizeThinkingBlockFeature(thinkingBlock);
  };

  const sendMessage = async (): Promise<void> => {
    await sendMessageFeature({
      state: input.state,
      inputTextarea: input.inputTextarea,
      beginStreamingUi,
      endStreamingUi,
      autoResizeTextarea: input.autoResizeTextarea,
      clearPendingImage: input.clearPendingImage,
      closeSlashCommandMenu: input.closeSlashCommandMenu,
      executeSlashCommand: input.executeSlashCommand,
      showError: input.showError,
      addUserMessage: input.addUserMessage,
      createAssistantSurface: input.createAssistantSurface,
      scrollToBottom: input.scrollToBottom,
      buildStreamingListeners,
      finalizeThinkingBlock,
      getActiveAgent: input.getActiveAgent,
      ensureActiveSession: input.ensureActiveSession,
      renderToolCalls: input.renderToolCalls,
      renderMarkdownHtml: input.renderMarkdownHtml,
      syncInterruptedTurn: input.syncInterruptedTurn,
      resetSessionWorkbench: input.resetSessionWorkbench,
      truncateTitleFromInput: input.truncateTitleFromInput,
      touchActiveSession: input.touchActiveSession,
      persistSessions: input.persistSessions,
      renderSessionList: input.renderSessionList,
      onUndoTurn: input.onUndoTurn,
      defaultSessionTitle: input.defaultSessionTitle,
      escapeHtml: input.escapeHtml
    });
  };

  return {
    sendMessage
  };
}
