import type {
  AgentBackendConfig,
  AgentSavePayload,
  AgentToolProfile,
  ChatImageInput,
  McpDashboardServer,
  SkillCatalogItem,
  StoredAgent,
  TurnCheckpointInfo
} from "./domain-types";

export interface ChatResumeToolCall {
  name: string;
  args: Record<string, unknown>;
  result: { ok: boolean; data?: unknown; error?: string };
}

export interface ChatResumeSnapshot {
  version: 1;
  taskId: string;
  sessionId: string;
  workspace: string;
  message: string;
  history: Array<{ user: string; assistant: string }>;
  agentId: string | null;
  thinkingEnabled: boolean;
  streamedText: string;
  streamedThinking: string;
  toolCalls: ChatResumeToolCall[];
  updatedAt: string;
}

export interface ChatResult {
  ok: boolean;
  taskId: string;
  summary?: string;
  error?: string;
  interrupted?: boolean;
  resumeSnapshot?: ChatResumeSnapshot | null;
  toolCalls?: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result: { ok: boolean; data?: unknown; error?: string };
    timestamp: string;
  }>;
  changedFiles?: string[];
  executedCommands?: Array<{ command: string; exitCode: number | null }>;
}

export interface SendMessagePayload {
  taskId?: string;
  sessionId?: string;
  message: string;
  images?: ChatImageInput[];
  workspace: string;
  agentId?: string | null;
  thinking?: boolean;
  planMode?: boolean;
}

export interface MemoryStatusPayload {
  workspace: string;
  sessionId?: string;
}

export interface MemoryGetSummaryPayload {
  workspace: string;
  sessionId?: string;
}

export interface MemoryForceCompactPayload {
  workspace: string;
  sessionId?: string;
}

export interface MemoryGetTurnsPayload {
  workspace: string;
  sessionId?: string;
  afterSeq?: number;
}

export interface GetResumeStatePayload {
  sessionId?: string;
  workspace: string;
}

export interface StopMessagePayload {
  taskId: string;
}

export interface StopMessageResult {
  ok: boolean;
  status: "accepted" | "already_stopping" | "not_found";
  error?: string;
}

export interface WorkbenchTaskItem {
  id: string;
  title: string;
  kind: "plan" | "execution" | "search" | "coding";
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}

export interface ModifiedFileEntry {
  path: string;
  added: number;
  removed: number;
}

export interface TerminalSessionSummary {
  terminalId: string;
  sessionId: string;
  title: string;
  workspace: string;
  status: "running" | "exited" | "closed";
  createdAt: string;
  exitCode?: number | null;
}

export interface TerminalCreatePayload {
  sessionId: string;
  workspace: string;
  title?: string;
}

export interface TerminalWritePayload {
  terminalId: string;
  data: string;
}

export interface TerminalResizePayload {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalClosePayload {
  terminalId: string;
}

export interface CheckpointListPayload {
  workspace: string;
}

export interface CheckpointUndoPayload {
  workspace: string;
  checkpointId: string;
}

export interface ProviderProbePayload {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface TuanziAPI {
  sendMessage: (payload: SendMessagePayload) => Promise<ChatResult>;
  getResumeState: (
    payload: GetResumeStatePayload
  ) => Promise<{ ok: boolean; resumeSnapshot?: ChatResumeSnapshot | null; error?: string }>;
  stopMessage: (payload: StopMessagePayload) => Promise<StopMessageResult>;
  createTerminal: (payload: TerminalCreatePayload) => Promise<{
    ok: boolean;
    terminal?: TerminalSessionSummary;
    error?: string;
  }>;
  writeTerminal: (payload: TerminalWritePayload) => Promise<{ ok: boolean; error?: string }>;
  resizeTerminal: (payload: TerminalResizePayload) => Promise<{ ok: boolean; error?: string }>;
  closeTerminal: (payload: TerminalClosePayload) => Promise<{ ok: boolean; error?: string }>;
  listCheckpoints: (
    payload: CheckpointListPayload
  ) => Promise<{ ok: boolean; checkpoints?: TurnCheckpointInfo[]; error?: string }>;
  undoToCheckpoint: (
    payload: CheckpointUndoPayload
  ) => Promise<{ ok: boolean; restoredFiles?: number; removedFiles?: number; error?: string }>;
  selectWorkspace: () => Promise<string | null>;
  minimizeWindow: () => Promise<{ ok: boolean; error?: string }>;
  toggleMaximizeWindow: () => Promise<{ ok: boolean; maximized?: boolean; error?: string }>;
  closeWindow: () => Promise<{ ok: boolean; error?: string }>;
  isWindowMaximized: () => Promise<{ ok: boolean; maximized?: boolean; error?: string }>;
  listAgents: () => Promise<{ ok: boolean; agents?: StoredAgent[]; error?: string }>;
  getAgent: (id: string) => Promise<{ ok: boolean; agent?: StoredAgent; error?: string }>;
  saveAgent: (payload: AgentSavePayload) => Promise<{ ok: boolean; agent?: StoredAgent; error?: string }>;
  deleteAgent: (id: string) => Promise<{ ok: boolean; error?: string }>;
  listAgentTools: (
    payload: { workspace?: string | null }
  ) => Promise<{ ok: boolean; tools?: AgentToolProfile[]; error?: string }>;
  getAgentConfig: () => Promise<{ ok: boolean; config?: AgentBackendConfig; error?: string }>;
  saveAgentConfig: (
    payload: unknown
  ) => Promise<{ ok: boolean; config?: AgentBackendConfig; error?: string }>;
  listSkills: (
    payload: {
      workspace?: string | null;
      workspaceCandidates?: Array<string | null | undefined>;
    }
  ) => Promise<{ ok: boolean; skills?: SkillCatalogItem[]; error?: string }>;
  testProviderConnection: (
    payload: ProviderProbePayload
  ) => Promise<{ ok: boolean; reachable?: boolean; message?: string; error?: string }>;
  fetchProviderModels: (payload: ProviderProbePayload) => Promise<{
    ok: boolean;
    models?: Array<{ id: string; displayName: string; isVision: boolean }>;
    message?: string;
    error?: string;
  }>;
  getWorkspaceMcp: (payload: {
    workspace?: string | null;
  }) => Promise<{ ok: boolean; mcp?: Record<string, unknown>; error?: string }>;
  saveWorkspaceMcp: (payload: {
    workspace?: string | null;
    mcp?: Record<string, unknown>;
  }) => Promise<{ ok: boolean; error?: string }>;
  getMcpDashboard: (payload: {
    workspace?: string | null;
  }) => Promise<{ ok: boolean; mcp?: { servers: McpDashboardServer[] }; error?: string }>;
  mergeMcpJson: (payload: { jsonText?: string | null }) => Promise<{ ok: boolean; error?: string }>;
  setMcpServerEnabled: (payload: {
    serverId: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  memoryGetStatus: (
    payload: MemoryStatusPayload
  ) => Promise<{
    ok: boolean;
    status?: {
      sessionId: string;
      workspace: string;
      nextSeq: number;
      lastCompactedSeq: number;
      turnCount: number;
      hasSummary: boolean;
      summaryUpdatedAt: string | null;
      summaryFromSeq: number | null;
      summaryToSeq: number | null;
    };
    error?: string;
  }>;
  memoryGetSummary: (
    payload: MemoryGetSummaryPayload
  ) => Promise<{
    ok: boolean;
    summary?: {
      fromSeq: number;
      toSeq: number;
      title: string;
      summary: string;
      keyPoints: string[];
      openQuestions: string[];
      updatedAt: string;
      source: "model" | "fallback";
    } | null;
    error?: string;
  }>;
  memoryForceCompact: (
    payload: MemoryForceCompactPayload
  ) => Promise<{
    ok: boolean;
    summary?: {
      fromSeq: number;
      toSeq: number;
      title: string;
      summary: string;
      keyPoints: string[];
      openQuestions: string[];
      updatedAt: string;
      source: "model" | "fallback";
    } | null;
    error?: string;
  }>;
  memoryGetTurns: (
    payload: MemoryGetTurnsPayload
  ) => Promise<{
    ok: boolean;
    turns?: Array<{
      seq: number;
      user: string;
      assistant: string;
      interrupted: boolean;
      createdAt: string;
    }>;
    error?: string;
  }>;
  onDelta: (callback: (data: { taskId: string; delta: string }) => void) => () => void;
  onThinking: (callback: (data: { taskId: string; delta: string }) => void) => () => void;
  onToolCalls: (
    callback: (data: {
      taskId: string;
      toolCalls: Array<{
        toolName: string;
        args: Record<string, unknown>;
        result: { ok: boolean; data?: unknown; error?: string };
        timestamp: string;
      }>;
    }) => void
  ) => () => void;
  onToolCallCompleted: (
    callback: (data: {
      taskId: string;
      toolCall: {
        toolName: string;
        args: Record<string, unknown>;
        result: { ok: boolean; data?: unknown; error?: string };
        timestamp: string;
      };
    }) => void
  ) => () => void;
  onLog: (callback: (data: { taskId: string; level: string; message: string }) => void) => () => void;
  onPhase: (callback: (data: { taskId: string; phase: string }) => void) => () => void;
  onPlanPreview: (callback: (data: { taskId: string; preview: string }) => void) => () => void;
  onTasks: (callback: (data: { taskId: string; sessionId: string; tasks: WorkbenchTaskItem[] }) => void) => () => void;
  onModifiedFiles: (
    callback: (data: { taskId: string; sessionId: string; files: ModifiedFileEntry[] }) => void
  ) => () => void;
  onTerminalOpened: (
    callback: (data: { terminal: TerminalSessionSummary }) => void
  ) => () => void;
  onTerminalData: (
    callback: (data: { terminalId: string; sessionId: string; chunk: string }) => void
  ) => () => void;
  onTerminalExit: (
    callback: (data: { terminalId: string; sessionId: string; exitCode: number | null }) => void
  ) => () => void;
  onTerminalClosed: (
    callback: (data: { terminalId: string; sessionId: string }) => void
  ) => () => void;
  onWindowMaximizedChanged: (callback: (data: { maximized: boolean }) => void) => () => void;
}
