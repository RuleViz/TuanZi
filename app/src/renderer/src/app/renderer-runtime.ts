import {
  activeAgentAvatar,
  activeAgentName,
  agentEditorAvatarInput,
  agentEditorAvatarPreview,
  agentEditorBackBtn,
  agentEditorDeleteBtn,
  agentEditorDescription,
  agentEditorFilename,
  agentEditorName,
  agentEditorPrompt,
  agentEditorSaveBtn,
  agentEditorTags,
  agentEditorView,
  agentGrid,
  agentLibraryModal,
  agentLibraryView,
  agentModalTitle,
  agentToolList,
  attachImageBtn,
  byId,
  chatArea,
  closeMcpJsonModalBtn,
  closeProviderModelModalBtn,
  historyList,
  imageFileInput,
  inputBox,
  inputImagePreview,
  inputTextarea,
  mcpAddBtn,
  mcpJsonCancelBtn,
  mcpJsonConfirmBtn,
  mcpJsonInput,
  mcpJsonModal,
  mcpRefreshBtn,
  mcpServerList,
  planModeBtn,
  providerAddBtn,
  providerAddModelBtn,
  providerApiKeyInput,
  providerBaseUrlInput,
  providerDeleteBtn,
  providerEditorTitle,
  providerEnabledToggle,
  providerFetchModelsBtn,
  providerList,
  providerModelInput,
  providerModelList,
  providerModelModal,
  providerModelModalCancelBtn,
  providerModelModalConfirmBtn,
  providerModelModalContextWindowInput,
  providerModelModalDisplayNameInput,
  providerModelModalIdInput,
  providerModelModalMaxOutputInput,
  providerModelModalProtocolTypeSelect,
  providerModelModalVisionToggle,
  providerNameInput,
  providerTestBtn,
  providerTypeInput,
  sendingIndicator,
  sendBtn,
  settingsModal,
  settingsNav,
  skillsCatalogList,
  slashCommandList,
  slashCommandMenu,
  stopBtn,
  toggleWorkbench,
  thinkingBtn,
  welcomeAvatar,
  welcomeState,
  welcomeTitle,
  closeWorkbenchBtn,
  workbenchDrawer,
  workbenchFiles,
  workbenchFilesCount,
  workbenchTasks,
  workbenchTasksCount,
  workbenchTerminalPanel,
  workbenchTerminalTabs,
  workbenchTerminalsCount,
  newWorkbenchTerminalBtn,
  workspaceLabel
} from "./dom"
import { createChatViewport } from "./chat-viewport"
import { createBindInitEvents, createBindTopBarDrag } from "./init-bindings"
import { state } from "./state"
import {
  escapeHtml,
  firstChar,
  formatByteSize,
  normalizeOptionalString,
  slugifyAsFilename
} from "./text-utils"
import { showError, showSuccess } from "./toast"
import { createAgentFeature } from "../features/agent/agent-feature"
import { createImageAttachmentController } from "../features/chat/image-attach"
import { createMarkdownRenderer } from "../features/chat/markdown"
import { createMessageRenderer } from "../features/chat/message-render"
import { createChatRuntime } from "../features/chat/runtime"
import { createSlashCommandController } from "../features/chat/slash-command"
import { createSessionFeature } from "../features/session/session-feature"
import { createSettingsFeature } from "../features/settings/settings-feature"
import { createWorkbenchFeature } from "../features/workbench/workbench-feature"

const SESSION_STORAGE_KEY = "tuanzi.desktop.sessions.v1"
const AGENT_STORAGE_KEY = "tuanzi.desktop.activeAgent.v1"
const DEFAULT_SESSION_TITLE = "新对话"
const MAX_SESSION_HISTORY = 30
const TITLE_MAX_CHARS = 18
const DEFAULT_AGENT_PROMPT = "你是一个务实、准确的 AI 编程助手，先理解需求，再按需调用工具并验证结果。"
const EMPTY_WORKSPACE_KEY = "__no_workspace__"
const DEFAULT_PROVIDER_TYPE = "openai"
const DEFAULT_PROVIDER_BASE_URL = "https://api.openai.com/v1"
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_TITLEBAR_HEIGHT = 38
const SESSION_PERSIST_DEBOUNCE_MS = 220

function createSessionPersistPerfLog(): (event: string, fields?: Record<string, unknown>) => void {
  const enabled = window.localStorage.getItem("tuanzi.desktop.sessionPerf") === "1"
  return (event: string, fields?: Record<string, unknown>): void => {
    if (!enabled) {
      return
    }
    const payload = fields ? ` ${JSON.stringify(fields)}` : ""
    console.log(`[session-persist] ${event}${payload}`)
  }
}

export function createRendererRuntime() {
  const sessionPersistPerfLog = createSessionPersistPerfLog()

  const {
    clearPendingImage,
    attachImageFile
  } = createImageAttachmentController({
    state,
    inputImagePreview,
    attachImageBtn,
    imageFileInput,
    byId,
    escapeHtml,
    formatByteSize,
    showError,
    maxImageBytes: MAX_CHAT_IMAGE_BYTES
  })

  const {
    scrollToBottom,
    smartScrollToBottom,
    autoResizeTextarea
  } = createChatViewport({
    chatArea,
    inputTextarea,
    maxInputHeight: 200
  })

  const renderMarkdownHtml = createMarkdownRenderer({
    escapeHtml
  })

  const {
    addUserMessage,
    addAssistantMessage,
    createAssistantSurface,
    createExecBlock,
    renderToolCalls,
    appendCompletedToolCall
  } = createMessageRenderer({
    chatArea,
    welcomeState,
    escapeHtml,
    formatByteSize,
    renderMarkdownHtml,
    scrollToBottom
  })

  // Undo turn callback — will be fully wired after sessionFeature is created
  let undoTurnImpl: ((turnIndex: number) => void) | undefined
  let renderCurrentSessionWorkbench = (): void => {}

  const sessionFeature = createSessionFeature({
    state,
    defaultSessionTitle: DEFAULT_SESSION_TITLE,
    maxSessionHistory: MAX_SESSION_HISTORY,
    titleMaxChars: TITLE_MAX_CHARS,
    sessionStorageKey: SESSION_STORAGE_KEY,
    sessionPersistDebounceMs: SESSION_PERSIST_DEBOUNCE_MS,
    sessionPersistPerfLog,
    emptyWorkspaceKey: EMPTY_WORKSPACE_KEY,
    emptyWorkspaceLabel: "未选择工作目录",
    emptyWorkspaceTitle: "点击选择工作目录",
    chatArea,
    welcomeState,
    workspaceLabel,
    historyList,
    inputTextarea,
    addUserMessage,
    addAssistantMessage,
    scrollToBottom,
    clearPendingImage,
    autoResizeTextarea,
    showError,
    api: window.tuanzi,
    onSessionChanged: () => {
      renderCurrentSessionWorkbench()
    },
    onUndoTurn: (turnIndex: number) => {
      if (undoTurnImpl) {
        undoTurnImpl(turnIndex)
      }
    }
  })

  const {
    syncInterruptedTurn,
    getActiveSession,
    ensureActiveSession,
    truncateTitleFromInput,
    persistSessions,
    flushSessionsToStorage,
    loadSessionsFromStorage,
    touchActiveSession,
    refreshResumeSnapshot,
    renderWorkspaceLabel,
    renderActiveConversation,
    renderSessionList,
    closeHistoryContextMenu,
    selectWorkspace,
    createNewSession
  } = sessionFeature

  const workbenchFeature = createWorkbenchFeature({
    state,
    drawer: workbenchDrawer,
    tasksContainer: workbenchTasks,
    tasksCount: workbenchTasksCount,
    terminalsCount: workbenchTerminalsCount,
    filesCount: workbenchFilesCount,
    filesContainer: workbenchFiles,
    terminalTabs: workbenchTerminalTabs,
    terminalPanel: workbenchTerminalPanel,
    toggleButton: toggleWorkbench,
    closeButton: closeWorkbenchBtn,
    newTerminalButton: newWorkbenchTerminalBtn,
    showError,
    api: window.tuanzi
  })
  renderCurrentSessionWorkbench = () => {
    workbenchFeature.renderCurrentSessionWorkbench()
  }

  // Wire the undo turn handler now that session feature is available
  undoTurnImpl = (turnIndex: number) => {
    if (state.isSending) {
      showError("请等待当前任务完成后再撤回")
      return
    }
    const active = getActiveSession()
    if (!active || !active.workspace) {
      showError("没有活跃的会话或工作目录")
      return
    }
    if (turnIndex < 0 || turnIndex >= active.history.length) {
      showError("无效的撤回位置")
      return
    }

    // List checkpoints and find the one matching this turn
    window.tuanzi.listCheckpoints({ workspace: active.workspace }).then((listResult) => {
      if (!listResult.ok || !listResult.checkpoints) {
        showError("无法获取检查点列表")
        return
      }

      // The checkpoint at position turnIndex corresponds to the state before that turn
      const checkpoints = listResult.checkpoints
      if (turnIndex >= checkpoints.length) {
        showError("没有对应的检查点（可能检查点已过期）")
        return
      }
      const checkpoint = checkpoints[turnIndex]

      return window.tuanzi.undoToCheckpoint({
        workspace: active.workspace,
        checkpointId: checkpoint.id
      }).then((result) => {
        if (!result.ok) {
          showError(result.error || "撤回失败")
          return
        }
        // Remove turns from turnIndex onward
        active.history.splice(turnIndex)
        touchActiveSession()
        persistSessions()
        renderActiveConversation()
        renderSessionList()
        showSuccess(`✓ 已撤回到第 ${turnIndex} 轮（恢复 ${result.restoredFiles ?? 0} 文件，移除 ${result.removedFiles ?? 0} 文件）`)
      })
    }).catch((err) => {
      showError(`撤回失败: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const bindTopBarDrag = createBindTopBarDrag({
    defaultTitlebarHeight: DEFAULT_TITLEBAR_HEIGHT,
    flushSessionsToStorage,
    api: window.tuanzi
  })

  const agentFeature = createAgentFeature({
    state,
    agentStorageKey: AGENT_STORAGE_KEY,
    defaultAgentPrompt: DEFAULT_AGENT_PROMPT,
    activeAgentAvatar,
    activeAgentName,
    welcomeAvatar,
    welcomeTitle,
    agentGrid,
    agentToolList,
    agentLibraryModal,
    agentLibraryView,
    agentEditorView,
    agentEditorBackBtn,
    agentModalTitle,
    agentEditorAvatarInput,
    agentEditorAvatarPreview,
    agentEditorName,
    agentEditorFilename,
    agentEditorDescription,
    agentEditorTags,
    agentEditorPrompt,
    agentEditorDeleteBtn,
    agentEditorSaveBtn,
    firstChar,
    normalizeOptionalString,
    slugifyAsFilename,
    escapeHtml,
    showError,
    getActiveSession,
    api: window.tuanzi
  })

  const {
    getActiveAgent,
    loadActiveAgentPreference,
    renderEditorToolList,
    setAgentModalView,
    closeAgentModal,
    saveAgentFromEditor,
    deleteAgentFromEditor,
    refreshAgentData,
    openAgentLibrary,
    bindAgentEditorEvents
  } = agentFeature

  let closeSlashCommandMenuImpl: () => void = () => {}

  const settingsFeature = createSettingsFeature({
    state,
    defaultProviderType: DEFAULT_PROVIDER_TYPE,
    defaultProviderBaseUrl: DEFAULT_PROVIDER_BASE_URL,
    settingsNav,
    settingsModal,
    skillsCatalogList,
    providerList,
    providerEditorTitle,
    providerNameInput,
    providerTypeInput,
    providerBaseUrlInput,
    providerModelInput,
    providerApiKeyInput,
    providerEnabledToggle,
    providerDeleteBtn,
    providerModelList,
    providerAddBtn,
    providerAddModelBtn,
    providerTestBtn,
    providerFetchModelsBtn,
    providerModelModal,
    providerModelModalIdInput,
    providerModelModalDisplayNameInput,
    providerModelModalVisionToggle,
    providerModelModalContextWindowInput,
    providerModelModalMaxOutputInput,
    providerModelModalProtocolTypeSelect,
    closeProviderModelModalBtn,
    providerModelModalCancelBtn,
    providerModelModalConfirmBtn,
    mcpServerList,
    mcpRefreshBtn,
    mcpAddBtn,
    mcpJsonModal,
    mcpJsonInput,
    closeMcpJsonModalBtn,
    mcpJsonCancelBtn,
    mcpJsonConfirmBtn,
    normalizeOptionalString,
    escapeHtml,
    showError,
    showSuccess,
    getActiveSession,
    closeSlashCommandMenu: () => closeSlashCommandMenuImpl(),
    renderEditorToolList,
    api: window.tuanzi
  })

  const {
    buildSettingsDraft,
    renderSettingsDraft,
    openSettingsModal,
    closeSettingsModal,
    saveSettings,
    closeProviderModelModal,
    closeMcpJsonModal,
    bindSettingsEvents
  } = settingsFeature

  const {
    closeSlashCommandMenu,
    updateSlashCommandMenu,
    moveSlashSuggestionCursor,
    applySlashSuggestion,
    executeSlashCommand
  } = createSlashCommandController({
    state,
    inputTextarea,
    slashCommandMenu,
    slashCommandList,
    settingsModal,
    escapeHtml,
    autoResizeTextarea,
    showError,
    showSuccess,
    buildSettingsDraft,
    renderSettingsDraft,
    createNewSession,
    selectWorkspace,
    openSettingsModal,
    openAgentLibrary,
    api: window.tuanzi
  })

  closeSlashCommandMenuImpl = closeSlashCommandMenu

  const chatRuntime = createChatRuntime({
    state,
    inputTextarea,
    inputBox,
    sendBtn,
    attachImageBtn,
    stopBtn,
    thinkingBtn,
    planModeBtn,
    sendingIndicator,
    autoResizeTextarea,
    clearPendingImage,
    closeSlashCommandMenu,
    executeSlashCommand,
    showError,
    addUserMessage,
    createAssistantSurface,
    scrollToBottom,
    getActiveAgent,
    ensureActiveSession,
    renderToolCalls,
    renderMarkdownHtml,
    syncInterruptedTurn,
    truncateTitleFromInput,
    touchActiveSession,
    persistSessions,
    renderSessionList,
    onUndoTurn: (turnIndex: number) => {
      if (undoTurnImpl) {
        undoTurnImpl(turnIndex)
      }
    },
    defaultSessionTitle: DEFAULT_SESSION_TITLE,
    escapeHtml,
    smartScrollToBottom,
    createExecBlock,
    appendCompletedToolCall,
    resetSessionWorkbench: (sessionId: string) => workbenchFeature.resetSessionWorkbench(sessionId)
  })

  const bindInitEvents = createBindInitEvents({
    state,
    api: window.tuanzi,
    closeHistoryContextMenu,
    closeSlashCommandMenu,
    moveSlashSuggestionCursor,
    applySlashSuggestion,
    sendMessage: () => chatRuntime.sendMessage(),
    autoResizeTextarea,
    updateSlashCommandMenu,
    attachImageFile,
    selectWorkspace,
    showError,
    createNewSession,
    refreshAgentData: async () => refreshAgentData(),
    setAgentModalView,
    closeAgentModal,
    saveAgentFromEditor,
    deleteAgentFromEditor,
    openSettingsModal,
    closeSettingsModal,
    saveSettings,
    closeProviderModelModal,
    closeMcpJsonModal,
    bindAgentEditorEvents,
    bindSettingsEvents
  })

  return {
    loadSessionsFromStorage,
    renderSessionList,
    ensureActiveSession,
    renderWorkspaceLabel,
    renderActiveConversation,
    refreshResumeSnapshot,
    bindTopBarDrag,
    bindInitEvents,
    bindWorkbench: () => workbenchFeature.bind(),
    refreshAgentData,
    loadActiveAgentPreference,
    autoResizeTextarea,
    clearPendingImage,
    focusInput: () => inputTextarea.focus()
  }
}
