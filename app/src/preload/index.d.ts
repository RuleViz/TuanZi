export interface ChatResult {
  ok: boolean
  taskId: string
  summary?: string
  error?: string
  interrupted?: boolean
  resumeSnapshot?: ChatResumeSnapshot | null
  toolCalls?: Array<{
    toolName: string
    args: Record<string, unknown>
    result: { ok: boolean; data?: unknown; error?: string }
    timestamp: string
  }>
  changedFiles?: string[]
  executedCommands?: Array<{ command: string; exitCode: number | null }>
}

export interface ChatResumeToolCall {
  name: string
  args: Record<string, unknown>
  result: { ok: boolean; data?: unknown; error?: string }
}

export interface ChatResumeSnapshot {
  version: 1
  taskId: string
  sessionId: string
  workspace: string
  message: string
  history: Array<{ user: string; assistant: string }>
  agentId: string | null
  thinkingEnabled: boolean
  streamedText: string
  streamedThinking: string
  toolCalls: ChatResumeToolCall[]
  updatedAt: string
}

export type GlobalSkillCategory = 'file_system' | 'execute_command' | 'web_search'

export interface AgentProviderConfig {
  type: string
  apiKey: string
  baseUrl: string
  model: string
}

export interface ProviderModelItem {
  id: string
  displayName: string
  isVision: boolean
  enabled: boolean
}

export interface ProviderConfig extends AgentProviderConfig {
  id: string
  name: string
  models: ProviderModelItem[]
  isEnabled: boolean
}

export interface AgentBackendConfig {
  provider: AgentProviderConfig
  providers: ProviderConfig[]
  activeProviderId: string
  global_skills: {
    file_system: boolean
    execute_command: boolean
    web_search: boolean
  }
}

export interface StoredAgent {
  id: string
  filename: string
  name: string
  avatar: string
  description: string
  tags: string[]
  tools: string[]
  prompt: string
}

export interface AgentToolProfile {
  name: string
  category: GlobalSkillCategory
  prompt: string
}

export interface AgentSavePayload {
  previousFilename?: string | null
  filename?: string | null
  name: string
  avatar?: string | null
  description?: string | null
  tags?: string[]
  tools?: string[]
  prompt: string
}

export interface McpDashboardServer {
  serverId: string
  enabled: boolean
  command: string
  args: string[]
  env: Record<string, string>
  status: 'online' | 'offline' | 'error'
  error?: string
  tools: Array<{
    name: string
    description: string
    namespacedName: string
  }>
}

export interface TuanziAPI {
  sendMessage: (payload: {
    taskId?: string
    sessionId?: string
    message: string
    workspace: string
    history: Array<{ user: string; assistant: string }>
    agentId?: string | null
    thinking?: boolean
  }) => Promise<ChatResult>
  getResumeState: (payload: {
    sessionId?: string
    workspace: string
  }) => Promise<{ ok: boolean; resumeSnapshot?: ChatResumeSnapshot | null; error?: string }>
  stopMessage: (payload: { taskId: string }) => Promise<{ ok: boolean; error?: string }>
  selectWorkspace: () => Promise<string | null>
  listAgents: () => Promise<{ ok: boolean; agents?: StoredAgent[]; error?: string }>
  getAgent: (id: string) => Promise<{ ok: boolean; agent?: StoredAgent; error?: string }>
  saveAgent: (payload: AgentSavePayload) => Promise<{ ok: boolean; agent?: StoredAgent; error?: string }>
  deleteAgent: (id: string) => Promise<{ ok: boolean; error?: string }>
  listAgentTools: (payload: {
    workspace?: string | null
  }) => Promise<{ ok: boolean; tools?: AgentToolProfile[]; error?: string }>
  getAgentConfig: () => Promise<{ ok: boolean; config?: AgentBackendConfig; error?: string }>
  saveAgentConfig: (
    payload: unknown
  ) => Promise<{ ok: boolean; config?: AgentBackendConfig; error?: string }>
  testProviderConnection: (payload: {
    type?: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }) => Promise<{ ok: boolean; reachable?: boolean; message?: string; error?: string }>
  fetchProviderModels: (payload: {
    type?: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }) => Promise<{
    ok: boolean
    models?: Array<{ id: string; displayName: string; isVision: boolean }>
    message?: string
    error?: string
  }>
  getWorkspaceMcp: (payload: {
    workspace?: string | null
  }) => Promise<{ ok: boolean; mcp?: Record<string, unknown>; error?: string }>
  saveWorkspaceMcp: (payload: {
    workspace?: string | null
    mcp?: Record<string, unknown>
  }) => Promise<{ ok: boolean; error?: string }>
  getMcpDashboard: (payload: {
    workspace?: string | null
  }) => Promise<{ ok: boolean; mcp?: { servers: McpDashboardServer[] }; error?: string }>
  mergeMcpJson: (payload: {
    jsonText?: string | null
  }) => Promise<{ ok: boolean; error?: string }>
  setMcpServerEnabled: (payload: {
    serverId: string
    enabled: boolean
  }) => Promise<{ ok: boolean; error?: string }>
  onDelta: (callback: (data: { taskId: string; delta: string }) => void) => () => void
  onThinking: (callback: (data: { taskId: string; delta: string }) => void) => () => void
  onToolCalls: (
    callback: (data: {
      taskId: string
      toolCalls: Array<{
        toolName: string
        args: Record<string, unknown>
        result: { ok: boolean; data?: unknown; error?: string }
        timestamp: string
      }>
    }) => void
  ) => () => void
  onToolCallCompleted: (
    callback: (data: {
      taskId: string
      toolCall: {
        toolName: string
        args: Record<string, unknown>
        result: { ok: boolean; data?: unknown; error?: string }
        timestamp: string
      }
    }) => void
  ) => () => void
  onLog: (
    callback: (data: { taskId: string; level: string; message: string }) => void
  ) => () => void
  onPhase: (callback: (data: { taskId: string; phase: string }) => void) => () => void
}

declare global {
  interface Window {
    tuanzi: TuanziAPI
  }
}
