import type { AgentBackendConfig } from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";
import type { SettingsDraft, SlashSuggestion } from "../../app/state";

interface SlashCommandState {
  slashVisible: boolean;
  slashSuggestions: SlashSuggestion[];
  slashActiveIndex: number;
  agentConfig: AgentBackendConfig | null;
  settingsDraft: SettingsDraft | null;
}

interface SlashModelItem {
  providerId: string;
  providerName: string;
  modelId: string;
}

interface SlashCommandDeps {
  state: SlashCommandState;
  inputTextarea: HTMLTextAreaElement;
  slashCommandMenu: HTMLDivElement;
  slashCommandList: HTMLDivElement;
  settingsModal: HTMLDivElement;
  escapeHtml: (text: string) => string;
  autoResizeTextarea: () => void;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  buildSettingsDraft: (config: AgentBackendConfig) => SettingsDraft;
  renderSettingsDraft: () => void;
  createNewSession: () => void;
  selectWorkspace: () => Promise<void>;
  openSettingsModal: () => Promise<void>;
  openAgentLibrary: () => Promise<void>;
  onAgentConfigUpdated?: (config: AgentBackendConfig) => void;
  api: Pick<TuanziAPI, "getAgentConfig" | "saveAgentConfig">;
}

export interface SlashCommandController {
  closeSlashCommandMenu: () => void;
  updateSlashCommandMenu: () => void;
  moveSlashSuggestionCursor: (offset: number) => void;
  applySlashSuggestion: (index: number) => Promise<void>;
  executeSlashCommand: (raw: string) => Promise<boolean>;
}

const SLASH_COMMAND_DEFS: Array<{
  command: string;
  description: string;
  executeImmediately: boolean;
}> = [
  {
    command: "/model",
    description: "Switch provider model, then continue chatting.",
    executeImmediately: false
  },
  {
    command: "/model current",
    description: "Show current active provider/model.",
    executeImmediately: true
  },
  {
    command: "/new",
    description: "Create a new conversation.",
    executeImmediately: true
  },
  {
    command: "/workspace",
    description: "Select workspace folder.",
    executeImmediately: true
  },
  {
    command: "/settings",
    description: "Open settings center.",
    executeImmediately: true
  },
  {
    command: "/agent",
    description: "Open agent library.",
    executeImmediately: true
  },
  {
    command: "/help",
    description: "Show slash command tips.",
    executeImmediately: true
  }
];

export function createSlashCommandController(input: SlashCommandDeps): SlashCommandController {
  const closeSlashCommandMenu = (): void => {
    input.state.slashVisible = false;
    input.state.slashSuggestions = [];
    input.state.slashActiveIndex = 0;
    input.slashCommandMenu.classList.remove("visible");
    input.slashCommandMenu.setAttribute("aria-hidden", "true");
    input.slashCommandList.innerHTML = "";
  };

  const getAvailableSlashModels = (): SlashModelItem[] => {
    const config = input.state.agentConfig;
    if (!config) {
      return [];
    }
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const output: SlashModelItem[] = [];

    for (const provider of providers) {
      if (provider.isEnabled === false) {
        continue;
      }
      const providerName = provider.name || provider.id || "Provider";
      const enabledModels =
        Array.isArray(provider.models) && provider.models.length > 0
          ? provider.models.filter((model) => model.enabled !== false).map((model) => model.id)
          : [];

      if (enabledModels.length === 0) {
        if (provider.model) {
          output.push({
            providerId: provider.id,
            providerName,
            modelId: provider.model
          });
        }
        continue;
      }

      for (const modelId of enabledModels) {
        output.push({
          providerId: provider.id,
          providerName,
          modelId
        });
      }
    }

    return output;
  };

  const getCurrentProviderModelLabel = (config: AgentBackendConfig | null): string => {
    if (!config) {
      return "Unknown";
    }
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const active = providers.find((item) => item.id === config.activeProviderId) ?? null;
    if (active && active.model) {
      return `${active.name || active.id} / ${active.model}`;
    }
    return "Model not set";
  };

  const buildCommandSlashSuggestions = (query: string): SlashSuggestion[] => {
    const normalized = query.trim().toLowerCase();
    const output: SlashSuggestion[] = [];
    for (const def of SLASH_COMMAND_DEFS) {
      if (normalized && !def.command.toLowerCase().startsWith(normalized)) {
        continue;
      }
      const commandText = def.command === "/model" ? "/model " : def.command;
      output.push({
        id: `cmd-${def.command}`,
        label: def.command,
        description: def.description,
        commandText,
        executeImmediately: def.executeImmediately
      });
    }
    return output;
  };

  const buildModelSlashSuggestions = (modelQuery: string): SlashSuggestion[] => {
    const normalized = modelQuery.trim().toLowerCase();
    const suggestions: SlashSuggestion[] = [];

    if (!normalized || "/model current".includes(`/model ${normalized}`)) {
      suggestions.push({
        id: "cmd-/model-current",
        label: "/model current",
        description: "Show the current provider/model",
        commandText: "/model current",
        executeImmediately: true
      });
    }

    const models = getAvailableSlashModels();
    for (const item of models) {
      const keyword = `${item.providerName}/${item.modelId}`.toLowerCase();
      if (normalized && !keyword.includes(normalized) && !item.modelId.toLowerCase().includes(normalized)) {
        continue;
      }
      suggestions.push({
        id: `model-${item.providerId}-${item.modelId}`,
        label: `${item.providerName} / ${item.modelId}`,
        description: `Switch to ${item.modelId}`,
        commandText: `/model ${item.providerId}/${item.modelId}`,
        executeImmediately: true
      });
    }

    return suggestions;
  };

  const buildSlashSuggestions = (value: string): SlashSuggestion[] => {
    const leftTrimmed = value.trimStart();
    if (!leftTrimmed.startsWith("/")) {
      return [];
    }

    const lower = leftTrimmed.toLowerCase();
    if (lower === "/model" || lower.startsWith("/model ")) {
      const args = lower === "/model" ? "" : leftTrimmed.slice("/model ".length);
      return buildModelSlashSuggestions(args);
    }

    const firstSpace = leftTrimmed.indexOf(" ");
    if (firstSpace < 0) {
      return buildCommandSlashSuggestions(leftTrimmed);
    }

    const command = leftTrimmed.slice(0, firstSpace);
    return buildCommandSlashSuggestions(command);
  };

  const renderSlashCommandMenu = (): void => {
    if (!input.state.slashVisible || input.state.slashSuggestions.length === 0) {
      closeSlashCommandMenu();
      return;
    }

    input.slashCommandList.innerHTML = "";
    input.state.slashSuggestions.forEach((suggestion, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "slash-command-item";
      if (index === input.state.slashActiveIndex) {
        item.classList.add("active");
      }
      item.innerHTML = `
        <div class="slash-command-title">${input.escapeHtml(suggestion.label)}</div>
        <div class="slash-command-desc">${input.escapeHtml(suggestion.description)}</div>
      `;
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        void applySlashSuggestion(index);
      });
      input.slashCommandList.appendChild(item);
    });

    input.slashCommandMenu.classList.add("visible");
    input.slashCommandMenu.setAttribute("aria-hidden", "false");
  };

  const updateSlashCommandMenu = (): void => {
    const text = input.inputTextarea.value;
    if (!text.trim().startsWith("/")) {
      closeSlashCommandMenu();
      return;
    }

    const suggestions = buildSlashSuggestions(text);
    if (suggestions.length === 0) {
      closeSlashCommandMenu();
      return;
    }

    input.state.slashVisible = true;
    input.state.slashSuggestions = suggestions;
    input.state.slashActiveIndex = 0;
    renderSlashCommandMenu();
  };

  const moveSlashSuggestionCursor = (offset: number): void => {
    if (!input.state.slashVisible || input.state.slashSuggestions.length === 0) {
      return;
    }
    const total = input.state.slashSuggestions.length;
    input.state.slashActiveIndex = (input.state.slashActiveIndex + offset + total) % total;
    renderSlashCommandMenu();
  };

  const switchToProviderModel = async (providerId: string, modelId: string): Promise<boolean> => {
    const currentConfig = input.state.agentConfig;
    let config: AgentBackendConfig | null = currentConfig;
    if (!config) {
      const configResult = await input.api.getAgentConfig();
      if (!configResult.ok || !configResult.config) {
        input.showError(configResult.error || "Failed to load provider config");
        return false;
      }
      config = configResult.config;
    }

    const draft = input.buildSettingsDraft(config);
    const provider = draft.providers.find((item) => item.id === providerId);
    if (!provider) {
      input.showError("Provider not found");
      return false;
    }

    provider.isEnabled = true;
    provider.model = modelId;
    if (!provider.models.some((item) => item.id === modelId)) {
      provider.models.push({
        id: modelId,
        displayName: modelId,
        isVision: false,
        enabled: true,
        contextWindowTokens: null,
        maxOutputTokens: null,
        protocolType: "openai_chat_completions",
        tokenEstimatorType: "builtin"
      });
    }
    for (const model of provider.models) {
      if (model.id === modelId) {
        model.enabled = true;
      }
    }

    const saveResult = await input.api.saveAgentConfig({
      provider: {
        type: provider.type,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKey: provider.apiKey
      },
      providers: draft.providers,
      activeProviderId: provider.id
    });
    if (!saveResult.ok || !saveResult.config) {
      input.showError(saveResult.error || "Failed to switch model");
      return false;
    }

    input.state.agentConfig = saveResult.config;
    input.state.settingsDraft = input.buildSettingsDraft(saveResult.config);
    input.onAgentConfigUpdated?.(saveResult.config);
    if (input.settingsModal.classList.contains("visible")) {
      input.renderSettingsDraft();
    }
    input.showSuccess(`Switched to ${provider.name || provider.id} / ${modelId}`);
    return true;
  };

  const handleModelSlashCommand = async (args: string): Promise<boolean> => {
    const normalized = args.trim();
    if (!normalized) {
      input.showError("Type /model and select a model from the popup");
      return true;
    }

    if (normalized.toLowerCase() === "current") {
      input.showSuccess(`Current model: ${getCurrentProviderModelLabel(input.state.agentConfig)}`);
      return true;
    }

    const models = getAvailableSlashModels();
    const query = normalized.toLowerCase();
    const matches = models.filter((item) => {
      const byModel = item.modelId.toLowerCase().includes(query);
      const byProvider = item.providerId.toLowerCase().includes(query) || item.providerName.toLowerCase().includes(query);
      const byCombo = `${item.providerId}/${item.modelId}`.toLowerCase() === query;
      const byComboName = `${item.providerName}/${item.modelId}`.toLowerCase() === query;
      return byModel || byProvider || byCombo || byComboName;
    });

    if (matches.length === 0) {
      input.showError(`No model matched: ${normalized}`);
      return true;
    }
    if (matches.length > 1) {
      input.showError("Multiple models matched, keep typing to narrow down or pick from popup");
      return true;
    }

    const matched = matches[0];
    return await switchToProviderModel(matched.providerId, matched.modelId);
  };

  const executeSlashCommand = async (raw: string): Promise<boolean> => {
    const text = raw.trim();
    if (!text.startsWith("/")) {
      return false;
    }

    const [commandToken, ...restParts] = text.split(/\s+/);
    const command = commandToken.toLowerCase();
    const args = restParts.join(" ");

    if (command === "/model") {
      return await handleModelSlashCommand(args);
    }
    if (command === "/new") {
      input.createNewSession();
      input.showSuccess("Started a new conversation");
      return true;
    }
    if (command === "/workspace") {
      await input.selectWorkspace();
      return true;
    }
    if (command === "/settings") {
      await input.openSettingsModal();
      return true;
    }
    if (command === "/agent") {
      await input.openAgentLibrary();
      return true;
    }
    if (command === "/help") {
      input.showSuccess("Commands: /model, /model current, /new, /workspace, /settings, /agent");
      return true;
    }

    input.showError(`Unknown command: ${commandToken}`);
    return true;
  };

  const applySlashSuggestion = async (index: number): Promise<void> => {
    if (!input.state.slashVisible || index < 0 || index >= input.state.slashSuggestions.length) {
      return;
    }
    const suggestion = input.state.slashSuggestions[index];
    input.inputTextarea.value = suggestion.commandText;
    input.autoResizeTextarea();
    input.inputTextarea.focus();

    if (suggestion.executeImmediately) {
      const handled = await executeSlashCommand(suggestion.commandText);
      if (handled) {
        input.inputTextarea.value = "";
        input.autoResizeTextarea();
        closeSlashCommandMenu();
      }
      return;
    }
    updateSlashCommandMenu();
  };

  return {
    closeSlashCommandMenu,
    updateSlashCommandMenu,
    moveSlashSuggestionCursor,
    applySlashSuggestion,
    executeSlashCommand
  };
}
