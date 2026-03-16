import type { ChatSession, ConversationTurn, StoredSessionPayload } from '../../app/state'

interface SessionStoreState {
  sessions: ChatSession[]
  activeSessionId: string
}

interface SessionStoreConfig {
  state: SessionStoreState
  defaultSessionTitle: string
  maxSessionHistory: number
  titleMaxChars: number
  sessionStorageKey: string
  sessionPersistDebounceMs: number
  sessionPersistPerfLog: (event: string, fields?: Record<string, unknown>) => void
}

interface SyncInterruptedTurnInput {
  user: string
  assistant: string
  thinking?: string
  interrupted: boolean
}

export interface SessionStore {
  syncInterruptedTurn: (session: ChatSession, input: SyncInterruptedTurnInput) => void
  buildModelHistory: (
    session: ChatSession,
    maxTurns: number
  ) => Array<{ user: string; assistant: string }>
  createSession: (initial?: Partial<Pick<ChatSession, 'title' | 'workspace'>>) => ChatSession
  getActiveSession: () => ChatSession | null
  ensureActiveSession: () => ChatSession
  truncateTitleFromInput: (input: string) => string
  persistSessions: () => void
  flushSessionsToStorage: () => void
  loadSessionsFromStorage: () => void
  touchActiveSession: () => void
}

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function findInterruptedTurnIndex(session: ChatSession, userText: string): number {
  for (let index = session.history.length - 1; index >= 0; index -= 1) {
    const turn = session.history[index]
    if (turn.user === userText && turn.interrupted) {
      return index
    }
  }
  return -1
}

function isConversationTurn(value: unknown): value is ConversationTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.user === 'string' &&
    typeof record.assistant === 'string' &&
    (record.thinking === undefined || typeof record.thinking === 'string') &&
    (record.interrupted === undefined || typeof record.interrupted === 'boolean')
  )
}

function isValidIsoTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function normalizeSession(
  value: unknown,
  config: { defaultSessionTitle: string; maxSessionHistory: number }
): ChatSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !record.id.trim()) {
    return null
  }
  if (typeof record.title !== 'string') {
    return null
  }
  if (typeof record.workspace !== 'string') {
    return null
  }
  if (!Array.isArray(record.history)) {
    return null
  }
  if (!isValidIsoTime(record.createdAt) || !isValidIsoTime(record.updatedAt)) {
    return null
  }
  const history = record.history.filter(isConversationTurn).map((turn) => ({
    user: turn.user,
    assistant: turn.assistant,
    thinking: turn.thinking,
    interrupted: turn.interrupted === true
  }))
  return {
    id: record.id,
    title: record.title.trim() || config.defaultSessionTitle,
    workspace: record.workspace,
    history: history.slice(-config.maxSessionHistory),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

export function createSessionStore(config: SessionStoreConfig): SessionStore {
  let sessionPersistTimer: number | null = null
  let sessionPersistDirty = false

  const createSession = (initial?: Partial<Pick<ChatSession, 'title' | 'workspace'>>): ChatSession => {
    const now = new Date().toISOString()
    return {
      id: generateSessionId(),
      title: (initial?.title || config.defaultSessionTitle).trim() || config.defaultSessionTitle,
      workspace: (initial?.workspace || '').trim(),
      history: [],
      createdAt: now,
      updatedAt: now
    }
  }

  const getActiveSession = (): ChatSession | null => {
    return config.state.sessions.find((item) => item.id === config.state.activeSessionId) ?? null
  }

  const persistSessions = (): void => {
    sessionPersistDirty = true
    if (sessionPersistTimer !== null) {
      return
    }
    sessionPersistTimer = window.setTimeout(() => {
      sessionPersistTimer = null
      flushSessionsToStorage()
    }, config.sessionPersistDebounceMs)
  }

  const flushSessionsToStorage = (): void => {
    if (!sessionPersistDirty) {
      return
    }
    sessionPersistDirty = false
    const payload: StoredSessionPayload = {
      version: 1,
      activeSessionId: config.state.activeSessionId,
      sessions: config.state.sessions
    }
    const startedAt = performance.now()
    try {
      localStorage.setItem(config.sessionStorageKey, JSON.stringify(payload))
      config.sessionPersistPerfLog('stored', {
        sessions: payload.sessions.length,
        elapsedMs: Number((performance.now() - startedAt).toFixed(2))
      })
    } catch {
      config.sessionPersistPerfLog('store_failed')
    }
  }

  const ensureActiveSession = (): ChatSession => {
    let active = getActiveSession()
    if (active) {
      return active
    }
    const created = createSession()
    config.state.sessions.push(created)
    config.state.activeSessionId = created.id
    persistSessions()
    return created
  }

  const truncateTitleFromInput = (input: string): string => {
    const compact = input.replace(/\s+/g, ' ').trim()
    if (!compact) {
      return config.defaultSessionTitle
    }
    if (compact.length <= config.titleMaxChars) {
      return compact
    }
    return `${compact.slice(0, config.titleMaxChars)}...`
  }

  const syncInterruptedTurn = (session: ChatSession, input: SyncInterruptedTurnInput): void => {
    const nextTurn: ConversationTurn = {
      user: input.user,
      assistant: input.assistant,
      thinking: input.thinking,
      interrupted: input.interrupted
    }
    const existingIndex = findInterruptedTurnIndex(session, input.user)
    if (existingIndex >= 0) {
      session.history[existingIndex] = nextTurn
      return
    }
    session.history.push(nextTurn)
    if (session.history.length > config.maxSessionHistory) {
      session.history.splice(0, session.history.length - config.maxSessionHistory)
    }
  }

  const buildModelHistory = (
    session: ChatSession,
    maxTurns: number
  ): Array<{ user: string; assistant: string }> => {
    const completedTurns = session.history.filter((turn) => {
      if (turn.interrupted) {
        return false
      }
      return turn.user.trim().length > 0 && turn.assistant.trim().length > 0
    })
    const windowed = completedTurns.slice(-Math.max(0, maxTurns))
    return windowed.map((turn) => ({
      user: turn.user,
      assistant: turn.assistant
    }))
  }

  const loadSessionsFromStorage = (): void => {
    try {
      const raw = localStorage.getItem(config.sessionStorageKey)
      if (!raw) {
        config.state.sessions = [createSession()]
        config.state.activeSessionId = config.state.sessions[0].id
        persistSessions()
        return
      }
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid session payload')
      }
      const record = parsed as Record<string, unknown>
      if (record.version !== 1 || !Array.isArray(record.sessions)) {
        throw new Error('Unsupported session payload')
      }
      const sessions = record.sessions
        .map((item) => normalizeSession(item, config))
        .filter((item): item is ChatSession => item !== null)

      if (sessions.length === 0) {
        config.state.sessions = [createSession()]
        config.state.activeSessionId = config.state.sessions[0].id
        persistSessions()
        return
      }

      config.state.sessions = sessions
      const savedActive = typeof record.activeSessionId === 'string' ? record.activeSessionId : ''
      const activeExists = sessions.some((item) => item.id === savedActive)
      config.state.activeSessionId = activeExists ? savedActive : sessions[0].id
    } catch {
      config.state.sessions = [createSession()]
      config.state.activeSessionId = config.state.sessions[0].id
      persistSessions()
    }
  }

  const touchActiveSession = (): void => {
    const active = getActiveSession()
    if (!active) {
      return
    }
    active.updatedAt = new Date().toISOString()
  }

  return {
    syncInterruptedTurn,
    buildModelHistory,
    createSession,
    getActiveSession,
    ensureActiveSession,
    truncateTitleFromInput,
    persistSessions,
    flushSessionsToStorage,
    loadSessionsFromStorage,
    touchActiveSession
  }
}
