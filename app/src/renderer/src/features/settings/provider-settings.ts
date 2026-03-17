import type {
  AgentBackendConfig,
  ProviderConfig,
  ProviderModelItem,
  ProviderModelProtocolType
} from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";
import type { SettingsDraft } from "../../app/state";

interface ProviderSettingsState {
  settingsDraft: SettingsDraft | null;
}

interface ProviderSettingsDeps {
  state: ProviderSettingsState;
  defaultProviderType: string;
  defaultProviderBaseUrl: string;
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
  providerModelModal: HTMLDivElement;
  providerModelModalIdInput: HTMLInputElement;
  providerModelModalDisplayNameInput: HTMLInputElement;
  providerModelModalVisionToggle: HTMLButtonElement;
  providerModelModalContextWindowInput: HTMLInputElement;
  providerModelModalMaxOutputInput: HTMLInputElement;
  providerModelModalProtocolTypeSelect: HTMLSelectElement;
  normalizeOptionalString: (value: unknown) => string | null;
  escapeHtml: (text: string) => string;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  renderSettingsDraft: () => void;
  api: Pick<TuanziAPI, "testProviderConnection" | "fetchProviderModels">;
}

export interface ProviderSettingsController {
  toggleSwitch: (button: HTMLButtonElement, enabled: boolean) => void;
  readToggle: (button: HTMLButtonElement) => boolean;
  createProviderId: () => string;
  normalizeProviderModelList: (input: unknown, providerType: string) => ProviderModelItem[];
  normalizeProviderDraft: (input: Partial<ProviderConfig>) => ProviderConfig;
  ensureSettingsDraft: () => SettingsDraft;
  getActiveDraftProvider: () => ProviderConfig | null;
  renderProviderList: () => void;
  renderProviderModelCards: (provider: ProviderConfig) => void;
  renderProviderEditor: () => void;
  updateActiveProviderFromInputs: () => void;
  addDraftProvider: () => void;
  removeActiveDraftProvider: () => void;
  openProviderModelModal: () => void;
  closeProviderModelModal: () => void;
  addModelToActiveProvider: () => void;
  testActiveProviderConnection: () => Promise<void>;
  fetchModelsForActiveProvider: () => Promise<void>;
  buildSettingsDraft: (config: AgentBackendConfig) => SettingsDraft;
}

export function createProviderSettingsController(input: ProviderSettingsDeps): ProviderSettingsController {
  const toggleSwitch = (button: HTMLButtonElement, enabled: boolean): void => {
    button.dataset.enabled = enabled ? "true" : "false";
  };

  const readToggle = (button: HTMLButtonElement): boolean => {
    return button.dataset.enabled === "true";
  };

  const createProviderId = (): string => {
    return `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const defaultProtocolTypeForProvider = (providerType: string): ProviderModelProtocolType => {
    const normalized = providerType.trim().toLowerCase();
    if (normalized === "anthropic") {
      return "anthropic_messages";
    }
    if (normalized === "gemini") {
      return "gemini_generate_content";
    }
    if (
      normalized === "openai" ||
      normalized === "openai_compatible" ||
      normalized === "azure_openai"
    ) {
      return "openai_chat_completions";
    }
    return "custom";
  };

  const normalizeTokenLimit = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
    return null;
  };

  const parseTokenLimitInput = (value: string): { valid: boolean; tokenLimit: number | null } => {
    const normalized = input.normalizeOptionalString(value);
    if (!normalized) {
      return { valid: true, tokenLimit: null };
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { valid: false, tokenLimit: null };
    }
    return { valid: true, tokenLimit: Math.floor(parsed) };
  };

  const normalizeProtocolType = (value: unknown, providerType: string): ProviderModelProtocolType => {
    if (value === "openai_chat_completions") {
      return value;
    }
    if (value === "openai_responses") {
      return value;
    }
    if (value === "anthropic_messages") {
      return value;
    }
    if (value === "gemini_generate_content") {
      return value;
    }
    if (value === "custom") {
      return value;
    }
    return defaultProtocolTypeForProvider(providerType);
  };

  const protocolTypeLabel = (protocolType: ProviderModelProtocolType): string => {
    if (protocolType === "openai_chat_completions") {
      return "OpenAI Chat";
    }
    if (protocolType === "openai_responses") {
      return "OpenAI Responses";
    }
    if (protocolType === "anthropic_messages") {
      return "Anthropic Messages";
    }
    if (protocolType === "gemini_generate_content") {
      return "Gemini Generate";
    }
    return "Custom";
  };

  const normalizeProviderModelList = (value: unknown, providerType: string): ProviderModelItem[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    const output: ProviderModelItem[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = input.normalizeOptionalString(record.id);
      if (!id) {
        continue;
      }
      const key = id.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push({
        id,
        displayName: input.normalizeOptionalString(record.displayName) ?? id,
        isVision: record.isVision === true,
        enabled: typeof record.enabled === "boolean" ? record.enabled : true,
        contextWindowTokens: normalizeTokenLimit(record.contextWindowTokens),
        maxOutputTokens: normalizeTokenLimit(record.maxOutputTokens),
        protocolType: normalizeProtocolType(record.protocolType, providerType),
        tokenEstimatorType:
          record.tokenEstimatorType === "remote_exact" ||
          record.tokenEstimatorType === "heuristic" ||
          record.tokenEstimatorType === "builtin"
            ? record.tokenEstimatorType
            : "builtin"
      });
    }
    return output;
  };

  const normalizeProviderDraft = (value: Partial<ProviderConfig>): ProviderConfig => {
    const providerType = input.normalizeOptionalString(value.type) ?? input.defaultProviderType;
    return {
      id: input.normalizeOptionalString(value.id) ?? createProviderId(),
      name: input.normalizeOptionalString(value.name) ?? "Untitled Provider",
      type: providerType,
      baseUrl: input.normalizeOptionalString(value.baseUrl) ?? input.defaultProviderBaseUrl,
      apiKey: input.normalizeOptionalString(value.apiKey) ?? "",
      model: input.normalizeOptionalString(value.model) ?? "",
      models: normalizeProviderModelList(value.models, providerType),
      isEnabled: value.isEnabled !== false
    };
  };

  const ensureSettingsDraft = (): SettingsDraft => {
    if (!input.state.settingsDraft) {
      input.state.settingsDraft = {
        providers: [normalizeProviderDraft({ id: createProviderId(), name: "OpenAI", type: "openai" })],
        activeProviderId: ""
      };
    }

    if (input.state.settingsDraft.providers.length === 0) {
      input.state.settingsDraft.providers.push(
        normalizeProviderDraft({ id: createProviderId(), name: "OpenAI", type: "openai" })
      );
    }
    if (!input.state.settingsDraft.providers.some((item) => item.id === input.state.settingsDraft!.activeProviderId)) {
      input.state.settingsDraft.activeProviderId = input.state.settingsDraft.providers[0].id;
    }

    return input.state.settingsDraft;
  };

  const getActiveDraftProvider = (): ProviderConfig | null => {
    const draft = ensureSettingsDraft();
    return draft.providers.find((item) => item.id === draft.activeProviderId) ?? draft.providers[0] ?? null;
  };

  const renderProviderList = (): void => {
    const draft = ensureSettingsDraft();
    input.providerList.innerHTML = "";
    if (draft.providers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "provider-list-empty";
      empty.textContent = "No providers yet";
      input.providerList.appendChild(empty);
      return;
    }

    for (const provider of draft.providers) {
      const item = document.createElement("button");
      item.className = "provider-list-item";
      if (provider.id === draft.activeProviderId) {
        item.classList.add("active");
      }
      item.innerHTML = `
        <div class="provider-item-main">
          <span class="provider-item-name">${input.escapeHtml(provider.name)}</span>
          <span class="provider-item-status ${provider.isEnabled ? "enabled" : ""}">${provider.isEnabled ? "ON" : "OFF"}</span>
        </div>
        <div class="provider-item-sub">${input.escapeHtml(provider.model || "No default model")}</div>
      `;
      item.addEventListener("click", () => {
        draft.activeProviderId = provider.id;
        input.renderSettingsDraft();
      });
      input.providerList.appendChild(item);
    }
  };

  const renderProviderModelCards = (provider: ProviderConfig): void => {
    input.providerModelList.innerHTML = "";
    if (provider.models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "provider-model-empty";
      empty.textContent = "No models. Fetch from provider or add one manually.";
      input.providerModelList.appendChild(empty);
      return;
    }

    for (const model of provider.models) {
      const card = document.createElement("div");
      card.className = "provider-model-card";
      if (model.id === provider.model) {
        card.classList.add("default");
      }
      card.innerHTML = `
        <div class="provider-model-main">
          <div class="provider-model-name">${input.escapeHtml(model.displayName || model.id)}</div>
          <button class="toggle-switch" data-enabled="${model.enabled ? "true" : "false"}"></button>
        </div>
        <div class="provider-model-meta">
          <span class="provider-model-badge">${input.escapeHtml(model.id)}</span>
          ${model.isVision ? '<span class="provider-model-badge vision">VISION</span>' : ""}
          <span class="provider-model-badge">${input.escapeHtml(protocolTypeLabel(model.protocolType))}</span>
          ${model.contextWindowTokens !== null ? `<span class="provider-model-badge">CTX ${input.escapeHtml(String(model.contextWindowTokens))}</span>` : ""}
          ${model.maxOutputTokens !== null ? `<span class="provider-model-badge">OUT ${input.escapeHtml(String(model.maxOutputTokens))}</span>` : ""}
        </div>
        <div class="provider-model-actions">
          <button class="agent-btn secondary provider-model-default-btn">${model.id === provider.model ? "Default" : "Set Default"}</button>
          <button class="agent-btn danger provider-model-delete-btn">Delete</button>
        </div>
      `;

      const toggle = card.querySelector(".toggle-switch") as HTMLButtonElement;
      toggle.addEventListener("click", () => {
        model.enabled = !model.enabled;
        if (!model.enabled && provider.model === model.id) {
          provider.model = provider.models.find((item) => item.enabled && item.id !== model.id)?.id ?? "";
        }
        input.renderSettingsDraft();
      });

      const setDefaultBtn = card.querySelector(".provider-model-default-btn") as HTMLButtonElement;
      setDefaultBtn.addEventListener("click", () => {
        model.enabled = true;
        provider.model = model.id;
        input.renderSettingsDraft();
      });

      const deleteBtn = card.querySelector(".provider-model-delete-btn") as HTMLButtonElement;
      deleteBtn.addEventListener("click", () => {
        provider.models = provider.models.filter((item) => item.id !== model.id);
        if (provider.model === model.id) {
          provider.model = provider.models.find((item) => item.enabled)?.id ?? "";
        }
        input.renderSettingsDraft();
      });

      input.providerModelList.appendChild(card);
    }
  };

  const renderProviderEditor = (): void => {
    const provider = getActiveDraftProvider();
    if (!provider) {
      input.providerEditorTitle.textContent = "Provider Settings";
      input.providerNameInput.value = "";
      input.providerTypeInput.value = input.defaultProviderType;
      input.providerBaseUrlInput.value = input.defaultProviderBaseUrl;
      input.providerModelInput.value = "";
      input.providerApiKeyInput.value = "";
      toggleSwitch(input.providerEnabledToggle, true);
      input.providerModelList.innerHTML = "";
      return;
    }

    input.providerEditorTitle.textContent = `${provider.name} Settings`;
    input.providerNameInput.value = provider.name;
    const hasTypeOption = Array.from(input.providerTypeInput.options).some((item) => item.value === provider.type);
    if (!hasTypeOption) {
      const custom = document.createElement("option");
      custom.value = provider.type;
      custom.textContent = provider.type;
      input.providerTypeInput.appendChild(custom);
    }
    input.providerTypeInput.value = provider.type;
    input.providerBaseUrlInput.value = provider.baseUrl;
    input.providerModelInput.value = provider.model;
    input.providerApiKeyInput.value = provider.apiKey;
    toggleSwitch(input.providerEnabledToggle, provider.isEnabled);
    input.providerDeleteBtn.disabled = ensureSettingsDraft().providers.length <= 1;
    renderProviderModelCards(provider);
  };

  const updateActiveProviderFromInputs = (): void => {
    const provider = getActiveDraftProvider();
    if (!provider) {
      return;
    }
    provider.name = input.normalizeOptionalString(input.providerNameInput.value) ?? "Untitled Provider";
    provider.type = input.normalizeOptionalString(input.providerTypeInput.value) ?? input.defaultProviderType;
    provider.baseUrl = input.normalizeOptionalString(input.providerBaseUrlInput.value) ?? input.defaultProviderBaseUrl;
    provider.model = input.normalizeOptionalString(input.providerModelInput.value) ?? "";
    provider.apiKey = input.normalizeOptionalString(input.providerApiKeyInput.value) ?? "";
    provider.isEnabled = readToggle(input.providerEnabledToggle);
    input.providerEditorTitle.textContent = `${provider.name} Settings`;
    renderProviderList();
  };

  const addDraftProvider = (): void => {
    const draft = ensureSettingsDraft();
    const provider = normalizeProviderDraft({
      id: createProviderId(),
      name: `Provider ${draft.providers.length + 1}`,
      type: input.defaultProviderType
    });
    draft.providers.push(provider);
    draft.activeProviderId = provider.id;
    input.renderSettingsDraft();
  };

  const removeActiveDraftProvider = (): void => {
    const draft = ensureSettingsDraft();
    const current = getActiveDraftProvider();
    if (!current) {
      return;
    }
    if (draft.providers.length <= 1) {
      input.showError("At least one provider must remain");
      return;
    }
    const confirmed = window.confirm(`Delete provider "${current.name}"?`);
    if (!confirmed) {
      return;
    }
    draft.providers = draft.providers.filter((item) => item.id !== current.id);
    draft.activeProviderId = draft.providers[0]?.id ?? "";
    input.renderSettingsDraft();
  };

  const openProviderModelModal = (): void => {
    updateActiveProviderFromInputs();
    const provider = getActiveDraftProvider();
    if (!provider) {
      return;
    }

    input.providerModelModalIdInput.value = "";
    input.providerModelModalDisplayNameInput.value = "";
    input.providerModelModalContextWindowInput.value = "";
    input.providerModelModalMaxOutputInput.value = "";
    input.providerModelModalProtocolTypeSelect.value = defaultProtocolTypeForProvider(provider.type);
    toggleSwitch(input.providerModelModalVisionToggle, false);
    input.providerModelModal.classList.add("visible");
    requestAnimationFrame(() => {
      if (!input.providerModelModal.classList.contains("visible")) {
        return;
      }
      input.providerModelModalIdInput.focus();
      input.providerModelModalIdInput.setSelectionRange(
        input.providerModelModalIdInput.value.length,
        input.providerModelModalIdInput.value.length
      );
    });
  };

  const closeProviderModelModal = (): void => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && input.providerModelModal.contains(activeElement)) {
      activeElement.blur();
    }
    input.providerModelModal.classList.remove("visible");
  };

  const addModelToActiveProvider = (): void => {
    updateActiveProviderFromInputs();
    const provider = getActiveDraftProvider();
    if (!provider) {
      return;
    }

    const modelId = input.normalizeOptionalString(input.providerModelModalIdInput.value);
    if (!modelId) {
      input.showError("请输入模型 ID");
      input.providerModelModalIdInput.focus();
      return;
    }

    const existingModelIds = new Set(provider.models.map((item) => item.id.toLowerCase()));
    if (existingModelIds.has(modelId.toLowerCase())) {
      input.showError(`模型已存在：${modelId}`);
      input.providerModelModalIdInput.focus();
      return;
    }

    const displayName = input.normalizeOptionalString(input.providerModelModalDisplayNameInput.value) ?? modelId;
    const supportsVision = readToggle(input.providerModelModalVisionToggle);
    const contextWindowParse = parseTokenLimitInput(input.providerModelModalContextWindowInput.value);
    if (!contextWindowParse.valid) {
      input.showError("上下文上限需为正整数");
      input.providerModelModalContextWindowInput.focus();
      return;
    }
    const maxOutputParse = parseTokenLimitInput(input.providerModelModalMaxOutputInput.value);
    if (!maxOutputParse.valid) {
      input.showError("最大输出需为正整数");
      input.providerModelModalMaxOutputInput.focus();
      return;
    }
    const protocolType = normalizeProtocolType(input.providerModelModalProtocolTypeSelect.value, provider.type);

    provider.models.push({
      id: modelId,
      displayName,
      isVision: supportsVision,
      enabled: true,
      contextWindowTokens: contextWindowParse.tokenLimit,
      maxOutputTokens: maxOutputParse.tokenLimit,
      protocolType,
      tokenEstimatorType: "builtin"
    });
    if (!provider.model) {
      provider.model = modelId;
    }
    closeProviderModelModal();
    input.renderSettingsDraft();
    input.showSuccess(`已添加模型：${modelId}`);
  };

  const testActiveProviderConnection = async (): Promise<void> => {
    updateActiveProviderFromInputs();
    const provider = getActiveDraftProvider();
    if (!provider) {
      return;
    }
    const result = await input.api.testProviderConnection({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model
    });
    if (!result.ok) {
      input.showError(result.error || "Connection test failed");
      return;
    }
    window.alert(result.message || "Connection successful.");
  };

  const fetchModelsForActiveProvider = async (): Promise<void> => {
    updateActiveProviderFromInputs();
    const provider = getActiveDraftProvider();
    if (!provider) {
      return;
    }
    const result = await input.api.fetchProviderModels({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model
    });
    if (!result.ok || !result.models) {
      input.showError(result.error || "Failed to fetch models");
      return;
    }

    if (result.message) {
      input.showSuccess(result.message);
    }

    const existing = new Map(provider.models.map((item) => [item.id.toLowerCase(), item]));
    for (const model of result.models) {
      const key = model.id.toLowerCase();
      const hit = existing.get(key);
      if (hit) {
        hit.displayName = model.displayName || hit.displayName;
        hit.isVision = model.isVision || hit.isVision;
        hit.protocolType = hit.protocolType || defaultProtocolTypeForProvider(provider.type);
        if (hit.tokenEstimatorType !== "builtin" && hit.tokenEstimatorType !== "heuristic" && hit.tokenEstimatorType !== "remote_exact") {
          hit.tokenEstimatorType = "builtin";
        }
        continue;
      }
      provider.models.push({
        id: model.id,
        displayName: model.displayName || model.id,
        isVision: model.isVision,
        enabled: true,
        contextWindowTokens: null,
        maxOutputTokens: null,
        protocolType: defaultProtocolTypeForProvider(provider.type),
        tokenEstimatorType: "builtin"
      });
    }
    if (!provider.model) {
      provider.model = provider.models.find((item) => item.enabled)?.id ?? "";
    }
    input.renderSettingsDraft();
    if (result.models.length === 0) {
      window.alert(result.message || "No models returned by provider.");
      return;
    }
    window.alert(`Synced ${result.models.length} models.`);
  };

  const buildSettingsDraft = (config: AgentBackendConfig): SettingsDraft => {
    const fromProviders = Array.isArray(config.providers) ? config.providers : [];
    const providers =
      fromProviders.length > 0
        ? fromProviders.map((item) => normalizeProviderDraft(item))
        : [normalizeProviderDraft({ id: createProviderId(), name: "Default Provider" })];
    const activeProviderId =
      providers.find((item) => item.id === config.activeProviderId)?.id ?? providers[0]?.id ?? createProviderId();

    return {
      providers,
      activeProviderId
    };
  };

  return {
    toggleSwitch,
    readToggle,
    createProviderId,
    normalizeProviderModelList,
    normalizeProviderDraft,
    ensureSettingsDraft,
    getActiveDraftProvider,
    renderProviderList,
    renderProviderModelCards,
    renderProviderEditor,
    updateActiveProviderFromInputs,
    addDraftProvider,
    removeActiveDraftProvider,
    openProviderModelModal,
    closeProviderModelModal,
    addModelToActiveProvider,
    testActiveProviderConnection,
    fetchModelsForActiveProvider,
    buildSettingsDraft
  };
}
