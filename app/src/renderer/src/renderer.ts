/**
 * TuanZi Desktop — Renderer Process
 * 对话界面主逻辑 + Agent 创建/编辑 + 扩展设置中心
 */

import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'

interface ConversationTurn {
  user: string
  assistant: string
  thinking?: string
  interrupted?: boolean
}

interface ChatSession {
  id: string
  title: string
  workspace: string
  history: ConversationTurn[]
  createdAt: string
  updatedAt: string
}

interface StoredSessionPayload {
  version: 1
  activeSessionId: string
  sessions: ChatSession[]
}

type GlobalSkillCategory = 'file_system' | 'execute_command' | 'web_search'

interface AgentProviderConfig {
  type: string
  apiKey: string
  baseUrl: string
  model: string
}

interface ProviderModelItem {
  id: string
  displayName: string
  isVision: boolean
  enabled: boolean
}

interface ProviderConfig extends AgentProviderConfig {
  id: string
  name: string
  models: ProviderModelItem[]
  isEnabled: boolean
}

interface AgentBackendConfig {
  provider: AgentProviderConfig
  providers: ProviderConfig[]
  activeProviderId: string
  global_skills: {
    file_system: boolean
    execute_command: boolean
    web_search: boolean
  }
}

interface StoredAgent {
  id: string
  filename: string
  name: string
  avatar: string
  description: string
  tags: string[]
  tools: string[]
  prompt: string
}

interface AgentToolProfile {
  name: string
  category: GlobalSkillCategory
  prompt: string
}

interface McpDashboardTool {
  name: string
  description: string
  namespacedName: string
}

interface McpDashboardServer {
  serverId: string
  enabled: boolean
  command: string
  args: string[]
  env: Record<string, string>
  status: 'online' | 'offline' | 'error'
  error?: string
  tools: McpDashboardTool[]
}

interface AgentEditorState {
  mode: 'create' | 'edit'
  previousFilename: string | null
  filenameTouched: boolean
  selectedTools: Set<string>
}

interface SettingsDraft {
  providers: ProviderConfig[]
  activeProviderId: string
  globalSkills: {
    file_system: boolean
    execute_command: boolean
    web_search: boolean
  }
}

interface SlashSuggestion {
  id: string
  label: string
  description: string
  commandText: string
  executeImmediately: boolean
}

const SESSION_STORAGE_KEY = 'tuanzi.desktop.sessions.v1'
const AGENT_STORAGE_KEY = 'tuanzi.desktop.activeAgent.v1'
const DEFAULT_SESSION_TITLE = '新对话'
const MAX_SESSION_HISTORY = 30
const TITLE_MAX_CHARS = 18
const DEFAULT_AGENT_PROMPT = '你是一个务实、准确的 AI 编程助手，先理解需求，再按需调用工具并验证结果。'
const EMPTY_WORKSPACE_KEY = '__no_workspace__'
const DEFAULT_PROVIDER_TYPE = 'openai'
const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1'
const TOP_BAR_NO_DRAG_SELECTOR = '.top-bar-btn, .workspace-label, .agent-chip'
let isManualTitlebarDragging = false
const SLASH_COMMAND_DEFS: Array<{
  command: string
  description: string
  executeImmediately: boolean
}> = [
  {
    command: '/model',
    description: 'Switch provider model, then continue chatting.',
    executeImmediately: false
  },
  {
    command: '/model current',
    description: 'Show current active provider/model.',
    executeImmediately: true
  },
  {
    command: '/new',
    description: 'Create a new conversation.',
    executeImmediately: true
  },
  {
    command: '/workspace',
    description: 'Select workspace folder.',
    executeImmediately: true
  },
  {
    command: '/settings',
    description: 'Open settings center.',
    executeImmediately: true
  },
  {
    command: '/agent',
    description: 'Open agent library.',
    executeImmediately: true
  },
  {
    command: '/help',
    description: 'Show slash command tips.',
    executeImmediately: true
  }
]

const state = {
  sessions: [] as ChatSession[],
  activeSessionId: '',
  isSending: false,
  currentStreamText: '',
  currentTaskId: '',
  currentRenderedToolCalls: 0,

  agents: [] as StoredAgent[],
  activeAgentId: '',
  agentToolProfiles: [] as AgentToolProfile[],
  agentConfig: null as AgentBackendConfig | null,
  editor: {
    mode: 'create',
    previousFilename: null,
    filenameTouched: false,
    selectedTools: new Set<string>()
  } as AgentEditorState,
  expandedWorkspaceKeys: new Set<string>(),
  settingsDraft: null as SettingsDraft | null,
  slashSuggestions: [] as SlashSuggestion[],
  slashActiveIndex: 0,
  slashVisible: false,
  mcpServers: [] as McpDashboardServer[],
  expandedMcpServerIds: new Set<string>(),
  isMcpLoading: false,
  isThinking: false
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing required element #${id}`)
  }
  return element as T
}

const chatArea = byId<HTMLDivElement>('chatArea')
const welcomeState = byId<HTMLDivElement>('welcomeState')
const welcomeAvatar = byId<HTMLDivElement>('welcomeAvatar')
const welcomeTitle = byId<HTMLHeadingElement>('welcomeTitle')
const inputTextarea = byId<HTMLTextAreaElement>('inputTextarea')
const inputBox = byId<HTMLDivElement>('inputBox')
const sendBtn = byId<HTMLButtonElement>('sendBtn')
const stopBtn = byId<HTMLButtonElement>('stopBtn')
const sendingIndicator = byId<HTMLDivElement>('sendingIndicator')
const selectWorkspaceBtn = byId<HTMLButtonElement>('selectWorkspaceBtn')
const thinkingBtn = byId<HTMLButtonElement>('thinkingBtn')
const workspaceLabel = byId<HTMLSpanElement>('workspaceLabel')
const toggleSidebar = byId<HTMLButtonElement>('toggleSidebar')
const sidebar = byId<HTMLElement>('sidebar')
const topBar = document.querySelector<HTMLElement>('.top-bar')
const topBarDrag = document.querySelector<HTMLElement>('.top-bar-drag')
const newChatBtn = byId<HTMLButtonElement>('newChatBtn')
const settingsBtn = byId<HTMLButtonElement>('settingsBtn')
const historyList = byId<HTMLDivElement>('historyList')

const activeAgentChip = byId<HTMLDivElement>('activeAgentChip')
const activeAgentAvatar = byId<HTMLDivElement>('activeAgentAvatar')
const activeAgentName = byId<HTMLSpanElement>('activeAgentName')

const agentLibraryModal = byId<HTMLDivElement>('agentLibraryModal')
const closeAgentModalBtn = byId<HTMLButtonElement>('closeAgentModalBtn')
const agentModalTitle = byId<HTMLHeadingElement>('agentModalTitle')
const agentEditorBackBtn = byId<HTMLButtonElement>('agentEditorBackBtn')
const agentLibraryView = byId<HTMLDivElement>('agentLibraryView')
const agentEditorView = byId<HTMLDivElement>('agentEditorView')
const agentGrid = byId<HTMLDivElement>('agentGrid')
const agentEditorAvatarInput = byId<HTMLInputElement>('agentEditorAvatarInput')
const agentEditorAvatarPreview = byId<HTMLDivElement>('agentEditorAvatarPreview')
const agentEditorName = byId<HTMLInputElement>('agentEditorName')
const agentEditorFilename = byId<HTMLInputElement>('agentEditorFilename')
const agentEditorDescription = byId<HTMLInputElement>('agentEditorDescription')
const agentEditorTags = byId<HTMLInputElement>('agentEditorTags')
const agentEditorPrompt = byId<HTMLTextAreaElement>('agentEditorPrompt')
const agentToolList = byId<HTMLDivElement>('agentToolList')
const agentEditorDeleteBtn = byId<HTMLButtonElement>('agentEditorDeleteBtn')
const agentEditorCancelBtn = byId<HTMLButtonElement>('agentEditorCancelBtn')
const agentEditorSaveBtn = byId<HTMLButtonElement>('agentEditorSaveBtn')

const settingsModal = byId<HTMLDivElement>('settingsModal')
const closeSettingsModalBtn = byId<HTMLButtonElement>('closeSettingsModalBtn')
const settingsNav = byId<HTMLElement>('settingsNav')
const providerList = byId<HTMLDivElement>('providerList')
const providerAddBtn = byId<HTMLButtonElement>('providerAddBtn')
const providerEditorTitle = byId<HTMLDivElement>('providerEditorTitle')
const providerNameInput = byId<HTMLInputElement>('providerNameInput')
const providerTypeInput = byId<HTMLSelectElement>('providerTypeInput')
const providerBaseUrlInput = byId<HTMLInputElement>('providerBaseUrlInput')
const providerModelInput = byId<HTMLInputElement>('providerModelInput')
const providerApiKeyInput = byId<HTMLInputElement>('providerApiKeyInput')
const providerEnabledToggle = byId<HTMLButtonElement>('providerEnabledToggle')
const providerDeleteBtn = byId<HTMLButtonElement>('providerDeleteBtn')
const providerTestBtn = byId<HTMLButtonElement>('providerTestBtn')
const providerFetchModelsBtn = byId<HTMLButtonElement>('providerFetchModelsBtn')
const providerAddModelBtn = byId<HTMLButtonElement>('providerAddModelBtn')
const providerModelList = byId<HTMLDivElement>('providerModelList')
const globalSkillFileSystem = byId<HTMLButtonElement>('globalSkillFileSystem')
const globalSkillExecuteCommand = byId<HTMLButtonElement>('globalSkillExecuteCommand')
const globalSkillWebSearch = byId<HTMLButtonElement>('globalSkillWebSearch')
const mcpRefreshBtn = byId<HTMLButtonElement>('mcpRefreshBtn')
const mcpAddBtn = byId<HTMLButtonElement>('mcpAddBtn')
const mcpServerList = byId<HTMLDivElement>('mcpServerList')
const mcpJsonModal = byId<HTMLDivElement>('mcpJsonModal')
const closeMcpJsonModalBtn = byId<HTMLButtonElement>('closeMcpJsonModalBtn')
const mcpJsonCancelBtn = byId<HTMLButtonElement>('mcpJsonCancelBtn')
const mcpJsonConfirmBtn = byId<HTMLButtonElement>('mcpJsonConfirmBtn')
const mcpJsonInput = byId<HTMLTextAreaElement>('mcpJsonInput')
const settingsCancelBtn = byId<HTMLButtonElement>('settingsCancelBtn')
const settingsSaveBtn = byId<HTMLButtonElement>('settingsSaveBtn')
const slashCommandMenu = byId<HTMLDivElement>('slashCommandMenu')
const slashCommandList = byId<HTMLDivElement>('slashCommandList')

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function firstChar(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  const chars = Array.from(trimmed)
  return chars.length > 0 ? chars[0] : ''
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function getAgentAvatar(agent: Pick<StoredAgent, 'name' | 'avatar'>): string {
  const fromAvatar = firstChar(agent.avatar)
  if (fromAvatar) {
    return fromAvatar
  }
  const fromName = firstChar(agent.name)
  if (fromName) {
    return fromName.toUpperCase()
  }
  return 'A'
}

function scrollToBottom(): void {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight
  })
}

function autoResizeTextarea(): void {
  inputTextarea.style.height = 'auto'
  const newHeight = Math.min(inputTextarea.scrollHeight, 200)
  inputTextarea.style.height = newHeight + 'px'
}

function showToast(msg: string, success = false): void {
  let toast = document.querySelector('.error-toast') as HTMLDivElement | null
  if (!toast) {
    toast = document.createElement('div')
    toast.className = 'error-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.classList.toggle('success', success)
  toast.classList.add('visible')
  setTimeout(() => toast!.classList.remove('visible'), 4000)
}

function showError(msg: string): void {
  showToast(msg, false)
}

function showSuccess(msg: string): void {
  showToast(msg, true)
}

function bindTopBarDrag(): void {
  const dragTargets = topBar ? [topBar] : topBarDrag ? [topBarDrag] : []

  const stopManualDrag = (): void => {
    if (!isManualTitlebarDragging) {
      return
    }
    isManualTitlebarDragging = false
    window.tuanzi.endWindowDrag()
  }

  const onWindowMouseMove = (event: MouseEvent): void => {
    if (!isManualTitlebarDragging) {
      return
    }
    window.tuanzi.updateWindowDrag({ screenX: event.screenX, screenY: event.screenY })
  }

  for (const target of dragTargets) {
    target.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return
      }
      const clickedNoDrag = (event.target as HTMLElement | null)?.closest(TOP_BAR_NO_DRAG_SELECTOR)
      if (clickedNoDrag) {
        return
      }
      event.preventDefault()
      isManualTitlebarDragging = true
      window.tuanzi.startWindowDrag({ screenX: event.screenX, screenY: event.screenY })
    })
  }

  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', stopManualDrag)
  window.addEventListener('blur', stopManualDrag)
}

function closeSlashCommandMenu(): void {
  state.slashVisible = false
  state.slashSuggestions = []
  state.slashActiveIndex = 0
  slashCommandMenu.classList.remove('visible')
  slashCommandMenu.setAttribute('aria-hidden', 'true')
  slashCommandList.innerHTML = ''
}

function renderSlashCommandMenu(): void {
  if (!state.slashVisible || state.slashSuggestions.length === 0) {
    closeSlashCommandMenu()
    return
  }

  slashCommandList.innerHTML = ''
  state.slashSuggestions.forEach((suggestion, index) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'slash-command-item'
    if (index === state.slashActiveIndex) {
      item.classList.add('active')
    }
    item.innerHTML = `
      <div class="slash-command-title">${escapeHtml(suggestion.label)}</div>
      <div class="slash-command-desc">${escapeHtml(suggestion.description)}</div>
    `
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      void applySlashSuggestion(index)
    })
    slashCommandList.appendChild(item)
  })

  slashCommandMenu.classList.add('visible')
  slashCommandMenu.setAttribute('aria-hidden', 'false')
}

function getAvailableSlashModels(): Array<{ providerId: string; providerName: string; modelId: string }> {
  const config = state.agentConfig
  if (!config) {
    return []
  }
  const providers = Array.isArray(config.providers) ? config.providers : []
  const output: Array<{ providerId: string; providerName: string; modelId: string }> = []

  for (const provider of providers) {
    if (provider.isEnabled === false) {
      continue
    }
    const providerName = provider.name || provider.id || 'Provider'
    const enabledModels =
      Array.isArray(provider.models) && provider.models.length > 0
        ? provider.models.filter((model) => model.enabled !== false).map((model) => model.id)
        : []

    if (enabledModels.length === 0) {
      if (provider.model) {
        output.push({
          providerId: provider.id,
          providerName,
          modelId: provider.model
        })
      }
      continue
    }

    for (const modelId of enabledModels) {
      output.push({
        providerId: provider.id,
        providerName,
        modelId
      })
    }
  }

  return output
}

function getCurrentProviderModelLabel(config: AgentBackendConfig | null): string {
  if (!config) {
    return 'Unknown'
  }
  const providers = Array.isArray(config.providers) ? config.providers : []
  const active = providers.find((item) => item.id === config.activeProviderId) ?? null
  if (active && active.model) {
    return `${active.name || active.id} / ${active.model}`
  }
  return 'Model not set'
}

function buildCommandSlashSuggestions(query: string): SlashSuggestion[] {
  const normalized = query.trim().toLowerCase()
  const output: SlashSuggestion[] = []
  for (const def of SLASH_COMMAND_DEFS) {
    if (normalized && !def.command.toLowerCase().startsWith(normalized)) {
      continue
    }
    const commandText = def.command === '/model' ? '/model ' : def.command
    output.push({
      id: `cmd-${def.command}`,
      label: def.command,
      description: def.description,
      commandText,
      executeImmediately: def.executeImmediately
    })
  }
  return output
}

function buildModelSlashSuggestions(modelQuery: string): SlashSuggestion[] {
  const normalized = modelQuery.trim().toLowerCase()
  const suggestions: SlashSuggestion[] = []

  if (!normalized || '/model current'.includes(`/model ${normalized}`)) {
    suggestions.push({
      id: 'cmd-/model-current',
      label: '/model current',
      description: 'Show the current provider/model',
      commandText: '/model current',
      executeImmediately: true
    })
  }

  const models = getAvailableSlashModels()
  for (const item of models) {
    const keyword = `${item.providerName}/${item.modelId}`.toLowerCase()
    if (normalized && !keyword.includes(normalized) && !item.modelId.toLowerCase().includes(normalized)) {
      continue
    }
    suggestions.push({
      id: `model-${item.providerId}-${item.modelId}`,
      label: `${item.providerName} / ${item.modelId}`,
      description: `Switch to ${item.modelId}`,
      commandText: `/model ${item.providerId}/${item.modelId}`,
      executeImmediately: true
    })
  }

  return suggestions
}

function buildSlashSuggestions(input: string): SlashSuggestion[] {
  const leftTrimmed = input.trimStart()
  if (!leftTrimmed.startsWith('/')) {
    return []
  }

  const lower = leftTrimmed.toLowerCase()
  if (lower === '/model' || lower.startsWith('/model ')) {
    const args = lower === '/model' ? '' : leftTrimmed.slice('/model '.length)
    return buildModelSlashSuggestions(args)
  }

  const firstSpace = leftTrimmed.indexOf(' ')
  if (firstSpace < 0) {
    return buildCommandSlashSuggestions(leftTrimmed)
  }

  const command = leftTrimmed.slice(0, firstSpace)
  return buildCommandSlashSuggestions(command)
}

function updateSlashCommandMenu(): void {
  const text = inputTextarea.value
  if (!text.trim().startsWith('/')) {
    closeSlashCommandMenu()
    return
  }

  const suggestions = buildSlashSuggestions(text)
  if (suggestions.length === 0) {
    closeSlashCommandMenu()
    return
  }

  state.slashVisible = true
  state.slashSuggestions = suggestions
  state.slashActiveIndex = 0
  renderSlashCommandMenu()
}

function moveSlashSuggestionCursor(offset: number): void {
  if (!state.slashVisible || state.slashSuggestions.length === 0) {
    return
  }
  const total = state.slashSuggestions.length
  state.slashActiveIndex = (state.slashActiveIndex + offset + total) % total
  renderSlashCommandMenu()
}

async function switchToProviderModel(providerId: string, modelId: string): Promise<boolean> {
  const configResult = state.agentConfig
    ? { ok: true, config: state.agentConfig }
    : await window.tuanzi.getAgentConfig()
  if (!configResult.ok || !configResult.config) {
    showError(configResult.error || 'Failed to load provider config')
    return false
  }

  const config = configResult.config
  const draft = buildSettingsDraft(config)
  const provider = draft.providers.find((item) => item.id === providerId)
  if (!provider) {
    showError('Provider not found')
    return false
  }

  provider.isEnabled = true
  provider.model = modelId
  if (!provider.models.some((item) => item.id === modelId)) {
    provider.models.push({
      id: modelId,
      displayName: modelId,
      isVision: false,
      enabled: true
    })
  }
  for (const model of provider.models) {
    if (model.id === modelId) {
      model.enabled = true
    }
  }

  const saveResult = await window.tuanzi.saveAgentConfig({
    provider: {
      type: provider.type,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey
    },
    providers: draft.providers,
    activeProviderId: provider.id,
    global_skills: config.global_skills
  })
  if (!saveResult.ok || !saveResult.config) {
    showError(saveResult.error || 'Failed to switch model')
    return false
  }

  state.agentConfig = saveResult.config
  state.settingsDraft = buildSettingsDraft(saveResult.config)
  if (settingsModal.classList.contains('visible')) {
    renderSettingsDraft()
  }
  showSuccess(`Switched to ${provider.name} / ${modelId}`)
  return true
}

async function handleModelSlashCommand(args: string): Promise<boolean> {
  const normalized = args.trim()
  if (!normalized) {
    showError('Type /model and select a model from the popup')
    return true
  }

  if (normalized.toLowerCase() === 'current') {
    showSuccess(`Current model: ${getCurrentProviderModelLabel(state.agentConfig)}`)
    return true
  }

  const models = getAvailableSlashModels()
  const query = normalized.toLowerCase()
  const matches = models.filter((item) => {
    const byModel = item.modelId.toLowerCase().includes(query)
    const byProvider = item.providerId.toLowerCase().includes(query) || item.providerName.toLowerCase().includes(query)
    const byCombo = `${item.providerId}/${item.modelId}`.toLowerCase() === query
    const byComboName = `${item.providerName}/${item.modelId}`.toLowerCase() === query
    return byModel || byProvider || byCombo || byComboName
  })

  if (matches.length === 0) {
    showError(`No model matched: ${normalized}`)
    return true
  }
  if (matches.length > 1) {
    showError('Multiple models matched, keep typing to narrow down or pick from popup')
    return true
  }

  const matched = matches[0]
  return switchToProviderModel(matched.providerId, matched.modelId)
}

async function executeSlashCommand(raw: string): Promise<boolean> {
  const text = raw.trim()
  if (!text.startsWith('/')) {
    return false
  }

  const [commandToken, ...restParts] = text.split(/\s+/)
  const command = commandToken.toLowerCase()
  const args = restParts.join(' ')

  if (command === '/model') {
    return handleModelSlashCommand(args)
  }
  if (command === '/new') {
    createNewSession()
    showSuccess('Started a new conversation')
    return true
  }
  if (command === '/workspace') {
    await selectWorkspace()
    return true
  }
  if (command === '/settings') {
    await openSettingsModal()
    return true
  }
  if (command === '/agent') {
    await refreshAgentData().then(() => {
      setAgentModalView('library')
      agentLibraryModal.classList.add('visible')
    })
    return true
  }
  if (command === '/help') {
    showSuccess('Commands: /model, /model current, /new, /workspace, /settings, /agent')
    return true
  }

  showError(`Unknown command: ${commandToken}`)
  return true
}

async function applySlashSuggestion(index: number): Promise<void> {
  if (!state.slashVisible || index < 0 || index >= state.slashSuggestions.length) {
    return
  }
  const suggestion = state.slashSuggestions[index]
  inputTextarea.value = suggestion.commandText
  autoResizeTextarea()
  inputTextarea.focus()

  if (suggestion.executeImmediately) {
    const handled = await executeSlashCommand(suggestion.commandText)
    if (handled) {
      inputTextarea.value = ''
      autoResizeTextarea()
      closeSlashCommandMenu()
    }
    return
  }
  updateSlashCommandMenu()
}

// 重新配置 marked 实例
const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language }).value
    }
  })
)

marked.setOptions({
  breaks: true,
  gfm: true
})

function renderMarkdownHtml(text: string): string {
  if (!text) return ''
  try {
    return marked.parse(text) as string
  } catch (e) {
    console.error('Markdown rendering error:', e)
    return escapeHtml(text).replace(/\n/g, '<br>')
  }
}

function addUserMessage(text: string): void {
  welcomeState.style.display = 'none'

  const messageEl = document.createElement('div')
  messageEl.className = 'message user'
  messageEl.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`
  chatArea.appendChild(messageEl)
  scrollToBottom()
}

function addAssistantMessage(text: string, thinking?: string): void {
  const contentEl = createAssistantMessage()

  if (thinking) {
    const blocksContainer = document.createElement('div')
    blocksContainer.className = 'blocks-container'
    contentEl.appendChild(blocksContainer)

    const { block, output } = createExecBlock({
      type: 'thinking',
      title: 'Thought Process',
      statusOk: true,
      statusText: '✓ processed'
    })
    output.textContent = thinking
    blocksContainer.appendChild(block)
  }

  const textContainer = document.createElement('div')
  textContainer.className = 'markdown-text'
  textContainer.innerHTML = renderMarkdownHtml(text)
  contentEl.appendChild(textContainer)

  scrollToBottom()
}

function createAssistantMessage(): HTMLDivElement {
  const messageEl = document.createElement('div')
  messageEl.className = 'message assistant'
  const contentEl = document.createElement('div')
  contentEl.className = 'msg-content'
  messageEl.appendChild(contentEl)
  chatArea.appendChild(messageEl)
  return contentEl
}

function createExecBlock(opts: {
  type: 'tool' | 'command' | 'thinking'
  title: string
  statusOk?: boolean
  statusText?: string
  loading?: boolean
}): { block: HTMLDivElement; output: HTMLPreElement } {
  const block = document.createElement('div')
  block.className = 'exec-block' + (opts.loading ? ' loading' : '')
  block.dataset.execType = opts.type

  let statusHtml = ''
  if (opts.statusText !== undefined) {
    const cls = opts.statusOk ? 'status-ok' : 'status-err'
    statusHtml = `<span class="status-badge ${cls}">${escapeHtml(opts.statusText)}</span>`
  }

  const iconSvg =
    opts.type === 'command'
      ? `<svg class="tool-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 9a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3A.5.5 0 0 1 6 9zM.146 2.854a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L3.793 6.5.146 2.854z"/></svg>`
      : opts.type === 'thinking'
        ? `<svg class="tool-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M9.5 2a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h2z"/><path d="M14.5 2a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5h2z"/></svg>`
        : `<svg class="tool-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 0L0 1l2.313 2.313-1.96 1.96A.5.5 0 0 0 .5 6h5a.5.5 0 0 0 .5-.5v-5a.5.5 0 0 0-.854-.354l-1.96 1.96L1 0zm9.5 5h5a.5.5 0 0 0 .354-.854l-1.96-1.96L16 0l-1-1-2.313 2.313-1.96-1.96A.5.5 0 0 0 10 .5v5a.5.5 0 0 0 .5.5zM6 10.5v5a.5.5 0 0 0 .854.354l1.96-1.96L11 16l1-1-2.313-2.313 1.96-1.96A.5.5 0 0 0 11.5 10h-5a.5.5 0 0 0-.5.5zm-5 0v-5a.5.5 0 0 0-.854-.354l.44.44L.146 6.146a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L1.207 6.5H5.5A.5.5 0 0 0 6 6V1a.5.5 0 0 0-.854-.354L3.793 2.293.146 6.146z"/></svg>`

  block.innerHTML = `
    <div class="exec-title">
      <span class="chevron">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
        </svg>
      </span>
      ${iconSvg}
      ${escapeHtml(opts.title)}
      ${statusHtml}
    </div>
    <div class="exec-output"><pre></pre></div>
  `

  const titleEl = block.querySelector('.exec-title') as HTMLDivElement
  titleEl.addEventListener('click', () => {
    block.classList.toggle('expanded')
  })

  const output = block.querySelector('.exec-output pre') as HTMLPreElement
  return { block, output }
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(args, null, 2)
    return str.length > 800 ? str.substring(0, 800) + '...' : str
  } catch {
    return '[unserializable]'
  }
}

function formatResult(result: { ok: boolean; data?: unknown; error?: string }): string {
  if (!result.ok) {
    return `Error: ${result.error || 'Unknown error'}`
  }
  if (result.data === undefined) return 'ok'
  try {
    const str = JSON.stringify(result.data, null, 2)
    return str.length > 1200 ? str.substring(0, 1200) + '\n...(truncated)' : str
  } catch {
    return '[unserializable]'
  }
}

function renderToolCalls(
  container: HTMLDivElement,
  toolCalls: Array<{
    toolName: string
    args: Record<string, unknown>
    result: { ok: boolean; data?: unknown; error?: string }
    timestamp: string
  }>
): void {
  for (const call of toolCalls) {
    const isCommand = call.toolName === 'run_command'
    const statusOk = call.result.ok

    let title: string
    let outputContent: string

    if (isCommand) {
      const cmd = typeof call.args.command === 'string' ? call.args.command : 'command'
      title = 'Executed command'
      outputContent = `<span class="code-in">$ ${escapeHtml(cmd)}</span>

<span class="code-out">${escapeHtml(formatResult(call.result))}</span>`
    } else {
      title = `Tool Call: ${call.toolName}`
      outputContent = `<span class="code-dim">{</span>
<span class="code-in">${escapeHtml(formatArgs(call.args))}</span>
<span class="code-dim">}</span>

<span class="code-out">-> ${escapeHtml(formatResult(call.result))}</span>`
    }

    const statusText = statusOk ? 'done' : 'failed'
    const { block, output } = createExecBlock({
      type: isCommand ? 'command' : 'tool',
      title,
      statusOk,
      statusText
    })

    output.innerHTML = outputContent
    container.appendChild(block)
  }
}

async function refreshResumeSnapshot(): Promise<void> {
  const active = getActiveSession()
  if (!active || !active.workspace.trim()) {
    return
  }

  const result = await window.tuanzi.getResumeState({
    sessionId: active.id,
    workspace: active.workspace
  })

  if (!result.ok) {
    showError(result.error || 'Failed to load interrupted task')
    return
  }

  const snapshot = result.resumeSnapshot ?? null
  if (!snapshot) {
    return
  }

  syncInterruptedTurn(active, {
    user: snapshot.message,
    assistant: snapshot.streamedText,
    thinking: snapshot.streamedThinking || undefined,
    interrupted: true
  })
  touchActiveSession()
  persistSessions()
  renderSessionList()
}

function createAssistantSurface(): {
  contentEl: HTMLDivElement
  blocksContainer: HTMLDivElement
  textContainer: HTMLDivElement
} {
  const contentEl = createAssistantMessage()
  const blocksContainer = document.createElement('div')
  blocksContainer.className = 'blocks-container'
  contentEl.appendChild(blocksContainer)

  const textContainer = document.createElement('div')
  textContainer.className = 'markdown-text'
  contentEl.appendChild(textContainer)

  return { contentEl, blocksContainer, textContainer }
}

function appendCompletedToolCall(
  contentEl: HTMLDivElement,
  toolCall: {
    toolName: string
    args: Record<string, unknown>
    result: { ok: boolean; data?: unknown; error?: string }
    timestamp: string
  }
): void {
  const loadingBlock = contentEl.querySelector(
    '.exec-block.loading[data-exec-type="tool"], .exec-block.loading[data-exec-type="command"]'
  )
  if (loadingBlock) {
    loadingBlock.remove()
  }
  renderToolCalls(contentEl, [toolCall])
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

function syncInterruptedTurn(session: ChatSession, input: {
  user: string
  assistant: string
  thinking?: string
  interrupted: boolean
}): void {
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
  if (session.history.length > MAX_SESSION_HISTORY) {
    session.history.splice(0, session.history.length - MAX_SESSION_HISTORY)
  }
}

function createSession(initial?: Partial<Pick<ChatSession, 'title' | 'workspace'>>): ChatSession {
  const now = new Date().toISOString()
  return {
    id: generateSessionId(),
    title: (initial?.title || DEFAULT_SESSION_TITLE).trim() || DEFAULT_SESSION_TITLE,
    workspace: (initial?.workspace || '').trim(),
    history: [],
    createdAt: now,
    updatedAt: now
  }
}

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getActiveSession(): ChatSession | null {
  return state.sessions.find((item) => item.id === state.activeSessionId) ?? null
}

function ensureActiveSession(): ChatSession {
  let active = getActiveSession()
  if (active) {
    return active
  }
  const created = createSession()
  state.sessions.push(created)
  state.activeSessionId = created.id
  persistSessions()
  return created
}

function truncateTitleFromInput(input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return DEFAULT_SESSION_TITLE
  }
  if (compact.length <= TITLE_MAX_CHARS) {
    return compact
  }
  return `${compact.slice(0, TITLE_MAX_CHARS)}...`
}

function persistSessions(): void {
  const payload: StoredSessionPayload = {
    version: 1,
    activeSessionId: state.activeSessionId,
    sessions: state.sessions
  }
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // storage failures should not block runtime flow
  }
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

function normalizeSession(value: unknown): ChatSession | null {
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
    title: record.title.trim() || DEFAULT_SESSION_TITLE,
    workspace: record.workspace,
    history: history.slice(-MAX_SESSION_HISTORY),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function loadSessionsFromStorage(): void {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      state.sessions = [createSession()]
      state.activeSessionId = state.sessions[0].id
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
      .map((item) => normalizeSession(item))
      .filter((item): item is ChatSession => item !== null)

    if (sessions.length === 0) {
      state.sessions = [createSession()]
      state.activeSessionId = state.sessions[0].id
      persistSessions()
      return
    }

    state.sessions = sessions
    const savedActive = typeof record.activeSessionId === 'string' ? record.activeSessionId : ''
    const activeExists = sessions.some((item) => item.id === savedActive)
    state.activeSessionId = activeExists ? savedActive : sessions[0].id
  } catch {
    state.sessions = [createSession()]
    state.activeSessionId = state.sessions[0].id
    persistSessions()
  }
}

function renderWorkspaceLabel(workspace: string): void {
  if (!workspace) {
    workspaceLabel.textContent = '未选择工作目录'
    workspaceLabel.title = '点击选择工作目录'
    workspaceLabel.classList.remove('active')
    return
  }
  const parts = workspace.replace(/\\/g, '/').split('/')
  const display = parts.slice(-2).join('/')
  workspaceLabel.textContent = display
  workspaceLabel.classList.add('active')
  workspaceLabel.title = workspace
}

function getWorkspaceKey(workspace: string): string {
  const trimmed = workspace.trim()
  return trimmed || EMPTY_WORKSPACE_KEY
}

function getWorkspaceDisplayName(workspace: string): string {
  if (!workspace.trim()) {
    return '未选择工作区'
  }
  const normalized = workspace.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? workspace
}

function renderSessionList(): void {
  const sorted = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  historyList.innerHTML = ''

  type WorkspaceGroup = {
    key: string
    workspace: string
    updatedAt: string
    sessions: ChatSession[]
  }

  const groups = new Map<string, WorkspaceGroup>()
  for (const session of sorted) {
    const key = getWorkspaceKey(session.workspace)
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

  const activeWorkspaceKey = getWorkspaceKey(getActiveSession()?.workspace ?? '')
  state.expandedWorkspaceKeys.add(activeWorkspaceKey)

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

    const isExpanded = state.expandedWorkspaceKeys.has(group.key)
    const arrow = isExpanded ? 'v' : '>'
    const title = getWorkspaceDisplayName(group.workspace)
    header.textContent = `${arrow} ${title}`
    header.title = group.workspace || '未选择工作区'
    header.addEventListener('click', () => {
      if (state.expandedWorkspaceKeys.has(group.key)) {
        state.expandedWorkspaceKeys.delete(group.key)
      } else {
        state.expandedWorkspaceKeys.add(group.key)
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
      if (session.id === state.activeSessionId) {
        item.classList.add('active')
      }
      item.textContent = session.title
      item.title = session.title
      item.dataset.sessionId = session.id
      item.addEventListener('click', () => {
        if (state.isSending) {
          showError('请等待当前回复结束后再切换会话')
          return
        }
        switchSession(session.id)
      })
      sessionsBox.appendChild(item)

      // 右键删除功能
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showHistoryContextMenu(e.clientX, e.clientY, session.id)
      })
    }

    wrapper.appendChild(header)
    wrapper.appendChild(sessionsBox)
    historyList.appendChild(wrapper)
  }
}

function renderActiveConversation(): void {
  chatArea.innerHTML = ''
  chatArea.appendChild(welcomeState)

  const active = getActiveSession()
  if (!active || active.history.length === 0) {
    welcomeState.style.display = 'flex'
    return
  }

  welcomeState.style.display = 'none'
  for (const turn of active.history) {
    addUserMessage(turn.user)
    addAssistantMessage(turn.assistant, turn.thinking)
  }
  scrollToBottom()
}

function switchSession(sessionId: string): void {
  closeHistoryContextMenu()
  const target = state.sessions.find((item) => item.id === sessionId)
  if (!target) {
    return
  }
  state.activeSessionId = target.id
  renderSessionList()
  renderWorkspaceLabel(target.workspace)
  renderActiveConversation()
  persistSessions()
  void refreshResumeSnapshot().then(() => {
    renderActiveConversation()
  })
}

function touchActiveSession(): void {
  const active = getActiveSession()
  if (!active) {
    return
  }
  active.updatedAt = new Date().toISOString()
}

function showHistoryContextMenu(x: number, y: number, sessionId: string): void {
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

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    deleteSession(sessionId)
    closeHistoryContextMenu()
  })

  menu.appendChild(deleteBtn)
  document.body.appendChild(menu)

    // 记录当前菜单，以便关闭
    ; (window as any).activeHistoryContextMenu = menu
}

function closeHistoryContextMenu(): void {
  const existing = (window as any).activeHistoryContextMenu
  if (existing) {
    existing.remove()
      ; (window as any).activeHistoryContextMenu = null
  }
}

function deleteSession(sessionId: string): void {
  const index = state.sessions.findIndex(s => s.id === sessionId)
  if (index === -1) return

  state.sessions.splice(index, 1)

  if (state.activeSessionId === sessionId) {
    state.activeSessionId = state.sessions[0]?.id || ''
    renderActiveConversation()
  }

  renderSessionList()
  persistSessions()
}

function getActiveAgent(): StoredAgent | null {
  const byId = state.agents.find((agent) => agent.id === state.activeAgentId)
  if (byId) {
    return byId
  }
  const byDefault = state.agents.find((agent) => agent.filename.toLowerCase() === 'default.md')
  if (byDefault) {
    return byDefault
  }
  return state.agents[0] ?? null
}

function persistActiveAgentPreference(): void {
  try {
    localStorage.setItem(AGENT_STORAGE_KEY, state.activeAgentId)
  } catch {
    // ignore storage failures
  }
}

function loadActiveAgentPreference(): string | null {
  try {
    const raw = localStorage.getItem(AGENT_STORAGE_KEY)
    return normalizeOptionalString(raw)
  } catch {
    return null
  }
}

function applyActiveAgent(identifier: string | null, persist = true): void {
  const target = identifier
    ? state.agents.find((agent) => agent.id === identifier || agent.filename === identifier)
    : null
  const selected =
    target ??
    state.agents.find((agent) => agent.filename.toLowerCase() === 'default.md') ??
    state.agents[0] ??
    null

  if (!selected) {
    state.activeAgentId = ''
    return
  }

  state.activeAgentId = selected.id
  if (persist) {
    persistActiveAgentPreference()
  }
  renderActiveAgentIdentity()
}

function renderActiveAgentIdentity(): void {
  const agent = getActiveAgent()
  if (!agent) {
    return
  }
  const avatar = getAgentAvatar(agent)

  // 顶部 chip 更新
  activeAgentAvatar.textContent = avatar
  activeAgentName.textContent = agent.name

  welcomeAvatar.textContent = avatar
  welcomeTitle.textContent = `你好，我是 ${agent.name}`
}

function buildAgentCard(agent: StoredAgent, index: number): HTMLDivElement {
  const card = document.createElement('div')
  card.className = 'agent-card'
  if (agent.id === state.activeAgentId) {
    card.classList.add('active')
  }
  card.style.animationDelay = `${Math.min(index * 0.04, 0.4)}s`
  const avatar = getAgentAvatar(agent)
  const description = agent.description ? escapeHtml(agent.description) : '未填写简介'
  card.innerHTML = `
    <button class="agent-card-edit" title="编辑 Agent">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
        <path d="M15.502 1.94a.5.5 0 0 1 0 .706l-1.793 1.793-2.147-2.146L13.355.5a.5.5 0 0 1 .707 0l1.44 1.44ZM10.854 3.146 3 11v2h2l7.854-7.854-2-2ZM2 12.5V14h1.5l8.293-8.293-1.5-1.5L2 12.5Z"/>
      </svg>
    </button>
    <div class="avatar-container">
      <div class="card-avatar">${escapeHtml(avatar)}</div>
    </div>
    <div class="card-content">
      <div class="card-name">${escapeHtml(agent.name)}</div>
      <div class="card-file">${escapeHtml(agent.filename)}</div>
      <div class="card-description">${description}</div>
    </div>
  `

  const editBtn = card.querySelector('.agent-card-edit') as HTMLButtonElement
  editBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    openAgentEditor('edit', agent.filename)
  })

  card.addEventListener('click', () => {
    applyActiveAgent(agent.id)
    renderAgentGrid()
    closeAgentModal()
  })
  return card
}

function buildAddAgentCard(index: number): HTMLDivElement {
  const card = document.createElement('div')
  card.className = 'agent-card add-card'
  card.style.animationDelay = `${Math.min(index * 0.04, 0.5)}s`
  card.innerHTML = `
    <div class="add-icon-box">
      <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor">
        <path fill-rule="evenodd" d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2Z"/>
      </svg>
    </div>
    <div class="add-card-label">Create New</div>
  `
  card.addEventListener('click', () => openAgentEditor('create'))
  return card
}

function renderAgentGrid(): void {
  agentGrid.innerHTML = ''
  const fragment = document.createDocumentFragment()
  state.agents.forEach((agent, index) => {
    fragment.appendChild(buildAgentCard(agent, index))
  })
  fragment.appendChild(buildAddAgentCard(state.agents.length))
  agentGrid.appendChild(fragment)
}

function mapToolCategoryLabel(category: GlobalSkillCategory): string {
  if (category === 'execute_command') return '命令执行'
  if (category === 'web_search') return '网络搜索'
  return '文件系统'
}

function isGlobalSkillEnabled(category: GlobalSkillCategory): boolean {
  if (!state.agentConfig) {
    return true
  }
  return state.agentConfig.global_skills[category] === true
}

function renderEditorToolList(): void {
  agentToolList.innerHTML = ''
  if (state.agentToolProfiles.length === 0) {
    agentToolList.innerHTML = '<div class="agent-field-hint">未加载到工具清单，请稍后重试。</div>'
    return
  }

  for (const tool of state.agentToolProfiles) {
    const row = document.createElement('div')
    const globalEnabled = isGlobalSkillEnabled(tool.category)
    const selected = state.editor.selectedTools.has(tool.name)
    row.className = 'tool-row' + (globalEnabled ? '' : ' disabled')
    row.innerHTML = `
      <div>
        <div class="tool-row-title">
          ${escapeHtml(tool.name)}
          <span class="tool-row-category">${escapeHtml(mapToolCategoryLabel(tool.category))}</span>
        </div>
        <div class="tool-row-desc ${globalEnabled ? '' : 'tool-row-warning'}">
          ${escapeHtml(tool.prompt || '无描述')}
          ${globalEnabled ? '' : '<br>当前类别已被全局 Skills 禁用'}
        </div>
      </div>
    `
    const toggle = document.createElement('button')
    toggle.className = 'toggle-switch'
    toggle.dataset.enabled = selected ? 'true' : 'false'
    toggle.disabled = !globalEnabled
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!globalEnabled) {
        return
      }
      if (state.editor.selectedTools.has(tool.name)) {
        state.editor.selectedTools.delete(tool.name)
      } else {
        state.editor.selectedTools.add(tool.name)
      }
      renderEditorToolList()
    })
    row.addEventListener('click', () => {
      if (!globalEnabled) {
        return
      }
      if (state.editor.selectedTools.has(tool.name)) {
        state.editor.selectedTools.delete(tool.name)
      } else {
        state.editor.selectedTools.add(tool.name)
      }
      renderEditorToolList()
    })
    row.appendChild(toggle)
    agentToolList.appendChild(row)
  }
}

function slugifyAsFilename(input: string): string {
  const normalized = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .toLowerCase()
  return normalized ? `${normalized}.md` : ''
}

function normalizeFilenameInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  const withExt = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`
  return withExt
}

function parseTagsInput(raw: string): string[] {
  const tags = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const tag of tags) {
    if (seen.has(tag)) {
      continue
    }
    seen.add(tag)
    deduped.push(tag)
  }
  return deduped
}

function formatTagsInput(tags: string[]): string {
  return tags.join(', ')
}

function updateEditorAvatarPreview(): void {
  const avatar = firstChar(agentEditorAvatarInput.value) || firstChar(agentEditorName.value).toUpperCase() || 'A'
  agentEditorAvatarPreview.textContent = avatar
}

function setAgentModalView(view: 'library' | 'editor'): void {
  const isEditor = view === 'editor'
  agentLibraryView.classList.toggle('active', !isEditor)
  agentEditorView.classList.toggle('active', isEditor)
  agentEditorBackBtn.classList.toggle('visible', isEditor)
  agentModalTitle.textContent = isEditor
    ? state.editor.mode === 'create'
      ? '创建 Agent'
      : '编辑 Agent'
    : 'Agent 配置与切换'
}

function closeAgentModal(): void {
  agentLibraryModal.classList.remove('visible')
  setAgentModalView('library')
}

function openAgentEditor(mode: 'create' | 'edit', identifier?: string): void {
  if (mode === 'create') {
    state.editor.mode = 'create'
    state.editor.previousFilename = null
    state.editor.filenameTouched = false
    state.editor.selectedTools = new Set<string>(
      state.agentToolProfiles.length > 0 ? state.agentToolProfiles.map((tool) => tool.name) : []
    )
    agentEditorAvatarInput.value = ''
    agentEditorName.value = ''
    agentEditorFilename.value = ''
    agentEditorFilename.disabled = false
    agentEditorDescription.value = ''
    agentEditorTags.value = ''
    agentEditorPrompt.value = DEFAULT_AGENT_PROMPT
    agentEditorDeleteBtn.classList.add('hidden')
    agentEditorSaveBtn.textContent = '创建 Agent'
  } else {
    const target = state.agents.find((agent) => agent.id === identifier || agent.filename === identifier)
    if (!target) {
      showError('找不到要编辑的 Agent')
      return
    }
    state.editor.mode = 'edit'
    state.editor.previousFilename = target.filename
    state.editor.filenameTouched = true
    state.editor.selectedTools = new Set<string>(target.tools)
    agentEditorAvatarInput.value = target.avatar
    agentEditorName.value = target.name
    agentEditorFilename.value = target.filename
    agentEditorFilename.disabled = target.filename.toLowerCase() === 'default.md'
    agentEditorDescription.value = target.description
    agentEditorTags.value = formatTagsInput(target.tags)
    agentEditorPrompt.value = target.prompt
    agentEditorDeleteBtn.classList.toggle('hidden', target.filename.toLowerCase() === 'default.md')
    agentEditorSaveBtn.textContent = '保存 Agent'
  }

  updateEditorAvatarPreview()
  renderEditorToolList()
  setAgentModalView('editor')
  agentLibraryModal.classList.add('visible')
}

async function saveAgentFromEditor(): Promise<void> {
  const name = normalizeOptionalString(agentEditorName.value)
  if (!name) {
    showError('Agent 名称不能为空')
    return
  }
  const prompt = normalizeOptionalString(agentEditorPrompt.value)
  if (!prompt) {
    showError('系统提示词不能为空')
    return
  }

  const explicitFilename = normalizeFilenameInput(agentEditorFilename.value)
  let filename = explicitFilename || slugifyAsFilename(name)
  if (!filename) {
    showError('文件名不能为空')
    return
  }
  if (state.editor.mode === 'edit' && agentEditorFilename.disabled && state.editor.previousFilename) {
    filename = state.editor.previousFilename
  }

  const tags = parseTagsInput(agentEditorTags.value)
  const tools = Array.from(state.editor.selectedTools)
  const result = await window.tuanzi.saveAgent({
    previousFilename: state.editor.previousFilename,
    filename,
    name,
    avatar: normalizeOptionalString(agentEditorAvatarInput.value),
    description: normalizeOptionalString(agentEditorDescription.value),
    tags,
    tools,
    prompt
  })

  if (!result.ok || !result.agent) {
    showError(result.error || '保存 Agent 失败')
    return
  }

  await refreshAgentData(result.agent.id)
  renderAgentGrid()
  setAgentModalView('library')
}

async function deleteAgentFromEditor(): Promise<void> {
  const target = normalizeOptionalString(state.editor.previousFilename)
  if (!target) {
    return
  }
  if (target.toLowerCase() === 'default.md') {
    showError('默认 Agent 不允许删除')
    return
  }
  const confirmed = window.confirm(`确认删除 Agent: ${target} ?`)
  if (!confirmed) {
    return
  }
  const result = await window.tuanzi.deleteAgent(target)
  if (!result.ok) {
    showError(result.error || '删除 Agent 失败')
    return
  }
  await refreshAgentData('default')
  renderAgentGrid()
  setAgentModalView('library')
}

async function refreshAgentData(preferredAgent?: string | null): Promise<void> {
  const activeWorkspace = getActiveSession()?.workspace ?? ''
  const [agentsRes, configRes, toolsRes] = await Promise.all([
    window.tuanzi.listAgents(),
    window.tuanzi.getAgentConfig(),
    window.tuanzi.listAgentTools({ workspace: activeWorkspace })
  ])

  if (!agentsRes.ok || !agentsRes.agents) {
    showError(agentsRes.error || '加载 Agent 列表失败')
    return
  }
  state.agents = agentsRes.agents

  if (configRes.ok && configRes.config) {
    state.agentConfig = configRes.config
  }

  if (toolsRes.ok && toolsRes.tools) {
    state.agentToolProfiles = toolsRes.tools
  }

  const preferred = preferredAgent || state.activeAgentId || loadActiveAgentPreference()
  applyActiveAgent(preferred, true)
  renderAgentGrid()
  renderEditorToolList()
}

function toggleSwitch(button: HTMLButtonElement, enabled: boolean): void {
  button.dataset.enabled = enabled ? 'true' : 'false'
}

function readToggle(button: HTMLButtonElement): boolean {
  return button.dataset.enabled === 'true'
}

function createProviderId(): string {
  return `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeProviderModelList(input: unknown): ProviderModelItem[] {
  if (!Array.isArray(input)) {
    return []
  }
  const output: ProviderModelItem[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const record = item as Record<string, unknown>
    const id = normalizeOptionalString(record.id)
    if (!id) {
      continue
    }
    const key = id.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    output.push({
      id,
      displayName: normalizeOptionalString(record.displayName) ?? id,
      isVision: record.isVision === true,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true
    })
  }
  return output
}

function normalizeProviderDraft(input: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: normalizeOptionalString(input.id) ?? createProviderId(),
    name: normalizeOptionalString(input.name) ?? 'Untitled Provider',
    type: normalizeOptionalString(input.type) ?? DEFAULT_PROVIDER_TYPE,
    baseUrl: normalizeOptionalString(input.baseUrl) ?? DEFAULT_PROVIDER_BASE_URL,
    apiKey: normalizeOptionalString(input.apiKey) ?? '',
    model: normalizeOptionalString(input.model) ?? '',
    models: normalizeProviderModelList(input.models),
    isEnabled: input.isEnabled !== false
  }
}

function ensureSettingsDraft(): SettingsDraft {
  if (!state.settingsDraft) {
    state.settingsDraft = {
      providers: [normalizeProviderDraft({ id: createProviderId(), name: 'OpenAI', type: 'openai' })],
      activeProviderId: '',
      globalSkills: {
        file_system: true,
        execute_command: true,
        web_search: true
      }
    }
  }

  if (state.settingsDraft.providers.length === 0) {
    state.settingsDraft.providers.push(
      normalizeProviderDraft({ id: createProviderId(), name: 'OpenAI', type: 'openai' })
    )
  }
  if (!state.settingsDraft.providers.some((item) => item.id === state.settingsDraft!.activeProviderId)) {
    state.settingsDraft.activeProviderId = state.settingsDraft.providers[0].id
  }

  return state.settingsDraft
}

function getActiveDraftProvider(): ProviderConfig | null {
  const draft = ensureSettingsDraft()
  return draft.providers.find((item) => item.id === draft.activeProviderId) ?? draft.providers[0] ?? null
}

function renderProviderList(): void {
  const draft = ensureSettingsDraft()
  providerList.innerHTML = ''
  if (draft.providers.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'provider-list-empty'
    empty.textContent = 'No providers yet'
    providerList.appendChild(empty)
    return
  }

  for (const provider of draft.providers) {
    const item = document.createElement('button')
    item.className = 'provider-list-item'
    if (provider.id === draft.activeProviderId) {
      item.classList.add('active')
    }
    item.innerHTML = `
      <div class="provider-item-main">
        <span class="provider-item-name">${escapeHtml(provider.name)}</span>
        <span class="provider-item-status ${provider.isEnabled ? 'enabled' : ''}">${provider.isEnabled ? 'ON' : 'OFF'}</span>
      </div>
      <div class="provider-item-sub">${escapeHtml(provider.model || 'No default model')}</div>
    `
    item.addEventListener('click', () => {
      draft.activeProviderId = provider.id
      renderSettingsDraft()
    })
    providerList.appendChild(item)
  }
}

function renderProviderModelCards(provider: ProviderConfig): void {
  providerModelList.innerHTML = ''
  if (provider.models.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'provider-model-empty'
    empty.textContent = 'No models. Fetch from provider or add one manually.'
    providerModelList.appendChild(empty)
    return
  }

  for (const model of provider.models) {
    const card = document.createElement('div')
    card.className = 'provider-model-card'
    if (model.id === provider.model) {
      card.classList.add('default')
    }
    card.innerHTML = `
      <div class="provider-model-main">
        <div class="provider-model-name">${escapeHtml(model.displayName || model.id)}</div>
        <button class="toggle-switch" data-enabled="${model.enabled ? 'true' : 'false'}"></button>
      </div>
      <div class="provider-model-meta">
        <span class="provider-model-badge">${escapeHtml(model.id)}</span>
        ${model.isVision ? '<span class="provider-model-badge vision">VISION</span>' : ''}
      </div>
      <div class="provider-model-actions">
        <button class="agent-btn secondary provider-model-default-btn">${model.id === provider.model ? 'Default' : 'Set Default'}</button>
        <button class="agent-btn danger provider-model-delete-btn">Delete</button>
      </div>
    `

    const toggle = card.querySelector('.toggle-switch') as HTMLButtonElement
    toggle.addEventListener('click', () => {
      model.enabled = !model.enabled
      if (!model.enabled && provider.model === model.id) {
        provider.model = provider.models.find((item) => item.enabled && item.id !== model.id)?.id ?? ''
      }
      renderSettingsDraft()
    })

    const setDefaultBtn = card.querySelector('.provider-model-default-btn') as HTMLButtonElement
    setDefaultBtn.addEventListener('click', () => {
      model.enabled = true
      provider.model = model.id
      renderSettingsDraft()
    })

    const deleteBtn = card.querySelector('.provider-model-delete-btn') as HTMLButtonElement
    deleteBtn.addEventListener('click', () => {
      provider.models = provider.models.filter((item) => item.id !== model.id)
      if (provider.model === model.id) {
        provider.model = provider.models.find((item) => item.enabled)?.id ?? ''
      }
      renderSettingsDraft()
    })

    providerModelList.appendChild(card)
  }
}

function renderProviderEditor(): void {
  const provider = getActiveDraftProvider()
  if (!provider) {
    providerEditorTitle.textContent = 'Provider Settings'
    providerNameInput.value = ''
    providerTypeInput.value = DEFAULT_PROVIDER_TYPE
    providerBaseUrlInput.value = DEFAULT_PROVIDER_BASE_URL
    providerModelInput.value = ''
    providerApiKeyInput.value = ''
    toggleSwitch(providerEnabledToggle, true)
    providerModelList.innerHTML = ''
    return
  }

  providerEditorTitle.textContent = `${provider.name} Settings`
  providerNameInput.value = provider.name
  const hasTypeOption = Array.from(providerTypeInput.options).some((item) => item.value === provider.type)
  if (!hasTypeOption) {
    const custom = document.createElement('option')
    custom.value = provider.type
    custom.textContent = provider.type
    providerTypeInput.appendChild(custom)
  }
  providerTypeInput.value = provider.type
  providerBaseUrlInput.value = provider.baseUrl
  providerModelInput.value = provider.model
  providerApiKeyInput.value = provider.apiKey
  toggleSwitch(providerEnabledToggle, provider.isEnabled)
  providerDeleteBtn.disabled = ensureSettingsDraft().providers.length <= 1
  renderProviderModelCards(provider)
}

function updateActiveProviderFromInputs(): void {
  const provider = getActiveDraftProvider()
  if (!provider) {
    return
  }
  provider.name = normalizeOptionalString(providerNameInput.value) ?? 'Untitled Provider'
  provider.type = normalizeOptionalString(providerTypeInput.value) ?? DEFAULT_PROVIDER_TYPE
  provider.baseUrl = normalizeOptionalString(providerBaseUrlInput.value) ?? DEFAULT_PROVIDER_BASE_URL
  provider.model = normalizeOptionalString(providerModelInput.value) ?? ''
  provider.apiKey = normalizeOptionalString(providerApiKeyInput.value) ?? ''
  provider.isEnabled = readToggle(providerEnabledToggle)
  providerEditorTitle.textContent = `${provider.name} Settings`
  renderProviderList()
}

function addDraftProvider(): void {
  const draft = ensureSettingsDraft()
  const provider = normalizeProviderDraft({
    id: createProviderId(),
    name: `Provider ${draft.providers.length + 1}`,
    type: DEFAULT_PROVIDER_TYPE
  })
  draft.providers.push(provider)
  draft.activeProviderId = provider.id
  renderSettingsDraft()
}

function removeActiveDraftProvider(): void {
  const draft = ensureSettingsDraft()
  const current = getActiveDraftProvider()
  if (!current) {
    return
  }
  if (draft.providers.length <= 1) {
    showError('At least one provider must remain')
    return
  }
  const confirmed = window.confirm(`Delete provider "${current.name}"?`)
  if (!confirmed) {
    return
  }
  draft.providers = draft.providers.filter((item) => item.id !== current.id)
  draft.activeProviderId = draft.providers[0]?.id ?? ''
  renderSettingsDraft()
}

function addModelToActiveProvider(): void {
  const provider = getActiveDraftProvider()
  if (!provider) {
    return
  }
  const modelId = normalizeOptionalString(window.prompt('Enter model ID (for example: gpt-4o-mini)', ''))
  if (!modelId) {
    return
  }
  if (provider.models.some((item) => item.id.toLowerCase() === modelId.toLowerCase())) {
    showError(`Model already exists: ${modelId}`)
    return
  }
  const supportsVision = window.confirm('Does this model support image input?')
  provider.models.push({
    id: modelId,
    displayName: modelId,
    isVision: supportsVision,
    enabled: true
  })
  if (!provider.model) {
    provider.model = modelId
  }
  renderSettingsDraft()
}

async function testActiveProviderConnection(): Promise<void> {
  updateActiveProviderFromInputs()
  const provider = getActiveDraftProvider()
  if (!provider) {
    return
  }
  const result = await window.tuanzi.testProviderConnection({
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model
  })
  if (!result.ok) {
    showError(result.error || 'Connection test failed')
    return
  }
  window.alert(result.message || 'Connection successful.')
}

async function fetchModelsForActiveProvider(): Promise<void> {
  updateActiveProviderFromInputs()
  const provider = getActiveDraftProvider()
  if (!provider) {
    return
  }
  const result = await window.tuanzi.fetchProviderModels({
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model
  })
  if (!result.ok || !result.models) {
    showError(result.error || 'Failed to fetch models')
    return
  }

  if (result.message) {
    showSuccess(result.message)
  }

  const existing = new Map(provider.models.map((item) => [item.id.toLowerCase(), item]))
  for (const model of result.models) {
    const key = model.id.toLowerCase()
    const hit = existing.get(key)
    if (hit) {
      hit.displayName = model.displayName || hit.displayName
      hit.isVision = model.isVision || hit.isVision
      continue
    }
    provider.models.push({
      id: model.id,
      displayName: model.displayName || model.id,
      isVision: model.isVision,
      enabled: true
    })
  }
  if (!provider.model) {
    provider.model = provider.models.find((item) => item.enabled)?.id ?? ''
  }
  renderSettingsDraft()
  if (result.models.length === 0) {
    window.alert(result.message || 'No models returned by provider.')
    return
  }
  window.alert(`Synced ${result.models.length} models.`)
}

function buildSettingsDraft(config: AgentBackendConfig): SettingsDraft {
  const fromProviders = Array.isArray(config.providers) ? config.providers : []
  const providers =
    fromProviders.length > 0
      ? fromProviders.map((item) => normalizeProviderDraft(item))
      : [normalizeProviderDraft({ id: createProviderId(), name: 'Default Provider' })]
  const activeProviderId =
    providers.find((item) => item.id === config.activeProviderId)?.id ?? providers[0]?.id ?? createProviderId()

  return {
    providers,
    activeProviderId,
    globalSkills: {
      file_system: config.global_skills.file_system,
      execute_command: config.global_skills.execute_command,
      web_search: config.global_skills.web_search
    }
  }
}

function renderSettingsDraft(): void {
  if (!state.settingsDraft) {
    return
  }

  renderProviderList()
  renderProviderEditor()

  toggleSwitch(globalSkillFileSystem, state.settingsDraft.globalSkills.file_system)
  toggleSwitch(globalSkillExecuteCommand, state.settingsDraft.globalSkills.execute_command)
  toggleSwitch(globalSkillWebSearch, state.settingsDraft.globalSkills.web_search)
}

function setActiveSettingsPanel(panel: string): void {
  const navButtons = Array.from(settingsNav.querySelectorAll<HTMLButtonElement>('.settings-nav-item'))
  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.panel === panel)
  })
  const panels = Array.from(settingsModal.querySelectorAll<HTMLElement>('.settings-panel'))
  panels.forEach((item) => {
    item.classList.toggle('active', item.dataset.panel === panel)
  })
}

async function openSettingsModal(): Promise<void> {
  closeSlashCommandMenu()
  mcpJsonModal.classList.remove('visible')

  const configRes = await window.tuanzi.getAgentConfig()

  if (!configRes.ok || !configRes.config) {
    showError(configRes.error || '读取全局配置失败')
    return
  }

  state.agentConfig = configRes.config
  state.settingsDraft = buildSettingsDraft(configRes.config)
  state.mcpServers = []
  state.expandedMcpServerIds.clear()

  renderSettingsDraft()
  setActiveSettingsPanel('provider')
  settingsModal.classList.add('visible')
  requestAnimationFrame(() => {
    if (!settingsModal.classList.contains('visible')) {
      return
    }
    providerNameInput.focus()
    providerNameInput.setSelectionRange(providerNameInput.value.length, providerNameInput.value.length)
  })

  void refreshMcpServers()
}

function closeSettingsModal(): void {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement && settingsModal.contains(activeElement)) {
    activeElement.blur()
  }
  settingsModal.classList.remove('visible')
  mcpJsonModal.classList.remove('visible')
}

async function saveSettings(): Promise<void> {
  if (!state.settingsDraft) {
    return
  }

  updateActiveProviderFromInputs()
  const draft = ensureSettingsDraft()
  const activeProvider = getActiveDraftProvider()
  if (!activeProvider) {
    showError('No active provider')
    return
  }

  const globalSkills = {
    file_system: readToggle(globalSkillFileSystem),
    execute_command: readToggle(globalSkillExecuteCommand),
    web_search: readToggle(globalSkillWebSearch)
  }

  const configResult = await window.tuanzi.saveAgentConfig({
    provider: {
      type: activeProvider.type,
      baseUrl: activeProvider.baseUrl,
      model: activeProvider.model,
      apiKey: activeProvider.apiKey
    },
    providers: draft.providers,
    activeProviderId: activeProvider.id,
    global_skills: globalSkills
  })
  if (!configResult.ok || !configResult.config) {
    showError(configResult.error || '保存全局配置失败')
    return
  }

  state.agentConfig = configResult.config
  state.settingsDraft = buildSettingsDraft(configResult.config)

  closeSettingsModal()
  renderEditorToolList()
}

function renderMcpServers(): void {
  mcpServerList.innerHTML = ''
  if (state.isMcpLoading) {
    const loading = document.createElement('div')
    loading.className = 'mcp-empty'
    loading.textContent = '加载中，正在探测 MCP Server 状态...'
    mcpServerList.appendChild(loading)
    return
  }
  if (state.mcpServers.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mcp-empty'
    empty.textContent = '尚未配置 MCP Server，点击右上角“+ 添加”导入 JSON。'
    mcpServerList.appendChild(empty)
    return
  }

  for (const server of state.mcpServers) {
    const card = document.createElement('div')
    card.className = 'mcp-card'
    const isExpanded = state.expandedMcpServerIds.has(server.serverId)
    if (isExpanded) {
      card.classList.add('expanded')
    }

    const statusClass = server.status
    const commandPreview = [server.command, ...server.args].join(' ')
    const toolsHtml =
      server.tools.length > 0
        ? server.tools
          .map((tool) => {
            return `<div class="mcp-tool-row">
                <div class="mcp-tool-name">${escapeHtml(tool.name)}</div>
                <div class="mcp-tool-desc">${escapeHtml(tool.description || '-')}</div>
              </div>`
          })
          .join('')
        : '<div class="mcp-tool-row"><div class="mcp-tool-desc">无可用工具</div></div>'

    card.innerHTML = `
      <div class="mcp-card-head">
        <div class="mcp-chevron">></div>
        <div class="mcp-status-dot ${statusClass}"></div>
        <div class="mcp-title">
          <div class="mcp-title-text">${escapeHtml(server.serverId)}</div>
          <div class="mcp-subtitle">${escapeHtml(commandPreview || '(empty)')}</div>
          ${server.error ? `<div class="mcp-error">${escapeHtml(server.error)}</div>` : ''}
        </div>
        <button class="toggle-switch" data-enabled="${server.enabled ? 'true' : 'false'}"></button>
      </div>
      <div class="mcp-card-tools">${toolsHtml}</div>
    `

    const head = card.querySelector('.mcp-card-head') as HTMLDivElement
    head.addEventListener('click', () => {
      if (state.expandedMcpServerIds.has(server.serverId)) {
        state.expandedMcpServerIds.delete(server.serverId)
      } else {
        state.expandedMcpServerIds.add(server.serverId)
      }
      renderMcpServers()
    })

    const toggle = card.querySelector('.toggle-switch') as HTMLButtonElement
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      void toggleMcpServer(server.serverId, !server.enabled)
    })

    mcpServerList.appendChild(card)
  }
}

async function refreshMcpServers(): Promise<void> {
  state.isMcpLoading = true
  renderMcpServers()

  const workspace = getActiveSession()?.workspace ?? ''
  const result = await window.tuanzi.getMcpDashboard({ workspace })

  state.isMcpLoading = false
  if (!result.ok || !result.mcp) {
    showError(result.error || '读取 MCP 配置失败')
    renderMcpServers()
    return
  }
  state.mcpServers = result.mcp.servers
  renderMcpServers()
}

async function toggleMcpServer(serverId: string, enabled: boolean): Promise<void> {
  const result = await window.tuanzi.setMcpServerEnabled({ serverId, enabled })
  if (!result.ok) {
    showError(result.error || '切换 MCP Server 失败')
    return
  }
  await refreshMcpServers()
}

function openMcpJsonModal(): void {
  mcpJsonModal.classList.add('visible')
  mcpJsonInput.focus()
}

function closeMcpJsonModal(): void {
  mcpJsonModal.classList.remove('visible')
}

async function saveMcpJsonConfig(): Promise<void> {
  const jsonText = mcpJsonInput.value.trim()
  if (!jsonText) {
    showError('请输入 MCP JSON 配置')
    return
  }
  const result = await window.tuanzi.mergeMcpJson({ jsonText })
  if (!result.ok) {
    showError(result.error || '保存 MCP JSON 配置失败')
    return
  }
  closeMcpJsonModal()
  await refreshMcpServers()
}

function beginStreamingUi(taskId: string): void {
  state.isSending = true
  state.currentTaskId = taskId
  inputBox.classList.add('disabled')
  sendBtn.disabled = true
  sendBtn.style.display = 'none'
  stopBtn.style.display = 'flex'
  thinkingBtn.disabled = true
  sendingIndicator.classList.add('visible')
}

function endStreamingUi(): void {
  state.isSending = false
  state.currentTaskId = ''
  state.currentRenderedToolCalls = 0
  inputBox.classList.remove('disabled')
  sendBtn.disabled = false
  sendBtn.style.display = 'flex'
  stopBtn.style.display = 'none'
  thinkingBtn.disabled = false
  sendingIndicator.classList.remove('visible')
  scrollToBottom()
  inputTextarea.focus()
}

function buildStreamingListeners(input: {
  taskId: string
  contentEl: HTMLDivElement
  blocksContainer: HTMLDivElement
  textContainer: HTMLDivElement
  initialThinkingText?: string
  existingThinkingBlock?: { block: HTMLDivElement; output: HTMLPreElement } | null
}) {
  let thinkingBlock = input.existingThinkingBlock ?? null
  let currentThinkingText = input.initialThinkingText ?? ''

  const removePhaseListener = window.tuanzi.onPhase((data) => {
    state.currentTaskId = data.taskId
  })

  const removeDeltaListener = window.tuanzi.onDelta((data) => {
    state.currentTaskId = data.taskId
    state.currentStreamText += data.delta
    input.textContainer.innerHTML = renderMarkdownHtml(state.currentStreamText)
    scrollToBottom()
  })

  const removeThinkingListener = window.tuanzi.onThinking((data) => {
    state.currentTaskId = data.taskId
    if (!thinkingBlock) {
      thinkingBlock = createExecBlock({
        type: 'thinking',
        title: 'Thought Process',
        loading: true
      })
      thinkingBlock.block.classList.add('expanded')
      input.blocksContainer.appendChild(thinkingBlock.block)
    }
    thinkingBlock.block.classList.add('loading')
    currentThinkingText += data.delta
    thinkingBlock.output.textContent = currentThinkingText
    scrollToBottom()
  })

  const removeLogListener = window.tuanzi.onLog((data) => {
    state.currentTaskId = data.taskId
    if (data.message.startsWith('[tool] start ')) {
      const toolName = data.message.replace('[tool] start ', '').split(' ')[0]
      const { block } = createExecBlock({
        type: toolName === 'run_command' ? 'command' : 'tool',
        title: `Tool Call: ${toolName}`,
        loading: true
      })
      input.blocksContainer.appendChild(block)
      scrollToBottom()
    }
  })

  const removeToolCallCompletedListener = window.tuanzi.onToolCallCompleted((data) => {
    state.currentTaskId = data.taskId
    appendCompletedToolCall(input.contentEl, data.toolCall)
    state.currentRenderedToolCalls += 1
    scrollToBottom()
  })

  return {
    getCurrentThinkingText: (): string => currentThinkingText,
    getThinkingBlock: () => thinkingBlock,
    dispose: (): void => {
      removePhaseListener()
      removeDeltaListener()
      removeThinkingListener()
      removeLogListener()
      removeToolCallCompletedListener()
    }
  }
}

function finalizeThinkingBlock(
  thinkingBlock: { block: HTMLDivElement; output: HTMLPreElement } | null
): void {
  if (!thinkingBlock) {
    return
  }
  thinkingBlock.block.classList.remove('loading')
  thinkingBlock.block.classList.remove('expanded')
  const title = thinkingBlock.block.querySelector('.exec-title')
  const existingBadge = title?.querySelector('.status-badge')
  if (!existingBadge && title) {
    const badge = document.createElement('span')
    badge.className = 'status-badge status-ok'
    badge.textContent = 'processed'
    title.appendChild(badge)
  }
}

async function sendMessage(): Promise<void> {
  const text = inputTextarea.value.trim()
  if (!text || state.isSending) return

  if (text.startsWith('/')) {
    const handled = await executeSlashCommand(text)
    if (handled) {
      inputTextarea.value = ''
      autoResizeTextarea()
      closeSlashCommandMenu()
    }
    return
  }

  const active = ensureActiveSession()
  if (!active.workspace) {
    showError('Please select a workspace first')
    return
  }

  const newTaskId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5)

  state.currentStreamText = ''
  state.currentRenderedToolCalls = 0
  beginStreamingUi(newTaskId)
  inputTextarea.value = ''
  autoResizeTextarea()

  addUserMessage(text)
  const surface = createAssistantSurface()
  scrollToBottom()

  const listeners = buildStreamingListeners({
    taskId: newTaskId,
    contentEl: surface.contentEl,
    blocksContainer: surface.blocksContainer,
    textContainer: surface.textContainer
  })

  try {
    const activeAgent = getActiveAgent()
    const result = await window.tuanzi.sendMessage({
      taskId: newTaskId,
      sessionId: active.id,
      message: text,
      workspace: active.workspace,
      history: active.history.slice(-10),
      agentId: activeAgent?.id ?? null,
      thinking: state.isThinking
    })

    listeners.dispose()
    finalizeThinkingBlock(listeners.getThinkingBlock())

    if (result.ok) {
      const loadingBlocks = surface.contentEl.querySelectorAll('.exec-block.loading')
      loadingBlocks.forEach((block) => block.remove())

      if (!state.currentStreamText && result.summary) {
        surface.textContainer.innerHTML = renderMarkdownHtml(result.summary)
      }

      if (result.toolCalls && result.toolCalls.length > state.currentRenderedToolCalls) {
        renderToolCalls(surface.contentEl, result.toolCalls.slice(state.currentRenderedToolCalls))
      }

      const assistantText = state.currentStreamText || result.summary || ''
      syncInterruptedTurn(active, {
        user: text,
        assistant: assistantText,
        thinking: listeners.getCurrentThinkingText() || undefined,
        interrupted: false
      })

      if (active.history.length === 1 && (!active.title || active.title === DEFAULT_SESSION_TITLE)) {
        active.title = truncateTitleFromInput(text)
      }

      touchActiveSession()
      persistSessions()
      renderSessionList()
        } else if (result.interrupted && result.resumeSnapshot) {
      syncInterruptedTurn(active, {
        user: text,
        assistant: result.resumeSnapshot.streamedText,
        thinking: result.resumeSnapshot.streamedThinking || undefined,
        interrupted: true
      })
      touchActiveSession()
      persistSessions()
      renderSessionList()
        } else {
      surface.textContainer.innerHTML = `<p style="color: var(--status-err);">${escapeHtml(result.error || 'Execution failed')}</p>`
    }
  } catch (error) {
    listeners.dispose()
    const msg = error instanceof Error ? error.message : String(error)
    surface.textContainer.innerHTML = `<p style="color: var(--status-err);">${escapeHtml(msg)}</p>`
  } finally {
    endStreamingUi()
  }
}

async function selectWorkspace(): Promise<void> {
  const selected = await window.tuanzi.selectWorkspace()
  if (!selected) {
    return
  }

  // 1. 查找该目录下是否已有历史会话
  const sorted = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const existing = sorted.find((s) => s.workspace === selected)

  if (existing) {
    // 如果找到了，直接切过去
    switchSession(existing.id)
  } else {
    // 2. 如果没找到，检查当前活动会话是否是还没关联路径的“纯净”新会话
    const active = getActiveSession()
    if (active && active.history.length === 0 && !active.workspace.trim()) {
      active.workspace = selected
      touchActiveSession()
      renderWorkspaceLabel(selected)
      renderSessionList()
      persistSessions()
      void refreshResumeSnapshot().then(() => {
        renderActiveConversation()
      })
    } else {
      // 3. 否则，为新目录开启一个独立的新会话
      const session = createSession({ workspace: selected })
      state.sessions.push(session)
      switchSession(session.id)
    }
  }
}

function createNewSession(): void {
  const active = getActiveSession()
  const workspace = active?.workspace ?? ''
  const session = createSession({ workspace })
  state.sessions.push(session)
  switchSession(session.id)
  inputTextarea.value = ''
  autoResizeTextarea()
  inputTextarea.focus()
}

function bindAgentEditorEvents(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-tab'))
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.agent-panel'))
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab
      tabs.forEach((item) => item.classList.toggle('active', item === tab))
      panels.forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panel === target)
      })
    })
  })

  agentEditorName.addEventListener('input', () => {
    if (state.editor.mode === 'create' && !state.editor.filenameTouched) {
      agentEditorFilename.value = slugifyAsFilename(agentEditorName.value)
    }
    updateEditorAvatarPreview()
  })
  agentEditorFilename.addEventListener('input', () => {
    state.editor.filenameTouched = true
  })
  agentEditorAvatarInput.addEventListener('input', updateEditorAvatarPreview)
}

function bindSettingsEvents(): void {
  const navItems = Array.from(settingsNav.querySelectorAll<HTMLButtonElement>('.settings-nav-item'))
  navItems.forEach((button) => {
    button.addEventListener('click', () => {
      const panel = button.dataset.panel ?? 'provider'
      setActiveSettingsPanel(panel)
    })
  })

  providerAddBtn.addEventListener('click', () => {
    addDraftProvider()
  })
  providerDeleteBtn.addEventListener('click', () => {
    removeActiveDraftProvider()
  })
  providerAddModelBtn.addEventListener('click', () => {
    addModelToActiveProvider()
  })
  providerEnabledToggle.addEventListener('click', () => {
    toggleSwitch(providerEnabledToggle, !readToggle(providerEnabledToggle))
    updateActiveProviderFromInputs()
  })
  providerTestBtn.addEventListener('click', () => {
    void testActiveProviderConnection()
  })
  providerFetchModelsBtn.addEventListener('click', () => {
    void fetchModelsForActiveProvider()
  })

  providerNameInput.addEventListener('input', updateActiveProviderFromInputs)
  providerTypeInput.addEventListener('change', updateActiveProviderFromInputs)
  providerBaseUrlInput.addEventListener('input', updateActiveProviderFromInputs)
  providerModelInput.addEventListener('input', updateActiveProviderFromInputs)
  providerApiKeyInput.addEventListener('input', updateActiveProviderFromInputs)

  globalSkillFileSystem.addEventListener('click', () => {
    toggleSwitch(globalSkillFileSystem, !readToggle(globalSkillFileSystem))
  })
  globalSkillExecuteCommand.addEventListener('click', () => {
    toggleSwitch(globalSkillExecuteCommand, !readToggle(globalSkillExecuteCommand))
  })
  globalSkillWebSearch.addEventListener('click', () => {
    toggleSwitch(globalSkillWebSearch, !readToggle(globalSkillWebSearch))
  })

  mcpRefreshBtn.addEventListener('click', () => {
    void refreshMcpServers()
  })
  mcpAddBtn.addEventListener('click', openMcpJsonModal)
  closeMcpJsonModalBtn.addEventListener('click', closeMcpJsonModal)
  mcpJsonCancelBtn.addEventListener('click', closeMcpJsonModal)
  mcpJsonConfirmBtn.addEventListener('click', () => {
    void saveMcpJsonConfig()
  })
  mcpJsonModal.addEventListener('click', (event) => {
    if (event.target === mcpJsonModal) {
      closeMcpJsonModal()
    }
  })
}

async function init(): Promise<void> {
  loadSessionsFromStorage()
  renderSessionList()
  const active = ensureActiveSession()
  renderWorkspaceLabel(active.workspace)
  renderActiveConversation()
  await refreshResumeSnapshot()
  renderActiveConversation()
  bindTopBarDrag()

  document.addEventListener('click', (event) => {
    closeHistoryContextMenu()
    const target = event.target as HTMLElement | null
    if (!target) {
      closeSlashCommandMenu()
      return
    }
    if (
      !target.closest('#inputBox') &&
      !target.closest('#slashCommandMenu')
    ) {
      closeSlashCommandMenu()
    }
  })

  inputTextarea.addEventListener('keydown', (e) => {
    if (state.slashVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveSlashSuggestionCursor(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveSlashSuggestionCursor(-1)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSlashCommandMenu()
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault()
        void applySlashSuggestion(state.slashActiveIndex)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  })
  inputTextarea.addEventListener('input', () => {
    autoResizeTextarea()
    updateSlashCommandMenu()
  })

  sendBtn.addEventListener('click', () => {
    void sendMessage()
  })

  stopBtn.addEventListener('click', () => {
    console.log('Stop button clicked, state:', { isSending: state.isSending, currentTaskId: state.currentTaskId })
    if (state.isSending && state.currentTaskId) {
      void window.tuanzi.stopMessage({ taskId: state.currentTaskId })
    }
  })

  selectWorkspaceBtn.addEventListener('click', () => {
    void selectWorkspace()
  })
  workspaceLabel.addEventListener('click', () => {
    void selectWorkspace()
  })

  toggleSidebar.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.toggle('collapsed')
    toggleSidebar.classList.toggle('flipped', isCollapsed)
  })

  thinkingBtn.addEventListener('click', () => {
    state.isThinking = !state.isThinking
    thinkingBtn.classList.toggle('active', state.isThinking)
    thinkingBtn.title = state.isThinking ? '关闭思考模式' : '开启思考模式'
  })

  newChatBtn.addEventListener('click', () => {
    if (state.isSending) {
      showError('请等待当前回复结束后再新建会话')
      return
    }
    createNewSession()
  })

  activeAgentChip.addEventListener('click', () => {
    void refreshAgentData().then(() => {
      setAgentModalView('library')
      agentLibraryModal.classList.add('visible')
    })
  })
  closeAgentModalBtn.addEventListener('click', closeAgentModal)
  agentEditorBackBtn.addEventListener('click', () => setAgentModalView('library'))
  agentEditorCancelBtn.addEventListener('click', () => setAgentModalView('library'))
  agentEditorSaveBtn.addEventListener('click', () => {
    void saveAgentFromEditor()
  })
  agentEditorDeleteBtn.addEventListener('click', () => {
    void deleteAgentFromEditor()
  })
  agentLibraryModal.addEventListener('click', (event) => {
    if (event.target === agentLibraryModal) {
      closeAgentModal()
    }
  })

  settingsBtn.addEventListener('click', () => {
    void openSettingsModal()
  })
  closeSettingsModalBtn.addEventListener('click', closeSettingsModal)
  settingsCancelBtn.addEventListener('click', closeSettingsModal)
  settingsSaveBtn.addEventListener('click', () => {
    void saveSettings()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return
    }
    if (mcpJsonModal.classList.contains('visible')) {
      closeMcpJsonModal()
      return
    }
    if (settingsModal.classList.contains('visible')) {
      closeSettingsModal()
      return
    }
    if (agentLibraryModal.classList.contains('visible')) {
      if (agentEditorView.classList.contains('active')) {
        setAgentModalView('library')
      } else {
        closeAgentModal()
      }
    }
  })

  bindAgentEditorEvents()
  bindSettingsEvents()

  await refreshAgentData(loadActiveAgentPreference())
  autoResizeTextarea()
  inputTextarea.focus()
}

document.addEventListener('DOMContentLoaded', () => {
  void init().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    showError(`初始化失败: ${message}`)
  })
})
