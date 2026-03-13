import { app, shell, BrowserWindow, ipcMain, dialog } from "electron"
import { join, resolve } from "path"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"
import icon from "../../resources/icon.png?asset"
import {
  ChatResumeStore,
  type AppChatResumeSnapshot,
  type ToolLoopResumeStateSnapshot,
  type ToolLoopToolCallSnapshot
} from "./chat-resume-store"

// ── TuanZi Core Integration ────────────────────────────
// We import from the compiled CLI core. In development you can point to the
// TypeScript source via ts-node/register or pre-build with `npm run build` in
// the root project. For now we reference the compiled JS output.

let mainWindow: BrowserWindow | null = null
const activeTasks = new Map<string, AbortController>()
const chatResumeStore = new ChatResumeStore(app.getPath("userData"))
const MAX_CHAT_IMAGE_COUNT = 1
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024
const configuredShutdownTimeout = Number(process.env["TUANZI_SHUTDOWN_WAIT_MS"])
const SHUTDOWN_WAIT_TIMEOUT_MS = Number.isFinite(configuredShutdownTimeout) && configuredShutdownTimeout > 0
  ? Math.floor(configuredShutdownTimeout)
  : 2000
const SNAPSHOT_FLUSH_INTERVAL_MS = 200
const SNAPSHOT_MAX_STREAM_CHARS = 24_000
const SNAPSHOT_MAX_TOOL_CALLS = 80
const CLOSE_PERF_LOG_ENABLED = process.env["TUANZI_CLOSE_PERF_LOG"] === "1"
const CLOSE_PERF_SNAPSHOT_LOG_ENABLED = process.env["TUANZI_CLOSE_PERF_LOG_SNAPSHOT"] === "1"
const CLOSE_PERF_RESOURCE_LOG_ENABLED = process.env["TUANZI_CLOSE_PERF_LOG_RESOURCES"] === "1"
const configuredForceDestroyDelay = Number(process.env["TUANZI_CLOSE_FORCE_DESTROY_MS"])
const WINDOW_CLOSE_FORCE_DESTROY_MS = Number.isFinite(configuredForceDestroyDelay)
  ? Math.max(0, Math.floor(configuredForceDestroyDelay))
  : 1200

let shutdownDrainInProgress = false
let shutdownDrainCompleted = false
let closeForceDestroyTimer: NodeJS.Timeout | null = null

function closePerfLog(
  event: string,
  fields?: Record<string, unknown>,
  options?: { highFrequency?: boolean }
): void {
  if (!CLOSE_PERF_LOG_ENABLED) {
    return
  }
  if (options?.highFrequency && !CLOSE_PERF_SNAPSHOT_LOG_ENABLED) {
    return
  }
  const payload = fields ? ` ${JSON.stringify(fields)}` : ""
  console.log(`[close-perf] ${event}${payload}`)
}

function collectActiveResources(): Record<string, number> {
  const getResourcesInfo = (process as any).getActiveResourcesInfo as (() => string[]) | undefined
  if (typeof getResourcesInfo !== "function") {
    return {}
  }
  const resources = getResourcesInfo.call(process)
  if (!Array.isArray(resources)) {
    return {}
  }
  const counts: Record<string, number> = {}
  for (const resource of resources) {
    const key = typeof resource === "string" ? resource : String(resource)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function closePerfLogResources(event: string, fields?: Record<string, unknown>): void {
  if (!CLOSE_PERF_RESOURCE_LOG_ENABLED) {
    return
  }
  closePerfLog(event, {
    ...fields,
    resources: collectActiveResources()
  })
}

function clearCloseForceDestroyTimer(): void {
  if (!closeForceDestroyTimer) {
    return
  }
  clearTimeout(closeForceDestroyTimer)
  closeForceDestroyTimer = null
}

function scheduleCloseForceDestroy(win: BrowserWindow, reason: string): void {
  clearCloseForceDestroyTimer()
  if (WINDOW_CLOSE_FORCE_DESTROY_MS <= 0 || win.isDestroyed()) {
    return
  }
  closeForceDestroyTimer = setTimeout(() => {
    closeForceDestroyTimer = null
    if (win.isDestroyed()) {
      return
    }
    closePerfLog("window_force_destroy", {
      reason,
      timeoutMs: WINDOW_CLOSE_FORCE_DESTROY_MS,
      activeTasks: activeTasks.size
    })
    closePerfLogResources("window_force_destroy_resources", { reason })
    try {
      win.destroy()
    } catch (error) {
      closePerfLog("window_force_destroy_failed", {
        reason,
        error: toErrorMessage(error)
      })
    }
  }, WINDOW_CLOSE_FORCE_DESTROY_MS)
  if (typeof closeForceDestroyTimer.unref === "function") {
    closeForceDestroyTimer.unref()
  }
}

function abortAllActiveTasks(reason: string): number {
  let abortedCount = 0
  for (const controller of activeTasks.values()) {
    try {
      controller.abort()
      abortedCount += 1
    } catch {
      // Ignore abort failures; shutdown should continue.
    }
  }
  closePerfLog("active_tasks_aborted", {
    reason,
    abortedCount,
    remaining: activeTasks.size
  })
  return abortedCount
}

function trimPersistedStream(text: string): string {
  if (text.length <= SNAPSHOT_MAX_STREAM_CHARS) {
    return text
  }
  return text.slice(text.length - SNAPSHOT_MAX_STREAM_CHARS)
}

async function waitForActiveTasksToDrain(timeoutMs: number): Promise<{ remaining: number; elapsedMs: number }> {
  const startedAt = Date.now()
  while (activeTasks.size > 0) {
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= timeoutMs) {
      return {
        remaining: activeTasks.size,
        elapsedMs
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return {
    remaining: 0,
    elapsedMs: Date.now() - startedAt
  }
}

type GlobalSkillCategory = "file_system" | "execute_command" | "web_search"

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

interface ChatImageInput {
  name: string
  mimeType: string
  dataUrl: string
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
}

interface SkillCatalogItem {
  name: string
  description: string
  rootDir: string
  skillDir: string
  skillFile: string
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

interface AgentSavePayload {
  previousFilename?: string | null
  filename?: string | null
  name?: string | null
  avatar?: string | null
  description?: string | null
  tags?: string[]
  tools?: string[]
  prompt?: string | null
}

type LoadRuntimeConfigFn = (input: {
  workspaceRoot?: string
  approvalMode?: string
  modelOverride?: string | null
  agentOverride?: string | null
}) => unknown

type CreateToolRuntimeFn = (
  config: unknown,
  overrides?: { logger?: unknown; approvalGate?: unknown }
) => {
  registry: {
    getToolNames: () => string[]
  }
  toolContext?: {
    skillRuntime?: {
      listCatalog?: () => SkillCatalogItem[]
    }
  }
  dispose?: () => Promise<void>
}

type CreateOrchestratorFn = (
  config: unknown,
  runtime: unknown
) => {
  run: (
    input: {
      task: string
      memoryTurns?: Array<{ user: string; assistant: string }>
      resumeState?: ToolLoopResumeStateSnapshot | null
      userImages?: Array<{ dataUrl: string; mimeType: string }>
    },
    hooks?: {
      onPhaseChange?: (phase: string) => void
      onAssistantTextDelta?: (delta: string) => void
      onAssistantThinkingDelta?: (delta: string) => void
      onToolCallCompleted?: (call: ToolLoopToolCallSnapshot) => void
      onStateChange?: (state: ToolLoopResumeStateSnapshot) => void
      signal?: AbortSignal
    }
  ) => Promise<{
    summary: string
    toolCalls: Array<{
      toolName: string
      args: Record<string, unknown>
      result: { ok: boolean; data?: unknown; error?: string }
      timestamp: string
    }>
    changedFiles: string[]
    executedCommands: Array<{ command: string; exitCode: number | null }>
  }>
}

interface CoreModules {
  loadRuntimeConfig: LoadRuntimeConfigFn
  createToolRuntime: CreateToolRuntimeFn
  createOrchestrator: CreateOrchestratorFn
  listStoredAgentsSync: () => StoredAgent[]
  getStoredAgentSync: (identifier: string | null | undefined) => StoredAgent
  saveStoredAgentSync: (input: {
    filename?: string | null
    name: string
    avatar?: string | null
    description?: string | null
    tags?: string[]
    tools?: string[]
    prompt: string
  }) => StoredAgent
  deleteStoredAgentSync: (identifier: string) => void
  loadAgentBackendConfigSync: () => AgentBackendConfig
  saveAgentBackendConfigSync: (input: unknown) => AgentBackendConfig
  getSystemToolProfile: (name: string) => AgentToolProfile | null
  loadMcpConfigSync: () => McpConfigFile
  saveMcpConfigSync: (input: unknown) => McpConfigFile
  StdioMcpClient: new (settings: McpClientSettings) => McpClientLike
  RemoteMcpClient: new (settings: any) => McpClientLike
}

interface McpServerConfigEntry {
  enabled?: boolean
  type?: 'stdio' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfigEntry>
}

interface McpClientSettings {
  enabled: boolean
  type?: 'stdio' | 'remote'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env: Record<string, string>
  startupTimeoutMs: number
  requestTimeoutMs: number
}

interface McpClientLike {
  start: () => Promise<void>
  listTools: () => Promise<Array<{ name: string; description: string }>>
  stop: () => Promise<void>
}

let cachedCoreModules: CoreModules | null = null

function loadCoreModules(): CoreModules {
  const disableCache = process.env["TUANZI_DISABLE_CORE_MODULE_CACHE"] === "1"
  if (!disableCache && cachedCoreModules) {
    return cachedCoreModules
  }

  const corePath = resolve(__dirname, '../../..')
  const configMod = require(join(corePath, 'dist/config'))
  const runtimeMod = require(join(corePath, 'dist/runtime'))
  const agentStoreMod = require(join(corePath, 'dist/core/agent-store'))
  const agentToolingMod = require(join(corePath, 'dist/core/agent-tooling'))
  const mcpConfigMod = require(join(corePath, 'dist/mcp/config-store'))
  const mcpClientMod = require(join(corePath, 'dist/mcp/stdio-mcp-client'))

  const modules: CoreModules = {
    loadRuntimeConfig: configMod.loadRuntimeConfig as LoadRuntimeConfigFn,
    createToolRuntime: runtimeMod.createToolRuntime as CreateToolRuntimeFn,
    createOrchestrator: runtimeMod.createOrchestrator as CreateOrchestratorFn,
    listStoredAgentsSync: agentStoreMod.listStoredAgentsSync as () => StoredAgent[],
    getStoredAgentSync: agentStoreMod.getStoredAgentSync as (
      identifier: string | null | undefined
    ) => StoredAgent,
    saveStoredAgentSync: agentStoreMod.saveStoredAgentSync as CoreModules['saveStoredAgentSync'],
    deleteStoredAgentSync: agentStoreMod.deleteStoredAgentSync as (identifier: string) => void,
    loadAgentBackendConfigSync: agentStoreMod.loadAgentBackendConfigSync as () => AgentBackendConfig,
    saveAgentBackendConfigSync: agentStoreMod.saveAgentBackendConfigSync as (
      input: unknown
    ) => AgentBackendConfig,
    getSystemToolProfile: agentToolingMod.getSystemToolProfile as (
      name: string
    ) => AgentToolProfile | null,
    loadMcpConfigSync: mcpConfigMod.loadMcpConfigSync as () => McpConfigFile,
    saveMcpConfigSync: mcpConfigMod.saveMcpConfigSync as (input: unknown) => McpConfigFile,
    StdioMcpClient: mcpClientMod.StdioMcpClient as new (settings: McpClientSettings) => McpClientLike,
    RemoteMcpClient: require(join(corePath, 'dist/mcp/remote-mcp-client')).RemoteMcpClient as new (
      settings: any
    ) => McpClientLike
  }

  if (!disableCache) {
    cachedCoreModules = modules
  }

  return modules
}

function normalizeOptionalString(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null
  }
  const trimmed = input.trim()
  return trimmed ? trimmed : null
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null
  }
  return input as Record<string, unknown>
}

function normalizeProviderBaseUrl(rawBaseUrl: unknown): string | null {
  const baseUrl = normalizeOptionalString(rawBaseUrl)
  if (!baseUrl) {
    return null
  }
  return baseUrl.replace(/\/+$/, "")
}

function buildProviderHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-DashScope-Api-Key": apiKey,
    "X-API-Key": apiKey,
    "x-api-key": apiKey
  }
}

function isDashScopeCodingBaseUrl(rawBaseUrl: string): boolean {
  const normalized = normalizeProviderBaseUrl(rawBaseUrl)
  if (!normalized) {
    return false
  }
  try {
    const url = new URL(normalized)
    return url.hostname.toLowerCase() === "coding.dashscope.aliyuncs.com"
  } catch {
    return normalized.toLowerCase().includes("coding.dashscope.aliyuncs.com")
  }
}

async function probeProviderChatCompletions(input: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<void> {
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl)
  const apiKey = normalizeOptionalString(input.apiKey)
  const model = normalizeOptionalString(input.model)
  if (!baseUrl) {
    throw new Error("Missing provider baseUrl")
  }
  if (!apiKey) {
    throw new Error("Missing provider apiKey")
  }
  if (!model) {
    throw new Error("Missing provider model")
  }

  const endpoint = `${baseUrl}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: buildProviderHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
        stream: false
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`${response.status} ${response.statusText}${body ? ` ${body}` : ""}`.trim())
    }
  } finally {
    clearTimeout(timeout)
  }
}

function buildProviderModelEndpoints(baseUrl: string): string[] {
  const directModels = `${baseUrl}/models`
  const v1Models = `${baseUrl}/v1/models`
  const endpoints = new Set<string>()
  endpoints.add(directModels)
  if (!baseUrl.endsWith("/v1")) {
    endpoints.add(v1Models)
  }
  return [...endpoints]
}

function extractProviderModels(payload: unknown): Array<{ id: string; displayName: string; isVision: boolean }> {
  const root = asRecord(payload)
  const listSource = root && Array.isArray(root.data)
    ? root.data
    : root && Array.isArray(root.models)
      ? root.models
      : Array.isArray(payload)
        ? payload
        : []

  const output: Array<{ id: string; displayName: string; isVision: boolean }> = []
  const seen = new Set<string>()
  for (const item of listSource) {
    const raw = asRecord(item)
    const modelId =
      normalizeOptionalString(raw?.id) ??
      normalizeOptionalString(raw?.name) ??
      normalizeOptionalString(raw?.model)
    if (!modelId) {
      continue
    }
    const key = modelId.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const displayName =
      normalizeOptionalString(raw?.displayName) ??
      normalizeOptionalString(raw?.display_name) ??
      modelId
    const isVision =
      raw?.isVision === true ||
      raw?.vision === true ||
      (Array.isArray(raw?.modalities) && raw.modalities.some((item) => item === "image")) ||
      (Array.isArray(raw?.input_modalities) && raw.input_modalities.some((item) => item === "image"))

    output.push({
      id: modelId,
      displayName,
      isVision
    })
  }
  return output
}

async function requestProviderModels(input: {
  baseUrl: string
  apiKey: string
}): Promise<Array<{ id: string; displayName: string; isVision: boolean }>> {
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl)
  const apiKey = normalizeOptionalString(input.apiKey)
  if (!baseUrl) {
    throw new Error("Missing provider baseUrl")
  }
  if (!apiKey) {
    throw new Error("Missing provider apiKey")
  }

  const endpoints = buildProviderModelEndpoints(baseUrl)
  const headers = buildProviderHeaders(apiKey)

  let lastError: Error | null = null

  for (const endpoint of endpoints) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers,
        signal: controller.signal
      })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`${response.status} ${response.statusText}${body ? ` ${body}` : ""}`.trim())
      }
      const payload = (await response.json()) as unknown
      return extractProviderModels(payload)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError ?? new Error("Provider model request failed")
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function cloneToolCallSnapshot(call: ToolLoopToolCallSnapshot): ToolLoopToolCallSnapshot {
  return cloneJson(call)
}

function cloneToolCallSnapshots(calls: ToolLoopToolCallSnapshot[]): ToolLoopToolCallSnapshot[] {
  return calls.map((call) => cloneToolCallSnapshot(call))
}

function cloneResumeState(
  resumeState: ToolLoopResumeStateSnapshot | null
): ToolLoopResumeStateSnapshot | null {
  return resumeState ? cloneJson(resumeState) : null
}

function toRendererToolCall(call: ToolLoopToolCallSnapshot) {
  return {
    toolName: call.name,
    args: cloneJson(call.args),
    result: cloneJson(call.result),
    timestamp: new Date().toISOString()
  }
}

function loadMatchingChatResumeSnapshot(sessionId: string, workspace: string): AppChatResumeSnapshot | null {
  const snapshot = chatResumeStore.load()
  if (!snapshot) {
    return null
  }
  if (snapshot.sessionId !== sessionId || snapshot.workspace !== workspace) {
    return null
  }
  return snapshot
}

function buildChatResumeSnapshot(input: {
  taskId: string
  sessionId: string
  workspace: string
  message: string
  history: Array<{ user: string; assistant: string }>
  agentId: string | null
  thinkingEnabled: boolean
  streamedText: string
  streamedThinking: string
  toolCalls: ToolLoopToolCallSnapshot[]
  resumeState: ToolLoopResumeStateSnapshot | null
}): AppChatResumeSnapshot {
  return {
    version: 1,
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    message: input.message,
    history: cloneJson(input.history),
    agentId: input.agentId,
    thinkingEnabled: input.thinkingEnabled,
    streamedText: input.streamedText,
    streamedThinking: input.streamedThinking,
    toolCalls: cloneToolCallSnapshots(input.toolCalls),
    resumeState: cloneResumeState(input.resumeState),
    updatedAt: new Date().toISOString()
  }
}

function normalizeChatImages(input: unknown): ChatImageInput[] {
  if (!Array.isArray(input) || input.length === 0) {
    return []
  }
  if (input.length > MAX_CHAT_IMAGE_COUNT) {
    throw new Error(`Only ${MAX_CHAT_IMAGE_COUNT} image is supported per message.`)
  }

  const output: ChatImageInput[] = []
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid image payload.")
    }
    const record = item as Record<string, unknown>
    const name = normalizeOptionalString(record.name) ?? "image"
    const mimeType = normalizeOptionalString(record.mimeType)?.toLowerCase() ?? ""
    const dataUrl = normalizeOptionalString(record.dataUrl)
    if (!mimeType.startsWith("image/")) {
      throw new Error("Only image uploads are supported.")
    }
    if (!dataUrl) {
      throw new Error("Missing image data.")
    }

    const headerMatch = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i)
    if (!headerMatch) {
      throw new Error("Invalid image format. Please upload a standard image file.")
    }
    const headerMimeType = headerMatch[1].toLowerCase()
    if (headerMimeType !== mimeType) {
      throw new Error("Image MIME type mismatch.")
    }

    const byteSize = estimateDataUrlByteSize(dataUrl)
    if (byteSize === null) {
      throw new Error("Invalid base64 image content.")
    }
    if (byteSize > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(`Image is too large. Max size is ${Math.floor(MAX_CHAT_IMAGE_BYTES / (1024 * 1024))} MB.`)
    }

    output.push({
      name,
      mimeType,
      dataUrl
    })
  }
  return output
}

function estimateDataUrlByteSize(dataUrl: string): number | null {
  const commaIndex = dataUrl.indexOf(",")
  if (commaIndex < 0) {
    return null
  }
  const base64 = dataUrl.slice(commaIndex + 1).trim()
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    return null
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function getActiveProvider(config: AgentBackendConfig): ProviderConfig | null {
  const activeProviderId = normalizeOptionalString(config.activeProviderId)
  if (!activeProviderId) {
    return null
  }
  const providers = Array.isArray(config.providers) ? config.providers : []
  const provider = providers.find((item) => item.id === activeProviderId) ?? null
  if (!provider || provider.isEnabled === false) {
    return null
  }
  return provider
}

function supportsVisionForActiveModel(config: AgentBackendConfig): boolean {
  const provider = getActiveProvider(config)
  if (!provider) {
    return false
  }
  const activeModelId = normalizeOptionalString(provider.model)
  if (!activeModelId) {
    return false
  }
  const model = provider.models.find((item) => item.id.toLowerCase() === activeModelId.toLowerCase()) ?? null
  if (!model || model.enabled === false) {
    return false
  }
  return model.isVision === true
}

function resolveWorkspaceFromInput(raw: unknown): string {
  const workspace = normalizeOptionalString(raw)
  return resolve(workspace ?? process.cwd())
}

function collectWorkspaceCandidates(workspace: unknown, candidates: unknown): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  const pushCandidate = (value: unknown): void => {
    const normalized = normalizeOptionalString(value)
    if (!normalized) {
      return
    }
    const resolved = resolve(normalized)
    const key = resolved.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    output.push(resolved)
  }

  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      pushCandidate(candidate)
    }
  }
  pushCandidate(workspace)

  if (output.length === 0) {
    output.push(resolve(process.cwd()))
  }
  return output
}

function fallbackToolCategory(name: string): GlobalSkillCategory {
  if (name === 'search_web' || name === 'fetch_url') {
    return 'web_search'
  }
  if (name === 'run_command' || name === 'browser_action') {
    return 'execute_command'
  }
  return 'file_system'
}

async function disposeRuntimeSafe(runtime: { dispose?: () => Promise<void> } | null | undefined): Promise<void> {
  if (!runtime || typeof runtime.dispose !== "function") {
    return
  }
  try {
    await runtime.dispose()
  } catch {
    // Ignore runtime disposal errors during UI-driven metadata operations.
  }
}

function normalizeMcpServerId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function normalizeMcpServers(input: unknown): Record<string, McpServerConfigEntry> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  const output: Record<string, McpServerConfigEntry> = {}
  for (const [rawId, rawServer] of Object.entries(input as Record<string, unknown>)) {
    const serverId = normalizeMcpServerId(rawId)
    if (!serverId) continue
    if (!rawServer || typeof rawServer !== 'object' || Array.isArray(rawServer)) continue

    const record = rawServer as Record<string, unknown>
    const type = (typeof record.type === 'string' ? record.type : 'stdio') as 'stdio' | 'remote'
    const enabled = typeof record.enabled === 'boolean' ? record.enabled : true

    if (type === 'remote') {
      const url = typeof record.url === 'string' ? record.url.trim() : ''
      if (!url) continue
      output[serverId] = {
        type: 'remote',
        enabled,
        url,
        headers:
          record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)
            ? (record.headers as Record<string, string>)
            : {}
      }
    } else {
      const command = typeof record.command === 'string' ? record.command.trim() : ''
      if (!command) continue
      const args = Array.isArray(record.args)
        ? record.args
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
        : []
      const env =
        record.env && typeof record.env === 'object' && !Array.isArray(record.env)
          ? Object.fromEntries(
            Object.entries(record.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
          : undefined
      output[serverId] = {
        type: 'stdio',
        enabled,
        command,
        args,
        ...(env && Object.keys(env).length > 0 ? { env } : {})
      }
    }
  }
  return output
}

function createWindow(): void {
  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(isWindows ? { frame: false } : {}),
    ...(isMac ? { titleBarStyle: 'hidden' } : {}),
    backgroundColor: '#FFFFFF',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  mainWindow.on("close", () => {
    closePerfLog("window_close_event", { activeTasks: activeTasks.size })
    closePerfLogResources("window_close_event_resources", { activeTasks: activeTasks.size })
    scheduleCloseForceDestroy(mainWindow!, "window_close_event")
  })
  mainWindow.on("closed", () => {
    clearCloseForceDestroyTimer()
    closePerfLog("window_closed_event", { activeTasks: activeTasks.size })
    closePerfLogResources("window_closed_event_resources", { activeTasks: activeTasks.size })
    mainWindow = null
  })
  mainWindow.webContents.on("destroyed", () => {
    closePerfLog("webcontents_destroyed")
    closePerfLogResources("webcontents_destroyed_resources")
  })

  const emitWindowMaximizedState = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }
    mainWindow.webContents.send('window:maximized-changed', {
      maximized: mainWindow.isMaximized()
    })
  }
  mainWindow.on('maximize', emitWindowMaximizedState)
  mainWindow.on('unmaximize', emitWindowMaximizedState)
  mainWindow.webContents.on('did-finish-load', emitWindowMaximizedState)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── IPC Handlers ───────────────────────────────────────

function getSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed()) {
    return null
  }
  return win
}

ipcMain.handle('window:minimize', async (event) => {
  const win = getSenderWindow(event.sender)
  if (!win) {
    return { ok: false, error: 'Window unavailable' }
  }
  win.minimize()
  return { ok: true }
})

ipcMain.handle('window:toggleMaximize', async (event) => {
  const win = getSenderWindow(event.sender)
  if (!win) {
    return { ok: false, error: 'Window unavailable' }
  }
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
  return { ok: true, maximized: win.isMaximized() }
})

ipcMain.handle('window:close', async (event) => {
  const win = getSenderWindow(event.sender)
  if (!win) {
    return { ok: false, error: 'Window unavailable' }
  }
  closePerfLog("close_requested", { activeTasks: activeTasks.size })
  closePerfLogResources("close_requested_resources", { activeTasks: activeTasks.size })
  
  // Immediately hide the window to provide instant visual feedback.
  // The actual cleanup will continue behind the scenes.
  if (!win.isDestroyed()) {
    win.hide()
  }

  if (activeTasks.size > 0) {
    abortAllActiveTasks('window_close')
    // Give tasks a short window to acknowledge the abort before closing.
    const drainResult = await waitForActiveTasksToDrain(Math.min(SHUTDOWN_WAIT_TIMEOUT_MS, 400))
    closePerfLog('window_close_drain', {
      remaining: drainResult.remaining,
      elapsedMs: drainResult.elapsedMs
    })
  }
  closePerfLog("close_calling_win_close")
  scheduleCloseForceDestroy(win, "window_close_ipc")
  if (!win.isDestroyed()) {
    win.close()
  }
  closePerfLog("close_returned_from_win_close")
  closePerfLogResources("close_returned_from_win_close_resources", { activeTasks: activeTasks.size })
  return { ok: true }
})

ipcMain.handle('window:isMaximized', async (event) => {
  const win = getSenderWindow(event.sender)
  if (!win) {
    return { ok: false, error: 'Window unavailable' }
  }
  return { ok: true, maximized: win.isMaximized() }
})

ipcMain.handle('dialog:selectWorkspace', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

/**
 * Core chat handler — receives a user message and workspace path, streams
 * the Agent response back to the renderer via IPC events.
 *
 * We dynamically import the core modules so the main process can load them
 * after Electron is ready. This avoids import-order issues with ESM/CJS.
 */
async function runChatTask(
  webContents: Electron.WebContents,
    payload: {
      taskId?: string
      sessionId?: string
      message: string
      images?: ChatImageInput[]
      workspace: string
      history: Array<{ user: string; assistant: string }>
      agentId?: string | null
      thinking?: boolean
      resumeState?: ToolLoopResumeStateSnapshot | null
  }
) {
  const taskId = payload.taskId || Date.now().toString(36)
  const sessionId = normalizeOptionalString(payload.sessionId) ?? "default-session"
  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  let flushPendingSnapshots: (() => Promise<void>) | null = null
  let runtimeToDispose: { dispose?: () => Promise<void> } | null = null

  try {
    const { loadRuntimeConfig, createToolRuntime, createOrchestrator } = loadCoreModules()

    const runtimeConfig = loadRuntimeConfig({
      workspaceRoot: payload.workspace || process.cwd(),
      approvalMode: "auto",
      agentOverride: normalizeOptionalString(payload.agentId ?? null)
    }) as any
    const images = normalizeChatImages(payload.images)
    const effectiveMessage = normalizeOptionalString(payload.message) ?? (
      images.length > 0 ? "请根据我上传的图片进行分析并回答。" : ""
    )
    if (!effectiveMessage) {
      return {
        ok: false,
        taskId,
        error: "Message cannot be empty."
      }
    }
    if (
      images.length > 0 &&
      !supportsVisionForActiveModel(runtimeConfig.agentBackend.config as AgentBackendConfig)
    ) {
      return {
        ok: false,
        taskId,
        error: "当前模型不支持图像理解，请切换到支持图像理解的模型后重试。"
      }
    }

    if (payload.thinking) {
      runtimeConfig.agentSettings.modelRequest.thinking.type = "enabled"
      if (!runtimeConfig.agentSettings.modelRequest.thinking.budgetTokens) {
        runtimeConfig.agentSettings.modelRequest.thinking.budgetTokens = 4000
      }
    } else {
      runtimeConfig.agentSettings.modelRequest.thinking.type = "disabled"
    }

    const ipcLogger = {
      info: (msg: string): void => {
        webContents.send("chat:log", { taskId, level: "info", message: msg })
      },
      warn: (msg: string): void => {
        webContents.send("chat:log", { taskId, level: "warn", message: msg })
      },
      error: (msg: string): void => {
        webContents.send("chat:log", { taskId, level: "error", message: msg })
      }
    }

    const autoApprovalGate = {
      approve: async (): Promise<{ approved: boolean }> => ({ approved: true })
    }

    const runtime = createToolRuntime(runtimeConfig, {
      logger: ipcLogger,
      approvalGate: autoApprovalGate
    }) as Record<string, unknown>
    runtimeToDispose = runtime as { dispose?: () => Promise<void> }
    const orchestrator = createOrchestrator(runtimeConfig, runtime)
    const memoryTurns = (payload.history || []).slice(-10)

    let streamedText = payload.resumeState?.partialAssistantMessage?.content ?? ""
    let streamedThinking = payload.resumeState?.partialAssistantMessage?.thinking ?? ""
    const completedToolCalls = cloneToolCallSnapshots(payload.resumeState?.toolCalls ?? [])
    let latestResumeState = cloneResumeState(payload.resumeState ?? null)
    let pendingSnapshot: AppChatResumeSnapshot | null = null
    let snapshotFlushTimer: NodeJS.Timeout | null = null
    let snapshotWriteChain: Promise<void> = Promise.resolve()

    const flushSnapshotNow = (): Promise<void> => {
      const snapshot = pendingSnapshot
      pendingSnapshot = null
      if (!snapshot) {
        return Promise.resolve()
      }
      const startedAt = Date.now()
      const summary = {
        taskId,
        messageLength: snapshot.message.length,
        streamedTextLength: snapshot.streamedText.length,
        streamedThinkingLength: snapshot.streamedThinking.length,
        toolCallCount: snapshot.toolCalls.length
      }
      snapshotWriteChain = snapshotWriteChain
        .then(async () => {
          const byteSize = await chatResumeStore.save(snapshot)
          closePerfLog("snapshot_saved", {
            ...summary,
            byteSize,
            elapsedMs: Date.now() - startedAt
          }, { highFrequency: true })
        })
        .catch((error) => {
          console.warn(`[close-perf] Failed to persist chat snapshot: ${toErrorMessage(error)}`)
        })
      return snapshotWriteChain.finally(() => {
        if (pendingSnapshot) {
          scheduleSnapshotFlush(true)
        }
      })
    }

    const scheduleSnapshotFlush = (immediate: boolean): void => {
      if (snapshotFlushTimer) {
        if (!immediate) {
          return
        }
        clearTimeout(snapshotFlushTimer)
        snapshotFlushTimer = null
      }
      const delay = immediate ? 0 : SNAPSHOT_FLUSH_INTERVAL_MS
      snapshotFlushTimer = setTimeout(() => {
        snapshotFlushTimer = null
        void flushSnapshotNow()
      }, delay)
    }

    flushPendingSnapshots = async (): Promise<void> => {
      if (snapshotFlushTimer) {
        clearTimeout(snapshotFlushTimer)
        snapshotFlushTimer = null
      }
      await flushSnapshotNow()
      await snapshotWriteChain
      while (pendingSnapshot) {
        await flushSnapshotNow()
        await snapshotWriteChain
      }
    }

    const persistSnapshot = (): AppChatResumeSnapshot => {
      const snapshot = buildChatResumeSnapshot({
        taskId,
        sessionId,
        workspace: payload.workspace,
        message: effectiveMessage,
        history: memoryTurns,
        agentId: normalizeOptionalString(payload.agentId ?? null),
        thinkingEnabled: payload.thinking === true,
        streamedText,
        streamedThinking,
        toolCalls: completedToolCalls,
        resumeState: latestResumeState
      })
      const persistedSnapshot: AppChatResumeSnapshot = {
        ...snapshot,
        streamedText: trimPersistedStream(snapshot.streamedText),
        streamedThinking: trimPersistedStream(snapshot.streamedThinking),
        toolCalls:
          snapshot.toolCalls.length > SNAPSHOT_MAX_TOOL_CALLS
            ? snapshot.toolCalls.slice(snapshot.toolCalls.length - SNAPSHOT_MAX_TOOL_CALLS)
            : snapshot.toolCalls
      }
      pendingSnapshot = persistedSnapshot
      scheduleSnapshotFlush(false)
      return persistedSnapshot
    }

    persistSnapshot()

    const result = await orchestrator.run(
      {
        task: effectiveMessage,
        memoryTurns,
        userImages: images.map((item) => ({
          dataUrl: item.dataUrl,
          mimeType: item.mimeType
        })),
        resumeState: payload.resumeState ?? null
      },
      {
        signal: controller.signal,
        onPhaseChange: (phase: string) => {
          webContents.send("chat:phase", { taskId, phase })
        },
        onAssistantTextDelta: (delta: string) => {
          if (!delta) {
            return
          }
          streamedText += delta
          persistSnapshot()
          webContents.send("chat:delta", { taskId, delta })
        },
        onAssistantThinkingDelta: (delta: string) => {
          if (!delta) {
            return
          }
          streamedThinking += delta
          persistSnapshot()
          webContents.send("chat:thinking", { taskId, delta })
        },
        onToolCallCompleted: (call: ToolLoopToolCallSnapshot) => {
          completedToolCalls.push(cloneToolCallSnapshot(call))
          persistSnapshot()
          webContents.send("chat:toolCallCompleted", {
            taskId,
            toolCall: toRendererToolCall(call)
          })
        },
        onStateChange: (resumeState: ToolLoopResumeStateSnapshot) => {
          latestResumeState = cloneResumeState(resumeState)
          persistSnapshot()
        }
      }
    )

    if (result.toolCalls && result.toolCalls.length > 0) {
      webContents.send("chat:toolCalls", { taskId, toolCalls: result.toolCalls })
    }

    if (flushPendingSnapshots) {
      await flushPendingSnapshots()
    }
    await chatResumeStore.clear()

    return {
      ok: true,
      taskId,
      summary: streamedText || result.summary,
      toolCalls: result.toolCalls || [],
      changedFiles: result.changedFiles || [],
      executedCommands: result.executedCommands || []
    }
  } catch (error) {
    // During shutdown, skip snapshot flushing to avoid blocking the quit sequence.
    if (flushPendingSnapshots && !shutdownDrainInProgress && !shutdownDrainCompleted) {
      await flushPendingSnapshots()
    }
    const message = toErrorMessage(error)
    if (
      message === "Interrupted by user" ||
      message === "Model stream interrupted by user." ||
      (error instanceof Error && error.name === "AbortError") ||
      message.includes("The operation was aborted") ||
      message.includes("This operation was aborted")
    ) {
      const snapshot = loadMatchingChatResumeSnapshot(sessionId, payload.workspace)
      return {
        ok: false,
        taskId,
        error: "Task interrupted by user",
        interrupted: true,
        resumeSnapshot: snapshot
      }
    }
    return { ok: false, taskId, error: message }
  } finally {
    // Crucial: remove from activeTasks immediately to let the close handler proceed.
    activeTasks.delete(taskId)
    if (runtimeToDispose && typeof runtimeToDispose.dispose === "function") {
      try {
        await runtimeToDispose.dispose()
      } catch {
        // Ignore disposal errors.
      }
    }
  }
}

ipcMain.handle(
  'chat:sendMessage',
  async (
    event,
    payload: {
      taskId?: string
      sessionId?: string
      message: string
      images?: ChatImageInput[]
      workspace: string
      history: Array<{ user: string; assistant: string }>
      agentId?: string | null
      thinking?: boolean
    }
  ) => {
    return runChatTask(event.sender, payload)
  }
)

ipcMain.handle(
  'chat:getResumeState',
  async (_event, payload: { sessionId?: string; workspace: string }) => {
    const sessionId = normalizeOptionalString(payload.sessionId) ?? 'default-session'
    return {
      ok: true,
      resumeSnapshot: loadMatchingChatResumeSnapshot(sessionId, payload.workspace)
    }
  }
)

ipcMain.handle('chat:stopMessage', async (_event, payload: { taskId: string }) => {
  console.log(`[IPC] Received chat:stopMessage for taskId=${payload.taskId}`)
  const controller = activeTasks.get(payload.taskId)
  if (controller) {
    console.log(`[IPC] Aborting controller for taskId=${payload.taskId}`)
    controller.abort()
    return { ok: true }
  }
  console.log(`[IPC] Task not found for taskId=${payload.taskId}`)
  return { ok: false, error: 'Task not found or already completed' }
})

ipcMain.handle('agent:list', async () => {
  try {
    const { listStoredAgentsSync } = loadCoreModules()
    return {
      ok: true,
      agents: listStoredAgentsSync()
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('agent:get', async (_event, payload: { id?: string | null }) => {
  try {
    const { getStoredAgentSync } = loadCoreModules()
    return {
      ok: true,
      agent: getStoredAgentSync(payload?.id ?? 'default')
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('agent:save', async (_event, payload: AgentSavePayload) => {
  try {
    const { saveStoredAgentSync, deleteStoredAgentSync } = loadCoreModules()
    const name = normalizeOptionalString(payload?.name)
    const prompt = normalizeOptionalString(payload?.prompt)
    if (!name) {
      return {
        ok: false,
        error: 'Agent 名称不能为空'
      }
    }
    if (!prompt) {
      return {
        ok: false,
        error: '系统提示词不能为空'
      }
    }

    const saved = saveStoredAgentSync({
      filename: normalizeOptionalString(payload?.filename ?? null),
      name,
      avatar: normalizeOptionalString(payload?.avatar ?? null),
      description: normalizeOptionalString(payload?.description ?? null),
      tags: Array.isArray(payload?.tags) ? payload.tags : [],
      tools: Array.isArray(payload?.tools) ? payload.tools : [],
      prompt
    })

    const previousFilename = normalizeOptionalString(payload?.previousFilename ?? null)
    if (
      previousFilename &&
      previousFilename.toLowerCase() !== saved.filename.toLowerCase() &&
      previousFilename.toLowerCase() !== 'default.md'
    ) {
      try {
        deleteStoredAgentSync(previousFilename)
      } catch {
        // ignore rename cleanup errors and keep the saved agent as source of truth
      }
    }

    return {
      ok: true,
      agent: saved
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('agent:delete', async (_event, payload: { id?: string | null }) => {
  try {
    const { deleteStoredAgentSync } = loadCoreModules()
    const id = normalizeOptionalString(payload?.id ?? null)
    if (!id) {
      return {
        ok: false,
        error: '缺少 Agent 标识'
      }
    }
    deleteStoredAgentSync(id)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('agent-config:get', async () => {
  try {
    const { loadAgentBackendConfigSync } = loadCoreModules()
    return {
      ok: true,
      config: loadAgentBackendConfigSync()
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('agent-config:save', async (_event, payload: unknown) => {
  try {
    const { saveAgentBackendConfigSync } = loadCoreModules()
    return {
      ok: true,
      config: saveAgentBackendConfigSync(payload)
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle(
  "agent-config:testProviderConnection",
  async (_event, payload: { type?: string; baseUrl?: string; apiKey?: string; model?: string }) => {
    try {
      const baseUrl = payload?.baseUrl ?? ""
      const apiKey = payload?.apiKey ?? ""
      const model = payload?.model ?? ""
      try {
        await requestProviderModels({
          baseUrl,
          apiKey
        })
        return {
          ok: true,
          reachable: true,
          message: "Connection successful"
        }
      } catch (modelProbeError) {
        const normalizedModel = normalizeOptionalString(model)
        if (!normalizedModel) {
          throw modelProbeError
        }

        try {
          await probeProviderChatCompletions({
            baseUrl,
            apiKey,
            model: normalizedModel
          })
          return {
            ok: true,
            reachable: true,
            message: "Connected via chat/completions (this provider may not expose /models)."
          }
        } catch (chatProbeError) {
          const modelErrorText = toErrorMessage(modelProbeError)
          const chatErrorText = toErrorMessage(chatProbeError)
          if (modelErrorText === chatErrorText) {
            throw new Error(modelErrorText)
          }
          throw new Error(
            `Model list probe failed: ${modelErrorText}\nChat probe failed: ${chatErrorText}`
          )
        }
      }
    } catch (error) {
      return {
        ok: false,
        reachable: false,
        error: toErrorMessage(error)
      }
    }
  }
)

ipcMain.handle(
  "agent-config:fetchProviderModels",
  async (_event, payload: { type?: string; baseUrl?: string; apiKey?: string; model?: string }) => {
    try {
      const models = await requestProviderModels({
        baseUrl: payload?.baseUrl ?? "",
        apiKey: payload?.apiKey ?? ""
      })
      return {
        ok: true,
        models
      }
    } catch (error) {
      if (isDashScopeCodingBaseUrl(payload?.baseUrl ?? "")) {
        return {
          ok: true,
          models: [],
          message: "DashScope Coding endpoint does not expose /models. Please add model IDs manually."
        }
      }
      return {
        ok: false,
        error: toErrorMessage(error)
      }
    }
  }
)

ipcMain.handle('agent:listTools', async (_event, payload: { workspace?: string | null }) => {
  let runtime: ReturnType<CreateToolRuntimeFn> | null = null
  try {
    const { loadRuntimeConfig, createToolRuntime, getSystemToolProfile } = loadCoreModules()
    const runtimeConfig = loadRuntimeConfig({
      workspaceRoot: resolveWorkspaceFromInput(payload?.workspace),
      approvalMode: 'auto'
    })
    runtime = createToolRuntime(runtimeConfig)
    const toolNames = runtime.registry.getToolNames()
    const tools: AgentToolProfile[] = toolNames.map((name) => {
      const profile = getSystemToolProfile(name)
      return {
        name,
        category: profile?.category ?? fallbackToolCategory(name),
        prompt: profile?.prompt ?? ''
      }
    })
    return {
      ok: true,
      tools
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  } finally {
    await disposeRuntimeSafe(runtime)
  }
})

ipcMain.handle(
  'skills:list',
  async (
    _event,
    payload: { workspace?: string | null; workspaceCandidates?: Array<string | null | undefined> }
  ) => {
  const runtimes: Array<{ dispose?: () => Promise<void> }> = []
  try {
    const { loadRuntimeConfig, createToolRuntime } = loadCoreModules()
    const workspaceCandidates = collectWorkspaceCandidates(payload?.workspace, payload?.workspaceCandidates)
    const skillMap = new Map<string, SkillCatalogItem>()

    for (const workspaceRoot of workspaceCandidates) {
      const runtimeConfig = loadRuntimeConfig({
        workspaceRoot: resolveWorkspaceFromInput(workspaceRoot),
        approvalMode: 'auto'
      })
      const runtime = createToolRuntime(runtimeConfig)
      runtimes.push(runtime)
      const skillRuntime = runtime.toolContext?.skillRuntime
      const skills =
        skillRuntime && typeof skillRuntime.listCatalog === 'function' ? skillRuntime.listCatalog() : []
      for (const skill of skills) {
        const dedupeKey = skill.skillDir.toLowerCase()
        if (!skillMap.has(dedupeKey)) {
          skillMap.set(dedupeKey, skill)
        }
      }
    }

    const skills = [...skillMap.values()].sort((left, right) => left.name.localeCompare(right.name))
    return {
      ok: true,
      skills
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => disposeRuntimeSafe(runtime)))
  }
})

async function probeMcpServers(
  servers: Record<string, McpServerConfigEntry>,
  workspace?: string | null
): Promise<
  Array<{
    serverId: string
    enabled: boolean
    command: string
    args: string[]
    env: Record<string, string>
    status: 'online' | 'offline' | 'error'
    error?: string
    tools: Array<{ name: string; description: string; namespacedName: string }>
  }>
> {
  const {
    loadRuntimeConfig,
    StdioMcpClient,
    RemoteMcpClient
  } = loadCoreModules()

  const runtimeConfig = loadRuntimeConfig({
    workspaceRoot: resolveWorkspaceFromInput(workspace),
    approvalMode: 'auto'
  }) as {
    agentSettings?: { mcp?: { startupTimeoutMs?: number; requestTimeoutMs?: number } }
  }
  // npx -y may need to download packages on first run; use generous defaults.
  const startupTimeoutMs = runtimeConfig.agentSettings?.mcp?.startupTimeoutMs ?? 30_000
  const requestTimeoutMs = runtimeConfig.agentSettings?.mcp?.requestTimeoutMs ?? 30_000

  const entries = Object.entries(servers)
  const results: Array<{
    serverId: string
    enabled: boolean
    command: string
    args: string[]
    env: Record<string, string>
    status: 'online' | 'offline' | 'error'
    error?: string
    tools: Array<{ name: string; description: string; namespacedName: string }>
  }> = []

  for (const [serverId, server] of entries) {
    const enabled = server.enabled !== false
    const item = {
      serverId,
      enabled,
      command: server.command || server.url || '',
      args: server.args || [],
      env: server.env ?? {},
      status: 'offline' as 'online' | 'offline' | 'error',
      tools: [] as Array<{ name: string; description: string; namespacedName: string }>,
      error: undefined as string | undefined
    }

    if (!enabled) {
      results.push(item)
      continue
    }

    const client =
      server.type === 'remote'
        ? new (RemoteMcpClient as any)({
          url: server.url,
          headers: server.headers,
          requestTimeoutMs
        })
        : new StdioMcpClient({
          enabled: true,
          command: server.command || '',
          args: server.args || [],
          env: server.env ?? {},
          startupTimeoutMs,
          requestTimeoutMs
        })

    try {
      await client.start()
      const tools = await client.listTools()
      item.status = 'online'
      item.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        namespacedName: `mcp__${serverId}__${tool.name}`
      }))
    } catch (error) {
      item.status = 'error'
      item.error = toErrorMessage(error)
    } finally {
      try {
        await client.stop()
      } catch {
        // ignore stop errors
      }
    }

    results.push(item)
  }

  return results
}

ipcMain.handle('mcp:dashboard:get', async (_event, payload: { workspace?: string | null }) => {
  try {
    const { loadMcpConfigSync } = loadCoreModules()
    const config = loadMcpConfigSync()
    const servers = normalizeMcpServers(config.mcpServers)
    const cards = await probeMcpServers(servers, payload?.workspace)
    return {
      ok: true,
      mcp: {
        servers: cards
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('mcp:dashboard:mergeJson', async (_event, payload: { jsonText?: string | null }) => {
  try {
    const { loadMcpConfigSync, saveMcpConfigSync } = loadCoreModules()
    const rawText = typeof payload?.jsonText === 'string' ? payload.jsonText.trim() : ''
    if (!rawText) {
      return {
        ok: false,
        error: '请输入有效的 JSON 配置'
      }
    }

    const parsed = JSON.parse(rawText) as unknown
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
    if (!record) {
      return {
        ok: false,
        error: 'JSON 顶层必须是对象'
      }
    }

    const incomingRaw = record.mcpServers && typeof record.mcpServers === 'object'
      ? record.mcpServers
      : record
    const incoming = normalizeMcpServers(incomingRaw)
    if (Object.keys(incoming).length === 0) {
      return {
        ok: false,
        error: '未发现可用的 mcpServers 配置'
      }
    }

    const current = loadMcpConfigSync()
    const merged = {
      mcpServers: {
        ...current.mcpServers,
        ...incoming
      }
    }
    saveMcpConfigSync(merged)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle(
  'mcp:dashboard:setServerEnabled',
  async (_event, payload: { serverId?: string | null; enabled?: boolean }) => {
    try {
      const { loadMcpConfigSync, saveMcpConfigSync } = loadCoreModules()
      const serverId = normalizeMcpServerId(typeof payload?.serverId === 'string' ? payload.serverId : '')
      if (!serverId) {
        return {
          ok: false,
          error: '缺少 serverId'
        }
      }
      const enabled = payload?.enabled === true
      const config = loadMcpConfigSync()
      if (!config.mcpServers[serverId]) {
        return {
          ok: false,
          error: `找不到 MCP Server: ${serverId}`
        }
      }
      config.mcpServers[serverId] = {
        ...config.mcpServers[serverId],
        enabled
      }
      saveMcpConfigSync(config)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error)
      }
    }
  }
)

// Backward-compatible wrappers used by older renderer code.
ipcMain.handle('workspace:mcp:get', async () => {
  try {
    const { loadMcpConfigSync } = loadCoreModules()
    const config = loadMcpConfigSync()
    const servers = normalizeMcpServers(config.mcpServers)
    const firstServerId = Object.keys(servers)[0] ?? ''
    const first = firstServerId ? servers[firstServerId] : null
    return {
      ok: true,
      mcp: {
        enabled: Boolean(first && first.enabled !== false),
        command: first?.command ?? '',
        args: first?.args ?? [],
        serverId: firstServerId
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

ipcMain.handle('workspace:mcp:save', async (_event, payload: { mcp?: Record<string, unknown> }) => {
  try {
    const { saveMcpConfigSync } = loadCoreModules()
    const mcp = payload?.mcp && typeof payload.mcp === 'object' ? payload.mcp : {}
    const enabled = mcp.enabled === true
    const command = typeof mcp.command === 'string' ? mcp.command.trim() : ''
    const args = Array.isArray(mcp.args)
      ? mcp.args.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : []
    const serverId = normalizeMcpServerId(typeof mcp.serverId === 'string' ? mcp.serverId : 'default') || 'default'
    if (!enabled || !command) {
      saveMcpConfigSync({ mcpServers: {} })
      return { ok: true }
    }
    saveMcpConfigSync({
      mcpServers: {
        [serverId]: {
          enabled: true,
          command,
          args
        }
      }
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error)
    }
  }
})

// ── App Lifecycle ──────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.tuanzi.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closePerfLog("window_all_closed", {
    platform: process.platform,
    activeTasks: activeTasks.size
  })
  closePerfLogResources("window_all_closed_resources", {
    platform: process.platform,
    activeTasks: activeTasks.size
  })
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  closePerfLog("before_quit", {
    activeTasks: activeTasks.size,
    shutdownDrainInProgress,
    shutdownDrainCompleted
  })
  closePerfLogResources("before_quit_resources", {
    activeTasks: activeTasks.size,
    shutdownDrainInProgress,
    shutdownDrainCompleted
  })
  if (shutdownDrainCompleted || activeTasks.size === 0) {
    shutdownDrainCompleted = true
    closePerfLog("before_quit_fast_path", { activeTasks: activeTasks.size })
    closePerfLogResources("before_quit_fast_path_resources", { activeTasks: activeTasks.size })
    return
  }

  if (shutdownDrainInProgress) {
    event.preventDefault()
    closePerfLog("before_quit_reentrant_blocked", { activeTasks: activeTasks.size })
    return
  }

  shutdownDrainInProgress = true
  event.preventDefault()
  abortAllActiveTasks('before_quit')

  void waitForActiveTasksToDrain(SHUTDOWN_WAIT_TIMEOUT_MS)
    .then(({ remaining, elapsedMs }) => {
      if (remaining > 0) {
        console.warn(
          `[close-perf] Forced quit with ${remaining} active task(s) after ${elapsedMs}ms drain timeout.`
        )
      }
    })
    .finally(() => {
      shutdownDrainInProgress = false
      shutdownDrainCompleted = true
      closePerfLog("before_quit_drain_done", { activeTasks: activeTasks.size })
      closePerfLogResources("before_quit_drain_done_resources", { activeTasks: activeTasks.size })
      app.quit()
    })
})

app.on("will-quit", () => {
  clearCloseForceDestroyTimer()
  closePerfLog("will_quit", { activeTasks: activeTasks.size })
  closePerfLogResources("will_quit_resources", { activeTasks: activeTasks.size })
})

app.on("quit", (_event, exitCode) => {
  clearCloseForceDestroyTimer()
  closePerfLog("quit", { exitCode, activeTasks: activeTasks.size })
  closePerfLogResources("quit_resources", { exitCode, activeTasks: activeTasks.size })
})

