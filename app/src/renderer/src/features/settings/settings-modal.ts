import type {
  AgentBackendConfig,
  McpDashboardServer,
  ProviderConfig,
  SkillCatalogItem
} from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";
import type { ChatSession, SettingsDraft } from "../../app/state";

interface SettingsModalState {
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

interface SettingsModalDeps {
  state: SettingsModalState;
  settingsNav: HTMLElement;
  settingsModal: HTMLDivElement;
  mcpJsonModal: HTMLDivElement;
  providerModelModal: HTMLDivElement;
  providerNameInput: HTMLInputElement;
  skillsCatalogList: HTMLDivElement;
  normalizeOptionalString: (value: unknown) => string | null;
  getActiveSession: () => ChatSession | null;
  closeSlashCommandMenu: () => void;
  escapeHtml: (text: string) => string;
  showError: (message: string) => void;
  buildSettingsDraft: (config: AgentBackendConfig) => SettingsDraft;
  renderProviderList: () => void;
  renderProviderEditor: () => void;
  updateActiveProviderFromInputs: () => void;
  ensureSettingsDraft: () => SettingsDraft;
  getActiveDraftProvider: () => ProviderConfig | null;
  renderEditorToolList: () => void;
  api: Pick<TuanziAPI, "getAgentConfig" | "listSkills" | "saveAgentConfig">;
}

export interface SettingsModalController {
  getSkillWorkspaceCandidates: () => string[];
  renderSkillCatalog: () => void;
  renderSettingsDraft: () => void;
  setActiveSettingsPanel: (panel: string) => void;
  openSettingsModal: () => Promise<void>;
  closeSettingsModal: () => void;
  saveSettings: () => Promise<void>;
}

export function createSettingsModalController(input: SettingsModalDeps): SettingsModalController {
  const getSkillWorkspaceCandidates = (): string[] => {
    const output: string[] = [];
    const seen = new Set<string>();
    const push = (value: string | null | undefined): void => {
      const normalized = input.normalizeOptionalString(value ?? null);
      if (!normalized) {
        return;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      output.push(normalized);
    };

    push(input.getActiveSession()?.workspace);
    for (const session of input.state.sessions) {
      push(session.workspace);
    }
    return output;
  };

  const renderSkillCatalog = (): void => {
    input.skillsCatalogList.innerHTML = "";
    if (input.state.skillCatalog.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mcp-empty";
      const activeWorkspace = input.normalizeOptionalString(input.getActiveSession()?.workspace ?? null);
      empty.textContent = activeWorkspace
        ? "暂无已安装 Skills。已扫描 ~/.tuanzi/skills 与当前会话工作区的 .tuanzi/skills。"
        : "当前会话未选择工作区。请先选择工作区，或安装到 ~/.tuanzi/skills。";
      input.skillsCatalogList.appendChild(empty);
      return;
    }

    for (const skill of input.state.skillCatalog) {
      const row = document.createElement("div");
      row.className = "global-skill-row";
      row.innerHTML = `
        <div>
          <div class="global-skill-title">${input.escapeHtml(skill.name)}</div>
          <div class="global-skill-desc">${input.escapeHtml(skill.description || "No description")}</div>
          <div class="agent-field-hint">${input.escapeHtml(skill.skillDir)}</div>
        </div>
      `;
      input.skillsCatalogList.appendChild(row);
    }
  };

  const renderSettingsDraft = (): void => {
    if (!input.state.settingsDraft) {
      return;
    }

    input.renderProviderList();
    input.renderProviderEditor();
    renderSkillCatalog();
  };

  const setActiveSettingsPanel = (panel: string): void => {
    const navButtons = Array.from(input.settingsNav.querySelectorAll<HTMLButtonElement>(".settings-nav-item"));
    navButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.panel === panel);
    });
    const panels = Array.from(input.settingsModal.querySelectorAll<HTMLElement>(".settings-panel"));
    panels.forEach((item) => {
      item.classList.toggle("active", item.dataset.panel === panel);
    });
  };

  const openSettingsModal = async (): Promise<void> => {
    input.closeSlashCommandMenu();
    input.mcpJsonModal.classList.remove("visible");
    input.providerModelModal.classList.remove("visible");

    const workspaceCandidates = getSkillWorkspaceCandidates();
    const activeWorkspace = workspaceCandidates[0] ?? "";
    const [configRes, skillsRes] = await Promise.all([
      input.api.getAgentConfig(),
      input.api.listSkills({
        workspace: activeWorkspace,
        workspaceCandidates
      })
    ]);

    if (!configRes.ok || !configRes.config) {
      input.showError(configRes.error || "读取全局配置失败");
      return;
    }

    input.state.agentConfig = configRes.config;
    input.state.settingsDraft = input.buildSettingsDraft(configRes.config);
    input.state.skillCatalog = skillsRes.ok && Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
    if (!skillsRes.ok) {
      input.showError(skillsRes.error || "读取 Skills 目录失败");
    }
    input.state.mcpServers = [];
    input.state.expandedMcpServerIds.clear();
    input.state.isMcpLoading = false;
    input.state.hasLoadedMcp = false;
    input.state.mcpLoadToken += 1;

    renderSettingsDraft();
    setActiveSettingsPanel("provider");
    input.settingsModal.classList.add("visible");
    requestAnimationFrame(() => {
      if (!input.settingsModal.classList.contains("visible")) {
        return;
      }
      input.providerNameInput.focus();
      input.providerNameInput.setSelectionRange(input.providerNameInput.value.length, input.providerNameInput.value.length);
    });
  };

  const closeSettingsModal = (): void => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && input.settingsModal.contains(activeElement)) {
      activeElement.blur();
    }
    input.settingsModal.classList.remove("visible");
    input.mcpJsonModal.classList.remove("visible");
    input.providerModelModal.classList.remove("visible");
    input.state.mcpLoadToken += 1;
    input.state.isMcpLoading = false;
  };

  const saveSettings = async (): Promise<void> => {
    if (!input.state.settingsDraft) {
      return;
    }

    input.updateActiveProviderFromInputs();
    const draft = input.ensureSettingsDraft();
    const activeProvider = input.getActiveDraftProvider();
    if (!activeProvider) {
      input.showError("No active provider");
      return;
    }

    const configResult = await input.api.saveAgentConfig({
      provider: {
        type: activeProvider.type,
        baseUrl: activeProvider.baseUrl,
        model: activeProvider.model,
        apiKey: activeProvider.apiKey
      },
      providers: draft.providers,
      activeProviderId: activeProvider.id
    });
    if (!configResult.ok || !configResult.config) {
      input.showError(configResult.error || "保存全局配置失败");
      return;
    }

    input.state.agentConfig = configResult.config;
    input.state.settingsDraft = input.buildSettingsDraft(configResult.config);

    closeSettingsModal();
    input.renderEditorToolList();
  };

  return {
    getSkillWorkspaceCandidates,
    renderSkillCatalog,
    renderSettingsDraft,
    setActiveSettingsPanel,
    openSettingsModal,
    closeSettingsModal,
    saveSettings
  };
}
