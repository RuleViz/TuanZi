import type { ChatSession } from '../../app/state'

interface SessionListState {
  sessions: ChatSession[]
  activeSessionId: string
  isSending: boolean
  expandedWorkspaceKeys: Set<string>
}

interface SessionListViewConfig {
  state: SessionListState
  historyList: HTMLDivElement
  emptyWorkspaceKey: string
  getActiveWorkspace: () => string
  showError: (message: string) => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
}

interface WorkspaceGroup {
  key: string
  workspace: string
  updatedAt: string
  sessions: ChatSession[]
}

function getWorkspaceKey(workspace: string, emptyWorkspaceKey: string): string {
  const trimmed = workspace.trim()
  return trimmed || emptyWorkspaceKey
}

function getWorkspaceDisplayName(workspace: string): string {
  if (!workspace.trim()) {
    return '未选择工作区'
  }
  const normalized = workspace.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? workspace
}

export function createSessionListView(config: SessionListViewConfig): {
  renderSessionList: () => void
  closeHistoryContextMenu: () => void
} {
  let lastAutoExpandedWorkspaceKey: string | null = null
  let activeHistoryContextMenu: HTMLDivElement | null = null

  const closeHistoryContextMenu = (): void => {
    if (!activeHistoryContextMenu) {
      return
    }
    activeHistoryContextMenu.remove()
    activeHistoryContextMenu = null
  }

  const showHistoryContextMenu = (x: number, y: number, sessionId: string): void => {
    closeHistoryContextMenu()

    const menu = document.createElement('div')
    menu.className = 'history-context-menu'
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`

    const deleteBtn = document.createElement('div')
    deleteBtn.className = 'context-menu-item danger'
    deleteBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
        <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
      </svg>
      删除对话
    `

    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      config.onDeleteSession(sessionId)
      closeHistoryContextMenu()
    })

    menu.appendChild(deleteBtn)
    document.body.appendChild(menu)
    activeHistoryContextMenu = menu
  }

  const renderSessionList = (): void => {
    const sorted = [...config.state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    config.historyList.innerHTML = ''

    const groups = new Map<string, WorkspaceGroup>()
    for (const session of sorted) {
      const key = getWorkspaceKey(session.workspace, config.emptyWorkspaceKey)
      const existing = groups.get(key)
      if (existing) {
        existing.sessions.push(session)
        if (session.updatedAt > existing.updatedAt) {
          existing.updatedAt = session.updatedAt
        }
        continue
      }
      groups.set(key, {
        key,
        workspace: session.workspace,
        updatedAt: session.updatedAt,
        sessions: [session]
      })
    }

    const activeWorkspaceKey = getWorkspaceKey(config.getActiveWorkspace(), config.emptyWorkspaceKey)
    if (activeWorkspaceKey !== lastAutoExpandedWorkspaceKey) {
      config.state.expandedWorkspaceKeys.add(activeWorkspaceKey)
      lastAutoExpandedWorkspaceKey = activeWorkspaceKey
    }

    const orderedGroups = Array.from(groups.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const group of orderedGroups) {
      const wrapper = document.createElement('div')
      wrapper.className = 'history-workspace-group'

      const header = document.createElement('button')
      header.type = 'button'
      header.className = 'history-workspace'
      if (group.key === activeWorkspaceKey) {
        header.classList.add('current-workspace')
      }

      const isExpanded = config.state.expandedWorkspaceKeys.has(group.key)
      const arrow = isExpanded ? 'v' : '>'
      const title = getWorkspaceDisplayName(group.workspace)
      header.textContent = `${arrow} ${title}`
      header.title = group.workspace || '未选择工作区'
      header.addEventListener('click', () => {
        if (config.state.expandedWorkspaceKeys.has(group.key)) {
          config.state.expandedWorkspaceKeys.delete(group.key)
        } else {
          config.state.expandedWorkspaceKeys.add(group.key)
        }
        renderSessionList()
      })

      const sessionsBox = document.createElement('div')
      sessionsBox.className = 'history-sessions'
      if (!isExpanded) {
        sessionsBox.classList.add('collapsed')
      }

      for (const session of group.sessions) {
        const item = document.createElement('div')
        item.className = 'history-item'
        if (session.id === config.state.activeSessionId) {
          item.classList.add('active')
        }
        item.textContent = session.title
        item.title = session.title
        item.dataset.sessionId = session.id
        item.addEventListener('click', () => {
          if (config.state.isSending) {
            config.showError('请等待当前回复结束后再切换会话')
            return
          }
          config.onSwitchSession(session.id)
        })
        sessionsBox.appendChild(item)

        item.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          showHistoryContextMenu(event.clientX, event.clientY, session.id)
        })
      }

      wrapper.appendChild(header)
      wrapper.appendChild(sessionsBox)
      config.historyList.appendChild(wrapper)
    }
  }

  return {
    renderSessionList,
    closeHistoryContextMenu
  }
}
