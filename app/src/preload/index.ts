import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { TuanziAPI } from "../shared/ipc-contracts";

const tuanziAPI: TuanziAPI = {
  sendMessage: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.chatSendMessage, payload);
  },

  getResumeState: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.chatGetResumeState, payload);
  },

  stopMessage: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.chatStopMessage, payload);
  },

  listCheckpoints: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.checkpointList, payload);
  },

  undoToCheckpoint: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.checkpointUndo, payload);
  },

  selectWorkspace: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.dialogSelectWorkspace);
  },

  minimizeWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.windowMinimize);
  },

  toggleMaximizeWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize);
  },

  closeWindow: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.windowClose);
  },

  isWindowMaximized: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized);
  },

  listAgents: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentList);
  },

  getAgent: (id) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentGet, { id });
  },

  saveAgent: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentSave, payload);
  },

  deleteAgent: (id) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentDelete, { id });
  },

  listAgentTools: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentListTools, payload);
  },

  getAgentConfig: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentConfigGet);
  },

  saveAgentConfig: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentConfigSave, payload);
  },

  listSkills: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.skillsList, payload);
  },

  testProviderConnection: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentConfigTestProviderConnection, payload);
  },

  fetchProviderModels: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.agentConfigFetchProviderModels, payload);
  },

  getWorkspaceMcp: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceMcpGet, payload);
  },

  saveWorkspaceMcp: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.workspaceMcpSave, payload);
  },

  getMcpDashboard: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpDashboardGet, payload);
  },

  mergeMcpJson: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpDashboardMergeJson, payload);
  },

  setMcpServerEnabled: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.mcpDashboardSetServerEnabled, payload);
  },

  memoryGetStatus: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.memoryGetStatus, payload);
  },

  memoryGetSummary: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.memoryGetSummary, payload);
  },

  memoryForceCompact: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.memoryForceCompact, payload);
  },

  memoryGetTurns: (payload) => {
    return ipcRenderer.invoke(IPC_CHANNELS.memoryGetTurns, payload);
  },

  onDelta: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { taskId: string; delta: string }): void => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.chatDelta, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatDelta, handler);
  },

  onThinking: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { taskId: string; delta: string }): void => {
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.chatThinking, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatThinking, handler);
  },

  onToolCalls: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.chatToolCalls, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatToolCalls, handler);
  },

  onToolCallCompleted: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.chatToolCallCompleted, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatToolCallCompleted, handler);
  },

  onLog: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.chatLog, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatLog, handler);
  },

  onPhase: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.chatPhase, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatPhase, handler);
  },

  onPlanPreview: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.chatPlanPreview, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatPlanPreview, handler);
  },
  onWindowMaximizedChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      callback(data as Parameters<typeof callback>[0]);
    };
    ipcRenderer.on(IPC_CHANNELS.windowMaximizedChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.windowMaximizedChanged, handler);
  }
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("tuanzi", tuanziAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore
  window.tuanzi = tuanziAPI;
}
