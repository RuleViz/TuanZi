import type {
  JsonObject,
  Logger,
  McpBridge,
  McpDiscoveredTool,
  McpSettings,
  McpToolCallResult,
  ModelFunctionToolDefinition
} from "../core/types";
import { loadMcpConfigSync, type McpServerConfigEntry } from "./config-store";
import { StdioMcpClient, type McpListedTool } from "./stdio-mcp-client";
import { RemoteMcpClient } from "./remote-mcp-client";

export type NamespacedMcpTool = McpDiscoveredTool;

interface ManagedClient {
  clientPromise: Promise<StdioMcpClient | RemoteMcpClient>;
  lastUsedAt: number;
}

const TOOL_NAMESPACE_PREFIX = "mcp__";
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

export class McpManager implements McpBridge {
  private readonly clients = new Map<string, ManagedClient>();
  private readonly idleTtlMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly settings: McpSettings,
    private readonly logger: Logger,
    options?: { idleTtlMs?: number }
  ) {
    this.idleTtlMs = Math.max(60_000, options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleClients();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  async listNamespacedTools(): Promise<NamespacedMcpTool[]> {
    const servers = this.loadServers();
    const output: NamespacedMcpTool[] = [];

    for (const [serverId, server] of Object.entries(servers)) {
      const client = await this.getClient(serverId, server);
      const tools = await client.listTools();
      output.push(...toNamespacedTools(serverId, tools));
    }
    return output;
  }

  async listTools(): Promise<NamespacedMcpTool[]> {
    return this.listNamespacedTools();
  }

  async getModelToolDefinitions(): Promise<ModelFunctionToolDefinition[]> {
    const tools = await this.listNamespacedTools();
    return tools.map((tool) => toFunctionToolDefinition(tool));
  }

  async callNamespacedTool(namespacedName: string, args: JsonObject): Promise<McpToolCallResult> {
    const parsed = parseNamespacedToolName(namespacedName);
    if (!parsed) {
      throw new Error(
        `Invalid MCP tool name: ${namespacedName}. Expected format: ${TOOL_NAMESPACE_PREFIX}{serverId}__{toolName}`
      );
    }

    const servers = this.loadServers();
    const server = servers[parsed.serverId];
    if (!server) {
      throw new Error(`Unknown MCP server id: ${parsed.serverId}`);
    }
    const client = await this.getClient(parsed.serverId, server);
    this.logger.info(`[mcp] tools/call name=${namespacedName}`);
    return client.callTool(parsed.toolName, args);
  }

  async dispatchMcpToolCall(namespacedName: string, args: JsonObject): Promise<McpToolCallResult> {
    return this.callNamespacedTool(namespacedName, args);
  }

  async callTool(name: string, args: JsonObject): Promise<McpToolCallResult> {
    if (name.startsWith(TOOL_NAMESPACE_PREFIX)) {
      return this.callNamespacedTool(name, args);
    }

    const servers = this.loadServers();
    const entries = Object.entries(servers);
    if (entries.length === 1) {
      const [serverId, server] = entries[0];
      const client = await this.getClient(serverId, server);
      this.logger.info(`[mcp] tools/call name=${serverId}::${name}`);
      return client.callTool(name, args);
    }
    if (entries.length === 0) {
      throw new Error("No MCP server is configured.");
    }
    throw new Error(
      `Multiple MCP servers configured. Use namespaced tool name: ${TOOL_NAMESPACE_PREFIX}{serverId}__${name}`
    );
  }

  async stopAll(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const [serverId, managed] of this.clients.entries()) {
      this.clients.delete(serverId);
      try {
        const client = await managed.clientPromise;
        await client.stop();
      } catch {
        // ignore stop errors during shutdown
      }
    }
  }

  private loadServers(): Record<string, McpServerConfigEntry> {
    const fromConfigFile = loadMcpConfigSync().mcpServers;
    const enabledServers = Object.fromEntries(
      Object.entries(fromConfigFile).filter(([, server]) => server.enabled !== false)
    );
    if (Object.keys(enabledServers).length > 0) {
      return enabledServers;
    }

    // Legacy fallback to agent.config.json single-server MCP settings.
    if (this.settings.enabled && this.settings.command.trim()) {
      return {
        default: {
          command: this.settings.command,
          args: this.settings.args,
          ...(Object.keys(this.settings.env).length > 0 ? { env: this.settings.env } : {})
        }
      };
    }
    return {};
  }

  private async getClient(serverId: string, server: McpServerConfigEntry): Promise<StdioMcpClient | RemoteMcpClient> {
    const existing = this.clients.get(serverId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.clientPromise;
    }

    const clientPromise = (async () => {
      if (server.type === "remote" && server.url) {
        const client = new RemoteMcpClient({
          url: server.url,
          headers: server.headers,
          requestTimeoutMs: this.settings.requestTimeoutMs
        });
        await client.start();
        this.logger.info(`[mcp] connected remote server=${serverId} url=${server.url}`);
        return client;
      } else {
        const client = new StdioMcpClient({
          enabled: true,
          command: server.command || "",
          args: server.args || [],
          env: server.env ?? {},
          startupTimeoutMs: this.settings.startupTimeoutMs,
          requestTimeoutMs: this.settings.requestTimeoutMs
        });
        await client.start();
        this.logger.info(`[mcp] connected stdio server=${serverId} command=${server.command} args=${server.args?.join(" ")}`);
        return client;
      }
    })();

    this.clients.set(serverId, {
      clientPromise,
      lastUsedAt: Date.now()
    });
    return clientPromise;
  }

  private async cleanupIdleClients(): Promise<void> {
    const now = Date.now();
    for (const [serverId, managed] of this.clients.entries()) {
      if (now - managed.lastUsedAt < this.idleTtlMs) {
        continue;
      }
      this.clients.delete(serverId);
      try {
        const client = await managed.clientPromise;
        await client.stop();
        this.logger.info(`[mcp] idle timeout, stopped server=${serverId}`);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

function toNamespacedTools(serverId: string, tools: McpListedTool[]): NamespacedMcpTool[] {
  return tools.map((tool) => ({
    serverId,
    toolName: tool.name,
    namespacedName: `${TOOL_NAMESPACE_PREFIX}${serverId}__${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

function toFunctionToolDefinition(tool: NamespacedMcpTool): ModelFunctionToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.namespacedName,
      description: tool.description?.trim() || `MCP tool ${tool.serverId}::${tool.toolName}`,
      parameters: normalizeInputSchema(tool.inputSchema)
    }
  };
}

function normalizeInputSchema(inputSchema: JsonObject): JsonObject {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true
    };
  }

  const schema = { ...inputSchema };
  if (schema.type !== "object") {
    schema.type = "object";
  }

  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    schema.properties = {};
  }
  if (!Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
    schema.additionalProperties = true;
  }
  return schema;
}

function parseNamespacedToolName(input: string): { serverId: string; toolName: string } | null {
  if (!input.startsWith(TOOL_NAMESPACE_PREFIX)) {
    return null;
  }
  const body = input.slice(TOOL_NAMESPACE_PREFIX.length);
  const separatorIndex = body.indexOf("__");
  if (separatorIndex <= 0 || separatorIndex >= body.length - 2) {
    return null;
  }
  const serverId = body.slice(0, separatorIndex).trim();
  const toolName = body.slice(separatorIndex + 2).trim();
  if (!serverId || !toolName) {
    return null;
  }
  return { serverId, toolName };
}
