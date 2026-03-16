import type { TuanziAPI } from "../../../../shared/ipc-contracts"
import type { ChatSession } from "../../app/state"
import { createSessionActions } from "./session-actions"
import { createSessionListView } from "./session-list-view"
import { refreshResumeSnapshot as refreshResumeSnapshotFeature } from "./resume-sync"
import { createSessionStore } from "./session-store"
import {
  createNewSession as createNewSessionFeature,
  selectWorkspace as selectWorkspaceFeature
} from "./session-workspace"

interface SessionFeatureState {
  sessions: ChatSession[]
  activeSessionId: string
  isSending: boolean
  expandedWorkspaceKeys: Set<string>
}

interface SessionFeatureDeps {
  state: SessionFeatureState
  defaultSessionTitle: string
  maxSessionHistory: number
  titleMaxChars: number
  sessionStorageKey: string
  sessionPersistDebounceMs: number
  sessionPersistPerfLog: (event: string, fields?: Record<string, unknown>) => void
  emptyWorkspaceKey: string
  emptyWorkspaceLabel: string
  emptyWorkspaceTitle: string
  chatArea: HTMLDivElement
  welcomeState: HTMLDivElement
  workspaceLabel: HTMLSpanElement
  historyList: HTMLDivElement
  inputTextarea: HTMLTextAreaElement
  addUserMessage: (text: string, image?: null, undoCallback?: (() => void) | null) => void
  addAssistantMessage: (text: string, thinking?: string) => void
  scrollToBottom: () => void
  clearPendingImage: () => void
  autoResizeTextarea: () => void
  showError: (message: string) => void
  api: Pick<TuanziAPI, "getResumeState" | "selectWorkspace">
  onUndoTurn?: (turnIndex: number) => void
}

interface SyncInterruptedTurnInput {
  user: string
  assistant: string
  thinking?: string
  interrupted: boolean
}

export interface SessionFeature {
  syncInterruptedTurn: (session: ChatSession, input: SyncInterruptedTurnInput) => void
  buildModelHistory: (
    session: ChatSession,
    maxTurns: number
  ) => Array<{ user: string; assistant: string }>
  createSession: (initial?: Partial<Pick<ChatSession, "title" | "workspace">>) => ChatSession
  getActiveSession: () => ChatSession | null
  ensureActiveSession: () => ChatSession
  truncateTitleFromInput: (input: string) => string
  persistSessions: () => void
  flushSessionsToStorage: () => void
  loadSessionsFromStorage: () => void
  touchActiveSession: () => void
  refreshResumeSnapshot: () => Promise<void>
  renderWorkspaceLabel: (workspace: string) => void
  renderActiveConversation: () => void
  switchSession: (sessionId: string) => void
  renderSessionList: () => void
  closeHistoryContextMenu: () => void
  selectWorkspace: () => Promise<void>
  createNewSession: () => void
}

export function createSessionFeature(input: SessionFeatureDeps): SessionFeature {
  const sessionStore = createSessionStore({
    state: input.state,
    defaultSessionTitle: input.defaultSessionTitle,
    maxSessionHistory: input.maxSessionHistory,
    titleMaxChars: input.titleMaxChars,
    sessionStorageKey: input.sessionStorageKey,
    sessionPersistDebounceMs: input.sessionPersistDebounceMs,
    sessionPersistPerfLog: input.sessionPersistPerfLog
  })

  async function refreshResumeSnapshot(): Promise<void> {
    await refreshResumeSnapshotFeature({
      getActiveSession: sessionStore.getActiveSession,
      showError: input.showError,
      syncInterruptedTurn: sessionStore.syncInterruptedTurn,
      touchActiveSession: sessionStore.touchActiveSession,
      persistSessions: sessionStore.persistSessions,
      renderSessionList
    })
  }

  const sessionActions = createSessionActions({
    state: input.state,
    chatArea: input.chatArea,
    welcomeState: input.welcomeState,
    workspaceLabel: input.workspaceLabel,
    emptyWorkspaceLabel: input.emptyWorkspaceLabel,
    emptyWorkspaceTitle: input.emptyWorkspaceTitle,
    getActiveSession: sessionStore.getActiveSession,
    addUserMessage: input.addUserMessage,
    addAssistantMessage: input.addAssistantMessage,
    scrollToBottom: input.scrollToBottom,
    clearPendingImage: input.clearPendingImage,
    renderSessionList,
    persistSessions: sessionStore.persistSessions,
    refreshResumeSnapshot,
    onUndoTurn: input.onUndoTurn
  })

  function switchSession(sessionId: string): void {
    closeHistoryContextMenu()
    sessionActions.switchSession(sessionId)
  }

  function deleteSession(sessionId: string): void {
    sessionActions.deleteSession(sessionId)
  }

  const sessionListView = createSessionListView({
    state: input.state,
    historyList: input.historyList,
    emptyWorkspaceKey: input.emptyWorkspaceKey,
    getActiveWorkspace: () => sessionStore.getActiveSession()?.workspace ?? "",
    showError: input.showError,
    onSwitchSession: switchSession,
    onDeleteSession: deleteSession
  })

  function renderSessionList(): void {
    sessionListView.renderSessionList()
  }

  function closeHistoryContextMenu(): void {
    sessionListView.closeHistoryContextMenu()
  }

  async function selectWorkspace(): Promise<void> {
    await selectWorkspaceFeature({
      state: input.state,
      selectWorkspaceFromDialog: input.api.selectWorkspace,
      switchSession,
      getActiveSession: sessionStore.getActiveSession,
      touchActiveSession: sessionStore.touchActiveSession,
      renderWorkspaceLabel: sessionActions.renderWorkspaceLabel,
      renderSessionList,
      persistSessions: sessionStore.persistSessions,
      refreshResumeSnapshot,
      renderActiveConversation: sessionActions.renderActiveConversation,
      createSession: sessionStore.createSession
    })
  }

  function createNewSession(): void {
    createNewSessionFeature({
      state: input.state,
      getActiveSession: sessionStore.getActiveSession,
      createSession: sessionStore.createSession,
      switchSession,
      inputTextarea: input.inputTextarea,
      autoResizeTextarea: input.autoResizeTextarea,
      clearPendingImage: input.clearPendingImage
    })
  }

  return {
    syncInterruptedTurn: sessionStore.syncInterruptedTurn,
    buildModelHistory: sessionStore.buildModelHistory,
    createSession: sessionStore.createSession,
    getActiveSession: sessionStore.getActiveSession,
    ensureActiveSession: sessionStore.ensureActiveSession,
    truncateTitleFromInput: sessionStore.truncateTitleFromInput,
    persistSessions: sessionStore.persistSessions,
    flushSessionsToStorage: sessionStore.flushSessionsToStorage,
    loadSessionsFromStorage: sessionStore.loadSessionsFromStorage,
    touchActiveSession: sessionStore.touchActiveSession,
    refreshResumeSnapshot,
    renderWorkspaceLabel: sessionActions.renderWorkspaceLabel,
    renderActiveConversation: sessionActions.renderActiveConversation,
    switchSession,
    renderSessionList,
    closeHistoryContextMenu,
    selectWorkspace,
    createNewSession
  }
}
