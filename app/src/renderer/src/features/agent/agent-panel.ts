import type {
  AgentBackendConfig,
  AgentToolProfile,
  GlobalSkillCategory,
  StoredAgent
} from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";
import type { AgentEditorState, ChatSession } from "../../app/state";

interface AgentPanelState {
  agents: StoredAgent[];
  activeAgentId: string;
  agentToolProfiles: AgentToolProfile[];
  agentConfig: AgentBackendConfig | null;
  editor: AgentEditorState;
}

interface AgentPanelDeps {
  state: AgentPanelState;
  agentStorageKey: string;
  defaultAgentPrompt: string;
  activeAgentAvatar: HTMLDivElement;
  activeAgentName: HTMLSpanElement;
  welcomeAvatar: HTMLDivElement;
  welcomeTitle: HTMLHeadingElement;
  agentGrid: HTMLDivElement;
  agentToolList: HTMLDivElement;
  agentLibraryModal: HTMLDivElement;
  agentLibraryView: HTMLDivElement;
  agentEditorView: HTMLDivElement;
  agentEditorBackBtn: HTMLButtonElement;
  agentModalTitle: HTMLHeadingElement;
  agentEditorAvatarInput: HTMLInputElement;
  agentEditorAvatarPreview: HTMLDivElement;
  agentEditorName: HTMLInputElement;
  agentEditorFilename: HTMLInputElement;
  agentEditorDescription: HTMLInputElement;
  agentEditorTags: HTMLInputElement;
  agentEditorPrompt: HTMLTextAreaElement;
  agentEditorDeleteBtn: HTMLButtonElement;
  agentEditorSaveBtn: HTMLButtonElement;
  firstChar: (value: string) => string;
  normalizeOptionalString: (value: unknown) => string | null;
  escapeHtml: (text: string) => string;
  showError: (message: string) => void;
  getActiveSession: () => ChatSession | null;
  api: Pick<TuanziAPI, "saveAgent" | "deleteAgent" | "listAgents" | "getAgentConfig" | "listAgentTools">;
}

export interface AgentPanelController {
  getActiveAgent: () => StoredAgent | null;
  loadActiveAgentPreference: () => string | null;
  applyActiveAgent: (identifier: string | null, persist?: boolean) => void;
  renderActiveAgentIdentity: () => void;
  renderAgentGrid: () => void;
  renderEditorToolList: () => void;
  updateEditorAvatarPreview: () => void;
  setAgentModalView: (view: "library" | "editor") => void;
  closeAgentModal: () => void;
  openAgentEditor: (mode: "create" | "edit", identifier?: string) => void;
  saveAgentFromEditor: () => Promise<void>;
  deleteAgentFromEditor: () => Promise<void>;
  refreshAgentData: (preferredAgent?: string | null) => Promise<void>;
}

function mapToolCategoryLabel(category: GlobalSkillCategory): string {
  if (category === "execute_command") {
    return "命令执行";
  }
  if (category === "web_search") {
    return "网络搜索";
  }
  return "文件系统";
}

function slugifyAsFilename(input: string): string {
  const normalized = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  return normalized ? `${normalized}.md` : "";
}

function normalizeFilenameInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withExt = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
  return withExt;
}

function parseTagsInput(raw: string): string[] {
  const tags = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    deduped.push(tag);
  }
  return deduped;
}

function formatTagsInput(tags: string[]): string {
  return tags.join(", ");
}

export function createAgentPanelController(input: AgentPanelDeps): AgentPanelController {
  const getAgentAvatar = (agent: Pick<StoredAgent, "name" | "avatar">): string => {
    const fromAvatar = input.firstChar(agent.avatar);
    if (fromAvatar) {
      return fromAvatar;
    }
    const fromName = input.firstChar(agent.name);
    if (fromName) {
      return fromName.toUpperCase();
    }
    return "A";
  };

  const persistActiveAgentPreference = (): void => {
    try {
      localStorage.setItem(input.agentStorageKey, input.state.activeAgentId);
    } catch {
      // ignore storage failures
    }
  };

  const loadActiveAgentPreference = (): string | null => {
    try {
      const raw = localStorage.getItem(input.agentStorageKey);
      return input.normalizeOptionalString(raw);
    } catch {
      return null;
    }
  };

  const getActiveAgent = (): StoredAgent | null => {
    const byId = input.state.agents.find((agent) => agent.id === input.state.activeAgentId);
    if (byId) {
      return byId;
    }
    const byDefault =
      input.state.agents.find((agent) => agent.readOnly) ??
      input.state.agents.find((agent) => agent.filename.toLowerCase() === "default.md");
    if (byDefault) {
      return byDefault;
    }
    return input.state.agents[0] ?? null;
  };

  const renderActiveAgentIdentity = (): void => {
    const agent = getActiveAgent();
    if (!agent) {
      return;
    }
    const avatar = getAgentAvatar(agent);

    input.activeAgentAvatar.textContent = avatar;
    input.activeAgentName.textContent = agent.name;

    input.welcomeAvatar.textContent = avatar;
    input.welcomeTitle.textContent = `你好，我是 ${agent.name}`;
  };

  const applyActiveAgent = (identifier: string | null, persist = true): void => {
    const target = identifier
      ? input.state.agents.find((agent) => agent.id === identifier || agent.filename === identifier)
      : null;
    const selected =
      target ??
      input.state.agents.find((agent) => agent.readOnly) ??
      input.state.agents.find((agent) => agent.filename.toLowerCase() === "default.md") ??
      input.state.agents[0] ??
      null;

    if (!selected) {
      input.state.activeAgentId = "";
      return;
    }

    input.state.activeAgentId = selected.id;
    if (persist) {
      persistActiveAgentPreference();
    }
    renderActiveAgentIdentity();
  };

  const updateEditorAvatarPreview = (): void => {
    const avatar =
      input.firstChar(input.agentEditorAvatarInput.value) || input.firstChar(input.agentEditorName.value).toUpperCase() || "A";
    input.agentEditorAvatarPreview.textContent = avatar;
  };

  const setAgentModalView = (view: "library" | "editor"): void => {
    const isEditor = view === "editor";
    input.agentLibraryView.classList.toggle("active", !isEditor);
    input.agentEditorView.classList.toggle("active", isEditor);
    input.agentEditorBackBtn.classList.toggle("visible", isEditor);
    input.agentModalTitle.textContent = isEditor
      ? input.state.editor.mode === "create"
        ? "创建 Agent"
        : "编辑 Agent"
      : "Agent 配置与切换";
  };

  const closeAgentModal = (): void => {
    input.agentLibraryModal.classList.remove("visible");
    setAgentModalView("library");
  };

  const renderEditorToolList = (): void => {
    input.agentToolList.innerHTML = "";
    if (input.state.agentToolProfiles.length === 0) {
      input.agentToolList.innerHTML = '<div class="agent-field-hint">未加载到工具清单，请稍后重试。</div>';
      return;
    }

    for (const tool of input.state.agentToolProfiles) {
      const row = document.createElement("div");
      const selected = input.state.editor.selectedTools.has(tool.name);
      row.className = "tool-row";
      row.innerHTML = `
        <div>
          <div class="tool-row-title">
            ${input.escapeHtml(tool.name)}
            <span class="tool-row-category">${input.escapeHtml(mapToolCategoryLabel(tool.category))}</span>
          </div>
          <div class="tool-row-desc">
            ${input.escapeHtml(tool.prompt || "无描述")}
          </div>
        </div>
      `;
      const toggle = document.createElement("button");
      toggle.className = "toggle-switch";
      toggle.dataset.enabled = selected ? "true" : "false";
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (input.state.editor.selectedTools.has(tool.name)) {
          input.state.editor.selectedTools.delete(tool.name);
        } else {
          input.state.editor.selectedTools.add(tool.name);
        }
        renderEditorToolList();
      });
      row.addEventListener("click", () => {
        if (input.state.editor.selectedTools.has(tool.name)) {
          input.state.editor.selectedTools.delete(tool.name);
        } else {
          input.state.editor.selectedTools.add(tool.name);
        }
        renderEditorToolList();
      });
      row.appendChild(toggle);
      input.agentToolList.appendChild(row);
    }
  };

  const openAgentEditor = (mode: "create" | "edit", identifier?: string): void => {
    if (mode === "create") {
      input.state.editor.mode = "create";
      input.state.editor.previousFilename = null;
      input.state.editor.filenameTouched = false;
      input.state.editor.selectedTools = new Set<string>(
        input.state.agentToolProfiles.length > 0 ? input.state.agentToolProfiles.map((tool) => tool.name) : []
      );
      input.agentEditorAvatarInput.value = "";
      input.agentEditorName.value = "";
      input.agentEditorFilename.value = "";
      input.agentEditorFilename.disabled = false;
      input.agentEditorDescription.value = "";
      input.agentEditorTags.value = "";
      input.agentEditorPrompt.value = input.defaultAgentPrompt;
      input.agentEditorDeleteBtn.classList.add("hidden");
      input.agentEditorSaveBtn.textContent = "创建 Agent";
    } else {
      const target = input.state.agents.find((agent) => agent.id === identifier || agent.filename === identifier);
      if (!target) {
        input.showError("找不到要编辑的 Agent");
        return;
      }
      if (target.readOnly) {
        input.showError("内置默认 Agent 为只读，不能编辑");
        return;
      }
      input.state.editor.mode = "edit";
      input.state.editor.previousFilename = target.filename;
      input.state.editor.filenameTouched = true;
      input.state.editor.selectedTools = new Set<string>(target.tools);
      input.agentEditorAvatarInput.value = target.avatar;
      input.agentEditorName.value = target.name;
      input.agentEditorFilename.value = target.filename;
      input.agentEditorFilename.disabled = target.readOnly;
      input.agentEditorDescription.value = target.description;
      input.agentEditorTags.value = formatTagsInput(target.tags);
      input.agentEditorPrompt.value = target.prompt;
      input.agentEditorDeleteBtn.classList.toggle("hidden", target.readOnly);
      input.agentEditorSaveBtn.textContent = "保存 Agent";
    }

    updateEditorAvatarPreview();
    renderEditorToolList();
    setAgentModalView("editor");
    input.agentLibraryModal.classList.add("visible");
  };

  const buildAgentCard = (agent: StoredAgent, index: number): HTMLDivElement => {
    const card = document.createElement("div");
    card.className = "agent-card";
    if (agent.id === input.state.activeAgentId) {
      card.classList.add("active");
    }
    card.style.animationDelay = `${Math.min(index * 0.04, 0.4)}s`;
    const avatar = getAgentAvatar(agent);
    const description = agent.description ? input.escapeHtml(agent.description) : "未填写简介";
    card.innerHTML = `
      <button class="agent-card-edit" title="编辑 Agent">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M15.502 1.94a.5.5 0 0 1 0 .706l-1.793 1.793-2.147-2.146L13.355.5a.5.5 0 0 1 .707 0l1.44 1.44ZM10.854 3.146 3 11v2h2l7.854-7.854-2-2ZM2 12.5V14h1.5l8.293-8.293-1.5-1.5L2 12.5Z"/>
        </svg>
      </button>
      <div class="avatar-container">
        <div class="card-avatar">${input.escapeHtml(avatar)}</div>
      </div>
      <div class="card-content">
        <div class="card-name">${input.escapeHtml(agent.name)}</div>
        <div class="card-file">${input.escapeHtml(agent.filename)}</div>
        <div class="card-description">${description}</div>
      </div>
    `;

    const editBtn = card.querySelector(".agent-card-edit") as HTMLButtonElement;
    if (agent.readOnly) {
      editBtn.classList.add("hidden");
      editBtn.disabled = true;
    } else {
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openAgentEditor("edit", agent.filename);
      });
    }

    card.addEventListener("click", () => {
      applyActiveAgent(agent.id);
      renderAgentGrid();
      closeAgentModal();
    });
    return card;
  };

  const buildAddAgentCard = (index: number): HTMLDivElement => {
    const card = document.createElement("div");
    card.className = "agent-card add-card";
    card.style.animationDelay = `${Math.min(index * 0.04, 0.5)}s`;
    card.innerHTML = `
      <div class="add-icon-box">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2Z"/>
        </svg>
      </div>
      <div class="add-card-label">Create New</div>
    `;
    card.addEventListener("click", () => openAgentEditor("create"));
    return card;
  };

  const renderAgentGrid = (): void => {
    input.agentGrid.innerHTML = "";
    const fragment = document.createDocumentFragment();
    input.state.agents.forEach((agent, index) => {
      fragment.appendChild(buildAgentCard(agent, index));
    });
    fragment.appendChild(buildAddAgentCard(input.state.agents.length));
    input.agentGrid.appendChild(fragment);
  };

  const saveAgentFromEditor = async (): Promise<void> => {
    const name = input.normalizeOptionalString(input.agentEditorName.value);
    if (!name) {
      input.showError("Agent 名称不能为空");
      return;
    }
    const prompt = input.normalizeOptionalString(input.agentEditorPrompt.value);
    if (!prompt) {
      input.showError("系统提示词不能为空");
      return;
    }

    const explicitFilename = normalizeFilenameInput(input.agentEditorFilename.value);
    let filename = explicitFilename || slugifyAsFilename(name);
    if (!filename) {
      input.showError("文件名不能为空");
      return;
    }
    if (input.state.editor.mode === "edit" && input.agentEditorFilename.disabled && input.state.editor.previousFilename) {
      filename = input.state.editor.previousFilename;
    }
    if (input.state.editor.mode === "edit" && input.state.editor.previousFilename) {
      const target = input.state.agents.find((agent) => agent.filename === input.state.editor.previousFilename);
      if (target?.readOnly) {
        input.showError("内置默认 Agent 为只读，不能编辑");
        return;
      }
    }

    const tags = parseTagsInput(input.agentEditorTags.value);
    const tools = Array.from(input.state.editor.selectedTools);
    const result = await input.api.saveAgent({
      previousFilename: input.state.editor.previousFilename,
      filename,
      name,
      avatar: input.normalizeOptionalString(input.agentEditorAvatarInput.value),
      description: input.normalizeOptionalString(input.agentEditorDescription.value),
      tags,
      tools,
      prompt
    });

    if (!result.ok || !result.agent) {
      input.showError(result.error || "保存 Agent 失败");
      return;
    }

    await refreshAgentData(result.agent.id);
    renderAgentGrid();
    setAgentModalView("library");
  };

  const deleteAgentFromEditor = async (): Promise<void> => {
    const target = input.normalizeOptionalString(input.state.editor.previousFilename);
    if (!target) {
      return;
    }
    const targetAgent = input.state.agents.find((agent) => agent.filename === target || agent.id === target);
    if (targetAgent?.readOnly) {
      input.showError("内置默认 Agent 为只读，不能删除");
      return;
    }
    const confirmed = window.confirm(`确认删除 Agent: ${target} ?`);
    if (!confirmed) {
      return;
    }
    const result = await input.api.deleteAgent(target);
    if (!result.ok) {
      input.showError(result.error || "删除 Agent 失败");
      return;
    }
    await refreshAgentData("default");
    renderAgentGrid();
    setAgentModalView("library");
  };

  const refreshAgentData = async (preferredAgent?: string | null): Promise<void> => {
    const activeWorkspace = input.getActiveSession()?.workspace ?? "";
    const [agentsRes, configRes, toolsRes] = await Promise.all([
      input.api.listAgents(),
      input.api.getAgentConfig(),
      input.api.listAgentTools({ workspace: activeWorkspace })
    ]);

    if (!agentsRes.ok || !agentsRes.agents) {
      input.showError(agentsRes.error || "加载 Agent 列表失败");
      return;
    }
    input.state.agents = agentsRes.agents;

    if (configRes.ok && configRes.config) {
      input.state.agentConfig = configRes.config;
    }

    if (toolsRes.ok && toolsRes.tools) {
      input.state.agentToolProfiles = toolsRes.tools;
    }

    const preferred = preferredAgent || input.state.activeAgentId || loadActiveAgentPreference();
    applyActiveAgent(preferred, true);
    renderAgentGrid();
    renderEditorToolList();
  };

  return {
    getActiveAgent,
    loadActiveAgentPreference,
    applyActiveAgent,
    renderActiveAgentIdentity,
    renderAgentGrid,
    renderEditorToolList,
    updateEditorAvatarPreview,
    setAgentModalView,
    closeAgentModal,
    openAgentEditor,
    saveAgentFromEditor,
    deleteAgentFromEditor,
    refreshAgentData
  };
}
