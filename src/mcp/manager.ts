import type { JsonObject, Logger, McpBridge, McpSettings, McpToolCallResult } from "../core/types";
import { StdioMcpClient } from "./stdio-mcp-client";

export class McpManager implements McpBridge {
  private clientPromise: Promise<StdioMcpClient> | null = null;

  constructor(
    private readonly settings: McpSettings,
    private readonly logger: Logger
  ) {}

  async callTool(name: string, args: JsonObject): Promise<McpToolCallResult> {
    const client = await this.getClient();
    this.logger.info(`[mcp] tools/call name=${name}`);
    return client.callTool(name, args);
  }

  private async getClient(): Promise<StdioMcpClient> {
    if (!this.settings.enabled) {
      throw new Error("MCP is disabled. Enable mcp.enabled in agent.config.json.");
    }

    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = new StdioMcpClient(this.settings);
        await client.start();
        this.logger.info(
          `[mcp] connected command=${this.settings.command} args=${this.settings.args.join(" ")}`
        );
        return client;
      })();
    }

    return this.clientPromise;
  }
}

