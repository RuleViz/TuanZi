import type { ChatSession, ConversationToolCall } from '../../app/state'

interface SessionActionState {
  sessions: ChatSession[]
  activeSessionId: string
}

interface SessionActionsDeps {
  state: SessionActionState
  chatArea: HTMLDivElement
  welcomeState: HTMLDivElement
  workspaceLabel: HTMLSpanElement
  emptyWorkspaceLabel: string
  emptyWorkspaceTitle: string
  getActiveSession: () => ChatSession | null
  addUserMessage: (text: string, image?: null, undoCallback?: (() => void) | null) => void
  addAssistantMessage: (text: string, thinking?: string, toolCalls?: ConversationToolCall[]) => void
  scrollToBottom: () => void
  clearPendingImage: () => void
  renderSessionList: () => void
  persistSessions: () => void
  refreshResumeSnapshot: () => Promise<void>
  onUndoTurn?: (turnIndex: number) => void
  onSessionChanged?: (sessionId: string) => void
}

export interface SessionActions {
  renderWorkspaceLabel: (workspace: string) => void
  renderActiveConversation: () => void
  switchSession: (sessionId: string) => void
  deleteSession: (sessionId: string) => void
}

export function createSessionActions(deps: SessionActionsDeps): SessionActions {
  const renderWorkspaceLabel = (workspace: string): void => {
    if (!workspace) {
      deps.workspaceLabel.textContent = deps.emptyWorkspaceLabel
      deps.workspaceLabel.title = deps.emptyWorkspaceTitle
      deps.workspaceLabel.classList.remove('active')
      return
    }
    const parts = workspace.replace(/\\/g, '/').split('/')
    const display = parts.slice(-2).join('/')
    deps.workspaceLabel.textContent = display
    deps.workspaceLabel.classList.add('active')
    deps.workspaceLabel.title = workspace
  }

  const renderActiveConversation = (): void => {
    deps.chatArea.innerHTML = ''
    deps.chatArea.appendChild(deps.welcomeState)

    const active = deps.getActiveSession()
    if (!active || active.history.length === 0) {
      deps.welcomeState.style.display = 'flex'
      return
    }

    deps.welcomeState.style.display = 'none'
    for (let i = 0; i < active.history.length; i++) {
      const turn = active.history[i]
      const turnIndex = i
      const undoCallback = deps.onUndoTurn
        ? () => deps.onUndoTurn!(turnIndex)
        : null
      deps.addUserMessage(turn.user, null, undoCallback)
      deps.addAssistantMessage(turn.assistant, turn.thinking, turn.toolCalls)
    }
    deps.scrollToBottom()
  }

  const switchSession = (sessionId: string): void => {
    const target = deps.state.sessions.find((item) => item.id === sessionId)
    if (!target) {
      return
    }
    deps.clearPendingImage()
    deps.state.activeSessionId = target.id
    deps.renderSessionList()
    renderWorkspaceLabel(target.workspace)
    renderActiveConversation()
    deps.onSessionChanged?.(target.id)
    deps.persistSessions()
    void deps.refreshResumeSnapshot().then(() => {
      renderActiveConversation()
      deps.onSessionChanged?.(target.id)
    })
  }

  const deleteSession = (sessionId: string): void => {
    const index = deps.state.sessions.findIndex((session) => session.id === sessionId)
    if (index === -1) {
      return
    }

    deps.state.sessions.splice(index, 1)

    if (deps.state.activeSessionId === sessionId) {
      deps.state.activeSessionId = deps.state.sessions[0]?.id || ''
      renderActiveConversation()
      if (deps.state.activeSessionId) {
        deps.onSessionChanged?.(deps.state.activeSessionId)
      }
    }

    deps.renderSessionList()
    deps.persistSessions()
  }

  return {
    renderWorkspaceLabel,
    renderActiveConversation,
    switchSession,
    deleteSession
  }
}
