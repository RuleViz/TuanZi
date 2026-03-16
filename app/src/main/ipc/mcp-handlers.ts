import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels";

export interface McpHandlersDeps {
  loadCoreModules: () => any;
  toErrorMessage: (error: unknown) => string;
  normalizeMcpServers: (servers: unknown) => any;
  normalizeMcpServerId: (input: string) => string;
  probeMcpServers: (servers: any, workspace?: string | null) => Promise<any[]>;
}

export function registerMcpHandlers(deps: McpHandlersDeps): void {
  ipcMain.handle(IPC_CHANNELS.mcpDashboardGet, async (_event, payload: { workspace?: string | null }) => {
    try {
      const { loadMcpConfigSync } = deps.loadCoreModules();
      const config = loadMcpConfigSync();
      const servers = deps.normalizeMcpServers(config.mcpServers);
      const cards = await deps.probeMcpServers(servers, payload?.workspace);
      return { ok: true, mcp: { servers: cards } };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.mcpDashboardMergeJson, async (_event, payload: { jsonText?: string | null }) => {
    try {
      const { loadMcpConfigSync, saveMcpConfigSync } = deps.loadCoreModules();
      const rawText = typeof payload?.jsonText === "string" ? payload.jsonText.trim() : "";
      if (!rawText) {
        return { ok: false, error: "请输入有效的 JSON 配置" };
      }

      const parsed = JSON.parse(rawText) as unknown;
      const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
      if (!record) {
        return { ok: false, error: "JSON 顶层必须是对象" };
      }

      const incomingRaw = record.mcpServers && typeof record.mcpServers === "object"
        ? record.mcpServers
        : record;
      const incoming = deps.normalizeMcpServers(incomingRaw);
      if (Object.keys(incoming).length === 0) {
        return { ok: false, error: "未发现可用的 mcpServers 配置" };
      }

      const current = loadMcpConfigSync();
      const merged = {
        mcpServers: {
          ...current.mcpServers,
          ...incoming
        }
      };
      saveMcpConfigSync(merged);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.mcpDashboardSetServerEnabled,
    async (_event, payload: { serverId?: string | null; enabled?: boolean }) => {
      try {
        const { loadMcpConfigSync, saveMcpConfigSync } = deps.loadCoreModules();
        const serverId = deps.normalizeMcpServerId(typeof payload?.serverId === "string" ? payload.serverId : "");
        if (!serverId) {
          return { ok: false, error: "缺少 serverId" };
        }
        const enabled = payload?.enabled === true;
        const config = loadMcpConfigSync();
        if (!config.mcpServers[serverId]) {
          return { ok: false, error: `找不到 MCP Server: ${serverId}` };
        }
        config.mcpServers[serverId] = {
          ...config.mcpServers[serverId],
          enabled
        };
        saveMcpConfigSync(config);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: deps.toErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.workspaceMcpGet, async () => {
    try {
      const { loadMcpConfigSync } = deps.loadCoreModules();
      const config = loadMcpConfigSync();
      const servers = deps.normalizeMcpServers(config.mcpServers);
      const firstServerId = Object.keys(servers)[0] ?? "";
      const first = firstServerId ? (servers as Record<string, any>)[firstServerId] : null;
      return {
        ok: true,
        mcp: {
          enabled: Boolean(first && first.enabled !== false),
          command: first?.command ?? "",
          args: first?.args ?? [],
          serverId: firstServerId
        }
      };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.workspaceMcpSave, async (_event, payload: { mcp?: Record<string, unknown> }) => {
    try {
      const { saveMcpConfigSync } = deps.loadCoreModules();
      const mcp = payload?.mcp && typeof payload.mcp === "object" ? payload.mcp : {};
      const enabled = (mcp as Record<string, unknown>).enabled === true;
      const command = typeof (mcp as Record<string, unknown>).command === "string"
        ? ((mcp as Record<string, unknown>).command as string).trim()
        : "";
      const args = Array.isArray((mcp as Record<string, unknown>).args)
        ? ((mcp as Record<string, unknown>).args as unknown[])
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
      const serverId = deps.normalizeMcpServerId(
        typeof (mcp as Record<string, unknown>).serverId === "string"
          ? ((mcp as Record<string, unknown>).serverId as string)
          : "default"
      ) || "default";
      if (!enabled || !command) {
        saveMcpConfigSync({ mcpServers: {} });
        return { ok: true };
      }
      saveMcpConfigSync({
        mcpServers: {
          [serverId]: {
            enabled: true,
            command,
            args
          }
        }
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: deps.toErrorMessage(error) };
    }
  });
}
