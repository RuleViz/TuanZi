import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type {
  AgentBackendConfig,
  ChatImageInput,
  ProviderConfig,
  ProviderModelItem,
  ProviderModelProtocolType,
  ProviderModelTokenEstimatorType
} from "../../shared/domain-types";
import type { SendMessagePayload } from "../../shared/ipc-contracts";
import {
  type AppChatResumeSnapshot,
  ChatResumeStore,
  type ToolLoopResumeStateSnapshot,
  type ToolLoopToolCallSnapshot
} from "../chat-resume-store";
import { ConversationMemoryAssembler } from "./conversation-memory-assembler";
import {
  ConversationMemoryCompactor,
  type CompactorModelConfig
} from "./conversation-memory-compactor";
import { ConversationMemoryStore } from "./conversation-memory-store";
import type { ActiveTaskEntry } from "./active-task";
import type {
  ConversationModelSnapshot,
  ConversationTurnRecord,
  ConversationTurnToolCallRecord
} from "./conversation-memory-types";
import {
  cloneResumeState,
  cloneToolCallSnapshot,
  cloneToolCallSnapshots,
  createChatStreamHooks
} from "./chat-stream-bridge";
import {
  type TokenEstimateToolDefinition,
  type TokenEstimatorAdapter
} from "./token-estimators/base";
import { AnthropicMessagesTokenEstimator } from "./token-estimators/anthropic-messages";
import { CustomFallbackTokenEstimator } from "./token-estimators/custom-fallback";
import { GeminiGenerateContentTokenEstimator } from "./token-estimators/gemini-generate-content";
import { OpenAIChatCompletionsTokenEstimator } from "./token-estimators/openai-chat-completions";
import { OpenAIResponsesTokenEstimator } from "./token-estimators/openai-responses";
import { computeModifiedFileEntries } from "./modified-file-stats";
import type { TerminalManager } from "./terminal-manager";

interface ChatTaskServiceDeps {
  activeTasks: Map<string, ActiveTaskEntry>;
  chatResumeStore: ChatResumeStore;
  conversationMemoryStore: ConversationMemoryStore;
  loadCoreModules: () => any;
  normalizeOptionalString: (input: unknown) => string | null;
  toErrorMessage: (error: unknown) => string;
  closePerfLog: (event: string, fields?: Record<string, unknown>, options?: { highFrequency?: boolean }) => void;
  isShutdownDrainInProgress: () => boolean;
  isShutdownDrainCompleted: () => boolean;
  snapshotFlushIntervalMs: number;
  snapshotMaxStreamChars: number;
  snapshotMaxToolCalls: number;
  maxChatImageCount: number;
  maxChatImageBytes: number;
  terminalManager: TerminalManager;
  createTurnCheckpoint?: (
    workspace: string,
    turnId: string,
    turnIndex: number,
    userMessage: string
  ) => Promise<string | null>;
}

interface ActiveModelSelection {
  provider: ProviderConfig | null;
  modelItem: ProviderModelItem | null;
  protocolType: ProviderModelProtocolType;
  tokenEstimatorType: ProviderModelTokenEstimatorType;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function trimPersistedStream(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

function buildChatResumeSnapshot(input: {
  taskId: string;
  sessionId: string;
  workspace: string;
  message: string;
  agentId: string | null;
  thinkingEnabled: boolean;
  streamedText: string;
  streamedThinking: string;
  toolCalls: ToolLoopToolCallSnapshot[];
  resumeState: ToolLoopResumeStateSnapshot | null;
}): AppChatResumeSnapshot {
  return {
    version: 1,
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    message: input.message,
    history: [],
    agentId: input.agentId,
    thinkingEnabled: input.thinkingEnabled,
    streamedText: input.streamedText,
    streamedThinking: input.streamedThinking,
    toolCalls: input.toolCalls,
    resumeState: input.resumeState,
    updatedAt: new Date().toISOString()
  };
}

function estimateDataUrlByteSize(dataUrl: string): number | null {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const base64 = dataUrl.slice(commaIndex + 1).trim();
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    return null;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function normalizeChatImages(input: unknown, deps: ChatTaskServiceDeps): ChatImageInput[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [];
  }
  if (input.length > deps.maxChatImageCount) {
    throw new Error(`Only ${deps.maxChatImageCount} image is supported per message.`);
  }

  const output: ChatImageInput[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid image payload.");
    }
    const record = item as Record<string, unknown>;
    const name = deps.normalizeOptionalString(record.name) ?? "image";
    const mimeType = deps.normalizeOptionalString(record.mimeType)?.toLowerCase() ?? "";
    const dataUrl = deps.normalizeOptionalString(record.dataUrl);
    if (!mimeType.startsWith("image/")) {
      throw new Error("Only image uploads are supported.");
    }
    if (!dataUrl) {
      throw new Error("Missing image data.");
    }

    const headerMatch = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
    if (!headerMatch) {
      throw new Error("Invalid image format. Please upload a standard image file.");
    }
    const headerMimeType = headerMatch[1].toLowerCase();
    if (headerMimeType !== mimeType) {
      throw new Error("Image MIME type mismatch.");
    }

    const byteSize = estimateDataUrlByteSize(dataUrl);
    if (byteSize === null) {
      throw new Error("Invalid base64 image content.");
    }
    if (byteSize > deps.maxChatImageBytes) {
      throw new Error(`Image is too large. Max size is ${Math.floor(deps.maxChatImageBytes / (1024 * 1024))} MB.`);
    }

    output.push({
      name,
      mimeType,
      dataUrl
    });
  }
  return output;
}

function getActiveProvider(
  config: AgentBackendConfig,
  normalizeOptionalString: ChatTaskServiceDeps["normalizeOptionalString"]
): ProviderConfig | null {
  const activeProviderId = normalizeOptionalString(config.activeProviderId);
  if (!activeProviderId) {
    return null;
  }
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const provider = providers.find((item) => item.id === activeProviderId) ?? null;
  if (!provider || provider.isEnabled === false) {
    return null;
  }
  return provider;
}

function getActiveModel(
  provider: ProviderConfig,
  normalizeOptionalString: ChatTaskServiceDeps["normalizeOptionalString"]
): ProviderModelItem | null {
  const activeModelId = normalizeOptionalString(provider.model);
  if (!activeModelId) {
    return null;
  }
  const model = provider.models.find((item) => item.id.toLowerCase() === activeModelId.toLowerCase()) ?? null;
  if (!model || model.enabled === false) {
    return null;
  }
  return model;
}

function supportsVisionForActiveModel(
  config: AgentBackendConfig,
  normalizeOptionalString: ChatTaskServiceDeps["normalizeOptionalString"]
): boolean {
  const provider = getActiveProvider(config, normalizeOptionalString);
  if (!provider) {
    return false;
  }
  const model = getActiveModel(provider, normalizeOptionalString);
  if (!model) {
    return false;
  }
  return model.isVision === true;
}

function defaultProtocolTypeForProviderType(providerType: string): ProviderModelProtocolType {
  const normalized = providerType.trim().toLowerCase();
  if (normalized === "anthropic") {
    return "anthropic_messages";
  }
  if (normalized === "gemini") {
    return "gemini_generate_content";
  }
  if (
    normalized === "openai" ||
    normalized === "openai_compatible" ||
    normalized === "azure_openai"
  ) {
    return "openai_chat_completions";
  }
  return "custom";
}

function normalizeProtocolType(
  input: unknown,
  providerType: string
): ProviderModelProtocolType {
  if (input === "openai_chat_completions") {
    return input;
  }
  if (input === "openai_responses") {
    return input;
  }
  if (input === "anthropic_messages") {
    return input;
  }
  if (input === "gemini_generate_content") {
    return input;
  }
  if (input === "custom") {
    return input;
  }
  return defaultProtocolTypeForProviderType(providerType);
}

function normalizeTokenEstimatorType(input: unknown): ProviderModelTokenEstimatorType {
  if (input === "heuristic") {
    return input;
  }
  if (input === "remote_exact") {
    return input;
  }
  return "builtin";
}

function resolveActiveModelSelection(
  config: AgentBackendConfig,
  normalizeOptionalString: ChatTaskServiceDeps["normalizeOptionalString"]
): ActiveModelSelection {
  const provider = getActiveProvider(config, normalizeOptionalString);
  const modelItem = provider ? getActiveModel(provider, normalizeOptionalString) : null;
  const providerType = provider?.type ?? "";
  const protocolType = normalizeProtocolType(modelItem?.protocolType, providerType);

  return {
    provider,
    modelItem,
    protocolType,
    tokenEstimatorType: normalizeTokenEstimatorType(modelItem?.tokenEstimatorType),
    contextWindowTokens:
      typeof modelItem?.contextWindowTokens === "number" && Number.isFinite(modelItem.contextWindowTokens)
        ? Math.max(1, Math.floor(modelItem.contextWindowTokens))
        : null,
    maxOutputTokens:
      typeof modelItem?.maxOutputTokens === "number" && Number.isFinite(modelItem.maxOutputTokens)
        ? Math.max(1, Math.floor(modelItem.maxOutputTokens))
        : null
  };
}

function buildConversationModelSnapshot(selection: ActiveModelSelection): ConversationModelSnapshot | null {
  if (!selection.provider || !selection.modelItem) {
    return null;
  }
  return {
    providerId: selection.provider.id,
    providerType: selection.provider.type,
    modelId: selection.modelItem.id,
    contextWindowTokens: selection.contextWindowTokens,
    maxOutputTokens: selection.maxOutputTokens,
    protocolType: selection.protocolType,
    tokenEstimatorType: selection.tokenEstimatorType,
    capturedAt: new Date().toISOString()
  };
}

function normalizeToolCallsFromResult(input: unknown): ConversationTurnToolCallRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const output: ConversationTurnToolCallRecord[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.toolName !== "string") {
      continue;
    }
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
    const args = record.args && typeof record.args === "object" && !Array.isArray(record.args)
      ? cloneJson(record.args as Record<string, unknown>)
      : {};
    const resultRecord =
      record.result && typeof record.result === "object" && !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : {};
    output.push({
      toolName: record.toolName,
      args,
      result: {
        ok: resultRecord.ok === true,
        ...("data" in resultRecord ? { data: cloneJson(resultRecord.data) } : {}),
        ...(typeof resultRecord.error === "string" ? { error: resultRecord.error } : {})
      },
      timestamp
    });
  }
  return output;
}

function normalizeToolCallsFromResume(input: ToolLoopToolCallSnapshot[]): ConversationTurnToolCallRecord[] {
  const now = new Date().toISOString();
  return input.map((call) => ({
    toolName: call.name,
    args: cloneJson(call.args),
    result: cloneJson(call.result),
    timestamp: now
  }));
}

function resolveToolDefinitions(runtime: Record<string, unknown>): TokenEstimateToolDefinition[] {
  const registry = runtime.registry as
    | {
        getToolDefinitions?: () => Array<{
          function?: {
            name?: string;
            description?: string;
            parameters?: unknown;
          };
        }>;
      }
    | undefined;
  if (!registry || typeof registry.getToolDefinitions !== "function") {
    return [];
  }
  const definitions = registry.getToolDefinitions();
  if (!Array.isArray(definitions)) {
    return [];
  }
  const output: TokenEstimateToolDefinition[] = [];
  for (const item of definitions) {
    const fn = item?.function;
    if (!fn || typeof fn.name !== "string") {
      continue;
    }
    output.push({
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: cloneJson(fn.parameters) } : {})
    });
  }
  return output;
}

export function loadMatchingChatResumeSnapshot(
  chatResumeStore: ChatResumeStore,
  sessionId: string,
  workspace: string
): AppChatResumeSnapshot | null {
  const snapshot = chatResumeStore.load();
  if (!snapshot) {
    return null;
  }
  if (snapshot.sessionId !== sessionId || snapshot.workspace !== workspace) {
    return null;
  }
  return snapshot;
}

function findActiveTaskForSession(
  activeTasks: Map<string, ActiveTaskEntry>,
  sessionId: string,
  workspace: string,
  excludingTaskId?: string
): ActiveTaskEntry | null {
  for (const task of activeTasks.values()) {
    if (excludingTaskId && task.taskId === excludingTaskId) {
      continue;
    }
    if (task.sessionId !== sessionId || task.workspace !== workspace) {
      continue;
    }
    return task;
  }
  return null;
}

export function createRunChatTask(
  deps: ChatTaskServiceDeps
): (
  webContents: Electron.WebContents,
  payload: SendMessagePayload & { resumeState?: ToolLoopResumeStateSnapshot | null }
) => Promise<any> {
  const assembler = new ConversationMemoryAssembler(deps.conversationMemoryStore);
  const compactor = new ConversationMemoryCompactor(deps.conversationMemoryStore, {
    toErrorMessage: deps.toErrorMessage,
    log: (message: string) => deps.closePerfLog("memory_compactor", { message })
  });

  const tokenEstimators: Record<ProviderModelProtocolType, TokenEstimatorAdapter> = {
    openai_chat_completions: new OpenAIChatCompletionsTokenEstimator(),
    openai_responses: new OpenAIResponsesTokenEstimator(),
    anthropic_messages: new AnthropicMessagesTokenEstimator(),
    gemini_generate_content: new GeminiGenerateContentTokenEstimator(),
    custom: new CustomFallbackTokenEstimator("custom")
  };

  const pickTokenEstimator = (protocolType: ProviderModelProtocolType): TokenEstimatorAdapter => {
    const hit = tokenEstimators[protocolType];
    if (hit) {
      return hit;
    }
    return new CustomFallbackTokenEstimator(protocolType);
  };

  const appendConversationTurn = async (input: {
    workspace: string;
    sessionId: string;
    taskId: string;
    turnId: string;
    user: string;
    assistant: string;
    thinkingSummary: string;
    toolCalls: ConversationTurnToolCallRecord[];
    checkpointId: string | null;
    interrupted: boolean;
    modelSelection: ActiveModelSelection;
  }): Promise<ConversationTurnRecord> => {
    const state = await deps.conversationMemoryStore.getSessionState(input.workspace, input.sessionId);
    const now = new Date().toISOString();
    const seq = state.nextSeq;
    const record: ConversationTurnRecord = {
      version: 1,
      workspace: input.workspace,
      workspaceHash: deps.conversationMemoryStore.resolveWorkspaceHash(input.workspace),
      sessionId: input.sessionId,
      seq,
      turnId: input.turnId,
      taskId: input.taskId,
      turnIndex: seq,
      user: input.user,
      assistant: input.assistant,
      thinkingSummary: input.thinkingSummary,
      toolCalls: cloneJson(input.toolCalls),
      checkpointId: input.checkpointId,
      interrupted: input.interrupted,
      createdAt: now
    };
    await deps.conversationMemoryStore.appendTurn(record);
    state.nextSeq = seq + 1;
    state.updatedAt = now;
    state.modelSnapshot = buildConversationModelSnapshot(input.modelSelection);
    await deps.conversationMemoryStore.saveSessionState(state);
    return record;
  };

  const maybeCompactAfterTurn = async (input: {
    workspace: string;
    sessionId: string;
    runtimeConfig: any;
    runtime: Record<string, unknown>;
    modelSelection: ActiveModelSelection;
    toolCalls: ConversationTurnToolCallRecord[];
    images: ChatImageInput[];
  }): Promise<void> => {
    const contextWindowTokens = input.modelSelection.contextWindowTokens;
    if (!contextWindowTokens || contextWindowTokens <= 0) {
      return;
    }

    const assembled = await assembler.assembleContext({
      workspace: input.workspace,
      sessionId: input.sessionId,
      currentUserMessage: ""
    });
    const estimator = pickTokenEstimator(input.modelSelection.protocolType);
    const estimate = await estimator.estimate({
      systemPrompt: input.runtimeConfig?.agentBackend?.activeAgent?.prompt ?? "",
      conversationContext: assembled.contextText,
      currentUserMessage: "",
      tools: resolveToolDefinitions(input.runtime),
      toolCalls: input.toolCalls,
      images: input.images.map((item) => ({
        mimeType: item.mimeType,
        dataUrl: item.dataUrl
      })),
      maxOutputTokens: input.modelSelection.maxOutputTokens,
      contextWindowTokens,
      tokenEstimatorType: input.modelSelection.tokenEstimatorType
    });
    const threshold = Math.floor(contextWindowTokens * 0.7);
    deps.closePerfLog("memory_token_estimate", {
      sessionId: input.sessionId,
      protocolType: input.modelSelection.protocolType,
      estimatedInputTokens: estimate.estimatedInputTokens,
      threshold,
      contextWindowTokens
    });

    if (estimate.estimatedInputTokens < threshold) {
      return;
    }

    const modelConfig = resolveCompactorModelConfig(input.runtimeConfig, input.modelSelection, deps.normalizeOptionalString);
    const compactedSummary = await compactor.compactToSummary({
      workspace: input.workspace,
      sessionId: input.sessionId,
      modelConfig
    });
    deps.closePerfLog("memory_compacted", {
      sessionId: input.sessionId,
      compacted: compactedSummary !== null,
      compactedToSeq: compactedSummary?.toSeq ?? null,
      threshold,
      estimatedInputTokens: estimate.estimatedInputTokens
    });
  };

  return async function runChatTask(
    webContents: Electron.WebContents,
    payload: SendMessagePayload & { resumeState?: ToolLoopResumeStateSnapshot | null }
  ): Promise<any> {
    const taskId = payload.taskId || Date.now().toString(36);
    const sessionId = deps.normalizeOptionalString(payload.sessionId) ?? "default-session";
    const workspace = payload.workspace;
    const existingSessionTask = findActiveTaskForSession(deps.activeTasks, sessionId, workspace, taskId);
    if (existingSessionTask) {
      return {
        ok: false,
        taskId,
        error: "当前会话已有任务正在执行，请先停止或等待完成。"
      };
    }

    const controller = new AbortController();
    const activeTask: ActiveTaskEntry = {
      taskId,
      sessionId,
      workspace,
      controller,
      status: "running",
      startedAt: Date.now(),
      stopRequestedAt: null,
      forceStop: null
    };
    deps.activeTasks.set(taskId, activeTask);

    let flushPendingSnapshots: (() => Promise<void>) | null = null;
    let runtimeToDispose: { dispose?: () => Promise<void> } | null = null;
    let currentRuntimeConfig: any = null;
    let currentRuntime: Record<string, unknown> | null = null;
    let currentModelSelection: ActiveModelSelection | null = null;
    let currentImages: ChatImageInput[] = [];
    let currentMessage = "";
    let currentCheckpointId: string | null = null;
    let completedToolCallsForInterrupt: ToolLoopToolCallSnapshot[] = [];
    let latestStreamedText = "";
    let latestStreamedThinking = "";

    try {
      const {
        loadRuntimeConfig,
        createToolRuntime,
        createOrchestrator,
        createSubagentBridge
      } = deps.loadCoreModules();

      const runtimeConfig = loadRuntimeConfig({
        workspaceRoot: workspace || process.cwd(),
        approvalMode: "auto",
        agentOverride: deps.normalizeOptionalString(payload.agentId ?? null)
      }) as any;
      currentRuntimeConfig = runtimeConfig;

      const modelSelection = resolveActiveModelSelection(
        runtimeConfig.agentBackend.config as AgentBackendConfig,
        deps.normalizeOptionalString
      );
      currentModelSelection = modelSelection;

      const images = normalizeChatImages(payload.images, deps);
      currentImages = images;

      const effectiveMessage =
        deps.normalizeOptionalString(payload.message) ??
        (images.length > 0 ? "请根据我上传的图片进行分析并回答。" : "");
      currentMessage = effectiveMessage;
      if (!effectiveMessage) {
        return { ok: false, taskId, error: "Message cannot be empty." };
      }
      if (
        images.length > 0 &&
        !supportsVisionForActiveModel(runtimeConfig.agentBackend.config as AgentBackendConfig, deps.normalizeOptionalString)
      ) {
        return {
          ok: false,
          taskId,
          error: "当前模型不支持图像理解，请切换到支持图像理解的模型后重试。"
        };
      }

      if (payload.thinking) {
        runtimeConfig.agentSettings.modelRequest.thinking.type = "enabled";
        if (!runtimeConfig.agentSettings.modelRequest.thinking.budgetTokens) {
          runtimeConfig.agentSettings.modelRequest.thinking.budgetTokens = 4000;
        }
      } else {
        runtimeConfig.agentSettings.modelRequest.thinking.type = "disabled";
      }

      const sessionState = await deps.conversationMemoryStore.getSessionState(workspace, sessionId);
      sessionState.modelSnapshot = buildConversationModelSnapshot(modelSelection);
      sessionState.updatedAt = new Date().toISOString();
      await deps.conversationMemoryStore.saveSessionState(sessionState);

      const assembledContext = await assembler.assembleContext({
        workspace,
        sessionId,
        currentUserMessage: effectiveMessage
      });

      const ipcLogger = {
        info: (msg: string): void => {
          webContents.send(IPC_CHANNELS.chatLog, { taskId, level: "info", message: msg });
        },
        warn: (msg: string): void => {
          webContents.send(IPC_CHANNELS.chatLog, { taskId, level: "warn", message: msg });
        },
        error: (msg: string): void => {
          webContents.send(IPC_CHANNELS.chatLog, { taskId, level: "error", message: msg });
        }
      };

      const autoApprovalGate = {
        approve: async (): Promise<{ approved: boolean }> => ({ approved: true })
      };

      let primaryTasks: Array<{ id: string; title: string; kind: string; status: string; detail?: string }> = [];
      let subagentTasks: Array<{ id: string; title: string; kind: string; status: string; detail?: string }> = [];

      const emitCombinedTasks = (): void => {
        webContents.send(IPC_CHANNELS.chatTasks, {
          taskId,
          sessionId,
          tasks: [...primaryTasks, ...subagentTasks]
        });
      };

      const updatePrimaryTasks = (
        tasks: Array<{ id: string; title: string; kind: string; status: string; detail?: string }>
      ): void => {
        primaryTasks = tasks;
        emitCombinedTasks();
      };

      const updateSubagentTasks = (
        tasks: Array<{ id: string; title: string; kind: string; status: string; detail?: string }>
      ): void => {
        subagentTasks = tasks;
        emitCombinedTasks();
      };

      const runtime = createToolRuntime(runtimeConfig, {
        logger: ipcLogger,
        approvalGate: autoApprovalGate,
        terminalBridge: {
          executeCommand: (input: {
            sessionId: string;
            workspaceRoot: string;
            cwd: string;
            command: string;
            env: Record<string, string>;
            timeoutMs: number;
            signal?: AbortSignal;
            terminalId?: string;
            title?: string;
          }) => {
            return deps.terminalManager.executeCommand({
              sessionId: input.sessionId,
              workspace: input.workspaceRoot,
              cwd: input.cwd,
              command: input.command,
              env: input.env,
              timeoutMs: input.timeoutMs,
              signal: input.signal,
              terminalId: input.terminalId,
              title: input.title
            })
          }
        },
        sessionId
      }) as Record<string, unknown>;
      currentRuntime = runtime;
      const runtimeWithContext = runtime as Record<string, unknown> & {
        toolContext?: { subagentBridge?: unknown };
      };
      const subagentBridge =
        typeof createSubagentBridge === "function"
          ? createSubagentBridge(runtimeConfig, runtime as any, {
            taskId,
            onTasksChange: updateSubagentTasks
          })
          : null;
      if (subagentBridge && runtimeWithContext.toolContext && typeof runtimeWithContext.toolContext === "object") {
        runtimeWithContext.toolContext.subagentBridge = subagentBridge;
      }
      runtimeToDispose = runtime as { dispose?: () => Promise<void> };
      activeTask.forceStop = async () => {
        if (subagentBridge && typeof subagentBridge.dispose === "function") {
          await subagentBridge.dispose();
        }
        if (runtimeToDispose && typeof runtimeToDispose.dispose === "function") {
          await runtimeToDispose.dispose();
        }
      };
      const orchestrator = createOrchestrator(runtimeConfig, runtime);

      let streamedText = payload.resumeState?.partialAssistantMessage?.content ?? "";
      let streamedThinking = payload.resumeState?.partialAssistantMessage?.thinking ?? "";
      latestStreamedText = streamedText;
      latestStreamedThinking = streamedThinking;
      const completedToolCalls = cloneToolCallSnapshots(payload.resumeState?.toolCalls ?? []);
      completedToolCallsForInterrupt = completedToolCalls;
      let latestResumeState = cloneResumeState(payload.resumeState ?? null);
      let snapshotDirty = false;
      let snapshotFlushTimer: NodeJS.Timeout | null = null;
      let snapshotWriteChain: Promise<void> = Promise.resolve();

      const buildPersistedSnapshot = (): AppChatResumeSnapshot => {
        const trimmedToolCalls =
          completedToolCalls.length > deps.snapshotMaxToolCalls
            ? completedToolCalls.slice(completedToolCalls.length - deps.snapshotMaxToolCalls)
            : completedToolCalls;
        return buildChatResumeSnapshot({
          taskId,
          sessionId,
          workspace,
          message: effectiveMessage,
          agentId: deps.normalizeOptionalString(payload.agentId ?? null),
          thinkingEnabled: payload.thinking === true,
          streamedText: trimPersistedStream(streamedText, deps.snapshotMaxStreamChars),
          streamedThinking: trimPersistedStream(streamedThinking, deps.snapshotMaxStreamChars),
          toolCalls: cloneToolCallSnapshots(trimmedToolCalls),
          resumeState: latestResumeState
        });
      };

      const flushSnapshotNow = (): Promise<void> => {
        if (!snapshotDirty) {
          return Promise.resolve();
        }
        snapshotDirty = false;
        const snapshot = buildPersistedSnapshot();
        const startedAt = Date.now();
        const summary = {
          taskId,
          messageLength: snapshot.message.length,
          streamedTextLength: snapshot.streamedText.length,
          streamedThinkingLength: snapshot.streamedThinking.length,
          toolCallCount: snapshot.toolCalls.length
        };
        snapshotWriteChain = snapshotWriteChain
          .then(async () => {
            const byteSize = await deps.chatResumeStore.save(snapshot);
            deps.closePerfLog(
              "snapshot_saved",
              {
                ...summary,
                byteSize,
                elapsedMs: Date.now() - startedAt
              },
              { highFrequency: true }
            );
          })
          .catch((error) => {
            console.warn(`[close-perf] Failed to persist chat snapshot: ${deps.toErrorMessage(error)}`);
          });
        return snapshotWriteChain.finally(() => {
          if (snapshotDirty) {
            scheduleSnapshotFlush(true);
          }
        });
      };

      const scheduleSnapshotFlush = (immediate: boolean): void => {
        if (snapshotFlushTimer) {
          if (!immediate) {
            return;
          }
          clearTimeout(snapshotFlushTimer);
          snapshotFlushTimer = null;
        }
        const delay = immediate ? 0 : deps.snapshotFlushIntervalMs;
        snapshotFlushTimer = setTimeout(() => {
          snapshotFlushTimer = null;
          void flushSnapshotNow();
        }, delay);
      };

      flushPendingSnapshots = async (): Promise<void> => {
        if (snapshotFlushTimer) {
          clearTimeout(snapshotFlushTimer);
          snapshotFlushTimer = null;
        }
        await flushSnapshotNow();
        await snapshotWriteChain;
        while (snapshotDirty) {
          await flushSnapshotNow();
          await snapshotWriteChain;
        }
      };

      const markSnapshotDirty = (): void => {
        snapshotDirty = true;
        scheduleSnapshotFlush(false);
      };

      markSnapshotDirty();

      try {
        if (deps.createTurnCheckpoint) {
          currentCheckpointId = await deps.createTurnCheckpoint(workspace, taskId, sessionState.nextSeq, effectiveMessage);
        }
      } catch (cpError) {
        console.warn(`[checkpoint] Failed to create turn checkpoint: ${deps.toErrorMessage(cpError)}`);
      }

      const result = await orchestrator.run(
        {
          task: effectiveMessage,
          conversationContext: assembledContext.contextText,
          forcePlanMode: payload.planMode === true,
          userImages: images.map((item) => ({
            dataUrl: item.dataUrl,
            mimeType: item.mimeType
          })),
          resumeState: payload.resumeState ?? null
        },
        {
          signal: controller.signal,
          ...createChatStreamHooks({
            webContents,
            taskId,
            onAssistantTextDelta: (delta: string) => {
              streamedText += delta;
              latestStreamedText = streamedText;
              markSnapshotDirty();
            },
            onAssistantThinkingDelta: (delta: string) => {
              streamedThinking += delta;
              latestStreamedThinking = streamedThinking;
              markSnapshotDirty();
            },
            onTasksChange: () => {
              return;
            },
            emitTasks: updatePrimaryTasks,
            onToolCallCompleted: (call: ToolLoopToolCallSnapshot) => {
              completedToolCalls.push(cloneToolCallSnapshot(call));
              markSnapshotDirty();
            },
            onStateChange: (resumeState: ToolLoopResumeStateSnapshot) => {
              latestResumeState = cloneResumeState(resumeState);
              markSnapshotDirty();
            },
            sessionId
          })
        }
      );

      if (result.toolCalls && result.toolCalls.length > 0) {
        webContents.send(IPC_CHANNELS.chatToolCalls, { taskId, toolCalls: result.toolCalls });
      }

      if (flushPendingSnapshots) {
        await flushPendingSnapshots();
      }
      await deps.chatResumeStore.clear();

      const normalizedToolCalls = normalizeToolCallsFromResult(result.toolCalls ?? []);
      try {
        await appendConversationTurn({
          workspace,
          sessionId,
          taskId,
          turnId: `${taskId}-turn`,
          user: effectiveMessage,
          assistant: streamedText || result.summary || "",
          thinkingSummary: streamedThinking,
          toolCalls: normalizedToolCalls,
          checkpointId: currentCheckpointId,
          interrupted: false,
          modelSelection
        });
      } catch (turnError) {
        console.warn(`[memory] failed to append completed turn: ${deps.toErrorMessage(turnError)}`);
      }

      try {
        await maybeCompactAfterTurn({
          workspace,
          sessionId,
          runtimeConfig,
          runtime,
          modelSelection,
          toolCalls: normalizedToolCalls,
          images
        });
      } catch (compactError) {
        console.warn(`[memory] auto compact failed: ${deps.toErrorMessage(compactError)}`);
      }

      const modifiedFiles = await computeModifiedFileEntries(workspace, result.changedFiles || []);
      webContents.send(IPC_CHANNELS.chatModifiedFiles, {
        taskId,
        sessionId,
        files: modifiedFiles
      });

      return {
        ok: true,
        taskId,
        summary: streamedText || result.summary,
        toolCalls: result.toolCalls || [],
        changedFiles: result.changedFiles || [],
        executedCommands: result.executedCommands || []
      };
    } catch (error) {
      if (flushPendingSnapshots && !deps.isShutdownDrainInProgress() && !deps.isShutdownDrainCompleted()) {
        await flushPendingSnapshots();
      }
      const message = deps.toErrorMessage(error);
      if (
        message === "Interrupted by user" ||
        message === "Model stream interrupted by user." ||
        (error instanceof Error && error.name === "AbortError") ||
        message.includes("The operation was aborted") ||
        message.includes("This operation was aborted")
      ) {
        const snapshot = loadMatchingChatResumeSnapshot(deps.chatResumeStore, sessionId, workspace);
        if (currentModelSelection) {
          const toolCallsFromInterrupted = normalizeToolCallsFromResume(completedToolCallsForInterrupt);
          const assistantText = snapshot?.streamedText ?? latestStreamedText;
          const thinkingText = snapshot?.streamedThinking ?? latestStreamedThinking;
          try {
            await appendConversationTurn({
              workspace,
              sessionId,
              taskId,
              turnId: `${taskId}-turn`,
              user: currentMessage,
              assistant: assistantText,
              thinkingSummary: thinkingText,
              toolCalls: toolCallsFromInterrupted,
              checkpointId: currentCheckpointId,
              interrupted: true,
              modelSelection: currentModelSelection
            });
          } catch (turnError) {
            console.warn(`[memory] failed to append interrupted turn: ${deps.toErrorMessage(turnError)}`);
          }
          if (currentRuntimeConfig && currentRuntime) {
            try {
              await maybeCompactAfterTurn({
                workspace,
                sessionId,
                runtimeConfig: currentRuntimeConfig,
                runtime: currentRuntime,
                modelSelection: currentModelSelection,
                toolCalls: toolCallsFromInterrupted,
                images: currentImages
              });
            } catch (compactError) {
              console.warn(`[memory] auto compact failed after interruption: ${deps.toErrorMessage(compactError)}`);
            }
          }
        }
        return {
          ok: false,
          taskId,
          error: "Task interrupted by user",
          interrupted: true,
          resumeSnapshot: snapshot
        };
      }
      return { ok: false, taskId, error: message };
    } finally {
      deps.activeTasks.delete(taskId);
      if (runtimeToDispose && typeof runtimeToDispose.dispose === "function") {
        try {
          await runtimeToDispose.dispose();
        } catch {
          // Ignore disposal errors.
        }
      }
    }
  };
}

function resolveCompactorModelConfig(
  runtimeConfig: any,
  modelSelection: ActiveModelSelection,
  normalizeOptionalString: (input: unknown) => string | null
): CompactorModelConfig | null {
  const model = runtimeConfig?.model ?? null;
  const baseUrl = normalizeOptionalString(model?.baseUrl);
  const apiKey = normalizeOptionalString(model?.apiKey);
  const modelId = normalizeOptionalString(model?.coderModel);
  if (!baseUrl || !apiKey || !modelId) {
    return null;
  }
  return {
    baseUrl,
    apiKey,
    model: modelId,
    protocolType: modelSelection.protocolType
  };
}
