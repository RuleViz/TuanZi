import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import type { AgentSavePayload, AgentToolProfile } from "../../shared/domain-types";
import type { ProviderProbePayload } from "../../shared/ipc-contracts";

export interface AgentHandlersDeps {
  loadCoreModules: (options?: { bypassCache?: boolean }) => any;
  normalizeOptionalString: (input: unknown) => string | null;
  toErrorMessage: (error: unknown) => string;
  requestProviderModels: (input: { baseUrl: string; apiKey: string }) => Promise<Array<{ id: string; displayName: string; isVision: boolean }>>;
  probeProviderChatCompletions: (input: { baseUrl: string; apiKey: string; model: string }) => Promise<void>;
  isDashScopeCodingBaseUrl: (rawBaseUrl: string) => boolean;
  resolveWorkspaceFromInput: (workspace: string | null | undefined) => string;
  fallbackToolCategory: (toolName: string) => "file_system" | "execute_command" | "web_search";
  disposeRuntimeSafe: (runtime: { dispose?: () => Promise<void> } | null) => Promise<void>;
}

export function registerAgentHandlers(deps: AgentHandlersDeps): void {
  const isBuiltinDefaultIdentifier = (value: string | null | undefined): boolean => {
    const normalized = deps.normalizeOptionalString(value ?? null);
    if (!normalized) {
      return false;
    }
    const lowered = normalized.toLowerCase();
    return lowered === "default" || lowered === "default.md";
  };

  ipcMain.handle(IPC_CHANNELS.agentList, async () => {
    try {
      const { listStoredAgentsSync } = deps.loadCoreModules({ bypassCache: true });
      return { ok: true, agents: listStoredAgentsSync() };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentGet, async (_event, payload: { id?: string | null }) => {
    try {
      const { getStoredAgentSync } = deps.loadCoreModules({ bypassCache: true });
      return { ok: true, agent: getStoredAgentSync(payload?.id ?? "default") };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentSave, async (_event, payload: AgentSavePayload) => {
    try {
      const { saveStoredAgentSync, deleteStoredAgentSync } = deps.loadCoreModules();
      const name = deps.normalizeOptionalString(payload?.name);
      const prompt = deps.normalizeOptionalString(payload?.prompt);
      if (!name) {
        return { ok: false, error: "Agent 名称不能为空" };
      }
      if (!prompt) {
        return { ok: false, error: "系统提示词不能为空" };
      }
      if (isBuiltinDefaultIdentifier(payload?.filename) || isBuiltinDefaultIdentifier(payload?.previousFilename)) {
        return { ok: false, error: "内置默认 Agent 为只读，不能修改" };
      }

      const saved = saveStoredAgentSync({
        filename: deps.normalizeOptionalString(payload?.filename ?? null),
        name,
        avatar: deps.normalizeOptionalString(payload?.avatar ?? null),
        description: deps.normalizeOptionalString(payload?.description ?? null),
        tags: Array.isArray(payload?.tags) ? payload.tags : [],
        tools: Array.isArray(payload?.tools) ? payload.tools : [],
        prompt
      });

      const previousFilename = deps.normalizeOptionalString(payload?.previousFilename ?? null);
      if (
        previousFilename &&
        previousFilename.toLowerCase() !== saved.filename.toLowerCase() &&
        !isBuiltinDefaultIdentifier(previousFilename)
      ) {
        try {
          deleteStoredAgentSync(previousFilename);
        } catch {
          // ignore rename cleanup errors and keep the saved agent as source of truth
        }
      }

      return { ok: true, agent: saved };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentDelete, async (_event, payload: { id?: string | null }) => {
    try {
      const { deleteStoredAgentSync } = deps.loadCoreModules();
      const id = deps.normalizeOptionalString(payload?.id ?? null);
      if (!id) {
        return { ok: false, error: "缺少 Agent 标识" };
      }
      if (isBuiltinDefaultIdentifier(id)) {
        return { ok: false, error: "内置默认 Agent 为只读，不能删除" };
      }
      deleteStoredAgentSync(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentConfigGet, async () => {
    try {
      const { loadAgentBackendConfigSync } = deps.loadCoreModules();
      return { ok: true, config: loadAgentBackendConfigSync() };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentConfigSave, async (_event, payload: unknown) => {
    try {
      const { saveAgentBackendConfigSync } = deps.loadCoreModules();
      return { ok: true, config: saveAgentBackendConfigSync(payload) };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentConfigTestProviderConnection, async (_event, payload: ProviderProbePayload) => {
    try {
      const baseUrl = payload?.baseUrl ?? "";
      const apiKey = payload?.apiKey ?? "";
      const model = payload?.model ?? "";
      try {
        await deps.requestProviderModels({ baseUrl, apiKey });
        return { ok: true, reachable: true, message: "Connection successful" };
      } catch (modelProbeError) {
        const normalizedModel = deps.normalizeOptionalString(model);
        if (!normalizedModel) {
          throw modelProbeError;
        }

        try {
          await deps.probeProviderChatCompletions({ baseUrl, apiKey, model: normalizedModel });
          return {
            ok: true,
            reachable: true,
            message: "Connected via chat/completions (this provider may not expose /models)."
          };
        } catch (chatProbeError) {
          const modelErrorText = deps.toErrorMessage(modelProbeError);
          const chatErrorText = deps.toErrorMessage(chatProbeError);
          if (modelErrorText === chatErrorText) {
            throw new Error(modelErrorText);
          }
          throw new Error(`Model list probe failed: ${modelErrorText}\nChat probe failed: ${chatErrorText}`);
        }
      }
    } catch (error) {
      return { ok: false, reachable: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentConfigFetchProviderModels, async (_event, payload: ProviderProbePayload) => {
    try {
      const models = await deps.requestProviderModels({
        baseUrl: payload?.baseUrl ?? "",
        apiKey: payload?.apiKey ?? ""
      });
      return { ok: true, models };
    } catch (error) {
      if (deps.isDashScopeCodingBaseUrl(payload?.baseUrl ?? "")) {
        return {
          ok: true,
          models: [],
          message: "DashScope Coding endpoint does not expose /models. Please add model IDs manually."
        };
      }
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.agentListTools, async (_event, payload: { workspace?: string | null }) => {
    let runtime: any = null;
    try {
      const { loadRuntimeConfig, createToolRuntime, getSystemToolProfile } = deps.loadCoreModules({ bypassCache: true });
      const runtimeConfig = loadRuntimeConfig({
        workspaceRoot: deps.resolveWorkspaceFromInput(payload?.workspace),
        approvalMode: "auto"
      });
      runtime = createToolRuntime(runtimeConfig);
      const toolNames = runtime.registry.getToolNames();
      const tools: AgentToolProfile[] = toolNames.map((name: string) => {
        const profile = getSystemToolProfile(name);
        return {
          name,
          category: profile?.category ?? deps.fallbackToolCategory(name),
          prompt: profile?.prompt ?? ""
        };
      });
      return { ok: true, tools };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    } finally {
      await deps.disposeRuntimeSafe(runtime);
    }
  });
}
