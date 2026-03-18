interface InitEventState {
  slashVisible: boolean;
  slashActiveIndex: number;
  isSending: boolean;
  isStopping: boolean;
  currentTaskId: string;
  isThinking: boolean;
  planModeEnabled: boolean;
}

interface InitEventsDeps {
  state: InitEventState;
  inputTextarea: HTMLTextAreaElement;
  inputBox: HTMLDivElement;
  slashCommandMenu: HTMLDivElement;
  attachImageBtn: HTMLButtonElement;
  imageFileInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  selectWorkspaceBtn: HTMLButtonElement;
  workspaceLabel: HTMLSpanElement;
  toggleSidebar: HTMLButtonElement;
  sidebar: HTMLElement;
  thinkingBtn: HTMLButtonElement;
  planModeBtn: HTMLButtonElement;
  newChatBtn: HTMLButtonElement;
  activeAgentChip: HTMLDivElement;
  agentLibraryModal: HTMLDivElement;
  closeAgentModalBtn: HTMLButtonElement;
  agentEditorBackBtn: HTMLButtonElement;
  agentEditorCancelBtn: HTMLButtonElement;
  agentEditorSaveBtn: HTMLButtonElement;
  agentEditorDeleteBtn: HTMLButtonElement;
  settingsBtn: HTMLButtonElement;
  closeSettingsModalBtn: HTMLButtonElement;
  settingsCancelBtn: HTMLButtonElement;
  settingsSaveBtn: HTMLButtonElement;
  providerModelModal: HTMLDivElement;
  mcpJsonModal: HTMLDivElement;
  settingsModal: HTMLDivElement;
  agentEditorView: HTMLDivElement;
  closeHistoryContextMenu: () => void;
  closeSlashCommandMenu: () => void;
  moveSlashSuggestionCursor: (offset: number) => void;
  applySlashSuggestion: (index: number) => Promise<void>;
  sendMessage: () => Promise<void>;
  autoResizeTextarea: () => void;
  updateSlashCommandMenu: () => void;
  attachImageFile: (file: File) => Promise<void>;
  stopMessage: (taskId: string) => Promise<{ ok: boolean; status: "accepted" | "already_stopping" | "not_found"; error?: string }>;
  selectWorkspace: () => Promise<void>;
  showError: (message: string) => void;
  createNewSession: () => void;
  refreshAgentData: () => Promise<void>;
  setAgentModalView: (view: "library" | "editor") => void;
  closeAgentModal: () => void;
  saveAgentFromEditor: () => Promise<void>;
  deleteAgentFromEditor: () => Promise<void>;
  openSettingsModal: () => Promise<void>;
  closeSettingsModal: () => void;
  saveSettings: () => Promise<void>;
  closeProviderModelModal: () => void;
  closeMcpJsonModal: () => void;
  bindAgentEditorEvents: () => void;
  bindSettingsEvents: () => void;
}

export function bindInitEvents(input: InitEventsDeps): void {
  document.addEventListener("click", (event) => {
    input.closeHistoryContextMenu();
    const target = event.target as HTMLElement | null;
    if (!target) {
      input.closeSlashCommandMenu();
      return;
    }
    if (!target.closest("#inputBox") && !target.closest("#slashCommandMenu")) {
      input.closeSlashCommandMenu();
    }
  });

  input.inputTextarea.addEventListener("keydown", (event) => {
    if (input.state.slashVisible) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        input.moveSlashSuggestionCursor(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        input.moveSlashSuggestionCursor(-1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        input.closeSlashCommandMenu();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        void input.applySlashSuggestion(input.state.slashActiveIndex);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void input.sendMessage();
    }
  });
  input.inputTextarea.addEventListener("input", () => {
    input.autoResizeTextarea();
    input.updateSlashCommandMenu();
  });
  input.inputTextarea.addEventListener("paste", (event) => {
    const clipboardItems = event.clipboardData?.items;
    if (!clipboardItems || clipboardItems.length === 0) {
      return;
    }
    for (const item of Array.from(clipboardItems)) {
      if (!item.type.startsWith("image/")) {
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      event.preventDefault();
      void input.attachImageFile(file);
      break;
    }
  });

  input.attachImageBtn.addEventListener("click", () => {
    if (input.state.isSending) {
      return;
    }
    input.imageFileInput.click();
  });
  input.imageFileInput.addEventListener("change", () => {
    const file = input.imageFileInput.files?.[0];
    if (!file) {
      return;
    }
    void input.attachImageFile(file);
  });

  input.sendBtn.addEventListener("click", () => {
    void input.sendMessage();
  });

  input.stopBtn.addEventListener("click", () => {
    if (!input.state.isSending || !input.state.currentTaskId) {
      return;
    }
    if (input.state.isStopping) {
      return;
    }
    input.state.isStopping = true;
    void input.stopMessage(input.state.currentTaskId)
      .then((result) => {
        if (!result.ok && result.status !== "not_found") {
          input.state.isStopping = false;
          input.showError(result.error || "停止任务失败");
          return;
        }
        if (result.status === "not_found") {
          input.state.isStopping = false;
        }
      })
      .catch((error) => {
        input.state.isStopping = false;
        input.showError(error instanceof Error ? error.message : String(error));
      });
  });

  input.selectWorkspaceBtn.addEventListener("click", () => {
    void input.selectWorkspace();
  });
  input.workspaceLabel.addEventListener("click", () => {
    void input.selectWorkspace();
  });

  input.toggleSidebar.addEventListener("click", () => {
    const isCollapsed = input.sidebar.classList.toggle("collapsed");
    input.toggleSidebar.classList.toggle("flipped", isCollapsed);
  });

  input.thinkingBtn.addEventListener("click", () => {
    input.state.isThinking = !input.state.isThinking;
    input.thinkingBtn.classList.toggle("active", input.state.isThinking);
    input.thinkingBtn.title = input.state.isThinking ? "关闭思考模式" : "开启思考模式";
  });

  input.planModeBtn.addEventListener("click", () => {
    input.state.planModeEnabled = !input.state.planModeEnabled;
    input.planModeBtn.classList.toggle("active", input.state.planModeEnabled);
    input.planModeBtn.title = input.state.planModeEnabled ? "关闭计划模式" : "开启计划模式";
  });

  input.newChatBtn.addEventListener("click", () => {
    if (input.state.isSending) {
      input.showError("请等待当前回复结束后再新建会话");
      return;
    }
    input.createNewSession();
  });

  input.activeAgentChip.addEventListener("click", () => {
    void input.refreshAgentData().then(() => {
      input.setAgentModalView("library");
      input.agentLibraryModal.classList.add("visible");
    });
  });
  input.closeAgentModalBtn.addEventListener("click", input.closeAgentModal);
  input.agentEditorBackBtn.addEventListener("click", () => input.setAgentModalView("library"));
  input.agentEditorCancelBtn.addEventListener("click", () => input.setAgentModalView("library"));
  input.agentEditorSaveBtn.addEventListener("click", () => {
    void input.saveAgentFromEditor();
  });
  input.agentEditorDeleteBtn.addEventListener("click", () => {
    void input.deleteAgentFromEditor();
  });
  input.agentLibraryModal.addEventListener("click", (event) => {
    if (event.target === input.agentLibraryModal) {
      input.closeAgentModal();
    }
  });

  input.settingsBtn.addEventListener("click", () => {
    void input.openSettingsModal();
  });
  input.closeSettingsModalBtn.addEventListener("click", input.closeSettingsModal);
  input.settingsCancelBtn.addEventListener("click", input.closeSettingsModal);
  input.settingsSaveBtn.addEventListener("click", () => {
    void input.saveSettings();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (input.providerModelModal.classList.contains("visible")) {
      input.closeProviderModelModal();
      return;
    }
    if (input.mcpJsonModal.classList.contains("visible")) {
      input.closeMcpJsonModal();
      return;
    }
    if (input.settingsModal.classList.contains("visible")) {
      input.closeSettingsModal();
      return;
    }
    if (input.agentLibraryModal.classList.contains("visible")) {
      if (input.agentEditorView.classList.contains("active")) {
        input.setAgentModalView("library");
      } else {
        input.closeAgentModal();
      }
    }
  });

  input.bindAgentEditorEvents();
  input.bindSettingsEvents();
}
