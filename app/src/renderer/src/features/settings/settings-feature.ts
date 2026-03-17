import type {
  AgentBackendConfig,
  McpDashboardServer,
  ProviderConfig,
  SkillCatalogItem
} from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";
import type { ChatSession, SettingsDraft } from "../../app/state";
import { createMcpSettingsController } from "./mcp-settings";
import { createProviderSettingsController } from "./provider-settings";
import { bindSettingsEvents as bindSettingsEventsFeature } from "./settings-events";
import { createSettingsModalController } from "./settings-modal";

interface SettingsFeatureState {
  sessions: ChatSession[];
  agentConfig: AgentBackendConfig | null;
  settingsDraft: SettingsDraft | null;
  skillCatalog: SkillCatalogItem[];
  mcpServers: McpDashboardServer[];
  expandedMcpServerIds: Set<string>;
  isMcpLoading: boolean;
  hasLoadedMcp: boolean;
  mcpLoadToken: number;
}

interface SettingsFeatureDeps {
  state: SettingsFeatureState;
  defaultProviderType: string;
  defaultProviderBaseUrl: string;
  settingsNav: HTMLElement;
  settingsModal: HTMLDivElement;
  skillsCatalogList: HTMLDivElement;
  providerList: HTMLDivElement;
  providerEditorTitle: HTMLDivElement;
  providerNameInput: HTMLInputElement;
  providerTypeInput: HTMLSelectElement;
  providerBaseUrlInput: HTMLInputElement;
  providerModelInput: HTMLInputElement;
  providerApiKeyInput: HTMLInputElement;
  providerEnabledToggle: HTMLButtonElement;
  providerDeleteBtn: HTMLButtonElement;
  providerModelList: HTMLDivElement;
  providerAddBtn: HTMLButtonElement;
  providerAddModelBtn: HTMLButtonElement;
  providerTestBtn: HTMLButtonElement;
  providerFetchModelsBtn: HTMLButtonElement;
  providerModelModal: HTMLDivElement;
  providerModelModalIdInput: HTMLInputElement;
  providerModelModalDisplayNameInput: HTMLInputElement;
  providerModelModalVisionToggle: HTMLButtonElement;
  providerModelModalContextWindowInput: HTMLInputElement;
  providerModelModalMaxOutputInput: HTMLInputElement;
  providerModelModalProtocolTypeSelect: HTMLSelectElement;
  closeProviderModelModalBtn: HTMLButtonElement;
  providerModelModalCancelBtn: HTMLButtonElement;
  providerModelModalConfirmBtn: HTMLButtonElement;
  mcpServerList: HTMLDivElement;
  mcpRefreshBtn: HTMLButtonElement;
  mcpAddBtn: HTMLButtonElement;
  mcpJsonModal: HTMLDivElement;
  mcpJsonInput: HTMLTextAreaElement;
  closeMcpJsonModalBtn: HTMLButtonElement;
  mcpJsonCancelBtn: HTMLButtonElement;
  mcpJsonConfirmBtn: HTMLButtonElement;
  normalizeOptionalString: (value: unknown) => string | null;
  escapeHtml: (text: string) => string;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  getActiveSession: () => ChatSession | null;
  closeSlashCommandMenu: () => void;
  renderEditorToolList: () => void;
  api: Pick<
    TuanziAPI,
    | "testProviderConnection"
    | "fetchProviderModels"
    | "getAgentConfig"
    | "listSkills"
    | "saveAgentConfig"
    | "getMcpDashboard"
    | "setMcpServerEnabled"
    | "mergeMcpJson"
  >;
}

export interface SettingsFeature {
  ensureSettingsDraft: () => SettingsDraft;
  getActiveDraftProvider: () => ProviderConfig | null;
  buildSettingsDraft: (config: AgentBackendConfig) => SettingsDraft;
  renderSettingsDraft: () => void;
  setActiveSettingsPanel: (panel: string) => void;
  openSettingsModal: () => Promise<void>;
  closeSettingsModal: () => void;
  saveSettings: () => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  closeProviderModelModal: () => void;
  closeMcpJsonModal: () => void;
  bindSettingsEvents: () => void;
}

export function createSettingsFeature(input: SettingsFeatureDeps): SettingsFeature {
  let renderSettingsDraftBridge: (() => void) | null = null;

  const providerSettingsController = createProviderSettingsController({
    state: input.state,
    defaultProviderType: input.defaultProviderType,
    defaultProviderBaseUrl: input.defaultProviderBaseUrl,
    providerList: input.providerList,
    providerEditorTitle: input.providerEditorTitle,
    providerNameInput: input.providerNameInput,
    providerTypeInput: input.providerTypeInput,
    providerBaseUrlInput: input.providerBaseUrlInput,
    providerModelInput: input.providerModelInput,
    providerApiKeyInput: input.providerApiKeyInput,
    providerEnabledToggle: input.providerEnabledToggle,
    providerDeleteBtn: input.providerDeleteBtn,
    providerModelList: input.providerModelList,
    providerModelModal: input.providerModelModal,
    providerModelModalIdInput: input.providerModelModalIdInput,
    providerModelModalDisplayNameInput: input.providerModelModalDisplayNameInput,
    providerModelModalVisionToggle: input.providerModelModalVisionToggle,
    providerModelModalContextWindowInput: input.providerModelModalContextWindowInput,
    providerModelModalMaxOutputInput: input.providerModelModalMaxOutputInput,
    providerModelModalProtocolTypeSelect: input.providerModelModalProtocolTypeSelect,
    normalizeOptionalString: input.normalizeOptionalString,
    escapeHtml: input.escapeHtml,
    showError: input.showError,
    showSuccess: input.showSuccess,
    renderSettingsDraft: () => {
      renderSettingsDraftBridge?.();
    },
    api: input.api
  });

  const settingsModalController = createSettingsModalController({
    state: input.state,
    settingsNav: input.settingsNav,
    settingsModal: input.settingsModal,
    mcpJsonModal: input.mcpJsonModal,
    providerModelModal: input.providerModelModal,
    providerNameInput: input.providerNameInput,
    skillsCatalogList: input.skillsCatalogList,
    normalizeOptionalString: input.normalizeOptionalString,
    getActiveSession: input.getActiveSession,
    closeSlashCommandMenu: input.closeSlashCommandMenu,
    escapeHtml: input.escapeHtml,
    showError: input.showError,
    buildSettingsDraft: providerSettingsController.buildSettingsDraft,
    renderProviderList: providerSettingsController.renderProviderList,
    renderProviderEditor: providerSettingsController.renderProviderEditor,
    updateActiveProviderFromInputs: providerSettingsController.updateActiveProviderFromInputs,
    ensureSettingsDraft: providerSettingsController.ensureSettingsDraft,
    getActiveDraftProvider: providerSettingsController.getActiveDraftProvider,
    renderEditorToolList: input.renderEditorToolList,
    api: input.api
  });

  renderSettingsDraftBridge = settingsModalController.renderSettingsDraft;

  const mcpSettingsController = createMcpSettingsController({
    state: input.state,
    mcpServerList: input.mcpServerList,
    mcpJsonModal: input.mcpJsonModal,
    mcpJsonInput: input.mcpJsonInput,
    escapeHtml: input.escapeHtml,
    showError: input.showError,
    getWorkspace: () => input.getActiveSession()?.workspace ?? "",
    api: input.api
  });

  const bindSettingsEvents = (): void => {
    bindSettingsEventsFeature({
      state: input.state,
      settingsNav: input.settingsNav,
      providerAddBtn: input.providerAddBtn,
      providerDeleteBtn: input.providerDeleteBtn,
      providerAddModelBtn: input.providerAddModelBtn,
      providerEnabledToggle: input.providerEnabledToggle,
      providerTestBtn: input.providerTestBtn,
      providerFetchModelsBtn: input.providerFetchModelsBtn,
      providerNameInput: input.providerNameInput,
      providerTypeInput: input.providerTypeInput,
      providerBaseUrlInput: input.providerBaseUrlInput,
      providerModelInput: input.providerModelInput,
      providerApiKeyInput: input.providerApiKeyInput,
      mcpRefreshBtn: input.mcpRefreshBtn,
      mcpAddBtn: input.mcpAddBtn,
      closeMcpJsonModalBtn: input.closeMcpJsonModalBtn,
      mcpJsonCancelBtn: input.mcpJsonCancelBtn,
      mcpJsonConfirmBtn: input.mcpJsonConfirmBtn,
      mcpJsonModal: input.mcpJsonModal,
      providerModelModalVisionToggle: input.providerModelModalVisionToggle,
      closeProviderModelModalBtn: input.closeProviderModelModalBtn,
      providerModelModalCancelBtn: input.providerModelModalCancelBtn,
      providerModelModalConfirmBtn: input.providerModelModalConfirmBtn,
      providerModelModal: input.providerModelModal,
      providerModelModalIdInput: input.providerModelModalIdInput,
      providerModelModalDisplayNameInput: input.providerModelModalDisplayNameInput,
      setActiveSettingsPanel: settingsModalController.setActiveSettingsPanel,
      refreshMcpServers: mcpSettingsController.refreshMcpServers,
      addDraftProvider: providerSettingsController.addDraftProvider,
      removeActiveDraftProvider: providerSettingsController.removeActiveDraftProvider,
      openProviderModelModal: providerSettingsController.openProviderModelModal,
      toggleSwitch: providerSettingsController.toggleSwitch,
      readToggle: providerSettingsController.readToggle,
      updateActiveProviderFromInputs: providerSettingsController.updateActiveProviderFromInputs,
      testActiveProviderConnection: providerSettingsController.testActiveProviderConnection,
      fetchModelsForActiveProvider: providerSettingsController.fetchModelsForActiveProvider,
      openMcpJsonModal: mcpSettingsController.openMcpJsonModal,
      closeMcpJsonModal: mcpSettingsController.closeMcpJsonModal,
      saveMcpJsonConfig: mcpSettingsController.saveMcpJsonConfig,
      closeProviderModelModal: providerSettingsController.closeProviderModelModal,
      addModelToActiveProvider: providerSettingsController.addModelToActiveProvider
    });
  };

  return {
    ensureSettingsDraft: providerSettingsController.ensureSettingsDraft,
    getActiveDraftProvider: providerSettingsController.getActiveDraftProvider,
    buildSettingsDraft: providerSettingsController.buildSettingsDraft,
    renderSettingsDraft: settingsModalController.renderSettingsDraft,
    setActiveSettingsPanel: settingsModalController.setActiveSettingsPanel,
    openSettingsModal: settingsModalController.openSettingsModal,
    closeSettingsModal: settingsModalController.closeSettingsModal,
    saveSettings: settingsModalController.saveSettings,
    refreshMcpServers: mcpSettingsController.refreshMcpServers,
    closeProviderModelModal: providerSettingsController.closeProviderModelModal,
    closeMcpJsonModal: mcpSettingsController.closeMcpJsonModal,
    bindSettingsEvents
  };
}
