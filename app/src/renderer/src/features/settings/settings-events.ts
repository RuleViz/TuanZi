interface SettingsEventState {
  hasLoadedMcp: boolean;
  isMcpLoading: boolean;
}

interface SettingsEventsDeps {
  state: SettingsEventState;
  settingsNav: HTMLElement;
  providerAddBtn: HTMLButtonElement;
  providerDeleteBtn: HTMLButtonElement;
  providerAddModelBtn: HTMLButtonElement;
  providerEnabledToggle: HTMLButtonElement;
  providerTestBtn: HTMLButtonElement;
  providerFetchModelsBtn: HTMLButtonElement;
  providerNameInput: HTMLInputElement;
  providerTypeInput: HTMLSelectElement;
  providerBaseUrlInput: HTMLInputElement;
  providerModelInput: HTMLInputElement;
  providerApiKeyInput: HTMLInputElement;
  mcpRefreshBtn: HTMLButtonElement;
  mcpAddBtn: HTMLButtonElement;
  closeMcpJsonModalBtn: HTMLButtonElement;
  mcpJsonCancelBtn: HTMLButtonElement;
  mcpJsonConfirmBtn: HTMLButtonElement;
  mcpJsonModal: HTMLDivElement;
  providerModelModalVisionToggle: HTMLButtonElement;
  closeProviderModelModalBtn: HTMLButtonElement;
  providerModelModalCancelBtn: HTMLButtonElement;
  providerModelModalConfirmBtn: HTMLButtonElement;
  providerModelModal: HTMLDivElement;
  providerModelModalIdInput: HTMLInputElement;
  providerModelModalDisplayNameInput: HTMLInputElement;
  setActiveSettingsPanel: (panel: string) => void;
  refreshMcpServers: () => Promise<void>;
  addDraftProvider: () => void;
  removeActiveDraftProvider: () => Promise<void>;
  openProviderModelModal: () => void;
  toggleSwitch: (button: HTMLButtonElement, enabled: boolean) => void;
  readToggle: (button: HTMLButtonElement) => boolean;
  updateActiveProviderFromInputs: () => void;
  testActiveProviderConnection: () => Promise<void>;
  fetchModelsForActiveProvider: () => Promise<void>;
  openMcpJsonModal: () => void;
  closeMcpJsonModal: () => void;
  saveMcpJsonConfig: () => Promise<void>;
  closeProviderModelModal: () => void;
  addModelToActiveProvider: () => void;
}

export function bindSettingsEvents(input: SettingsEventsDeps): void {
  const navItems = Array.from(input.settingsNav.querySelectorAll<HTMLButtonElement>(".settings-nav-item"));
  navItems.forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.dataset.panel ?? "provider";
      input.setActiveSettingsPanel(panel);
      if (panel === "mcp" && !input.state.hasLoadedMcp && !input.state.isMcpLoading) {
        void input.refreshMcpServers();
      }
    });
  });

  input.providerAddBtn.addEventListener("click", () => {
    input.addDraftProvider();
  });
  input.providerDeleteBtn.addEventListener("click", () => {
    input.removeActiveDraftProvider();
  });
  input.providerAddModelBtn.addEventListener("click", () => {
    input.openProviderModelModal();
  });
  input.providerEnabledToggle.addEventListener("click", () => {
    input.toggleSwitch(input.providerEnabledToggle, !input.readToggle(input.providerEnabledToggle));
    input.updateActiveProviderFromInputs();
  });
  input.providerTestBtn.addEventListener("click", () => {
    void input.testActiveProviderConnection();
  });
  input.providerFetchModelsBtn.addEventListener("click", () => {
    void input.fetchModelsForActiveProvider();
  });

  input.providerNameInput.addEventListener("input", input.updateActiveProviderFromInputs);
  input.providerTypeInput.addEventListener("change", input.updateActiveProviderFromInputs);
  input.providerBaseUrlInput.addEventListener("input", input.updateActiveProviderFromInputs);
  input.providerModelInput.addEventListener("input", input.updateActiveProviderFromInputs);
  input.providerApiKeyInput.addEventListener("input", input.updateActiveProviderFromInputs);

  input.mcpRefreshBtn.addEventListener("click", () => {
    void input.refreshMcpServers();
  });
  input.mcpAddBtn.addEventListener("click", input.openMcpJsonModal);
  input.closeMcpJsonModalBtn.addEventListener("click", input.closeMcpJsonModal);
  input.mcpJsonCancelBtn.addEventListener("click", input.closeMcpJsonModal);
  input.mcpJsonConfirmBtn.addEventListener("click", () => {
    void input.saveMcpJsonConfig();
  });
  input.mcpJsonModal.addEventListener("click", (event) => {
    if (event.target === input.mcpJsonModal) {
      input.closeMcpJsonModal();
    }
  });

  input.providerModelModalVisionToggle.addEventListener("click", () => {
    input.toggleSwitch(input.providerModelModalVisionToggle, !input.readToggle(input.providerModelModalVisionToggle));
  });
  input.closeProviderModelModalBtn.addEventListener("click", input.closeProviderModelModal);
  input.providerModelModalCancelBtn.addEventListener("click", input.closeProviderModelModal);
  input.providerModelModalConfirmBtn.addEventListener("click", () => {
    input.addModelToActiveProvider();
  });
  input.providerModelModal.addEventListener("click", (event) => {
    if (event.target === input.providerModelModal) {
      input.closeProviderModelModal();
    }
  });
  input.providerModelModalIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.addModelToActiveProvider();
    }
  });
  input.providerModelModalDisplayNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.addModelToActiveProvider();
    }
  });
}
