import type {
  AgentBackendConfig,
  AgentToolProfile,
  StoredAgent
} from "../../../../shared/domain-types";
import type { TuanziAPI } from "../../../../shared/ipc-contracts";
import type { AgentEditorState, ChatSession } from "../../app/state";
import { bindAgentEditorEvents as bindAgentEditorEventsFeature } from "./agent-events";
import { createAgentPanelController } from "./agent-panel";

interface AgentFeatureState {
  agents: StoredAgent[];
  activeAgentId: string;
  agentToolProfiles: AgentToolProfile[];
  agentConfig: AgentBackendConfig | null;
  editor: AgentEditorState;
}

interface AgentFeatureDeps {
  state: AgentFeatureState;
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
  slugifyAsFilename: (input: string) => string;
  escapeHtml: (text: string) => string;
  showError: (message: string) => void;
  getActiveSession: () => ChatSession | null;
  api: Pick<TuanziAPI, "saveAgent" | "deleteAgent" | "listAgents" | "getAgentConfig" | "listAgentTools">;
}

export interface AgentFeature {
  getActiveAgent: () => StoredAgent | null;
  loadActiveAgentPreference: () => string | null;
  renderEditorToolList: () => void;
  setAgentModalView: (view: "library" | "editor") => void;
  closeAgentModal: () => void;
  saveAgentFromEditor: () => Promise<void>;
  deleteAgentFromEditor: () => Promise<void>;
  refreshAgentData: (preferredAgent?: string | null) => Promise<void>;
  openAgentLibrary: () => Promise<void>;
  bindAgentEditorEvents: () => void;
}

export function createAgentFeature(input: AgentFeatureDeps): AgentFeature {
  const panel = createAgentPanelController({
    state: input.state,
    agentStorageKey: input.agentStorageKey,
    defaultAgentPrompt: input.defaultAgentPrompt,
    activeAgentAvatar: input.activeAgentAvatar,
    activeAgentName: input.activeAgentName,
    welcomeAvatar: input.welcomeAvatar,
    welcomeTitle: input.welcomeTitle,
    agentGrid: input.agentGrid,
    agentToolList: input.agentToolList,
    agentLibraryModal: input.agentLibraryModal,
    agentLibraryView: input.agentLibraryView,
    agentEditorView: input.agentEditorView,
    agentEditorBackBtn: input.agentEditorBackBtn,
    agentModalTitle: input.agentModalTitle,
    agentEditorAvatarInput: input.agentEditorAvatarInput,
    agentEditorAvatarPreview: input.agentEditorAvatarPreview,
    agentEditorName: input.agentEditorName,
    agentEditorFilename: input.agentEditorFilename,
    agentEditorDescription: input.agentEditorDescription,
    agentEditorTags: input.agentEditorTags,
    agentEditorPrompt: input.agentEditorPrompt,
    agentEditorDeleteBtn: input.agentEditorDeleteBtn,
    agentEditorSaveBtn: input.agentEditorSaveBtn,
    firstChar: input.firstChar,
    normalizeOptionalString: input.normalizeOptionalString,
    escapeHtml: input.escapeHtml,
    showError: input.showError,
    getActiveSession: input.getActiveSession,
    api: input.api
  });

  const bindAgentEditorEvents = (): void => {
    bindAgentEditorEventsFeature({
      state: input.state,
      agentEditorName: input.agentEditorName,
      agentEditorFilename: input.agentEditorFilename,
      agentEditorAvatarInput: input.agentEditorAvatarInput,
      slugifyAsFilename: input.slugifyAsFilename,
      updateEditorAvatarPreview: panel.updateEditorAvatarPreview
    });
  };

  const openAgentLibrary = async (): Promise<void> => {
    await panel.refreshAgentData();
    panel.setAgentModalView("library");
    input.agentLibraryModal.classList.add("visible");
  };

  return {
    getActiveAgent: panel.getActiveAgent,
    loadActiveAgentPreference: panel.loadActiveAgentPreference,
    renderEditorToolList: panel.renderEditorToolList,
    setAgentModalView: panel.setAgentModalView,
    closeAgentModal: panel.closeAgentModal,
    saveAgentFromEditor: panel.saveAgentFromEditor,
    deleteAgentFromEditor: panel.deleteAgentFromEditor,
    refreshAgentData: panel.refreshAgentData,
    openAgentLibrary,
    bindAgentEditorEvents
  };
}
