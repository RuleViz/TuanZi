interface BootstrapDeps {
  loadSessionsFromStorage: () => void;
  renderSessionList: () => void;
  ensureActiveSession: () => { workspace: string };
  renderWorkspaceLabel: (workspace: string) => void;
  renderActiveConversation: () => void;
  refreshResumeSnapshot: () => Promise<void>;
  bindTopBarDrag: () => void;
  bindInitEvents: () => void;
  refreshAgentData: (preferredAgent?: string | null) => Promise<void>;
  loadActiveAgentPreference: () => string | null;
  autoResizeTextarea: () => void;
  clearPendingImage: () => void;
  focusInput: () => void;
}

export async function bootstrapRendererApp(input: BootstrapDeps): Promise<void> {
  input.loadSessionsFromStorage();
  input.renderSessionList();
  const active = input.ensureActiveSession();
  input.renderWorkspaceLabel(active.workspace);
  input.renderActiveConversation();
  await input.refreshResumeSnapshot();
  input.renderActiveConversation();
  input.bindTopBarDrag();
  input.bindInitEvents();

  await input.refreshAgentData(input.loadActiveAgentPreference());
  input.autoResizeTextarea();
  input.clearPendingImage();
  input.focusInput();
}
