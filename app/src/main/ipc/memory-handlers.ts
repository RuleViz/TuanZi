import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type {
  MemoryForceCompactPayload,
  MemoryGetSummaryPayload,
  MemoryGetTurnsPayload,
  MemoryStatusPayload
} from "../../shared/ipc-contracts";
import type { ProviderModelProtocolType } from "../../shared/domain-types";
import { ConversationMemoryCompactor } from "../services/conversation-memory-compactor";
import { ConversationMemoryStore } from "../services/conversation-memory-store";

interface ModelCompactionConfig {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  protocolType: ProviderModelProtocolType;
}

export interface MemoryHandlersDeps {
  conversationMemoryStore: ConversationMemoryStore;
  conversationMemoryCompactor: ConversationMemoryCompactor;
  loadCoreModules: () => any;
  normalizeOptionalString: (input: unknown) => string | null;
  toErrorMessage: (error: unknown) => string;
}

export function registerMemoryHandlers(deps: MemoryHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.memoryGetStatus, async (_event, payload: MemoryStatusPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload?.workspace);
      if (!workspace) {
        return { ok: false, error: "Missing workspace" };
      }
      const sessionId = deps.normalizeOptionalString(payload?.sessionId) ?? "default-session";
      const [state, turns, summary] = await Promise.all([
        deps.conversationMemoryStore.getSessionState(workspace, sessionId),
        deps.conversationMemoryStore.listTurns(workspace, sessionId),
        deps.conversationMemoryStore.getSummary(workspace, sessionId)
      ]);
      return {
        ok: true,
        status: {
          sessionId,
          workspace,
          nextSeq: state.nextSeq,
          lastCompactedSeq: state.lastCompactedSeq,
          turnCount: turns.length,
          hasSummary: summary !== null,
          summaryUpdatedAt: summary?.updatedAt ?? null,
          summaryFromSeq: summary?.fromSeq ?? null,
          summaryToSeq: summary?.toSeq ?? null
        }
      };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.memoryGetSummary, async (_event, payload: MemoryGetSummaryPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload?.workspace);
      if (!workspace) {
        return { ok: false, error: "Missing workspace" };
      }
      const sessionId = deps.normalizeOptionalString(payload?.sessionId) ?? "default-session";
      const summary = await deps.conversationMemoryStore.getSummary(workspace, sessionId);
      return {
        ok: true,
        summary: summary
          ? {
              fromSeq: summary.fromSeq,
              toSeq: summary.toSeq,
              title: summary.title,
              summary: summary.summary,
              keyPoints: summary.keyPoints,
              openQuestions: summary.openQuestions,
              updatedAt: summary.updatedAt,
              source: summary.source
            }
          : null
      };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.memoryForceCompact, async (_event, payload: MemoryForceCompactPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload?.workspace);
      if (!workspace) {
        return { ok: false, error: "Missing workspace" };
      }
      const sessionId = deps.normalizeOptionalString(payload?.sessionId) ?? "default-session";
      const modelConfig = resolveModelCompactionConfig(deps, workspace);
      const summary = await deps.conversationMemoryCompactor.compactToSummary({
        workspace,
        sessionId,
        modelConfig
      });
      return {
        ok: true,
        summary: summary
          ? {
              fromSeq: summary.fromSeq,
              toSeq: summary.toSeq,
              title: summary.title,
              summary: summary.summary,
              keyPoints: summary.keyPoints,
              openQuestions: summary.openQuestions,
              updatedAt: summary.updatedAt,
              source: summary.source
            }
          : null
      };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.memoryGetTurns, async (_event, payload: MemoryGetTurnsPayload) => {
    try {
      const workspace = deps.normalizeOptionalString(payload?.workspace);
      if (!workspace) {
        return { ok: false, error: "Missing workspace" };
      }
      const sessionId = deps.normalizeOptionalString(payload?.sessionId) ?? "default-session";
      const afterSeq =
        typeof payload?.afterSeq === "number" && Number.isFinite(payload.afterSeq)
          ? Math.floor(payload.afterSeq)
          : undefined;
      const turns = await deps.conversationMemoryStore.listTurns(workspace, sessionId, {
        ...(afterSeq !== undefined ? { afterSeq } : {})
      });
      return {
        ok: true,
        turns: turns.map((turn) => ({
          seq: turn.seq,
          user: turn.user,
          assistant: turn.assistant,
          interrupted: turn.interrupted,
          createdAt: turn.createdAt
        }))
      };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });
}

function resolveModelCompactionConfig(deps: MemoryHandlersDeps, workspace: string): ModelCompactionConfig | null {
  try {
    const { loadRuntimeConfig } = deps.loadCoreModules();
    const runtimeConfig = loadRuntimeConfig({
      workspaceRoot: workspace,
      approvalMode: "auto"
    }) as any;
    const model = runtimeConfig?.model ?? null;
    const config = runtimeConfig?.agentBackend?.config ?? null;
    const activeProviderId = deps.normalizeOptionalString(config?.activeProviderId);
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    const provider = providers.find((item: any) => item?.id === activeProviderId) ?? null;
    const providerModelId = deps.normalizeOptionalString(provider?.model);
    const modelItem = Array.isArray(provider?.models)
      ? provider.models.find((item: any) => {
          const id = deps.normalizeOptionalString(item?.id);
          return id !== null && providerModelId !== null && id.toLowerCase() === providerModelId.toLowerCase();
        }) ?? null
      : null;

    return {
      baseUrl: deps.normalizeOptionalString(model?.baseUrl),
      apiKey: deps.normalizeOptionalString(model?.apiKey),
      model: deps.normalizeOptionalString(model?.coderModel),
      protocolType: normalizeProtocolType(modelItem?.protocolType)
    };
  } catch {
    return null;
  }
}

function normalizeProtocolType(input: unknown): ProviderModelProtocolType {
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
  return "openai_chat_completions";
}
