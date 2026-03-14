import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { AgentBackendConfig, ChatImageInput, ProviderConfig } from "../../shared/domain-types";
import type { SendMessagePayload } from "../../shared/ipc-contracts";
import {
  type AppChatResumeSnapshot,
  ChatResumeStore,
  type ToolLoopResumeStateSnapshot,
  type ToolLoopToolCallSnapshot
} from "../chat-resume-store";
import {
  cloneResumeState,
  cloneToolCallSnapshot,
  cloneToolCallSnapshots,
  createChatStreamHooks
} from "./chat-stream-bridge";

interface ChatTaskServiceDeps {
  activeTasks: Map<string, AbortController>;
  chatResumeStore: ChatResumeStore;
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
  history: Array<{ user: string; assistant: string }>;
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
    history: cloneJson(input.history),
    agentId: input.agentId,
    thinkingEnabled: input.thinkingEnabled,
    streamedText: input.streamedText,
    streamedThinking: input.streamedThinking,
    toolCalls: cloneToolCallSnapshots(input.toolCalls),
    resumeState: cloneResumeState(input.resumeState),
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

function getActiveProvider(config: AgentBackendConfig, normalizeOptionalString: ChatTaskServiceDeps["normalizeOptionalString"]): ProviderConfig | null {
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

function supportsVisionForActiveModel(
  config: AgentBackendConfig,
  normalizeOptionalString: ChatTaskServiceDeps["normalizeOptionalString"]
): boolean {
  const provider = getActiveProvider(config, normalizeOptionalString);
  if (!provider) {
    return false;
  }
  const activeModelId = normalizeOptionalString(provider.model);
  if (!activeModelId) {
    return false;
  }
  const model = provider.models.find((item) => item.id.toLowerCase() === activeModelId.toLowerCase()) ?? null;
  if (!model || model.enabled === false) {
    return false;
  }
  return model.isVision === true;
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

export function createRunChatTask(deps: ChatTaskServiceDeps): (
  webContents: Electron.WebContents,
  payload: SendMessagePayload & { resumeState?: ToolLoopResumeStateSnapshot | null }
) => Promise<any> {
  return async function runChatTask(
    webContents: Electron.WebContents,
    payload: SendMessagePayload & { resumeState?: ToolLoopResumeStateSnapshot | null }
  ): Promise<any> {
    const taskId = payload.taskId || Date.now().toString(36);
    const sessionId = deps.normalizeOptionalString(payload.sessionId) ?? "default-session";
    const controller = new AbortController();
    deps.activeTasks.set(taskId, controller);
    let flushPendingSnapshots: (() => Promise<void>) | null = null;
    let runtimeToDispose: { dispose?: () => Promise<void> } | null = null;

    try {
      const { loadRuntimeConfig, createToolRuntime, createOrchestrator } = deps.loadCoreModules();

      const runtimeConfig = loadRuntimeConfig({
        workspaceRoot: payload.workspace || process.cwd(),
        approvalMode: "auto",
        agentOverride: deps.normalizeOptionalString(payload.agentId ?? null)
      }) as any;
      const images = normalizeChatImages(payload.images, deps);
      const effectiveMessage = deps.normalizeOptionalString(payload.message) ?? (
        images.length > 0 ? "请根据我上传的图片进行分析并回答。" : ""
      );
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

      const runtime = createToolRuntime(runtimeConfig, {
        logger: ipcLogger,
        approvalGate: autoApprovalGate
      }) as Record<string, unknown>;
      runtimeToDispose = runtime as { dispose?: () => Promise<void> };
      const orchestrator = createOrchestrator(runtimeConfig, runtime);
      const memoryTurns = (payload.history || []).slice(-10);

      let streamedText = payload.resumeState?.partialAssistantMessage?.content ?? "";
      let streamedThinking = payload.resumeState?.partialAssistantMessage?.thinking ?? "";
      const completedToolCalls = cloneToolCallSnapshots(payload.resumeState?.toolCalls ?? []);
      let latestResumeState = cloneResumeState(payload.resumeState ?? null);
      let pendingSnapshot: AppChatResumeSnapshot | null = null;
      let snapshotFlushTimer: NodeJS.Timeout | null = null;
      let snapshotWriteChain: Promise<void> = Promise.resolve();

      const flushSnapshotNow = (): Promise<void> => {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        if (!snapshot) {
          return Promise.resolve();
        }
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
          if (pendingSnapshot) {
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
        while (pendingSnapshot) {
          await flushSnapshotNow();
          await snapshotWriteChain;
        }
      };

      const persistSnapshot = (): AppChatResumeSnapshot => {
        const snapshot = buildChatResumeSnapshot({
          taskId,
          sessionId,
          workspace: payload.workspace,
          message: effectiveMessage,
          history: memoryTurns,
          agentId: deps.normalizeOptionalString(payload.agentId ?? null),
          thinkingEnabled: payload.thinking === true,
          streamedText,
          streamedThinking,
          toolCalls: completedToolCalls,
          resumeState: latestResumeState
        });
        const persistedSnapshot: AppChatResumeSnapshot = {
          ...snapshot,
          streamedText: trimPersistedStream(snapshot.streamedText, deps.snapshotMaxStreamChars),
          streamedThinking: trimPersistedStream(snapshot.streamedThinking, deps.snapshotMaxStreamChars),
          toolCalls:
            snapshot.toolCalls.length > deps.snapshotMaxToolCalls
              ? snapshot.toolCalls.slice(snapshot.toolCalls.length - deps.snapshotMaxToolCalls)
              : snapshot.toolCalls
        };
        pendingSnapshot = persistedSnapshot;
        scheduleSnapshotFlush(false);
        return persistedSnapshot;
      };

      persistSnapshot();

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
          ...createChatStreamHooks({
            webContents,
            taskId,
            onAssistantTextDelta: (delta: string) => {
              streamedText += delta;
              persistSnapshot();
            },
            onAssistantThinkingDelta: (delta: string) => {
              streamedThinking += delta;
              persistSnapshot();
            },
            onToolCallCompleted: (call: ToolLoopToolCallSnapshot) => {
              completedToolCalls.push(cloneToolCallSnapshot(call));
              persistSnapshot();
            },
            onStateChange: (resumeState: ToolLoopResumeStateSnapshot) => {
              latestResumeState = cloneResumeState(resumeState);
              persistSnapshot();
            }
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
        const snapshot = loadMatchingChatResumeSnapshot(deps.chatResumeStore, sessionId, payload.workspace);
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
