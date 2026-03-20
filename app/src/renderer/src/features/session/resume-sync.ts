import type { ChatSession, ConversationToolCall } from "../../app/state";

interface RefreshResumeDeps {
  getActiveSession: () => ChatSession | null;
  showError: (message: string) => void;
  syncInterruptedTurn: (
    session: ChatSession,
    input: { user: string; assistant: string; thinking?: string; interrupted: boolean; toolCalls?: ConversationToolCall[] }
  ) => void;
  touchActiveSession: () => void;
  persistSessions: () => void;
  renderSessionList: () => void;
}

export async function refreshResumeSnapshot(input: RefreshResumeDeps): Promise<void> {
  const active = input.getActiveSession();
  if (!active || !active.workspace.trim()) {
    return;
  }

  const result = await window.tuanzi.getResumeState({
    sessionId: active.id,
    workspace: active.workspace
  });

  if (!result.ok) {
    input.showError(result.error || "Failed to load interrupted task");
    return;
  }

  const snapshot = result.resumeSnapshot ?? null;
  if (!snapshot) {
    return;
  }

  input.syncInterruptedTurn(active, {
    user: snapshot.message,
    assistant: snapshot.streamedText,
    thinking: snapshot.streamedThinking || undefined,
    interrupted: true,
    toolCalls: snapshot.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      toolName: toolCall.name,
      args: { ...toolCall.args },
      result: { ...toolCall.result }
    }))
  });
  input.touchActiveSession();
  input.persistSessions();
  input.renderSessionList();
}
