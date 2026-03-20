import type {
  AgentBackendConfig,
  AgentToolProfile,
  ChatImageInput,
  McpDashboardServer,
  ProviderConfig,
  SkillCatalogItem,
  StoredAgent
} from "../../../shared/domain-types";
import type {
  ModifiedFileEntry,
  TerminalSessionSummary,
  WorkbenchTaskItem
} from "../../../shared/ipc-contracts";

export interface ConversationTurn {
  user: string;
  assistant: string;
  thinking?: string;
  interrupted?: boolean;
  toolCalls?: ConversationToolCall[];
  checkpointId?: string;
}

export interface ConversationToolCall {
  id?: string;
  toolName: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
  timestamp?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  history: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredSessionPayload {
  version: 1;
  activeSessionId: string;
  sessions: ChatSession[];
}

export interface AgentEditorState {
  mode: "create" | "edit";
  previousFilename: string | null;
  filenameTouched: boolean;
  selectedTools: Set<string>;
}

export interface SettingsDraft {
  providers: ProviderConfig[];
  activeProviderId: string;
}

export interface SlashSuggestion {
  id: string;
  label: string;
  description: string;
  commandText: string;
  executeImmediately: boolean;
}

export interface PendingChatImage extends ChatImageInput {
  sizeBytes: number;
}

export interface WorkbenchTerminalState extends TerminalSessionSummary {
  output: string;
}

export interface SessionWorkbenchState {
  tasks: WorkbenchTaskItem[];
  terminals: WorkbenchTerminalState[];
  modifiedFiles: ModifiedFileEntry[];
  selectedTerminalId: string | null;
}

export const state = {
  sessions: [] as ChatSession[],
  activeSessionId: "",
  isSending: false,
  isStopping: false,
  currentStreamText: "",
  currentTaskId: "",
  currentRenderedToolCalls: 0,

  agents: [] as StoredAgent[],
  activeAgentId: "",
  agentToolProfiles: [] as AgentToolProfile[],
  agentConfig: null as AgentBackendConfig | null,
  editor: {
    mode: "create",
    previousFilename: null,
    filenameTouched: false,
    selectedTools: new Set<string>()
  } as AgentEditorState,
  expandedWorkspaceKeys: new Set<string>(),
  settingsDraft: null as SettingsDraft | null,
  skillCatalog: [] as SkillCatalogItem[],
  slashSuggestions: [] as SlashSuggestion[],
  slashActiveIndex: 0,
  slashVisible: false,
  pendingImage: null as PendingChatImage | null,
  mcpServers: [] as McpDashboardServer[],
  expandedMcpServerIds: new Set<string>(),
  isMcpLoading: false,
  hasLoadedMcp: false,
  mcpLoadToken: 0,
  isThinking: false,
  planModeEnabled: false,
  workbenchOpen: false,
  sessionWorkbench: {} as Record<string, SessionWorkbenchState>
};
