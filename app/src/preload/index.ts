import { contextBridge, ipcRenderer } from 'electron'

// ── TuanZi Desktop API ─────────────────────────────────
// Exposes a type-safe API to the renderer process via contextBridge.

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

export interface ChatImageInput {
  name: string
  mimeType: string
  dataUrl: string
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

const tuanziAPI = {
  /**
   * Send a chat message to the Agent.
   */
  sendMessage: (payload: {
    taskId?: string
    sessionId?: string
    message: string
    images?: ChatImageInput[]
    workspace: string
    history: Array<{ user: string; assistant: string }>
    agentId?: string | null
    thinking?: boolean
  }): Promise<ChatResult> => {
    return ipcRenderer.invoke('chat:sendMessage', payload)
  },

  getResumeState: (payload: {
    sessionId?: string
    workspace: string
  }): Promise<{ ok: boolean; resumeSnapshot?: ChatResumeSnapshot | null; error?: string }> => {
    return ipcRenderer.invoke('chat:getResumeState', payload)
  },

  /**
   * Stop an ongoing task.
   */
  stopMessage: (payload: { taskId: string }): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('chat:stopMessage', payload)
  },

  /**
   * Open OS directory picker.
   */
  selectWorkspace: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:selectWorkspace')
  },

  minimizeWindow: (): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('window:minimize')
  },

  toggleMaximizeWindow: (): Promise<{ ok: boolean; maximized?: boolean; error?: string }> => {
    return ipcRenderer.invoke('window:toggleMaximize')
  },

  closeWindow: (): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('window:close')
  },

  isWindowMaximized: (): Promise<{ ok: boolean; maximized?: boolean; error?: string }> => {
    return ipcRenderer.invoke('window:isMaximized')
  },

  listAgents: (): Promise<{ ok: boolean; agents?: StoredAgent[]; error?: string }> => {
    return ipcRenderer.invoke('agent:list')
  },

  getAgent: (id: string): Promise<{ ok: boolean; agent?: StoredAgent; error?: string }> => {
    return ipcRenderer.invoke('agent:get', { id })
  },

  saveAgent: (
    payload: AgentSavePayload
  ): Promise<{ ok: boolean; agent?: StoredAgent; error?: string }> => {
    return ipcRenderer.invoke('agent:save', payload)
  },

  deleteAgent: (id: string): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('agent:delete', { id })
  },

  listAgentTools: (payload: {
    workspace?: string | null
  }): Promise<{ ok: boolean; tools?: AgentToolProfile[]; error?: string }> => {
    return ipcRenderer.invoke('agent:listTools', payload)
  },

  getAgentConfig: (): Promise<{ ok: boolean; config?: AgentBackendConfig; error?: string }> => {
    return ipcRenderer.invoke('agent-config:get')
  },

  saveAgentConfig: (
    payload: unknown
  ): Promise<{ ok: boolean; config?: AgentBackendConfig; error?: string }> => {
    return ipcRenderer.invoke('agent-config:save', payload)
  },

  testProviderConnection: (payload: {
    type?: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }): Promise<{ ok: boolean; reachable?: boolean; message?: string; error?: string }> => {
    return ipcRenderer.invoke('agent-config:testProviderConnection', payload)
  },

  fetchProviderModels: (payload: {
    type?: string
    baseUrl?: string
    apiKey?: string
    model?: string
  }): Promise<{
    ok: boolean
    models?: Array<{ id: string; displayName: string; isVision: boolean }>
    message?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('agent-config:fetchProviderModels', payload)
  },

  getWorkspaceMcp: (payload: {
    workspace?: string | null
  }): Promise<{ ok: boolean; mcp?: Record<string, unknown>; error?: string }> => {
    return ipcRenderer.invoke('workspace:mcp:get', payload)
  },

  saveWorkspaceMcp: (payload: {
    workspace?: string | null
    mcp?: Record<string, unknown>
  }): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('workspace:mcp:save', payload)
  },

  getMcpDashboard: (payload: {
    workspace?: string | null
  }): Promise<{ ok: boolean; mcp?: { servers: McpDashboardServer[] }; error?: string }> => {
    return ipcRenderer.invoke('mcp:dashboard:get', payload)
  },

  mergeMcpJson: (payload: {
    jsonText?: string | null
  }): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('mcp:dashboard:mergeJson', payload)
  },

  setMcpServerEnabled: (payload: {
    serverId: string
    enabled: boolean
  }): Promise<{ ok: boolean; error?: string }> => {
    return ipcRenderer.invoke('mcp:dashboard:setServerEnabled', payload)
  },

  /**
   * Listen for streamed text deltas from the agent.
   */
  onDelta: (callback: (data: { taskId: string; delta: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { taskId: string; delta: string }): void => {
      callback(data)
    }
    ipcRenderer.on('chat:delta', handler)
    return () => ipcRenderer.removeListener('chat:delta', handler)
  },

  /**
   * Listen for streamed thinking content deltas from the agent.
   */
  onThinking: (callback: (data: { taskId: string; delta: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { taskId: string; delta: string }): void => {
      callback(data)
    }
    ipcRenderer.on('chat:thinking', handler)
    return () => ipcRenderer.removeListener('chat:thinking', handler)
  },

  /**
   * Listen for tool call notifications.
   */
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
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('chat:toolCalls', handler)
    return () => ipcRenderer.removeListener('chat:toolCalls', handler)
  },

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
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('chat:toolCallCompleted', handler)
    return () => ipcRenderer.removeListener('chat:toolCallCompleted', handler)
  },

  /**
   * Listen for agent logging events.
   */
  onLog: (
    callback: (data: { taskId: string; level: string; message: string }) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('chat:log', handler)
    return () => ipcRenderer.removeListener('chat:log', handler)
  },

  /**
   * Listen for phase change notifications.
   */
  onPhase: (
    callback: (data: { taskId: string; phase: string }) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('chat:phase', handler)
    return () => ipcRenderer.removeListener('chat:phase', handler)
  },

  onWindowMaximizedChanged: (
    callback: (data: { maximized: boolean }) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0])
    }
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('tuanzi', tuanziAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.tuanzi = tuanziAPI
}
