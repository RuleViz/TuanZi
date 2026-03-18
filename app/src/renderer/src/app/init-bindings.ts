import type { TuanziAPI } from "../../../shared/ipc-contracts"
import {
  activeAgentChip,
  agentEditorBackBtn,
  agentEditorCancelBtn,
  agentEditorDeleteBtn,
  agentEditorSaveBtn,
  agentEditorView,
  agentLibraryModal,
  attachImageBtn,
  closeAgentModalBtn,
  closeSettingsModalBtn,
  imageFileInput,
  inputBox,
  inputTextarea,
  mcpJsonModal,
  newChatBtn,
  planModeBtn,
  providerModelModal,
  selectWorkspaceBtn,
  sendBtn,
  settingsBtn,
  settingsCancelBtn,
  settingsModal,
  settingsSaveBtn,
  sidebar,
  slashCommandMenu,
  stopBtn,
  thinkingBtn,
  toggleSidebar,
  topBar,
  topBarDrag,
  windowCloseBtn,
  windowControls,
  windowMaximizeBtn,
  windowMinimizeBtn,
  workspaceLabel
} from "./dom"
import { bindInitEvents } from "./init-events"
import { bindTitlebarWindowControls } from "../features/window/titlebar"

interface InitBindingsState {
  slashVisible: boolean
  slashActiveIndex: number
  isSending: boolean
  isStopping: boolean
  currentTaskId: string
  isThinking: boolean
  planModeEnabled: boolean
}

interface TopbarBindingDeps {
  defaultTitlebarHeight: number
  flushSessionsToStorage: () => void
  api: Pick<
    TuanziAPI,
    "minimizeWindow" | "toggleMaximizeWindow" | "closeWindow" | "isWindowMaximized" | "onWindowMaximizedChanged"
  >
}

interface EventBindingDeps {
  state: InitBindingsState
  api: Pick<TuanziAPI, "stopMessage">
  closeHistoryContextMenu: () => void
  closeSlashCommandMenu: () => void
  moveSlashSuggestionCursor: (offset: number) => void
  applySlashSuggestion: (index: number) => Promise<void>
  sendMessage: () => Promise<void>
  autoResizeTextarea: () => void
  updateSlashCommandMenu: () => void
  attachImageFile: (file: File) => Promise<void>
  selectWorkspace: () => Promise<void>
  showError: (message: string) => void
  createNewSession: () => void
  refreshAgentData: () => Promise<void>
  setAgentModalView: (view: "library" | "editor") => void
  closeAgentModal: () => void
  saveAgentFromEditor: () => Promise<void>
  deleteAgentFromEditor: () => Promise<void>
  openSettingsModal: () => Promise<void>
  closeSettingsModal: () => void
  saveSettings: () => Promise<void>
  closeProviderModelModal: () => void
  closeMcpJsonModal: () => void
  bindAgentEditorEvents: () => void
  bindSettingsEvents: () => void
}

export function createBindTopBarDrag(input: TopbarBindingDeps): () => void {
  return (): void => {
    bindTitlebarWindowControls({
      topBar,
      topBarDrag,
      windowControls,
      windowMinimizeBtn,
      windowMaximizeBtn,
      windowCloseBtn,
      defaultTitlebarHeight: input.defaultTitlebarHeight,
      flushSessionsToStorage: input.flushSessionsToStorage,
      api: input.api
    })
  }
}

export function createBindInitEvents(input: EventBindingDeps): () => void {
  return (): void => {
    bindInitEvents({
      state: input.state,
      inputTextarea,
      inputBox,
      slashCommandMenu,
      attachImageBtn,
      imageFileInput,
      sendBtn,
      stopBtn,
      selectWorkspaceBtn,
      workspaceLabel,
      toggleSidebar,
      sidebar,
      thinkingBtn,
      planModeBtn,
      newChatBtn,
      activeAgentChip,
      agentLibraryModal,
      closeAgentModalBtn,
      agentEditorBackBtn,
      agentEditorCancelBtn,
      agentEditorSaveBtn,
      agentEditorDeleteBtn,
      settingsBtn,
      closeSettingsModalBtn,
      settingsCancelBtn,
      settingsSaveBtn,
      providerModelModal,
      mcpJsonModal,
      settingsModal,
      agentEditorView,
      closeHistoryContextMenu: input.closeHistoryContextMenu,
      closeSlashCommandMenu: input.closeSlashCommandMenu,
      moveSlashSuggestionCursor: input.moveSlashSuggestionCursor,
      applySlashSuggestion: input.applySlashSuggestion,
      sendMessage: input.sendMessage,
      autoResizeTextarea: input.autoResizeTextarea,
      updateSlashCommandMenu: input.updateSlashCommandMenu,
      attachImageFile: input.attachImageFile,
      stopMessage: (taskId: string) => input.api.stopMessage({ taskId }),
      selectWorkspace: input.selectWorkspace,
      showError: input.showError,
      createNewSession: input.createNewSession,
      refreshAgentData: input.refreshAgentData,
      setAgentModalView: input.setAgentModalView,
      closeAgentModal: input.closeAgentModal,
      saveAgentFromEditor: input.saveAgentFromEditor,
      deleteAgentFromEditor: input.deleteAgentFromEditor,
      openSettingsModal: input.openSettingsModal,
      closeSettingsModal: input.closeSettingsModal,
      saveSettings: input.saveSettings,
      closeProviderModelModal: input.closeProviderModelModal,
      closeMcpJsonModal: input.closeMcpJsonModal,
      bindAgentEditorEvents: input.bindAgentEditorEvents,
      bindSettingsEvents: input.bindSettingsEvents
    })
  }
}
