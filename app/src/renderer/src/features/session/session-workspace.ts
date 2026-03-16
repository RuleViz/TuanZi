import type { ChatSession } from "../../app/state";

interface SessionWorkspaceState {
  sessions: ChatSession[];
}

interface SelectWorkspaceDeps {
  state: SessionWorkspaceState;
  selectWorkspaceFromDialog: () => Promise<string | null>;
  switchSession: (sessionId: string) => void;
  getActiveSession: () => ChatSession | null;
  touchActiveSession: () => void;
  renderWorkspaceLabel: (workspace: string) => void;
  renderSessionList: () => void;
  persistSessions: () => void;
  refreshResumeSnapshot: () => Promise<void>;
  renderActiveConversation: () => void;
  createSession: (initial?: Partial<Pick<ChatSession, "title" | "workspace">>) => ChatSession;
}

interface CreateNewSessionDeps {
  state: SessionWorkspaceState;
  getActiveSession: () => ChatSession | null;
  createSession: (initial?: Partial<Pick<ChatSession, "title" | "workspace">>) => ChatSession;
  switchSession: (sessionId: string) => void;
  inputTextarea: HTMLTextAreaElement;
  autoResizeTextarea: () => void;
  clearPendingImage: () => void;
}

export async function selectWorkspace(input: SelectWorkspaceDeps): Promise<void> {
  const selected = await input.selectWorkspaceFromDialog();
  if (!selected) {
    return;
  }

  const sorted = [...input.state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const existing = sorted.find((session) => session.workspace === selected);

  if (existing) {
    input.switchSession(existing.id);
    return;
  }

  const active = input.getActiveSession();
  if (active && active.history.length === 0 && !active.workspace.trim()) {
    active.workspace = selected;
    input.touchActiveSession();
    input.renderWorkspaceLabel(selected);
    input.renderSessionList();
    input.persistSessions();
    void input.refreshResumeSnapshot().then(() => {
      input.renderActiveConversation();
    });
    return;
  }

  const session = input.createSession({ workspace: selected });
  input.state.sessions.push(session);
  input.switchSession(session.id);
}

export function createNewSession(input: CreateNewSessionDeps): void {
  const active = input.getActiveSession();
  const workspace = active?.workspace ?? "";
  const session = input.createSession({ workspace });
  input.state.sessions.push(session);
  input.switchSession(session.id);
  input.inputTextarea.value = "";
  input.autoResizeTextarea();
  input.clearPendingImage();
  input.inputTextarea.focus();
}
